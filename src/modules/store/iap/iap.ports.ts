import type { StoreCatalog, StoreProductDefinition } from "../store.catalog.js";

/** Stores handled out of the box. */
export const IapStore = {
  GooglePlay: "GooglePlay",
  AppleAppStore: "AppleAppStore",
  /** No payment: accepted only while demo purchases are on in the catalog and in the server settings. */
  Demo: "Demo",
} as const;

/** The receipt the client sends. Strings the client leaves out arrive as "" and count as absent. */
export interface IapReceipt {
  store: string;
  /** Apple: the transaction id. Demo: a random id per purchase. Google Play: optional (the order id). */
  transactionId?: string;
  /** Google Play purchase token. */
  purchaseToken?: string;
  /** Apple StoreKit 2 signed transaction (JWS). */
  signedTransaction?: string;
}

/** A purchase a store confirmed: ready to be delivered once. */
export interface VerifiedPurchase {
  store: string;
  productId: string;
  /** Unique id of the store transaction (see `iapTransactionKey`): delivered once across all accounts. */
  transactionKey: string;
  /** The store's order or transaction id, for support. */
  orderId: string;
  /** Production, Sandbox, Test (a Google license tester) or Demo. */
  environment: string;
  /** Runs after the grant is committed (Google Play acknowledges or consumes). Best effort. */
  afterGrant?: () => Promise<void>;
}

export interface IapVerifyInput {
  userId: string;
  product: StoreProductDefinition;
  receipt: IapReceipt;
  catalog: StoreCatalog;
}

/** One store. Throws an `IAP_*` ApiError when the receipt is not a valid, deliverable purchase. */
export interface IapStoreVerifier {
  readonly store: string;
  /** The key the receipt claims, without calling the store (null when it lacks the id). Used to answer a replay. */
  claimedKey(input: IapVerifyInput): string | null;
  verify(input: IapVerifyInput): Promise<VerifiedPurchase>;
}
