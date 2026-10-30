import { MoreThan } from "typeorm";
import type { Database } from "../../infrastructure/database/database.js";
import {
  DeviceLogin,
  Ranking,
  SeasonPremium,
  Session,
  TimeTrialRecord,
  User,
} from "../../infrastructure/database/entities/index.js";
import { nameKey } from "../../shared/text.js";

/** Who a player is, as the console lists them. */
export interface PlayerRef {
  id: string;
  username: string;
  displayName: string;
  guest: boolean;
}

/** An active ban or mute. */
export interface RestrictionRow {
  reason: string;
  until: number | null;
  createdAt: number;
  createdBy: string;
}

export type PlayerFilter = "all" | "registered" | "guest" | "banned" | "muted" | "online" | "new";
export type PlayerSort = "lastSeen" | "createdAt" | "xp" | "wins" | "matches" | "stars" | "name";

export interface PlayerListQuery {
  text: string;
  filter: PlayerFilter;
  sort: PlayerSort;
  descending: boolean;
  /** Accounts presence says are online (the `online` filter). */
  onlineIds: string[];
  /** Moments in milliseconds: now, and the start of the "new" window. */
  now: number;
  newSince: number;
  offset: number;
  limit: number;
}

export interface PlayerListRow extends PlayerRef {
  xp: number;
  wins: number;
  matches: number;
  stars: number;
  shards: number;
  createdAt: number;
  lastSeen: number;
  ban: { reason: string; until: number | null } | null;
  mute: { reason: string; until: number | null } | null;
}

export interface PlayerAccount extends PlayerRef {
  color: number;
  xp: number;
  wins: number;
  matches: number;
  createdAt: number;
  lastSeen: number;
}

export interface DeviceRow {
  deviceId: string;
  createdAt: number;
}
export interface RankingRow {
  mode: string;
  season: string;
  wins: number;
  matches: number;
  points: number;
}
export interface TimeRow {
  courseId: string;
  seconds: number;
}
export interface SocialCounts {
  friends: number;
  blocking: number;
  blockedBy: number;
  incoming: number;
  outgoing: number;
}
export interface ModerationRecord {
  ban: RestrictionRow | null;
  mute: RestrictionRow | null;
  reportsAgainst: { open: number; total: number };
  reportsFiled: number;
}
export interface LedgerRow {
  source: string;
  amount: number;
}

/** Columns the list can be sorted by (fixed SQL, never client text). */
const SORT_COLUMNS: Record<PlayerSort, string> = {
  lastSeen: "u.last_seen",
  createdAt: "u.created_at",
  xp: "u.xp",
  wins: "u.wins",
  matches: "u.matches",
  stars: "COALESCE(w.credits, 0)",
  name: "u.display_name",
};

/** The text as a LIKE pattern fragment: `%`, `_` and `\` match themselves. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

const asNumber = (value: unknown) => Number(value ?? 0);
const asRef = (row: PlayerRef): PlayerRef => ({
  id: row.id,
  username: row.username,
  displayName: row.displayName,
  guest: !!row.guest,
});

/** GM queries over accounts, wallets, characters, rankings and moderation tables. */
export class AdminPlayersRepository {
  constructor(private readonly db: Database) {}

  /** WHERE fragment and parameters of a search text: exact id, username prefix or display name containing it. */
  private match(text: string) {
    const lowered = text.toLowerCase();
    return {
      sql: "(u.id = ? OR u.username LIKE ? OR LOWER(u.display_name) LIKE ?)",
      parameters: [text, escapeLike(lowered) + "%", "%" + escapeLike(lowered) + "%"],
    };
  }

  /** Best matches first: the exact id, then usernames, then display names. */
  async search(text: string, limit: number): Promise<PlayerRef[]> {
    const match = this.match(text);
    const prefix = escapeLike(text.toLowerCase()) + "%";
    const rows = await this.db.query<PlayerRef>(
      `SELECT u.id, u.username, u.display_name AS displayName, u.guest
       FROM users u WHERE ${match.sql}
       ORDER BY CASE WHEN u.id = ? THEN 0 WHEN u.username LIKE ? THEN 1 ELSE 2 END, u.username, u.id
       LIMIT ?`,
      [...match.parameters, text, prefix, limit],
    );
    return rows.map(asRef);
  }

