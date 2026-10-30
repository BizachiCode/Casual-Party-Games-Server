import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerOptions } from "../../src/app/container.js";
import { loadSettings } from "../../src/config/env.js";
import { iapTransactionKey } from "../../src/modules/store/iap/iap.domain.js";
import type { IapStoreVerifier, IapVerifyInput } from "../../src/modules/store/iap/iap.ports.js";
import { iapError } from "../../src/modules/store/iap/iap.domain.js";
import {
  EMPTY_STORE_CATALOG,
  loadStoreCatalog,
  validateStoreCatalog,
  type StoreCatalog,
} from "../../src/modules/store/store.catalog.js";
import { content, startServer } from "../support/server.js";

const NOW = "2026-10-31T12:00:00Z";
const shipped = loadStoreCatalog();
const initialCredits = content.characterCatalog.initialCredits;

/** The shipped catalog with `edit` applied to a copy. */
function catalogWith(edit: (catalog: StoreCatalog) => void): StoreCatalog {
  const catalog = structuredClone(shipped);
  edit(catalog);
  return catalog;
}

let transactionCounter = 0;
/** A fresh demo transaction id (8..100 characters). */
const demoId = () => "demo-" + String(++transactionCounter).padStart(6, "0") + "-test";

interface Reply {
  status: number;
  // Responses are checked field by field, so the shape stays open here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/**
 * A stand-in for Google Play: tokens starting "pending", "down", "mismatch" or "consumed" fail in that way, any other
 * token is a valid purchase of the product in the request. `finished` counts the after-grant steps that ran.
 */
class FakeGoogle implements IapStoreVerifier {
  readonly store = "GooglePlay";
  finished: string[] = [];
  failFinish = false;

  claimedKey({ receipt }: IapVerifyInput): string | null {
    return receipt.purchaseToken ? iapTransactionKey(this.store, receipt.purchaseToken) : null;
  }

