import assert from "node:assert/strict";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverRoot } from "../../src/config/paths.js";
import {
  AppleAppStoreVerifier,
  loadAppleRootCertificates,
} from "../../src/modules/store/iap/apple-app-store.verifier.js";
import {
  GooglePlayVerifier,
  loadGoogleServiceAccount,
  type GoogleServiceAccount,
} from "../../src/modules/store/iap/google-play.verifier.js";
import { iapAccountToken, iapTransactionKey } from "../../src/modules/store/iap/iap.domain.js";
import type { IapVerifyInput, IapStoreVerifier } from "../../src/modules/store/iap/iap.ports.js";
import { StoreReceiptValidator } from "../../src/modules/store/iap/iap-receipt-validator.js";
import { loadStoreCatalog, type StoreCatalog } from "../../src/modules/store/store.catalog.js";

const catalog = loadStoreCatalog();
const pouch = catalog.products.find(product => product.id === "stars_pouch");
const starter = catalog.products.find(product => product.id === "starter_bundle");
const NOW = Date.parse("2026-10-31T12:00:00Z");

const input = (overrides: Partial<IapVerifyInput> & { receipt: IapVerifyInput["receipt"] }): IapVerifyInput => ({
  userId: "user-1",
  product: pouch,
  catalog,
  ...overrides,
});

