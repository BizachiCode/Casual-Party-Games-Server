import { randomUUID } from "node:crypto";
import type { Database } from "../../infrastructure/database/database.js";
import type { PlayerReport } from "../../infrastructure/database/entities/index.js";
import { ApiError, ensure } from "../../shared/errors.js";
import { cleanText } from "../../shared/text.js";
import type { ChatLine } from "./chat-log.js";
import type { ModerationRepository, PlayerRow, ResolvedReport } from "./moderation.repository.js";

export type PlayerRef = PlayerRow;

/** A ban (`until` null = permanent) or a mute (always ends). */
export interface Restriction {
  reason: string;
  until: number | null;
  createdAt: number;
  createdBy: string;
}
export interface RestrictionEntry extends Restriction {
  player: PlayerRef;
}

export type ReportAction = "none" | "warn" | "mute" | "kick" | "ban";
export const REPORT_REASONS = ["cheating", "abuse", "name", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface ReportRow {
  id: string;
  reporter: PlayerRef | null;
  target: PlayerRef | null;
  reason: string;
  details: string;
  roomId: string;
  createdAt: number;
  /** "open", "resolved" or "dismissed". */
  status: string;
  /** What the GM did when resolving: none, warn, mute, kick or ban; empty while open or dismissed. */
  resolution: string;
  note: string;
  handledBy: string;
  handledAt: number | null;
  evidenceCount: number;
  /** Open reports against the same target, this one included. */
  targetOpenReports: number;
}
export interface ReportDetail extends ReportRow {
  evidence: ChatLine[];
}

export interface ReportListQuery {
  /** "open", "resolved", "dismissed" or "all". */
  status: string;
  /** An account id or username; the reports about it. */
  target: string;
  /** An account id or username; the reports it filed. */
  reporter: string;
  page: number;
  pageSize: number;
}

export interface NewReport {
  reporterId: string;
  targetId: string;
  reason: ReportReason;
  details: string;
  roomId: string;
  evidence: ChatLine[];
}

export interface ReportHandling {
  action: ReportAction;
  note: string;
  operator: string;
  /** Close every open report about the same target too. */
  allForTarget?: boolean;
}

/** A mute is looked up for every chat message, so a result is reused this long. */
const MUTE_CACHE_MS = 15000;
const MUTE_CACHE_SIZE = 5000;
const REPORTS_PER_HOUR = 10;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/** "2026-11-01 12:00 UTC". */
const utcStamp = (time: number) => new Date(time).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** What a banned player is told when signing in. */
export function suspensionMessage(ban: Restriction): string {
  const reason = ban.reason ? " Reason: " + ban.reason : "";
  return (
    (ban.until === null ? "Account suspended permanently." : `Account suspended until ${utcStamp(ban.until)}.`) + reason
  );
}

/** What a muted player is told in the match chat: only the time when the mute ends today. */
export function muteNotice(mute: Restriction, now = Date.now()): string {
  const stamp = utcStamp(mute.until ?? now);
  const today = stamp.slice(0, 10) === utcStamp(now).slice(0, 10);
  return `Your chat is muted until ${today ? stamp.slice(11) : stamp}.`;
}

/** Bans (no sign-in), chat mutes and player reports. */
export class ModerationService {
  private readonly muteCache = new Map<string, { at: number; mute: Restriction | null }>();

  constructor(
    private readonly db: Database,
    private readonly records: ModerationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private get now(): number {
    return +this.clock();
  }

  /** The account as the console lists it, or null. */
  player(userId: string): Promise<PlayerRef | null> {
    return this.records.player(userId);
  }

  private async requirePlayer(userId: string): Promise<PlayerRef> {
    const player = await this.records.player(userId);
    if (!player) throw new ApiError(404, "Player not found.");
    return player;
  }

  async activeBan(userId: string): Promise<Restriction | null> {
    const ban = await this.records.activeBan(userId, this.now);
    return ban && restriction(ban);
  }

  /** Throws the 403 a suspended account gets instead of a session. */
  async assertNotBanned(userId: string): Promise<void> {
    const ban = await this.activeBan(userId);
    if (ban) throw new ApiError(403, suspensionMessage(ban));
  }

  /** The active mute, as of at most 15 seconds ago (changes made in this process show at once). */
  async activeMute(userId: string): Promise<Restriction | null> {
    const now = this.now;
    const cached = this.muteCache.get(userId);
    if (cached && now - cached.at < MUTE_CACHE_MS)
      return cached.mute && (cached.mute.until ?? 0) > now ? cached.mute : null;
    const row = await this.records.activeMute(userId, now);
    this.remember(userId, row && restriction(row), now);
    return row && restriction(row);
  }

  private remember(userId: string, mute: Restriction | null, now: number): void {
    if (this.muteCache.size >= MUTE_CACHE_SIZE) {
      for (const [id, entry] of this.muteCache) if (now - entry.at >= MUTE_CACHE_MS) this.muteCache.delete(id);
      if (this.muteCache.size >= MUTE_CACHE_SIZE) this.muteCache.clear();
    }
    this.muteCache.set(userId, { at: now, mute });
  }

  /** Suspends the account (`minutes` null = permanently); a second ban replaces the first. */
  async ban(userId: string, input: { reason: string; minutes: number | null; operator: string }): Promise<Restriction> {
    await this.requirePlayer(userId);
    const now = this.now;
    const row = {
      userId,
      reason: cleanText(input.reason).trim().slice(0, 280),
      until: input.minutes === null ? null : now + input.minutes * 60000,
      createdAt: now,
      createdBy: input.operator.slice(0, 64),
    };
    await this.records.saveBan(row);
    return restriction(row);
  }

  /** Lifts the ban; false when there was none (an expired one is removed too). */
  unban(userId: string): Promise<boolean> {
    return this.records.deleteBan(userId);
  }

  /** Silences the account's match chat for `minutes`. */
  async mute(userId: string, input: { reason: string; minutes: number; operator: string }): Promise<Restriction> {
    await this.requirePlayer(userId);
    const now = this.now;
    const row = {
      userId,
      reason: cleanText(input.reason).trim().slice(0, 280),
      until: now + input.minutes * 60000,
      createdAt: now,
      createdBy: input.operator.slice(0, 64),
    };
    await this.records.saveMute(row);
    this.muteCache.delete(userId);
    return restriction(row);
  }

  async unmute(userId: string): Promise<boolean> {
    this.muteCache.delete(userId);
    return this.records.deleteMute(userId);
  }

  bans(page: number, pageSize: number): Promise<{ total: number; entries: RestrictionEntry[] }> {
    return this.restrictions("bans", page, pageSize);
  }

  mutes(page: number, pageSize: number): Promise<{ total: number; entries: RestrictionEntry[] }> {
    return this.restrictions("mutes", page, pageSize);
  }

  private async restrictions(table: "bans" | "mutes", page: number, pageSize: number) {
    const { total, rows } = await this.records.restrictions(table, this.now, (page - 1) * pageSize, pageSize);
    return {
      total,
      entries: rows.map(row => ({
        ...restriction(row),
        player: { id: row.userId, username: row.username, displayName: row.displayName, guest: row.guest },
      })),
    };
  }

  /**
   * Files a report. An open report from the same reporter about the same target in the last day is returned instead
   * of a second one, and one reporter files at most ten an hour.
   */
  async fileReport(report: NewReport): Promise<{ reportId: string; duplicate: boolean }> {
    ensure(report.reporterId !== report.targetId, 400, "You cannot report yourself.");
    await this.requirePlayer(report.targetId);
    const now = this.now;
    const existing = await this.records.openReportSince(report.reporterId, report.targetId, now - DAY_MS);
    if (existing) return { reportId: existing.id, duplicate: true };
    ensure(
      (await this.records.countReportsBy(report.reporterId, now - HOUR_MS)) < REPORTS_PER_HOUR,
      429,
      "Too many reports. Retry later.",
    );
    const reportId = randomUUID();
    await this.records.insertReport({
      id: reportId,
      reporterId: report.reporterId,
      targetId: report.targetId,
      reason: report.reason,
      details: report.details.slice(0, 280),
      roomId: report.roomId.slice(0, 191),
      evidence: JSON.stringify(report.evidence),
      status: "open",
      resolution: "",
      note: "",
      handledBy: "",
      createdAt: now,
      handledAt: null,
    });
    return { reportId, duplicate: false };
  }

  openReports(): Promise<number> {
    return this.records.countOpenReports();
  }

  async reports(query: ReportListQuery): Promise<{ total: number; open: number; reports: ReportRow[] }> {
    const open = await this.records.countOpenReports();
    const targetId = query.target ? await this.records.findPlayerId(query.target) : "";
    const reporterId = query.reporter ? await this.records.findPlayerId(query.reporter) : "";
    // A filter that names nobody matches nothing.
    if (targetId === null || reporterId === null) return { total: 0, open, reports: [] };
    const { total, rows } = await this.records.listReports({
      status: query.status === "all" ? "" : query.status,
      targetId,
      reporterId,
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
    });
    return { total, open, reports: await this.rowsOf(rows) };
  }

  async report(id: string): Promise<ReportDetail> {
    const row = await this.records.report(id);
    if (!row) throw new ApiError(404, "Report not found.");
    const [report] = await this.rowsOf([row]);
    return { ...report, evidence: parseEvidence(row.evidence) };
  }

  private async rowsOf(rows: PlayerReport[]): Promise<ReportRow[]> {
    const players = await this.records.players(rows.flatMap(row => [row.reporterId, row.targetId]));
    const openCounts = await this.records.openReportCounts(rows.map(row => row.targetId));
    return rows.map(row => ({
      id: row.id,
      reporter: players.get(row.reporterId) ?? null,
      target: players.get(row.targetId) ?? null,
      reason: row.reason,
      details: row.details,
      roomId: row.roomId,
      createdAt: row.createdAt,
      status: row.status,
      resolution: row.resolution,
      note: row.note,
      handledBy: row.handledBy,
      handledAt: row.handledAt,
      evidenceCount: parseEvidence(row.evidence).length,
      targetOpenReports: openCounts.get(row.targetId) ?? 0,
    }));
  }

  /**
   * Marks the report resolved (with what was done about it) and, for `allForTarget`, every other open report about the
   * same target. Applying the action is the caller's job. Returns the target and how many reports were closed.
   */
  async resolve(id: string, handling: ReportHandling): Promise<{ targetId: string; resolved: number }> {
    const report = await this.openReport(id);
    const outcome = this.outcome("resolved", handling.action, handling);
    return this.db.transaction(async () => {
      ensure(await this.records.closeReport(id, outcome), 409, "This report was already handled.");
      const others = handling.allForTarget ? await this.records.closeReportsAbout(report.targetId, outcome) : 0;
      return { targetId: report.targetId, resolved: 1 + others };
    });
  }

  /** Closes the report without action. Returns the reported account. */
  async dismiss(id: string, handling: { note: string; operator: string }): Promise<{ targetId: string }> {
    const report = await this.openReport(id);
    const outcome = this.outcome("dismissed", "", { ...handling, action: "none" });
    ensure(await this.records.closeReport(id, outcome), 409, "This report was already handled.");
    return { targetId: report.targetId };
  }

  private async openReport(id: string): Promise<PlayerReport> {
    const report = await this.records.report(id);
    if (!report) throw new ApiError(404, "Report not found.");
    ensure(report.status === "open", 409, "This report was already handled.");
    return report;
  }

  private outcome(status: ResolvedReport["status"], resolution: string, handling: ReportHandling): ResolvedReport {
    return {
      status,
      resolution,
      note: cleanText(handling.note).trim().slice(0, 280),
      handledBy: handling.operator.slice(0, 64),
      handledAt: this.now,
    };
  }
}

function restriction(row: { reason: string; until: number | null; createdAt: number; createdBy: string }): Restriction {
  return { reason: row.reason, until: row.until, createdAt: row.createdAt, createdBy: row.createdBy };
}

function parseEvidence(text: string | null): ChatLine[] {
  if (!text) return [];
  try {
    const lines = JSON.parse(text);
    return Array.isArray(lines) ? lines : [];
  } catch {
    return [];
  }
}
