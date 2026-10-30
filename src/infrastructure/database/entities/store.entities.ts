import { Column, Entity, Index, PrimaryColumn } from "typeorm";
import { bigintNumber } from "./transformers.js";

/** A decimal column read as a number (some drivers send DECIMAL as text). */
const decimalNumber = {
  to: (value: number) => value,
  from: (value: string | number) => Number(value),
};

/**
 * A store transaction that was delivered, once across all accounts. The key is a SHA-256 of the store and its
 * transaction id, so the row outlives the account (no foreign key): a signed receipt stays valid forever and could
 * otherwise be replayed on a new account. Demo purchases are keyed per account and flagged by `environment`.
 */
@Entity({ name: "iap_transactions" })
@Index("IDX_iap_transactions_user", ["userId", "createdAt"])
@Index("IDX_iap_transactions_created", ["createdAt"])
export class IapTransaction {
  @PrimaryColumn({ type: "char", length: 64, name: "transaction_key" })
  transactionKey: string;
  @Column({ type: "varchar", length: 16 })
  store: string;
  @Column({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @Column({ type: "varchar", length: 150, name: "product_id" })
  productId: string;
  @Column({ type: "varchar", length: 40, name: "catalog_id" })
  catalogId: string;
  @Column({ type: "varchar", length: 191, name: "order_id", default: "" })
  orderId: string;
  /** Production, Sandbox, Test (a Google license tester) or Demo. */
  @Column({ type: "varchar", length: 16 })
  environment: string;
  /** Stars granted, bonus included. */
  @Column({ type: "int" })
  stars: number;
  @Column({ type: "int" })
  shards: number;
  @Column({ type: "decimal", precision: 8, scale: 2, name: "price_usd", transformer: decimalNumber })
  priceUsd: number;
  @Column({ type: "bigint", transformer: bigintNumber, name: "created_at" })
  createdAt: number;
}
