import type { Database } from "../../infrastructure/database/database.js";
import type { IapTransaction } from "../../infrastructure/database/entities/index.js";
import type { CollectionRepository } from "../collection/collection.repository.js";
import type { CollectionService, CollectionState } from "../collection/collection.service.js";
import { iapAccountToken, iapError } from "./iap/iap.domain.js";
import type { IapReceipt } from "./iap/iap.ports.js";
import type { StoreReceiptValidator } from "./iap/iap-receipt-validator.js";
import type { StoreCatalog, StoreProductDefinition } from "./store.catalog.js";
import type { StoreRepository } from "./store.repository.js";

const DAY_MS = 86400000;

/** GET /api/store. */
export interface StoreListing {
  /** Purchases without payment are accepted (the catalog and the server both allow them). */
  demo: boolean;
  products: StoreProductDefinition[];
  /** Only for a signed-in player: the ids of the once-per-account products already bought. */
  owned?: string[];
}

/** GET /api/store/check. */
export interface StoreCheck {
  ok: true;
  productId: string;
  demo: boolean;
  /** Pass it to the store with the purchase (Apple appAccountToken, Google obfuscated account id). */
  accountToken: string;
}

/** POST /api/store/purchase. */
export interface PurchaseResult {
  ok: true;
  /** The receipt was delivered before: nothing was granted again, `stars` and `shards` repeat the first grant. */
  duplicate: boolean;
  productId: string;
  /** Stars granted, bonus included. */
  stars: number;
  shards: number;
  environment: string;
  state: CollectionState;
}

/** One delivered purchase, for the GM console. */
export interface PurchaseEntry {
  key: string;
  store: string;
  environment: string;
  userId: string;
  productId: string;
  catalogId: string;
  stars: number;
  shards: number;
  priceUsd: number;
  createdAt: number;
}

