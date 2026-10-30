import type { Database } from "../../infrastructure/database/database.js";
import { GmAction } from "../../infrastructure/database/entities/index.js";

export interface AuditRow {
  id: string;
  at: number;
  operator: string;
  address: string;
  action: string;
  targetId: string | null;
  targetName: string | null;
  targetUsername: string | null;
  requestId: string | null;
  details: string | null;
}

export interface AuditQuery {
  action?: string;
  targetId?: string;
  operator?: string;
  offset: number;
  limit: number;
}

/** The GM audit log (table gm_actions). */
export class AdminAuditRepository {
  constructor(private readonly db: Database) {}

  async insert(row: Omit<GmAction, "id">): Promise<void> {
    await this.db.repository(GmAction).insert(row);
  }

  /** Writes the row unless one with the same request id exists; returns whether it was written. */
  async insertOnce(row: Omit<GmAction, "id">): Promise<boolean> {
    const result = await this.db.manager.createQueryBuilder().insert().into(GmAction).values(row).orIgnore().execute();
    return result.raw.affectedRows > 0;
  }

  async list(query: AuditQuery): Promise<{ total: number; rows: AuditRow[] }> {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (query.action) {
      conditions.push("a.action = ?");
      parameters.push(query.action);
    }
    if (query.targetId) {
      conditions.push("a.target_id = ?");
      parameters.push(query.targetId);
    }
    if (query.operator) {
      conditions.push("a.operator = ?");
      parameters.push(query.operator);
    }
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const [{ total }] = await this.db.query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM gm_actions a" + where,
      parameters,
    );
    const rows = await this.db.query<AuditRow>(
      "SELECT CAST(a.id AS CHAR) AS id, a.at, a.operator, a.address, a.action, a.target_id AS targetId," +
        " u.display_name AS targetName, u.username AS targetUsername, a.request_id AS requestId, a.details" +
        " FROM gm_actions a LEFT JOIN users u ON u.id = a.target_id" +
        where +
        " ORDER BY a.at DESC, a.id DESC LIMIT ? OFFSET ?",
      [...parameters, query.limit, query.offset],
    );
    return { total: Number(total), rows: rows.map(row => ({ ...row, at: Number(row.at) })) };
  }

  async actions(): Promise<string[]> {
    const rows = await this.db.query<{ action: string }>("SELECT DISTINCT action FROM gm_actions ORDER BY action");
    return rows.map(row => row.action);
  }

  async operators(): Promise<string[]> {
    const rows = await this.db.query<{ operator: string }>(
      "SELECT DISTINCT operator FROM gm_actions ORDER BY operator",
    );
    return rows.map(row => row.operator);
  }
}