  async list(query: PlayerListQuery): Promise<{ total: number; rows: PlayerListRow[] }> {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (query.text) {
      const match = this.match(query.text);
      conditions.push(match.sql);
      parameters.push(...match.parameters);
    }
    switch (query.filter) {
      case "registered":
        conditions.push("u.guest = 0");
        break;
      case "guest":
        conditions.push("u.guest = 1");
        break;
      case "banned":
        conditions.push("b.user_id IS NOT NULL");
        break;
      case "muted":
        conditions.push("m.user_id IS NOT NULL");
        break;
      case "new":
        conditions.push("u.created_at > ?");
        parameters.push(query.newSince);
        break;
      case "online":
        conditions.push(
          query.onlineIds.length ? "u.id IN (" + query.onlineIds.map(() => "?").join(",") + ")" : "1 = 0",
        );
        parameters.push(...query.onlineIds);
        break;
      default:
        break;
    }
    const source =
      ` FROM users u LEFT JOIN wallets w ON w.user_id = u.id` +
      ` LEFT JOIN bans b ON b.user_id = u.id AND (b.until IS NULL OR b.until > ?)` +
      ` LEFT JOIN mutes m ON m.user_id = u.id AND m.until > ?` +
      (conditions.length ? " WHERE " + conditions.join(" AND ") : "");
    const joined = [query.now, query.now, ...parameters];
    const [{ total }] = await this.db.query<{ total: number }>("SELECT COUNT(*) AS total" + source, joined);
    const direction = query.descending ? "DESC" : "ASC";
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT u.id, u.username, u.display_name AS displayName, u.guest, u.xp, u.wins, u.matches,
         COALESCE(w.credits, 0) AS stars, COALESCE(w.shards, 0) AS shards, u.created_at AS createdAt,
         u.last_seen AS lastSeen, b.user_id IS NOT NULL AS banned, b.reason AS banReason, b.until AS banUntil,
         m.user_id IS NOT NULL AS muted, m.reason AS muteReason, m.until AS muteUntil` +
        source +
        ` ORDER BY ${SORT_COLUMNS[query.sort]} ${direction}, u.id ${direction} LIMIT ? OFFSET ?`,
      [...joined, query.limit, query.offset],
    );
    return {
      total: asNumber(total),
      rows: rows.map(row => ({
        ...asRef(row as unknown as PlayerRef),
        xp: asNumber(row.xp),
        wins: asNumber(row.wins),
        matches: asNumber(row.matches),
        stars: asNumber(row.stars),
        shards: asNumber(row.shards),
        createdAt: asNumber(row.createdAt),
        lastSeen: asNumber(row.lastSeen),
        ban: row.banned ? { reason: String(row.banReason), until: row.banUntil === null ? null : +row.banUntil } : null,
        mute: row.muted
          ? { reason: String(row.muteReason), until: row.muteUntil === null ? null : +row.muteUntil }
          : null,
      })),
    };
  }

  /** The account, or null. Never selects the salt or the password digest. */
  async account(id: string): Promise<PlayerAccount | null> {
    const user = await this.db.repository(User).findOne({
      where: { id },
      select: {
        id: true,
        username: true,
        displayName: true,
        guest: true,
        color: true,
        xp: true,
        wins: true,
        matches: true,
        createdAt: true,
        lastSeen: true,
      },
    });
    return user ? { ...user, guest: !!user.guest } : null;
  }

  /** The account for an id or, failing that, a username (any case). */
  async resolveTarget(text: string): Promise<PlayerRef | null> {
    const rows = await this.db.query<PlayerRef>(
      `SELECT id, username, display_name AS displayName, guest FROM users WHERE id = ? OR username = ?
       ORDER BY id = ? DESC LIMIT 1`,
      [text, text.toLowerCase(), text],
    );
    return rows.length ? asRef(rows[0]) : null;
  }

  async liveSessions(id: string, now: number): Promise<number> {
    return this.db.repository(Session).countBy({ userId: id, expires: MoreThan(now) });
  }

  async devices(id: string): Promise<DeviceRow[]> {
    const rows = await this.db.repository(DeviceLogin).find({ where: { userId: id }, order: { createdAt: "ASC" } });
    return rows.map(row => ({ deviceId: row.deviceId, createdAt: row.createdAt }));
  }

  async rankings(id: string): Promise<RankingRow[]> {
    const rows = await this.db
      .repository(Ranking)
      .find({ where: { userId: id }, order: { season: "DESC", mode: "ASC" } });
    return rows.map(row => ({
      mode: row.mode,
      season: row.season,
      wins: row.wins ?? 0,
      matches: row.matches ?? 0,
      points: row.points ?? 0,
    }));
  }

  async times(id: string): Promise<TimeRow[]> {
    const rows = await this.db.repository(TimeTrialRecord).find({ where: { userId: id }, order: { courseId: "ASC" } });
    return rows.map(row => ({ courseId: row.courseId, seconds: row.seconds ?? 0 }));
  }

  async social(id: string): Promise<SocialCounts> {
    const [row] = await this.db.query<Record<string, unknown>>(
      `SELECT
         (SELECT COUNT(*) FROM friends WHERE low = ? OR high = ?) AS friends,
         (SELECT COUNT(*) FROM blocks WHERE owner = ?) AS blocking,
         (SELECT COUNT(*) FROM blocks WHERE target = ?) AS blockedBy,
         (SELECT COUNT(*) FROM requests WHERE recipient = ?) AS incoming,
         (SELECT COUNT(*) FROM requests WHERE sender = ?) AS outgoing`,
      [id, id, id, id, id, id],
    );
    return {
      friends: asNumber(row.friends),
      blocking: asNumber(row.blocking),
      blockedBy: asNumber(row.blockedBy),
      incoming: asNumber(row.incoming),
      outgoing: asNumber(row.outgoing),
    };
  }

  /** The active ban and mute (expired rows count as absent) and the reports about and by the account. */
  async moderation(id: string, now: number): Promise<ModerationRecord> {
    const restriction = async (table: "bans" | "mutes"): Promise<RestrictionRow | null> => {
      const [row] = await this.db.query<Record<string, unknown>>(
        `SELECT reason, until, created_at AS createdAt, created_by AS createdBy FROM ${table}
         WHERE user_id = ? AND (until IS NULL OR until > ?)`,
        [id, now],
      );
      if (!row) return null;
      return {
        reason: String(row.reason),
        until: row.until === null ? null : +(row.until as number),
        createdAt: asNumber(row.createdAt),
        createdBy: String(row.createdBy),
      };
    };
    const [reports] = await this.db.query<Record<string, unknown>>(
      `SELECT
         (SELECT COUNT(*) FROM reports WHERE target_id = ? AND status = 'open') AS open,
         (SELECT COUNT(*) FROM reports WHERE target_id = ?) AS total,
         (SELECT COUNT(*) FROM reports WHERE reporter_id = ?) AS filed`,
      [id, id, id],
    );
    return {
      ban: await restriction("bans"),
      mute: await restriction("mutes"),
      reportsAgainst: { open: asNumber(reports.open), total: asNumber(reports.total) },
      reportsFiled: asNumber(reports.filed),
    };
  }

  /** How many Star ledger rows the account has, and its most recent GM grants and removals (at most 50). */
  async ledger(id: string): Promise<{ entries: number; gm: LedgerRow[] }> {
    const [{ entries }] = await this.db.query<{ entries: number }>(
      "SELECT COUNT(*) AS entries FROM credit_ledger WHERE user_id = ?",
      [id],
    );
    const gm = await this.db.query<LedgerRow>(
      "SELECT source, amount FROM credit_ledger WHERE user_id = ? AND source LIKE 'gm:%' ORDER BY source DESC LIMIT 50",
      [id],
    );
    return { entries: asNumber(entries), gm: gm.map(row => ({ source: row.source, amount: asNumber(row.amount) })) };
  }

  /** Season XP and whether the account bought the premium track. */
  async seasonProgress(id: string, seasonId: string): Promise<{ xp: number; premium: boolean }> {
    const [row] = await this.db.query<{ xp: number | null }>(
      "SELECT (SELECT xp FROM season_progress WHERE user_id = ? AND season = ?) AS xp",
      [id, seasonId],
    );
    return {
      xp: asNumber(row?.xp),
      premium: await this.db.repository(SeasonPremium).existsBy({ userId: id, season: seasonId }),
    };
  }

  /** Fails with a duplicate entry (see nameTaken) when another account has the name. */
  async rename(id: string, displayName: string): Promise<void> {
    await this.db.repository(User).update({ id }, { displayName, nameKey: nameKey(displayName) });
  }

  async setXp(id: string, xp: number): Promise<void> {
    await this.db.repository(User).update({ id }, { xp });
  }

  /** Gives or takes the premium track; returns whether anything changed. */
  async setPremium(id: string, seasonId: string, owned: boolean, purchasedAt: number): Promise<boolean> {
    if (!owned) {
      const result = await this.db.repository(SeasonPremium).delete({ userId: id, season: seasonId });
      return !!result.affected;
    }
    const result = await this.db.manager
      .createQueryBuilder()
      .insert()
      .into(SeasonPremium)
      .values({ userId: id, season: seasonId, purchasedAt })
      .orIgnore()
      .execute();
    return result.raw.affectedRows > 0;
  }

  /** Deletes the account's monthly ranking rows (`boards`) and/or time trial records (`times`); returns the count. */
  async resetRankings(id: string, boards: boolean, times: boolean): Promise<number> {
    let removed = 0;
    if (boards) removed += (await this.db.repository(Ranking).delete({ userId: id })).affected ?? 0;
    if (times) removed += (await this.db.repository(TimeTrialRecord).delete({ userId: id })).affected ?? 0;
    return removed;
  }
}