/** Real-money Stars packs: the catalog, the receipt check and the one-time delivery. */
export class StoreService {
  constructor(
    private readonly db: Database,
    private readonly records: StoreRepository,
    private readonly collection: CollectionService,
    private readonly collectionRecords: CollectionRepository,
    private readonly validator: StoreReceiptValidator,
    readonly catalog: StoreCatalog,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Demo purchases are accepted right now. */
  get demo(): boolean {
    return this.validator.demoEnabled(this.catalog);
  }

  /** The product the client means: the store SKU, or the catalog id. */
  private product(productId: string): StoreProductDefinition {
    const product = this.catalog.products.find(
      candidate => candidate.productId === productId || candidate.id === productId,
    );
    if (!product) throw iapError("IAP_UNKNOWN_PRODUCT", `"${productId}" is not in the catalog`);
    return product;
  }

  private onceProducts(): StoreProductDefinition[] {
    return this.catalog.products.filter(product => product.oncePerAccount);
  }

  async listing(userId?: string): Promise<StoreListing> {
    const listing: StoreListing = { demo: this.demo, products: this.catalog.products };
    if (userId)
      listing.owned = await this.records.boughtCatalogIds(
        userId,
        this.onceProducts().map(product => product.id),
      );
    return listing;
  }

  /** Everything a purchase checks before any money moves: the product exists and is not owned already. */
  async check(userId: string, productId: string): Promise<StoreCheck> {
    const product = this.product(productId);
    if (product.oncePerAccount && (await this.records.boughtCatalogIds(userId, [product.id])).length)
      throw iapError("IAP_ALREADY_OWNED");
    return { ok: true, productId: product.productId, demo: this.demo, accountToken: iapAccountToken(userId) };
  }

  private async answer(userId: string, row: IapTransaction, duplicate: boolean): Promise<PurchaseResult> {
    return {
      ok: true,
      duplicate,
      productId: row.productId,
      stars: row.stars,
      shards: row.shards,
      environment: row.environment,
      state: await this.collection.state(userId),
    };
  }

  /** A delivery that exists already: the same account gets the first answer back, any other account is refused. */
  private replay(userId: string, existing: IapTransaction, product: StoreProductDefinition): IapTransaction {
    if (existing.userId !== userId) throw iapError("IAP_RECEIPT_USED", "delivered to another account");
    if (existing.productId !== product.productId) throw iapError("IAP_PRODUCT_MISMATCH", existing.productId);
    return existing;
  }

  /**
   * Delivers a purchase once. The receipt is checked with the store before the database transaction (it is a network
   * call); inside it the account is locked, the transaction is recorded under its key and the Stars and shards are
   * granted, so a retry or a second device finds the first delivery and grants nothing.
   */
  async purchase(userId: string, productId: string, receipt: IapReceipt): Promise<PurchaseResult> {
    const product = this.product(productId);
    const input = { userId, product, receipt, catalog: this.catalog };
    const claimed = this.validator.claimedKey(input);
    if (claimed) {
      const earlier = await this.records.find(claimed);
      if (earlier) return this.answer(userId, this.replay(userId, earlier, product), true);
    }
    // Cheap refusal before the store is called; the transaction below checks again under the account lock.
    if (product.oncePerAccount && (await this.records.boughtCatalogIds(userId, [product.id])).length)
      throw iapError("IAP_ALREADY_OWNED");
    const verified = await this.validator.verify(input);
    const delivered = await this.db.transaction(async () => {
      await this.db.lockUsers([userId]);
      const earlier = await this.records.find(verified.transactionKey);
      if (earlier) return { row: this.replay(userId, earlier, product), duplicate: true };
      if (product.oncePerAccount && (await this.records.boughtCatalogIds(userId, [product.id])).length)
        throw iapError("IAP_ALREADY_OWNED");
      const row: IapTransaction = {
        transactionKey: verified.transactionKey,
        store: verified.store,
        userId,
        productId: product.productId,
        catalogId: product.id,
        orderId: verified.orderId.slice(0, 191),
        environment: verified.environment,
        stars: product.stars + product.bonusStars,
        shards: product.shards,
        priceUsd: product.priceUsd,
        createdAt: +this.clock(),
      };
      if (!(await this.records.insert(row))) {
        const raced = await this.records.find(verified.transactionKey);
        return { row: this.replay(userId, raced, product), duplicate: true };
      }
      await this.collection.init(userId);
      await this.collection.reward(userId, "iap:" + verified.transactionKey, row.stars);
      if (row.shards > 0) await this.collectionRecords.addShards(userId, row.shards);
      return { row, duplicate: false };
    });
    if (!delivered.duplicate && verified.afterGrant) {
      // The grant is committed and stays, whatever the store says now.
      await verified
        .afterGrant()
        .catch(error => console.warn("[store] after-grant step failed:", (error as Error).message));
    }
    return this.answer(userId, delivered.row, delivered.duplicate);
  }

  /** Delivered purchases, newest first, of one account or of everybody. */
  async purchases(query: {
    userId?: string;
    page: number;
    pageSize: number;
  }): Promise<{ total: number; entries: PurchaseEntry[] }> {
    const { total, rows } = await this.records.list({
      userId: query.userId,
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
    });
    return {
      total,
      entries: rows.map(row => ({
        key: row.transactionKey,
        store: row.store,
        environment: row.environment,
        userId: row.userId,
        productId: row.productId,
        catalogId: row.catalogId,
        stars: row.stars,
        shards: row.shards,
        priceUsd: row.priceUsd,
        createdAt: row.createdAt,
      })),
    };
  }

  /** Dollars and purchases of the last `days` UTC days (today last), demo purchases left out. */
  async revenue(days = 14): Promise<{ days: string[]; usd: number[]; purchases: number[] }> {
    const today = Math.floor(+this.clock() / DAY_MS) * DAY_MS;
    const starts = Array.from({ length: days }, (_, i) => today - (days - 1 - i) * DAY_MS);
    const byDay = new Map((await this.records.revenueByDay(starts[0])).map(entry => [entry.dayStart, entry]));
    return {
      days: starts.map(start => new Date(start).toISOString().slice(0, 10)),
      usd: starts.map(start => Math.round((byDay.get(start)?.usd ?? 0) * 100) / 100),
      purchases: starts.map(start => byDay.get(start)?.purchases ?? 0),
    };
  }
}