describe("store verifiers", () => {
  // The verifiers log why they refuse a receipt; the tests refuse many.
  const warn = console.warn;
  before(() => {
    console.warn = () => {};
  });
  after(() => {
    console.warn = warn;
  });

  describe("Google Play", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const account: GoogleServiceAccount = {
      client_email: "play@example.iam.gserviceaccount.com",
      private_key: privateKey,
      token_uri: "https://oauth.test/token",
    };
    const purchaseUrl = (token: string, productId = pouch.productId) =>
      `https://publisher.test/${catalog.googlePackageName}/purchases/products/${productId}/tokens/${token}`;

    interface Fake {
      verifier: GooglePlayVerifier;
      calls: { url: string; method: string; body?: string; authorization?: string }[];
      /** Answers for the purchase URL: a status and a body. */
      purchase: { status: number; body: object };
      tokenStatus: number;
      finishStatus: number;
      offline: boolean;
    }

    /** A verifier whose fetch is a fake Android Publisher API and OAuth endpoint. */
    function fake(configured: GoogleServiceAccount | null = account): Fake {
      const state: Fake = {
        verifier: undefined,
        calls: [],
        purchase: { status: 200, body: { purchaseState: 0, consumptionState: 0, orderId: "GPA.1" } },
        tokenStatus: 200,
        finishStatus: 204,
        offline: false,
      };
      const fakeFetch = async (url: string, init: RequestInit = {}) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        state.calls.push({
          url,
          method: init.method ?? "GET",
          body: init.body as string | undefined,
          authorization: headers.authorization,
        });
        if (state.offline) throw new Error("connection refused");
        if (url === account.token_uri)
          return new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), {
            status: state.tokenStatus,
          });
        if (url.endsWith(":consume") || url.endsWith(":acknowledge"))
          return new Response(null, { status: state.finishStatus });
        return new Response(JSON.stringify(state.purchase.body), { status: state.purchase.status });
      };
      state.verifier = new GooglePlayVerifier(
        () => configured,
        fakeFetch,
        () => NOW,
        "https://publisher.test",
      );
      return state;
    }

    const receipt = (purchaseToken = "token-1") => ({ store: "GooglePlay", purchaseToken });

    it("verifies a purchase with a signed service account JWT and caches the access token", async () => {
      const state = fake();
      const verified = await state.verifier.verify(input({ receipt: receipt() }));
      assert.equal(verified.environment, "Production");
      assert.equal(verified.orderId, "GPA.1");
      assert.equal(verified.productId, pouch.productId);
      assert.equal(verified.transactionKey, iapTransactionKey("GooglePlay", "token-1"));
      assert.equal(state.verifier.claimedKey(input({ receipt: receipt() })), verified.transactionKey);
      assert.equal(state.verifier.claimedKey(input({ receipt: { store: "GooglePlay" } })), null);

      const [oauth, publisher] = state.calls;
      assert.equal(oauth.url, account.token_uri);
      const params = new URLSearchParams(oauth.body);
      assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [header, claims, signature] = params.get("assertion").split(".");
      assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
      const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
      assert.equal(payload.iss, account.client_email);
      assert.equal(payload.aud, account.token_uri);
      assert.equal(payload.scope, "https://www.googleapis.com/auth/androidpublisher");
      assert.equal(payload.iat, NOW / 1000);
      assert.equal(payload.exp, NOW / 1000 + 3600);
      const verifier = createVerify("RSA-SHA256").update(`${header}.${claims}`);
      assert.equal(verifier.verify(createPublicKey(publicKey), Buffer.from(signature, "base64url")), true);
      assert.equal(publisher.url, purchaseUrl("token-1"));
      assert.equal(publisher.authorization, "Bearer access-1");

      await state.verifier.verify(input({ receipt: receipt("token-2") }));
      assert.equal(state.calls.filter(call => call.url === account.token_uri).length, 1);
    });

    it("rejects, defers or refuses purchases by what Google says", async () => {
      const cases: [object, number, string][] = [
        [{ purchaseState: 1 }, 200, "IAP_RECEIPT_REJECTED"],
        [{ purchaseState: 2 }, 200, "IAP_PURCHASE_PENDING"],
        [{ purchaseState: 0, consumptionState: 1 }, 200, "IAP_RECEIPT_USED"],
        [{ purchaseState: 0, quantity: 2 }, 200, "IAP_RECEIPT_REJECTED"],
        [
          { purchaseState: 0, obfuscatedExternalAccountId: iapAccountToken("someone-else") },
          200,
          "IAP_RECEIPT_REJECTED",
        ],
        [{}, 404, "IAP_RECEIPT_REJECTED"],
        [{}, 400, "IAP_RECEIPT_REJECTED"],
        [{}, 403, "IAP_STORE_UNAVAILABLE"],
        [{}, 500, "IAP_STORE_UNAVAILABLE"],
      ];
      for (const [body, status, code] of cases) {
        const state = fake();
        state.purchase = { status, body };
        await assert.rejects(
          state.verifier.verify(input({ receipt: receipt() })),
          { code },
          JSON.stringify([body, status]),
        );
      }
      const mine = fake();
      mine.purchase.body = { purchaseState: 0, obfuscatedExternalAccountId: iapAccountToken("user-1") };
      assert.equal((await mine.verifier.verify(input({ receipt: receipt() }))).environment, "Production");
    });

    it("accepts license testers only while test purchases are allowed", async () => {
      const state = fake();
      state.purchase.body = { purchaseState: 0, purchaseType: 0 };
      assert.equal((await state.verifier.verify(input({ receipt: receipt() }))).environment, "Test");
      await assert.rejects(
        state.verifier.verify(input({ receipt: receipt(), catalog: { ...catalog, allowTestPurchases: false } })),
        { code: "IAP_RECEIPT_REJECTED" },
      );
    });

    it("reports a missing key, a missing package or an unreachable Google as retryable", async () => {
      await assert.rejects(fake(null).verifier.verify(input({ receipt: receipt() })), {
        code: "IAP_STORE_UNAVAILABLE",
      });
      await assert.rejects(
        fake().verifier.verify(input({ receipt: receipt(), catalog: { ...catalog, googlePackageName: "" } })),
        { code: "IAP_STORE_UNAVAILABLE" },
      );
      await assert.rejects(fake().verifier.verify(input({ receipt: { store: "GooglePlay" } })), {
        code: "IAP_RECEIPT_REJECTED",
      });
      const offline = fake();
      offline.offline = true;
      await assert.rejects(offline.verifier.verify(input({ receipt: receipt() })), { code: "IAP_STORE_UNAVAILABLE" });
      const refused = fake();
      refused.tokenStatus = 400;
      await assert.rejects(refused.verifier.verify(input({ receipt: receipt() })), { code: "IAP_STORE_UNAVAILABLE" });
    });

    it("consumes a pack and acknowledges a once-per-account product after the grant", async () => {
      const pack = fake();
      const verifiedPack = await pack.verifier.verify(input({ receipt: receipt() }));
      await verifiedPack.afterGrant();
      assert.equal(pack.calls.at(-1).url, purchaseUrl("token-1") + ":consume");
      assert.equal(pack.calls.at(-1).method, "POST");

      const bundle = fake();
      const verifiedBundle = await bundle.verifier.verify(input({ product: starter, receipt: receipt("token-9") }));
      await verifiedBundle.afterGrant();
      assert.equal(bundle.calls.at(-1).url, purchaseUrl("token-9", starter.productId) + ":acknowledge");

      const acknowledged = fake();
      acknowledged.purchase.body = { purchaseState: 0, acknowledgementState: 1 };
      const done = await acknowledged.verifier.verify(input({ product: starter, receipt: receipt("token-9") }));
      assert.equal(done.afterGrant, undefined);

      // A finish step the store refuses is logged, never thrown: the grant stands.
      const failing = fake();
      failing.finishStatus = 500;
      const verifiedFailing = await failing.verifier.verify(input({ receipt: receipt() }));
      const warn = console.warn;
      console.warn = () => {};
      try {
        await verifiedFailing.afterGrant();
      } finally {
        console.warn = warn;
      }
    });

    it("reads the service account from inline JSON or a file and never from a broken key", () => {
      const directory = mkdtempSync(join(tmpdir(), "party-google-"));
      const error = console.error;
      console.error = () => {};
      try {
        const json = JSON.stringify(account);
        assert.equal(loadGoogleServiceAccount(json, "").client_email, account.client_email);
        const file = join(directory, "key.json");
        writeFileSync(file, json);
        assert.equal(loadGoogleServiceAccount("", file).token_uri, account.token_uri);
        assert.equal(loadGoogleServiceAccount("", ""), null);
        assert.equal(loadGoogleServiceAccount("{not json", ""), null);
        assert.equal(loadGoogleServiceAccount(JSON.stringify({ client_email: "a@b" }), ""), null);
        assert.equal(loadGoogleServiceAccount("", join(directory, "missing.json")), null);
      } finally {
        console.error = error;
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  describe("App Store", () => {
    const roots = loadAppleRootCertificates(join(serverRoot, "certs", "apple"));
    const jws = (payload: object, signature = "c2lnbmF0dXJl") =>
      [
        Buffer.from(JSON.stringify({ alg: "ES256", x5c: [] })).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        signature,
      ].join(".");
    const receipt = (signedTransaction?: string) => ({ store: "AppleAppStore", signedTransaction });

    it("ships Apple's root certificate", () => {
      assert.ok(roots.length >= 1);
    });

    it("rejects garbage, other environments and forged signatures", async () => {
      const verifier = new AppleAppStoreVerifier(() => roots, false);
      const rejects = (value: string | undefined, overrides: Partial<IapVerifyInput> = {}) =>
        assert.rejects(verifier.verify(input({ receipt: receipt(value), ...overrides })), {
          code: "IAP_RECEIPT_REJECTED",
        });
      await rejects(undefined);
      await rejects("not a jws");
      await rejects("a.b.c");
      await rejects(jws({ environment: "Xcode", productId: pouch.productId }));
      await rejects(jws({ environment: "LocalTesting", productId: pouch.productId }));
      await rejects(jws({ environment: "Sandbox", productId: pouch.productId }), {
        catalog: { ...catalog, allowTestPurchases: false },
      });
      // Looks like a production transaction, but nothing chains to Apple.
      await rejects(jws({ environment: "Production", productId: pouch.productId, bundleId: catalog.appleBundleId }));
      await rejects(jws({ environment: "Sandbox", productId: pouch.productId, bundleId: catalog.appleBundleId }));
    });

    it("asks to retry when it is not set up", async () => {
      const unsigned = jws({ environment: "Production", productId: pouch.productId });
      const noRoots = new AppleAppStoreVerifier(() => [], false);
      await assert.rejects(noRoots.verify(input({ receipt: receipt(unsigned) })), { code: "IAP_STORE_UNAVAILABLE" });
      const verifier = new AppleAppStoreVerifier(() => roots, false);
      await assert.rejects(
        verifier.verify(input({ receipt: receipt(unsigned), catalog: { ...catalog, appleBundleId: "" } })),
        { code: "IAP_STORE_UNAVAILABLE" },
      );
    });

    it("claims the transaction id the client sends, and no certificates folder is an empty list", () => {
      const verifier = new AppleAppStoreVerifier(() => roots, false);
      const claimed = verifier.claimedKey(input({ receipt: { store: "AppleAppStore", transactionId: "2000001" } }));
      assert.equal(claimed, iapTransactionKey("AppleAppStore", "2000001"));
      assert.equal(verifier.claimedKey(input({ receipt: { store: "AppleAppStore" } })), null);
      const warn = console.warn;
      console.warn = () => {};
      try {
        assert.deepEqual(loadAppleRootCertificates(join(tmpdir(), "party-no-such-folder")), []);
      } finally {
        console.warn = warn;
      }
    });
  });

  describe("receipt validator", () => {
    const answers = (productId: string): IapStoreVerifier => ({
      store: "GooglePlay",
      claimedKey: () => null,
      verify: async () => ({
        store: "GooglePlay",
        productId,
        transactionKey: "k",
        orderId: "o",
        environment: "Production",
      }),
    });

    it("refuses a receipt that confirms another product and an unknown store", async () => {
      const mismatch = new StoreReceiptValidator([answers("com.other.product")], false);
      await assert.rejects(mismatch.verify(input({ receipt: { store: "GooglePlay" } })), {
        code: "IAP_PRODUCT_MISMATCH",
      });
      await assert.rejects(mismatch.verify(input({ receipt: { store: "Fake" } })), { code: "IAP_RECEIPT_REJECTED" });
      const fine = new StoreReceiptValidator([answers(pouch.productId)], false);
      assert.equal((await fine.verify(input({ receipt: { store: "GooglePlay" } }))).transactionKey, "k");
    });

    it("needs both switches for demo purchases and scopes their keys to the account", async () => {
      const on: StoreCatalog = { ...catalog, demoPurchases: true };
      const demo = (userId: string, transactionId: string) =>
        input({ userId, catalog: on, receipt: { store: "Demo", transactionId } });
      const allowed = new StoreReceiptValidator([], true);
      const first = await allowed.verify(demo("user-1", "demo-0001-abcd"));
      const second = await allowed.verify(demo("user-2", "demo-0001-abcd"));
      assert.equal(first.environment, "Demo");
      assert.notEqual(first.transactionKey, second.transactionKey);
      assert.equal(allowed.claimedKey(demo("user-1", "demo-0001-abcd")), first.transactionKey);
      await assert.rejects(allowed.verify(demo("user-1", "short")), { code: "IAP_RECEIPT_REJECTED" });
      await assert.rejects(allowed.verify(demo("user-1", "has spaces in it")), { code: "IAP_RECEIPT_REJECTED" });
      await assert.rejects(allowed.verify(demo("user-1", "")), { code: "IAP_RECEIPT_REJECTED" });
      await assert.rejects(new StoreReceiptValidator([], false).verify(demo("user-1", "demo-0001-abcd")), {
        code: "IAP_DEMO_DISABLED",
      });
      await assert.rejects(
        allowed.verify(
          input({
            catalog: { ...catalog, demoPurchases: false },
            receipt: { store: "Demo", transactionId: "demo-0001-abcd" },
          }),
        ),
        { code: "IAP_DEMO_DISABLED" },
      );
    });

    it("derives a stable account token in UUID form", () => {
      const token = iapAccountToken("user-1");
      assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(token, iapAccountToken("user-1"));
      assert.notEqual(token, iapAccountToken("user-2"));
    });
  });
});
