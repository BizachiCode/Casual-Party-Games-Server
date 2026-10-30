import type { StoreCatalog } from "../store.catalog.js";
import { iapError, iapTransactionKey, rejected } from "./iap.domain.js";
import { IapStore, type IapStoreVerifier, type IapVerifyInput, type VerifiedPurchase } from "./iap.ports.js";

const DEMO_TRANSACTION_ID = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Demo builds: grants the product without any payment. The transaction id is random per purchase and scoped to the
 * account, so a retry is idempotent and two players never collide.
 */
export class DemoVerifier implements IapStoreVerifier {
  readonly store = IapStore.Demo;

  constructor(private readonly enabled: (catalog: StoreCatalog) => boolean) {}

  claimedKey({ userId, receipt }: IapVerifyInput): string | null {
    return receipt.transactionId ? iapTransactionKey(this.store, `${userId}:${receipt.transactionId}`) : null;
  }

  async verify(input: IapVerifyInput): Promise<VerifiedPurchase> {
    if (!this.enabled(input.catalog)) throw iapError("IAP_DEMO_DISABLED");
    const transactionId = input.receipt.transactionId;
    if (!transactionId || !DEMO_TRANSACTION_ID.test(transactionId))
      throw rejected("demo transaction id missing or malformed");
    return {
      store: this.store,
      productId: input.product.productId,
      transactionKey: iapTransactionKey(this.store, `${input.userId}:${transactionId}`),
      orderId: transactionId,
      environment: "Demo",
    };
  }
}

/** Picks the verifier of the receipt's store and checks the product it confirmed. */
export class StoreReceiptValidator {
  private readonly stores = new Map<string, IapStoreVerifier>();

  /** @param serverAllowsDemo PARTY_IAP_DEMO_PURCHASES: demo receipts need it on top of the catalog's switch. */
  constructor(
    verifiers: IapStoreVerifier[],
    private readonly serverAllowsDemo: boolean,
  ) {
    for (const verifier of verifiers) this.register(verifier);
    if (!this.stores.has(IapStore.Demo)) this.register(new DemoVerifier(catalog => this.demoEnabled(catalog)));
  }

  /** Adds (or replaces) the verifier of one store. */
  register(verifier: IapStoreVerifier): this {
    this.stores.set(verifier.store, verifier);
    return this;
  }

  demoEnabled(catalog: StoreCatalog): boolean {
    return catalog.demoPurchases && this.serverAllowsDemo;
  }

  claimedKey(input: IapVerifyInput): string | null {
    return this.stores.get(input.receipt.store)?.claimedKey(input) ?? null;
  }

  async verify(input: IapVerifyInput): Promise<VerifiedPurchase> {
    const verifier = this.stores.get(input.receipt.store);
    if (!verifier) throw rejected(`unknown store "${input.receipt.store}"`);
    const verified = await verifier.verify(input);
    if (verified.productId !== input.product.productId) throw iapError("IAP_PRODUCT_MISMATCH", verified.productId);
    return verified;
  }
}
