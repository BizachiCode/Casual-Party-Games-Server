import { Table, TableIndex, type MigrationInterface, type QueryRunner } from "typeorm";

// In-app purchases: every store transaction that was delivered. There is no foreign key on purpose, the rows outlive
// the account they were delivered to.
export class StorePurchases1792886400006 implements MigrationInterface {
  name = "StorePurchases1792886400006";
  async up(runner: QueryRunner): Promise<void> {
    await runner.createTable(
      new Table({
        name: "iap_transactions",
        columns: [
          { name: "transaction_key", type: "char", length: "64", isPrimary: true, isNullable: false },
          { name: "store", type: "varchar", length: "16", isNullable: false },
          { name: "user_id", type: "varchar", length: "64", isNullable: false },
          { name: "product_id", type: "varchar", length: "150", isNullable: false },
          { name: "catalog_id", type: "varchar", length: "40", isNullable: false },
          { name: "order_id", type: "varchar", length: "191", isNullable: false, default: "''" },
          { name: "environment", type: "varchar", length: "16", isNullable: false },
          { name: "stars", type: "int", isNullable: false },
          { name: "shards", type: "int", isNullable: false },
          { name: "price_usd", type: "decimal", precision: 8, scale: 2, isNullable: false },
          { name: "created_at", type: "bigint", isNullable: false },
        ],
        engine: "InnoDB",
      }),
      true,
    );
    await runner.createIndex(
      "iap_transactions",
      new TableIndex({ name: "IDX_iap_transactions_user", columnNames: ["user_id", "created_at"] }),
    );
    await runner.createIndex(
      "iap_transactions",
      new TableIndex({ name: "IDX_iap_transactions_created", columnNames: ["created_at"] }),
    );
  }
  async down(): Promise<void> {
    throw new Error("Destructive rollback is disabled. Restore a verified MySQL backup deliberately.");
  }
}
