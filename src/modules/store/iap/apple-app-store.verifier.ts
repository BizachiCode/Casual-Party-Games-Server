import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from "@apple/app-store-server-library";
import { iapAccountToken, iapError, iapTransactionKey, rejected, storeUnavailable } from "./iap.domain.js";
import { IapStore, type IapStoreVerifier, type IapVerifyInput, type VerifiedPurchase } from "./iap.ports.js";

// App Store (iOS, iPadOS, macOS, tvOS, visionOS): the StoreKit 2 signed transaction (JWS) is verified with Apple's
// official library against Apple's root certificates, offline except for the optional OCSP revocation check.
// Only Production and Sandbox transactions are accepted: the Xcode and LocalTesting environments are signed with a
// local certificate the library does not chain to Apple, so anyone could forge one.

/** One-time purchases only (subscriptions need renewal tracking). */
const DELIVERABLE_TYPES = new Set(["Consumable", "Non-Consumable"]);

/** Every `*.cer` and `*.der` file of the folder (DER encoded). Empty when the folder is missing. */
export function loadAppleRootCertificates(directory: string): Buffer[] {
  try {
    return readdirSync(directory)
      .filter(file => /\.(cer|der)$/i.test(file))
      .map(file => readFileSync(join(directory, file)));
  } catch {
    console.warn(`[store] no Apple root certificates in ${directory}: App Store purchases cannot be verified.`);
    return [];
  }
}

/** The `environment` of a JWS payload, read without verifying it: it only picks the verifier, which checks it again. */
function peekEnvironment(jws: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      environment?: unknown;
    };
    return typeof payload.environment === "string" ? payload.environment : null;
  } catch {
    return null;
  }
}

export class AppleAppStoreVerifier implements IapStoreVerifier {
  readonly store = IapStore.AppleAppStore;
  private readonly verifiers = new Map<string, SignedDataVerifier>();

  constructor(
    private readonly rootCertificates: () => Buffer[],
    private readonly onlineChecks: boolean,
  ) {}

  claimedKey({ receipt }: IapVerifyInput): string | null {
    return receipt.transactionId ? iapTransactionKey(this.store, receipt.transactionId) : null;
  }

  async verify({ userId, product, receipt, catalog }: IapVerifyInput): Promise<VerifiedPurchase> {
    const bundleId = catalog.appleBundleId;
    if (!bundleId) throw storeUnavailable("appleBundleId is empty in the store catalog");
    const jws = receipt.signedTransaction;
    if (!jws) throw rejected("missing signed transaction");

    const environment = peekEnvironment(jws);
    if (environment !== Environment.PRODUCTION && environment !== Environment.SANDBOX)
      throw rejected(`unsupported environment ${environment}`);
    if (environment === Environment.SANDBOX && !catalog.allowTestPurchases)
      throw rejected("sandbox purchase while test purchases are off");

    const verifier = this.verifier(environment, bundleId, catalog.appleAppId);
    let transaction;
    try {
      transaction = await verifier.verifyAndDecodeTransaction(jws);
    } catch (error) {
      if (error instanceof VerificationException && error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE)
        throw storeUnavailable("Apple OCSP check unreachable: " + error.message);
      if (error instanceof VerificationException)
        throw rejected("invalid signature: " + VerificationStatus[error.status]);
      throw rejected("invalid signature: " + (error as Error).message);
    }

    if (transaction.productId !== product.productId) throw iapError("IAP_PRODUCT_MISMATCH", transaction.productId);
    if (!transaction.transactionId) throw rejected("missing transaction id");
    if (receipt.transactionId && receipt.transactionId !== transaction.transactionId)
      throw rejected("transaction id differs from the signed one");
    if (transaction.revocationDate) throw rejected("refunded");
    if (!DELIVERABLE_TYPES.has(String(transaction.type))) throw rejected(`unsupported type ${transaction.type}`);
    if ((transaction.quantity ?? 1) > 1) throw rejected("quantity above one");
    if (transaction.appAccountToken && transaction.appAccountToken.toLowerCase() !== iapAccountToken(userId))
      throw rejected("bought by another account");

    return {
      store: this.store,
      productId: transaction.productId,
      transactionKey: iapTransactionKey(this.store, transaction.transactionId),
      orderId: transaction.transactionId,
      environment,
    };
  }

  private verifier(environment: Environment, bundleId: string, appAppleId: number): SignedDataVerifier {
    const key = `${environment}|${bundleId}|${appAppleId}`;
    let verifier = this.verifiers.get(key);
    if (!verifier) {
      const roots = this.rootCertificates();
      // Retryable on purpose: the purchase stays pending on the device until the server is set up.
      if (roots.length === 0) throw storeUnavailable("no Apple root certificates are installed");
      // The library wants the app id for Production (0 when the app has none yet); the bundle id binds the transaction.
      verifier = new SignedDataVerifier(
        roots,
        this.onlineChecks,
        environment,
        bundleId,
        environment === Environment.PRODUCTION ? appAppleId : undefined,
      );
      this.verifiers.set(key, verifier);
    }
    return verifier;
  }
}
