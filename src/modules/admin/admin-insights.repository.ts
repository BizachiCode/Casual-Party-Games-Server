import type { Database } from "../../infrastructure/database/database.js";

export interface AccountCounts {
  total: number;
  registered: number;
  guests: number;
  new24h: number;
  new7d: number;
  active24h: number;
  active7d: number;
  banned: number;
  muted: number;
}

export interface EconomyTotals {
  stars: number;
  shards: number;
  wallets: number;
}

/** One UTC day of play, keyed by the day's "YYYY-MM-DD" text. */
export interface PlayDay {
  day: string;
  players: number;
  matches: number;
  wins: number;
}

const DAY_MS = 86400000;
const asNumber = (value: unknown) => Number(value ?? 0);

/** Aggregates for the GM overview. */
export class AdminInsightsRepository {
  constructor(private readonly db: Database) {}

  /** Accounts by kind, age and last activity; `now` is in milliseconds. Bans and mutes count only active rows. */
  async accounts(now: number): Promise<AccountCounts> {
    const [row] = await this.db.query<Record<string, unknown>>(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(guest = 0), 0) AS registered,
         COALESCE(SUM(guest = 1), 0) AS guests,
         COALESCE(SUM(created_at > ?), 0) AS new24h,
         COALESCE(SUM(created_at > ?), 0) AS new7d,
         COALESCE(SUM(last_seen > ?), 0) AS active24h,
         COALESCE(SUM(last_seen > ?), 0) AS active7d,
         (SELECT COUNT(*) FROM bans WHERE until IS NULL OR until > ?) AS banned,
         (SELECT COUNT(*) FROM mutes WHERE until > ?) AS muted
       FROM users`,
      [now - DAY_MS, now - 7 * DAY_MS, now - DAY_MS, now - 7 * DAY_MS, now, now],
    );
    return {
      total: asNumber(row.total),
      registered: asNumber(row.registered),
      guests: asNumber(row.guests),
      new24h: asNumber(row.new24h),
      new7d: asNumber(row.new7d),
      active24h: asNumber(row.active24h),
      active7d: asNumber(row.active7d),
      banned: asNumber(row.banned),
      muted: asNumber(row.muted),
    };
  }

  async openReports(): Promise<number> {
    const [{ open }] = await this.db.query<{ open: number }>(
      "SELECT COUNT(*) AS open FROM reports WHERE status = 'open'",
    );
    return asNumber(open);
  }

  async economy(): Promise<EconomyTotals> {
    const [row] = await this.db.query<Record<string, unknown>>(
      "SELECT COALESCE(SUM(credits), 0) AS stars, COALESCE(SUM(shards), 0) AS shards, COUNT(*) AS wallets FROM wallets",
    );
    return { stars: asNumber(row.stars), shards: asNumber(row.shards), wallets: asNumber(row.wallets) };
  }

  async premiumOwners(seasonId: string): Promise<number> {
    const [{ owners }] = await this.db.query<{ owners: number }>(
      "SELECT COUNT(*) AS owners FROM season_premium WHERE season = ?",
      [seasonId],
    );
    return asNumber(owners);
  }

  /** Accounts created per UTC day since `sinceMs`, as day start (milliseconds) -> count. */
  async newAccountsByDay(sinceMs: number): Promise<Map<number, number>> {
    const rows = await this.db.query<{ dayStart: number; created: number }>(
      `SELECT FLOOR(created_at / ${DAY_MS}) * ${DAY_MS} AS dayStart, COUNT(*) AS created
       FROM users WHERE created_at >= ? GROUP BY dayStart`,
      [sinceMs],
    );
    return new Map(rows.map(row => [asNumber(row.dayStart), asNumber(row.created)]));
  }

  /** Distinct players, matches and wins per UTC day from `fromDay` ("YYYY-MM-DD") on. */
  async playDays(fromDay: string): Promise<PlayDay[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT \`day\` AS day, COUNT(DISTINCT user_id) AS players, COALESCE(SUM(matches), 0) AS matches,
         COALESCE(SUM(wins), 0) AS wins
       FROM daily_progress WHERE \`day\` >= ? GROUP BY \`day\``,
      [fromDay],
    );
    return rows.map(row => ({
      day: String(row.day),
      players: asNumber(row.players),
      matches: asNumber(row.matches),
      wins: asNumber(row.wins),
    }));
  }
}
