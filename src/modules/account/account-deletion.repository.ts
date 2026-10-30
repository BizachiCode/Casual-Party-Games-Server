import type { Database } from "../../infrastructure/database/database.js";

/** Tables that outlive the account: purchase receipts (replay protection) and the audit log (no foreign key). */
export const KEPT_TABLES = ["iap_transactions", "gm_actions"];
/** Tables without any account column (content and season definitions). */
export const UNRELATED_TABLES = ["season_definitions", "content_identities"];
/** The names columns use for an account id. A new table with a differently named column has to be added here. */
export const ACCOUNT_COLUMNS = [
  "user_id",
  "owner",
  "target",
  "sender",
  "recipient",
  "low",
  "high",
  "reporter_id",
  "target_id",
];

export interface AccountReference {
  table: string;
  columns: string[];
}

/**
 * Removes an account and everything that belongs to it. The tables come from the entity metadata: every table with an
 * account column is cleaned, so a new entity that follows the naming is covered without a change here, and
 * unclassifiedTables() (checked by a test) names the tables that neither follow it nor were declared above.
 */
export class AccountDeletionRepository {
  constructor(private readonly db: Database) {}

  private get entityTables(): { table: string; columns: string[] }[] {
    return this.db.source.entityMetadatas.map(metadata => ({
      table: metadata.tableName,
      columns: metadata.columns.map(column => column.databaseName),
    }));
  }

  /** Every table (but users) with a column that references an account, and those columns. */
  references(): AccountReference[] {
    return this.entityTables
      .filter(entity => entity.table !== "users" && !KEPT_TABLES.includes(entity.table))
      .map(entity => ({ table: entity.table, columns: entity.columns.filter(name => ACCOUNT_COLUMNS.includes(name)) }))
      .filter(reference => reference.columns.length > 0);
  }

  /** Entity tables that are not users, not kept, not declared unrelated and have no known account column. */
  unclassifiedTables(): string[] {
    const handled = new Set(this.references().map(reference => reference.table));
    return this.entityTables
      .map(entity => entity.table)
      .filter(
        table => table !== "users" && ![...KEPT_TABLES, ...UNRELATED_TABLES].includes(table) && !handled.has(table),
      );
  }

  /** Deletes every row that names the account, then the account. Call inside a transaction. */
  async deleteAccount(id: string): Promise<void> {
    for (const { table, columns } of this.references()) {
      const condition = columns.map(column => `\`${column}\` = ?`).join(" OR ");
      await this.db.query(
        `DELETE FROM \`${table}\` WHERE ${condition}`,
        columns.map(() => id),
      );
    }
    await this.db.query("DELETE FROM `users` WHERE `id` = ?", [id]);
  }
}
