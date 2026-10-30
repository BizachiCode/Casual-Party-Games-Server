import type { Database } from "../../infrastructure/database/database.js";
import { DailyProgress, GoalClaim, ProgressionReceipt } from "../../infrastructure/database/entities/index.js";

export interface DailyTotals {
  matches: number;
  wins: number;
  teams: number;
}

/**
 * Daily goal counters (weekly goals sum them), counted matches and claimed goals (daily_progress,
 * progression_receipts, goal_claims).
 */
export class ProgressionRepository {
  constructor(private readonly db: Database) {}

  /** Marks the match as counted for the account; false when it already was. */
  async countMatch(userId: string, matchId: string): Promise<boolean> {
    const result = await this.db.manager
      .createQueryBuilder()
      .insert()
      .into(ProgressionReceipt)
      .values({ userId, matchId })
      .orIgnore()
      .execute();
    return result.raw.affectedRows > 0;
  }

  async addDaily(userId: string, day: string, won: boolean, team: boolean): Promise<void> {
    await this.db.query(
      `INSERT INTO daily_progress VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE
      matches=daily_progress.matches+1,wins=daily_progress.wins+VALUES(wins),teams=daily_progress.teams+VALUES(teams)`,
      [userId, day, 1, won ? 1 : 0, team ? 1 : 0],
    );
  }

  async daily(userId: string, day: string): Promise<DailyTotals> {
    return (await this.db.repository(DailyProgress).findOneBy({ userId, day })) ?? { matches: 0, wins: 0, teams: 0 };
  }

  /** The counters summed over the UTC days `from` to `to` (YYYY-MM-DD, both included), for weekly goals. */
  async range(userId: string, from: string, to: string): Promise<DailyTotals> {
    const [row] = await this.db.query<Record<keyof DailyTotals, string | number>>(
      `SELECT COALESCE(SUM(matches),0) AS matches,COALESCE(SUM(wins),0) AS wins,COALESCE(SUM(teams),0) AS teams
      FROM daily_progress WHERE user_id=? AND \`day\`>=? AND \`day\`<=?`,
      [userId, from, to],
    );
    return { matches: Number(row.matches), wins: Number(row.wins), teams: Number(row.teams) };
  }

  claimed(userId: string, goalId: string, period: string): Promise<boolean> {
    return this.db.repository(GoalClaim).existsBy({ userId, goalId, period });
  }
  async claim(userId: string, goalId: string, period: string): Promise<void> {
    await this.db.repository(GoalClaim).insert({ userId, goalId, period });
  }
  async addXp(userId: string, xp: number): Promise<void> {
    await this.db.query("UPDATE users SET xp=xp+? WHERE id=?", [xp, userId]);
  }
}