  async verify({ product, receipt }: IapVerifyInput) {
    const token = receipt.purchaseToken ?? "";
    if (token.startsWith("pending")) throw iapError("IAP_PURCHASE_PENDING");
    if (token.startsWith("down")) throw iapError("IAP_STORE_UNAVAILABLE");
    return {
      store: this.store,
      productId: token.startsWith("mismatch") ? "com.other.product" : product.productId,
      transactionKey: iapTransactionKey(this.store, token),
      orderId: "GPA." + token,
      environment: "Production",
      afterGrant: async () => {
        if (this.failFinish) throw new Error("store said no");
        this.finished.push(token);
      },
    };
  }
}

interface FixtureOptions {
  /** PARTY_IAP_DEMO_PURCHASES. */
  serverDemo?: boolean;
  store?: StoreCatalog;
  google?: FakeGoogle;
  now?: string;
}

async function setup(options: FixtureOptions = {}) {
  const google = options.google ?? new FakeGoogle();
  const containerOptions: ContainerOptions = {
    store: options.store ?? shipped,
    storeVerifiers: [google],
    clock: () => new Date(options.now ?? NOW),
  };
  const server = await startServer({ iapDemoPurchases: options.serverDemo ?? true }, containerOptions);
  const call = async (path: string, init: { token?: string; body?: unknown } = {}): Promise<Reply> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (init.token) headers.Authorization = "Bearer " + init.token;
    const response = await fetch(server.url + "/api/store" + path, {
      method: init.body === undefined ? "GET" : "POST",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: await response.json() };
  };
  const register = async (username: string) =>
    server.container.accounts.register({ username, password: "test-only-password" });
  const buyDemo = (token: string, id: string, transactionId = demoId()) =>
    call("/purchase", {
      token,
      body: {
        productId: "com.bizachicode.casualparty." + id,
        receipt: { store: "Demo", transactionId, purchaseToken: "", signedTransaction: "" },
      },
    });
  const buyGoogle = (token: string, id: string, purchaseToken: string) =>
    call("/purchase", {
      token,
      body: {
        productId: "com.bizachicode.casualparty." + id,
        receipt: { store: "GooglePlay", transactionId: "", purchaseToken, signedTransaction: "" },
      },
    });
  const rows = (userId: string) =>
    server.container.database.query<Record<string, unknown>>(
      "SELECT * FROM iap_transactions WHERE user_id = ? ORDER BY created_at, transaction_key",
      [userId],
    );
  return { server, google, call, register, buyDemo, buyGoogle, rows };
}

async function withStore(
  work: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  options?: FixtureOptions,
) {
  const fixture = await setup(options);
  try {
    await work(fixture);
  } finally {
    await fixture.server.stop();
  }
}

describe("store", () => {
  // The store logs why it refuses a receipt; these tests refuse many.
  const warn = console.warn;
  before(() => {
    console.warn = () => {};
  });
  after(() => {
    console.warn = warn;
  });

  describe("catalog", () => {
    it("ships a valid catalog of the sample products", () => {
      validateStoreCatalog(shipped);
      assert.deepEqual(
        shipped.products.map(product => product.id),
        ["starter_bundle", "stars_pouch", "stars_sack", "stars_chest", "stars_crate", "stars_vault", "stars_mountain"],
      );
      assert.equal(shipped.products[0].oncePerAccount, true);
      assert.ok(shipped.products.every(product => product.productId === "com.bizachicode.casualparty." + product.id));
    });

    it("reads a missing file as no store and refuses a broken one", () => {
      const directory = mkdtempSync(join(tmpdir(), "party-store-"));
      try {
        assert.deepEqual(loadStoreCatalog(join(directory, "missing.json")), EMPTY_STORE_CATALOG);
        validateStoreCatalog(EMPTY_STORE_CATALOG);
        const broken = join(directory, "broken.json");
        writeFileSync(broken, "{ not json");
        assert.throws(() => loadStoreCatalog(broken));
        const copy = join(directory, "copy.json");
        writeFileSync(copy, JSON.stringify(shipped));
        assert.deepEqual(loadStoreCatalog(copy), shipped);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("refuses what the stores or the client could not use", () => {
      const first = (catalog: StoreCatalog) => catalog.products[0];
      const changes: [string, (catalog: StoreCatalog) => void, RegExp][] = [
        ["version", catalog => ((catalog as { version: number }).version = 2), /version 1/],
        ["a duplicate id", catalog => (catalog.products[1].id = first(catalog).id), /appears twice/],
        ["a duplicate sku", catalog => (catalog.products[1].productId = first(catalog).productId), /reuses/],
        ["an upper case id", catalog => (first(catalog).id = "Starter"), /needs an id/],
        ["a short id", catalog => (first(catalog).id = "a"), /needs an id/],
        ["an upper case sku", catalog => (first(catalog).productId = "Com.Example.Pack"), /needs a productId/],
        ["negative stars", catalog => (first(catalog).stars = -1), /stars must be/],
        ["fractional bonus", catalog => (first(catalog).bonusStars = 1.5), /bonusStars must be/],
        [
          "nothing to give",
          catalog => Object.assign(first(catalog), { stars: 0, bonusStars: 0, shards: 0 }),
          /must give Stars or shards/,
        ],
        ["a free price", catalog => (first(catalog).priceUsd = 0), /priceUsd/],
        ["a huge price", catalog => (first(catalog).priceUsd = 1000), /priceUsd/],
        ["a text price", catalog => ((first(catalog) as { priceUsd: unknown }).priceUsd = "1"), /priceUsd/],
        [
          "a numeric flag",
          catalog => ((first(catalog) as { oncePerAccount: unknown }).oncePerAccount = 1),
          /oncePerAccount/,
        ],
        ["a bad badge", catalog => (first(catalog).badge = "Best Value"), /badge/],
        [
          "a missing switch",
          catalog => ((catalog as { demoPurchases: unknown }).demoPurchases = undefined),
          /true or false/,
        ],
        ["an app id", catalog => (catalog.appleAppId = -4), /appleAppId/],
        [
          "a package",
          catalog => ((catalog as { googlePackageName: unknown }).googlePackageName = 7),
          /googlePackageName/,
        ],
        ["too many products", catalog => (catalog.products = new Array(101).fill(first(catalog))), /at most 100/],
      ];
      for (const [label, change, message] of changes)
        assert.throws(() => validateStoreCatalog(catalogWith(change)), message, label);
    });
  });

  describe("settings", () => {
    const base = { DATABASE_URL: "mysql://root@127.0.0.1:3306/party" };

    it("turns demo purchases on outside production and off in production unless asked", () => {
      assert.equal(loadSettings(base).iapDemoPurchases, true);
      assert.equal(loadSettings({ ...base, NODE_ENV: "production" }).iapDemoPurchases, false);
      assert.equal(
        loadSettings({ ...base, NODE_ENV: "production", PARTY_IAP_DEMO_PURCHASES: "1" }).iapDemoPurchases,
        true,
      );
      assert.equal(loadSettings({ ...base, PARTY_IAP_DEMO_PURCHASES: "0" }).iapDemoPurchases, false);
      assert.throws(() => loadSettings({ ...base, PARTY_IAP_DEMO_PURCHASES: "yes" }), /PARTY_IAP_DEMO_PURCHASES/);
    });

    it("reads the store paths and credentials", () => {
      const settings = loadSettings({
        ...base,
        PARTY_STORE_CATALOG: "/data/store.json",
        PARTY_IAP_GOOGLE_SERVICE_ACCOUNT_FILE: "/data/play.json",
        PARTY_IAP_APPLE_ROOT_CERTS_DIR: "/data/apple",
        PARTY_IAP_APPLE_ONLINE_CHECKS: "0",
      });
      assert.equal(settings.storeCatalogPath, "/data/store.json");
      assert.equal(settings.iapGoogleServiceAccountFile, "/data/play.json");
      assert.equal(settings.iapGoogleServiceAccountJson, undefined);
      assert.equal(settings.iapAppleRootCertsDir, "/data/apple");
      assert.equal(settings.iapAppleOnlineChecks, false);
      assert.equal(loadSettings(base).iapAppleOnlineChecks, true);
      assert.throws(() => loadSettings({ ...base, PARTY_IAP_APPLE_ONLINE_CHECKS: "maybe" }), /ONLINE_CHECKS/);
    });
  });

  describe("HTTP", () => {
    it("lists the packs for everybody and the owned bundles for a signed-in player", async () => {
      await withStore(async ({ call, register, buyDemo }) => {
        const anonymous = await call("");
        assert.equal(anonymous.status, 200);
        assert.deepEqual(Object.keys(anonymous.body).sort(), ["demo", "products"]);
        assert.equal(anonymous.body.demo, true);
        assert.deepEqual(anonymous.body.products, shipped.products);

        const { token } = await register("shopper");
        assert.deepEqual((await call("", { token })).body.owned, []);
        await buyDemo(token, "starter_bundle");
        await buyDemo(token, "stars_pouch");
        const owned = await call("", { token });
        assert.deepEqual(owned.body.owned, ["starter_bundle"]);
        assert.deepEqual(owned.body.products, shipped.products);
        // A bad token is treated as anonymous here.
        assert.equal((await call("", { token: "garbage" })).body.owned, undefined);
      });
    });

    it("reports demo as off when either switch is off", async () => {
      await withStore(
        async ({ call }) => {
          assert.equal((await call("")).body.demo, false);
        },
        { serverDemo: false },
      );
      await withStore(
        async ({ call }) => {
          assert.equal((await call("")).body.demo, false);
        },
        { store: catalogWith(catalog => (catalog.demoPurchases = false)) },
      );
    });

    it("checks a purchase without charging", async () => {
      await withStore(async ({ call, register, buyDemo, server }) => {
        const { token, profile } = await register("checker");
        const id = "com.bizachicode.casualparty.starter_bundle";
        const check = await call("/check?productId=" + id, { token });
        assert.equal(check.status, 200);
        assert.deepEqual(Object.keys(check.body).sort(), ["accountToken", "demo", "ok", "productId"]);
        assert.equal(check.body.ok, true);
        assert.equal(check.body.productId, id);
        assert.equal(check.body.demo, true);
        assert.match(check.body.accountToken, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.equal((await call("/check?productId=" + id, { token })).body.accountToken, check.body.accountToken);
        assert.equal((await server.container.collection.state(profile.id)).credits, initialCredits);

        const unknown = await call("/check?productId=com.example.nope", { token });
        assert.equal(unknown.status, 400);
        assert.equal(unknown.body.code, "IAP_UNKNOWN_PRODUCT");
        assert.equal((await call("/check", { token })).body.code, "IAP_UNKNOWN_PRODUCT");
        assert.equal((await call("/check?productId=" + id)).status, 401);

        await buyDemo(token, "starter_bundle");
        const owned = await call("/check?productId=" + id, { token });
        assert.equal(owned.status, 409);
        assert.equal(owned.body.code, "IAP_ALREADY_OWNED");
        // A pack can always be bought again.
        assert.equal((await call("/check?productId=com.bizachicode.casualparty.stars_pouch", { token })).status, 200);
      });
    });

    it("grants a demo purchase once, with its bonus, and answers a replay with the same grant", async () => {
      await withStore(async ({ register, buyDemo, rows, server }) => {
        const { token, profile } = await register("buyer");
        const transactionId = demoId();
        const first = await buyDemo(token, "stars_sack", transactionId);
        assert.equal(first.status, 200);
        const { state, ...granted } = first.body;
        assert.deepEqual(granted, {
          ok: true,
          duplicate: false,
          productId: "com.bizachicode.casualparty.stars_sack",
          stars: 1100,
          shards: 0,
          environment: "Demo",
        });
        assert.deepEqual(state, await server.container.collection.state(profile.id));
        assert.equal(state.credits, initialCredits + 1100);
        assert.deepEqual(Object.keys(state).sort(), [
          "credits",
          "dailyAvailable",
          "equipped",
          "owned",
          "pityEpic",
          "pityLegendary",
          "shards",
        ]);

        const replay = await buyDemo(token, "stars_sack", transactionId);
        assert.equal(replay.status, 200);
        assert.deepEqual(replay.body, { ...first.body, duplicate: true });
        assert.equal((await server.container.collection.state(profile.id)).credits, initialCredits + 1100);

        const saved = await rows(profile.id);
        assert.equal(saved.length, 1);
        assert.equal(saved[0].transaction_key, iapTransactionKey("Demo", `${profile.id}:${transactionId}`));
        assert.equal(saved[0].store, "Demo");
        assert.equal(saved[0].environment, "Demo");
        assert.equal(saved[0].catalog_id, "stars_sack");
        assert.equal(saved[0].product_id, "com.bizachicode.casualparty.stars_sack");
        assert.equal(Number(saved[0].stars), 1100);
        assert.equal(Number(saved[0].shards), 0);
        // The catalog's price is recorded even though nothing was paid; the environment tells it apart.
        assert.equal(Number(saved[0].price_usd), 1.99);
        assert.equal(Number(saved[0].created_at), Date.parse(NOW));
      });
    });

    it("grants shards, takes the catalog id as well and ignores empty strings", async () => {
      await withStore(async ({ call, register }) => {
        const { token } = await register("bundler");
        const answer = await call("/purchase", {
          token,
          body: { productId: "starter_bundle", receipt: { store: "Demo", transactionId: demoId() } },
        });
        assert.equal(answer.status, 200);
        assert.equal(answer.body.productId, "com.bizachicode.casualparty.starter_bundle");
        assert.equal(answer.body.stars, 1500);
        assert.equal(answer.body.shards, 300);
        assert.equal(answer.body.state.shards, 300);
        assert.equal(answer.body.state.credits, initialCredits + 1500);
      });
    });

    it("keeps demo transaction ids private to the account", async () => {
      await withStore(async ({ register, buyDemo }) => {
        const first = await register("twin_a");
        const second = await register("twin_b");
        const transactionId = demoId();
        const one = await buyDemo(first.token, "stars_pouch", transactionId);
        const two = await buyDemo(second.token, "stars_pouch", transactionId);
        assert.equal(one.body.duplicate, false);
        assert.equal(two.body.duplicate, false);
        assert.equal(two.body.state.credits, initialCredits + 500);
      });
    });

    it("refuses demo purchases when the server or the catalog has them off", async () => {
      await withStore(
        async ({ register, buyDemo, rows }) => {
          const { token, profile } = await register("nodemo");
          const refused = await buyDemo(token, "stars_pouch");
          assert.equal(refused.status, 403);
          assert.equal(refused.body.code, "IAP_DEMO_DISABLED");
          assert.equal(typeof refused.body.error, "string");
          assert.deepEqual(await rows(profile.id), []);
        },
        { serverDemo: false },
      );
      await withStore(
        async ({ register, buyDemo }) => {
          const { token } = await register("nodemo_catalog");
          const refused = await buyDemo(token, "stars_pouch");
          assert.equal(refused.status, 403);
          assert.equal(refused.body.code, "IAP_DEMO_DISABLED");
        },
        { store: catalogWith(catalog => (catalog.demoPurchases = false)) },
      );
    });

    it("sells a once-per-account bundle once", async () => {
      await withStore(async ({ register, buyDemo, server, rows }) => {
        const { token, profile } = await register("onceonly");
        assert.equal((await buyDemo(token, "starter_bundle")).status, 200);
        const second = await buyDemo(token, "starter_bundle");
        assert.equal(second.status, 409);
        assert.equal(second.body.code, "IAP_ALREADY_OWNED");
        assert.equal((await rows(profile.id)).length, 1);
        assert.equal((await server.container.collection.state(profile.id)).credits, initialCredits + 1500);
        // The same bundle is still sold to other accounts.
        const other = await register("onceonly_b");
        assert.equal((await buyDemo(other.token, "starter_bundle")).status, 200);
      });
    });

    it("refuses what it cannot deliver, with a code the client can branch on", async () => {
      await withStore(async ({ call, register }) => {
        const { token } = await register("oddbuyer");
        const post = (body: unknown) => call("/purchase", { token, body });
        const demo = { store: "Demo", transactionId: demoId() };
        const cases: [unknown, number, string][] = [
          [{ productId: "com.example.nope", receipt: demo }, 400, "IAP_UNKNOWN_PRODUCT"],
          [{ productId: "", receipt: demo }, 400, "IAP_UNKNOWN_PRODUCT"],
          [{ receipt: demo }, 400, "IAP_UNKNOWN_PRODUCT"],
          [{ productId: "stars_pouch" }, 400, "IAP_RECEIPT_REJECTED"],
          [
            { productId: "stars_pouch", receipt: { store: "SteamStore", transactionId: demoId() } },
            400,
            "IAP_RECEIPT_REJECTED",
          ],
          [
            { productId: "stars_pouch", receipt: { store: "Demo", transactionId: "short" } },
            400,
            "IAP_RECEIPT_REJECTED",
          ],
          [{ productId: "stars_pouch", receipt: { store: "Demo", transactionId: "" } }, 400, "IAP_RECEIPT_REJECTED"],
          [
            { productId: "stars_pouch", receipt: { store: "AppleAppStore", signedTransaction: "" } },
            400,
            "IAP_RECEIPT_REJECTED",
          ],
          [
            { productId: "stars_pouch", receipt: { store: "GooglePlay", purchaseToken: "mismatch-1" } },
            400,
            "IAP_PRODUCT_MISMATCH",
          ],
        ];
        for (const [body, status, code] of cases) {
          const answer = await post(body);
          assert.equal(answer.status, status, JSON.stringify(body));
          assert.equal(answer.body.code, code, JSON.stringify(body));
          assert.equal(typeof answer.body.error, "string");
        }
        const anonymous = await call("/purchase", { body: { productId: "stars_pouch", receipt: demo } });
        assert.equal(anonymous.status, 401);
        assert.equal(anonymous.body.code, undefined);
      });
    });

    it("delivers a store purchase once across devices and accounts, then runs the after-grant step once", async () => {
      await withStore(async ({ register, buyGoogle, google, rows, server }) => {
        const owner = await register("payer");
        const thief = await register("thief");
        const first = await buyGoogle(owner.token, "stars_chest", "token-aaa");
        assert.equal(first.status, 200);
        assert.equal(first.body.duplicate, false);
        assert.equal(first.body.environment, "Production");
        assert.equal(first.body.stars, 3000);
        assert.deepEqual(google.finished, ["token-aaa"]);

        const replay = await buyGoogle(owner.token, "stars_chest", "token-aaa");
        assert.deepEqual(replay.body, { ...first.body, duplicate: true });
        assert.deepEqual(google.finished, ["token-aaa"]);

        const stolen = await buyGoogle(thief.token, "stars_chest", "token-aaa");
        assert.equal(stolen.status, 409);
        assert.equal(stolen.body.code, "IAP_RECEIPT_USED");
        assert.equal((await server.container.collection.state(thief.profile.id)).credits, initialCredits);

        const saved = await rows(owner.profile.id);
        assert.equal(saved.length, 1);
        assert.equal(saved[0].store, "GooglePlay");
        assert.equal(saved[0].environment, "Production");
        assert.equal(saved[0].order_id, "GPA.token-aaa");
        assert.equal(Number(saved[0].price_usd), 4.99);
        // A replay of a receipt for another product is a mismatch, not a second grant.
        const wrong = await buyGoogle(owner.token, "stars_pouch", "token-aaa");
        assert.equal(wrong.body.code, "IAP_PRODUCT_MISMATCH");
        assert.equal((await server.container.collection.state(owner.profile.id)).credits, initialCredits + 3000);
      });
    });

    it("keeps pending and unreachable stores retryable and the grant when the after-grant step fails", async () => {
      await withStore(async ({ register, buyGoogle, google, rows }) => {
        const { token, profile } = await register("patient");
        const pending = await buyGoogle(token, "stars_pouch", "pending-1");
        assert.equal(pending.status, 409);
        assert.equal(pending.body.code, "IAP_PURCHASE_PENDING");
        const down = await buyGoogle(token, "stars_pouch", "down-1");
        assert.equal(down.status, 503);
        assert.equal(down.body.code, "IAP_STORE_UNAVAILABLE");
        assert.equal(typeof down.body.error, "string");
        assert.notEqual(down.body.error, "Server operation failed.");
        assert.deepEqual(await rows(profile.id), []);

        google.failFinish = true;
        const granted = await buyGoogle(token, "stars_pouch", "fine-1");
        assert.equal(granted.status, 200);
        assert.equal(granted.body.stars, 500);
        assert.equal((await rows(profile.id)).length, 1);
      });
    });

    it("grants once when the same receipt arrives twice at the same moment", async () => {
      await withStore(async ({ register, buyDemo, buyGoogle, server, rows }) => {
        const { token, profile } = await register("racer");
        const transactionId = demoId();
        const [one, two] = await Promise.all([
          buyDemo(token, "stars_pouch", transactionId),
          buyDemo(token, "stars_pouch", transactionId),
        ]);
        assert.deepEqual([one.status, two.status], [200, 200]);
        assert.deepEqual([one.body.duplicate, two.body.duplicate].sort(), [false, true]);
        assert.equal((await server.container.collection.state(profile.id)).credits, initialCredits + 500);

        // Two accounts racing for one store receipt: exactly one wins.
        const rival = await register("racer_b");
        const results = await Promise.all([
          buyGoogle(token, "stars_pouch", "shared-token"),
          buyGoogle(rival.token, "stars_pouch", "shared-token"),
        ]);
        assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
        assert.equal((await rows(profile.id)).length + (await rows(rival.profile.id)).length, 2);
      });
    });
  });

  describe("service", () => {
    it("lists purchases and sums the real-money revenue of the last 14 days without the demo ones", async () => {
      await withStore(async ({ register, buyDemo, buyGoogle, server }) => {
        const one = await register("ledger_a");
        const two = await register("ledger_b");
        await buyDemo(one.token, "stars_mountain");
        await buyGoogle(one.token, "stars_chest", "pay-1");
        await buyGoogle(two.token, "stars_pouch", "pay-2");
        await buyGoogle(two.token, "stars_chest", "pay-3");

        const all = await server.container.store.purchases({ page: 1, pageSize: 10 });
        assert.equal(all.total, 4);
        assert.equal(all.entries.length, 4);
        assert.deepEqual(Object.keys(all.entries[0]).sort(), [
          "catalogId",
          "createdAt",
          "environment",
          "key",
          "priceUsd",
          "productId",
          "shards",
          "stars",
          "store",
          "userId",
        ]);
        assert.equal(all.entries.find(entry => entry.catalogId === "stars_mountain").environment, "Demo");
        assert.equal(all.entries.find(entry => entry.catalogId === "stars_mountain").priceUsd, 49.99);

        const mine = await server.container.store.purchases({ userId: two.profile.id, page: 1, pageSize: 10 });
        assert.equal(mine.total, 2);
        assert.ok(mine.entries.every(entry => entry.userId === two.profile.id));
        const paged = await server.container.store.purchases({ page: 2, pageSize: 3 });
        assert.equal(paged.total, 4);
        assert.equal(paged.entries.length, 1);

        const revenue = await server.container.store.revenue(14);
        assert.equal(revenue.days.length, 14);
        assert.equal(revenue.days[13], "2026-10-31");
        assert.equal(revenue.days[0], "2026-10-18");
        assert.equal(revenue.usd.length, 14);
        assert.equal(revenue.purchases.length, 14);
        assert.equal(revenue.usd[13], 10.97);
        assert.equal(revenue.purchases[13], 3);
        assert.equal(
          revenue.usd.slice(0, 13).reduce((sum, value) => sum + value, 0),
          0,
        );
        assert.equal((await server.container.store.revenue(3)).days.length, 3);
      });
    });
  });

  describe("without a store", () => {
    it("starts, lists nothing and refuses purchases", async () => {
      await withStore(
        async ({ call, register, buyDemo }) => {
          const listing = await call("");
          assert.deepEqual(listing.body, { demo: false, products: [] });
          const { token } = await register("nostore");
          const refused = await buyDemo(token, "stars_pouch");
          assert.equal(refused.status, 400);
          assert.equal(refused.body.code, "IAP_UNKNOWN_PRODUCT");
        },
        { store: EMPTY_STORE_CATALOG },
      );
    });
  });
});
