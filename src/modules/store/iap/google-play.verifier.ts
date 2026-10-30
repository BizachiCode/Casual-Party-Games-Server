import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { iapAccountToken, iapError, iapTransactionKey, rejected, storeUnavailable } from "./iap.domain.js";
import { IapStore, type IapStoreVerifier, type IapVerifyInput, type VerifiedPurchase } from "./iap.ports.js";

// Google Play: the purchase token is checked with the Android Publisher API (purchases.products.get) using a Play
// Console service account, then acknowledged (a once-per-account product) or consumed (a pack) after the grant:
// Google refunds purchases that stay unacknowledged for 3 days, and a consumed pack can be bought again.

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 10_000;

/** The fields of a service account key file this verifier needs. */
export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** `ProductPurchase` of the Android Publisher API (the fields used here). */
interface ProductPurchase {
  purchaseState?: number;
  consumptionState?: number;
  acknowledgementState?: number;
  orderId?: string;
  purchaseType?: number;
  quantity?: number;
  obfuscatedExternalAccountId?: string;
}

/** Reads the service account from inline JSON or a file; null when neither is set or the key is unusable. */
export function loadGoogleServiceAccount(inlineJson = "", filePath = ""): GoogleServiceAccount | null {
  try {
    const raw = inlineJson.trim() || (filePath ? readFileSync(filePath, "utf8") : "");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GoogleServiceAccount>;
    if (!parsed.client_email || !parsed.private_key) throw new Error("client_email or private_key is missing");
    return { client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri };
  } catch (error) {
    // Never log the key itself.
    console.error("[store] cannot read the Google Play service account key:", (error as Error).message);
    return null;
  }
}

const base64Url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/** The signed JWT a service account exchanges for an OAuth access token (RS256). */
export function signServiceAccountJwt(account: GoogleServiceAccount, audience: string, nowSeconds: number): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: audience, iat: nowSeconds, exp: nowSeconds + 3600 }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(account.private_key)
    .toString("base64url");
  return `${header}.${claims}.${signature}`;
}

export class GooglePlayVerifier implements IapStoreVerifier {
  readonly store = IapStore.GooglePlay;
  private accessToken: { value: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly account: () => GoogleServiceAccount | null,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly nowMs: () => number = Date.now,
    private readonly apiBase: string = API,
  ) {}

  claimedKey({ receipt }: IapVerifyInput): string | null {
    return receipt.purchaseToken ? iapTransactionKey(this.store, receipt.purchaseToken) : null;
  }

  async verify({ userId, product, receipt, catalog }: IapVerifyInput): Promise<VerifiedPurchase> {
    const packageName = catalog.googlePackageName;
    if (!packageName) throw storeUnavailable("googlePackageName is empty in the store catalog");
    const token = receipt.purchaseToken;
    if (!token) throw rejected("missing purchase token");

    const purchaseUrl =
      `${this.apiBase}/${encodeURIComponent(packageName)}/purchases/products/` +
      `${encodeURIComponent(product.productId)}/tokens/${encodeURIComponent(token)}`;
    const response = await this.call(purchaseUrl, "GET");
    if (response.status === 400 || response.status === 404 || response.status === 410)
      throw rejected("Google does not know this purchase");
    if (!response.ok) throw this.unavailable(response);

    const purchase = (await response.json()) as ProductPurchase;
    if (purchase.purchaseState === 2) throw iapError("IAP_PURCHASE_PENDING");
    if (purchase.purchaseState !== 0) throw rejected("cancelled or refunded");
    // The ledger answers a token this server delivered before it gets here; a consumed one is somebody else's.
    if (purchase.consumptionState === 1) throw iapError("IAP_RECEIPT_USED", "already consumed");
    const test = purchase.purchaseType === 0;
    if (test && !catalog.allowTestPurchases) throw rejected("license tester purchase while test purchases are off");
    if ((purchase.quantity ?? 1) > 1) throw rejected("quantity above one");
    if (purchase.obfuscatedExternalAccountId && purchase.obfuscatedExternalAccountId !== iapAccountToken(userId))
      throw rejected("bought by another account");

    const needsAcknowledge = purchase.acknowledgementState !== 1;
    // A pack is consumed (which also acknowledges it) so it can be bought again; a once-per-account product is only
    // acknowledged.
    const finish = product.oncePerAccount ? `${purchaseUrl}:acknowledge` : `${purchaseUrl}:consume`;
    return {
      store: this.store,
      productId: product.productId,
      transactionKey: iapTransactionKey(this.store, token),
      orderId: purchase.orderId ?? "",
      environment: test ? "Test" : "Production",
      afterGrant: needsAcknowledge || !product.oncePerAccount ? () => this.finish(finish) : undefined,
    };
  }

  private async finish(url: string): Promise<void> {
    const response = await this.call(url, "POST", "{}");
    // 400: finished meanwhile (the client consumed it as well). Anything else is retried by Google's 3 day refund
    // window only, so it is worth a log line.
    if (!response.ok && response.status !== 400)
      console.warn(`[store] Google Play finish failed (${response.status}); the purchase may be refunded.`);
  }

  private async call(url: string, method: "GET" | "POST", body?: string): Promise<Response> {
    const token = await this.token();
    try {
      return await this.fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw storeUnavailable("Android Publisher API unreachable: " + (error as Error).message);
    }
  }

  /** The service account's OAuth access token (JWT bearer grant), cached until a minute before it expires. */
  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAtMs - 60_000 > this.nowMs()) return this.accessToken.value;
    const account = this.account();
    // Retryable on purpose: the purchase stays pending on the device until the server is set up.
    if (!account) throw storeUnavailable("no Google Play service account is configured");
    const tokenUri = account.token_uri || DEFAULT_TOKEN_URI;
    const assertion = signServiceAccountJwt(account, tokenUri, Math.floor(this.nowMs() / 1000));
    let response: Response;
    try {
      response = await this.fetchImpl(tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw storeUnavailable("Google OAuth unreachable: " + (error as Error).message);
    }
    if (!response.ok) throw storeUnavailable(`Google OAuth refused the service account (${response.status})`);
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw storeUnavailable("Google OAuth answered without an access token");
    this.accessToken = { value: body.access_token, expiresAtMs: this.nowMs() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  private unavailable(response: Response) {
    if (response.status === 401 || response.status === 403) {
      this.accessToken = null;
      return storeUnavailable(`Android Publisher API refused the service account (${response.status})`);
    }
    return storeUnavailable(`Android Publisher API answered ${response.status}`);
  }
}
