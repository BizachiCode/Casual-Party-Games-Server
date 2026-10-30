import { In } from "typeorm";
import type { Database } from "../../infrastructure/database/database.js";
import { IapTransaction } from "../../infrastructure/database/entities/index.js";

export interface PurchaseListQuery {
  userId?: string;
  offset: number;
  limit: number;
}

/** Revenue of one UTC day: `dayStart` in milliseconds. */
export interface RevenueDay {
  dayStart: number;
  usd: number;
  purchases: number;
}

const DAY_MS = 86400000;

/** Delivered store transactions (table iap_transactions). */
export class StoreRepository {
  constructor(private readonly db: Database) {}

  find(transactionKey: string): Promise<IapTransaction | null> {
    return this.db.repository(IapTransaction).findOneBy({ transactionKey });
  }

  /** Records the transaction unless its key exists; returns whether this call wrote it. */
  async insert(row: IapTransaction): Promise<boolean> {
    const result = await this.db.manager
      .createQueryBuilder()
      .insert()
      .into(IapTransaction)
      .values(row)
      .orIgnore()
      .execute();
    return result.raw.affectedRows > 0;
  }

  /** The catalog ids among `catalogIds` the account bought (any environment, demo included). */
  async boughtCatalogIds(userId: string, catalogIds: string[]): Promise<string[]> {
    if (!catalogIds.length) return [];
    const rows = await this.db
      .repository(IapTransaction)
      .find({ where: { userId, catalogId: In(catalogIds) }, select: { catalogId: true } });
    return [...new Set(rows.map(row => row.catalogId))];
  }

  async list(query: PurchaseListQuery): Promise<{ total: number; rows: IapTransaction[] }> {
    const where = query.userId ? { userId: query.userId } : {};
    const [rows, total] = await this.db.repository(IapTransaction).findAndCount({
      where,
      order: { createdAt: "DESC", transactionKey: "DESC" },
      skip: query.offset,
      take: query.limit,
    });
    return { total, rows };
  }

  /** Dollars and purchases per UTC day since `sinceMs`, real money only (demo purchases are left out). */
  async revenueByDay(sinceMs: number): Promise<RevenueDay[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT FLOOR(created_at / ${DAY_MS}) * ${DAY_MS} AS dayStart, SUM(price_usd) AS usd, COUNT(*) AS purchases
       FROM iap_transactions WHERE created_at >= ? AND environment <> 'Demo' GROUP BY dayStart`,
      [sinceMs],
    );
    return rows.map(row => ({
      dayStart: Number(row.dayStart),
      usd: Number(row.usd),
      purchases: Number(row.purchases),
    }));
  }
}
