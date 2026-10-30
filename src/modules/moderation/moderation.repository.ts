import { In, IsNull, MoreThan } from "typeorm";
import type { Database } from "../../infrastructure/database/database.js";
import { Ban, Mute, PlayerReport, User } from "../../infrastructure/database/entities/index.js";

export interface PlayerRow {
  id: string;
  username: string;
  displayName: string;
  guest: boolean;
}

/** A ban or a mute with the account it belongs to. */
export interface RestrictionRow {
  userId: string;
  reason: string;
  until: number | null;
  createdAt: number;
  createdBy: string;
  username: string;
  displayName: string;
  guest: boolean;
}

export interface ReportQuery {
  /** "open", "resolved" or "dismissed"; every report when empty. */
  status: string;
  targetId: string;
  reporterId: string;
  offset: number;
  limit: number;
}

export interface ResolvedReport {
  status: "resolved" | "dismissed";
  resolution: string;
  note: string;
  handledBy: string;
  handledAt: number;
}

/** Bans, mutes and player reports (tables bans, mutes, reports). */
export class ModerationRepository {
  constructor(private readonly db: Database) {}

  private get bans() {
    return this.db.repository(Ban);
  }
  private get mutes() {
    return this.db.repository(Mute);
  }
  private get reports() {
    return this.db.repository(PlayerReport);
  }

  async player(id: string): Promise<PlayerRow | null> {
    return this.db.repository(User).findOne({
      where: { id },
      select: { id: true, username: true, displayName: true, guest: true },
    });
  }
  async players(ids: string[]): Promise<Map<string, PlayerRow>> {
    if (!ids.length) return new Map();
    const rows = await this.db.repository(User).find({
      where: { id: In([...new Set(ids)]) },
      select: { id: true, username: true, displayName: true, guest: true },
    });
    return new Map(rows.map(row => [row.id, row]));
  }
  /** The account whose id or (lower-cased) username is `text`, or null. */
  async findPlayerId(text: string): Promise<string | null> {
    const byId = await this.db.repository(User).findOne({ where: { id: text }, select: { id: true } });
    if (byId) return byId.id;
    const byName = await this.db
      .repository(User)
      .findOne({ where: { username: text.toLowerCase() }, select: { id: true } });
    return byName?.id ?? null;
  }

  activeBan(userId: string, now: number): Promise<Ban | null> {
    return this.bans.findOne({
      where: [
        { userId, until: IsNull() },
        { userId, until: MoreThan(now) },
      ],
    });
  }
  async saveBan(ban: Ban): Promise<void> {
    await this.bans.upsert(ban, ["userId"]);
  }
  async deleteBan(userId: string): Promise<boolean> {
    return !!(await this.bans.delete({ userId })).affected;
  }

  activeMute(userId: string, now: number): Promise<Mute | null> {
    return this.mutes.findOneBy({ userId, until: MoreThan(now) });
  }
  async saveMute(mute: Mute): Promise<void> {
    await this.mutes.upsert(mute, ["userId"]);
  }
  async deleteMute(userId: string): Promise<boolean> {
    return !!(await this.mutes.delete({ userId })).affected;
  }

  /** Active bans (or mutes), newest first, with the account of each. */
  async restrictions(
    table: "bans" | "mutes",
    now: number,
    offset: number,
    limit: number,
  ): Promise<{ total: number; rows: RestrictionRow[] }> {
    const active = table === "bans" ? "r.until IS NULL OR r.until > ?" : "r.until > ?";
    const [{ total }] = await this.db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${table} r WHERE ${active}`,
      [now],
    );
    const rows = await this.db.query<RestrictionRow>(
      "SELECT r.user_id AS userId, r.reason, r.until, r.created_at AS createdAt, r.created_by AS createdBy," +
        " u.username, u.display_name AS displayName, u.guest" +
        ` FROM ${table} r JOIN users u ON u.id = r.user_id WHERE ${active}` +
        " ORDER BY r.created_at DESC, r.user_id LIMIT ? OFFSET ?",
      [now, limit, offset],
    );
    return {
      total: Number(total),
      rows: rows.map(row => ({
        ...row,
        until: row.until === null ? null : Number(row.until),
        createdAt: Number(row.createdAt),
        guest: !!row.guest,
      })),
    };
  }

  async insertReport(report: PlayerReport): Promise<void> {
    await this.reports.insert(report);
  }
  report(id: string): Promise<PlayerReport | null> {
    return this.reports.findOneBy({ id });
  }
  /** The open report `reporterId` filed about `targetId` since `since`, if any. */
  openReportSince(reporterId: string, targetId: string, since: number): Promise<PlayerReport | null> {
    return this.reports
      .createQueryBuilder("report")
      .where(
        "report.reporter_id = :reporterId AND report.target_id = :targetId" +
          " AND report.status = 'open' AND report.created_at > :since",
        { reporterId, targetId, since },
      )
      .orderBy("report.created_at", "DESC")
      .getOne();
  }
  countReportsBy(reporterId: string, since: number): Promise<number> {
    return this.reports
      .createQueryBuilder("report")
      .where("report.reporter_id = :reporterId AND report.created_at > :since", { reporterId, since })
      .getCount();
  }
  countOpenReports(): Promise<number> {
    return this.reports.countBy({ status: "open" });
  }
  async listReports(query: ReportQuery): Promise<{ total: number; rows: PlayerReport[] }> {
    const builder = this.reports.createQueryBuilder("report").where("1 = 1");
    if (query.status) builder.andWhere("report.status = :status", { status: query.status });
    if (query.targetId) builder.andWhere("report.target_id = :targetId", { targetId: query.targetId });
    if (query.reporterId) builder.andWhere("report.reporter_id = :reporterId", { reporterId: query.reporterId });
    const total = await builder.getCount();
    const rows = await builder
      .orderBy("report.created_at", "DESC")
      .addOrderBy("report.id", "DESC")
      .offset(query.offset)
      .limit(query.limit)
      .getMany();
    return { total, rows };
  }
  /** Open reports per target, for these targets. */
  async openReportCounts(targetIds: string[]): Promise<Map<string, number>> {
    if (!targetIds.length) return new Map();
    const rows = await this.reports
      .createQueryBuilder("report")
      .select("report.target_id", "targetId")
      .addSelect("COUNT(*)", "open")
      .where("report.status = 'open' AND report.target_id IN (:...targetIds)", { targetIds: [...new Set(targetIds)] })
      .groupBy("report.target_id")
      .getRawMany<{ targetId: string; open: string }>();
    return new Map(rows.map(row => [row.targetId, Number(row.open)]));
  }
  /** Closes the report if it is still open; false when somebody else did first. */
  async closeReport(id: string, outcome: ResolvedReport): Promise<boolean> {
    return !!(await this.reports.update({ id, status: "open" }, outcome)).affected;
  }
  /** Closes every open report about the target; returns how many. */
  async closeReportsAbout(targetId: string, outcome: ResolvedReport): Promise<number> {
    return (await this.reports.update({ targetId, status: "open" }, outcome)).affected ?? 0;
  }
}
