import type { Database } from "../../infrastructure/database/database.js";
import { MatchReceipt } from "../../infrastructure/database/entities/index.js";

export interface BoardRow {
  id: string;
  username: string;
  displayName: string;
  wins: number;
  matches: number;
  points: number;
  seconds: number;
  score: number;
}

/** Match receipts, profile totals, monthly rankings and time trials (tables match_receipts, users, rankings, times). */
export class RankingRepository {
  constructor(private readonly db: Database) {}

  /** Marks the match as recorded for the account; false when it already was (a retried settlement). */
  async recordReceipt(matchId: string, userId: string): Promise<boolean> {
    const result = await this.db.manager
      .createQueryBuilder()
      .insert()
      .into(MatchReceipt)
      .values({ matchId, userId })
      .orIgnore()
      .execute();
    return result.raw.affectedRows > 0;
  }

  async addProfileResult(userId: string, xp: number, wins: number): Promise<void> {
    await this.db.query("UPDATE users SET xp=xp+?,wins=wins+?,matches=matches+1 WHERE id=?", [xp, wins, userId]);
  }

  async addRanking(userId: string, mode: string, season: string, won: number, points: number): Promise<void> {
    await this.db.query(
      `INSERT INTO rankings VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE
      wins=rankings.wins+VALUES(wins),matches=rankings.matches+1,points=rankings.points+VALUES(points)`,
      [userId, mode, season, won, 1, points],
    );
  }

  async recordTime(userId: string, courseId: string, seconds: number): Promise<void> {
    await this.db.query(
      "INSERT INTO times VALUES(?,?,?) ON DUPLICATE KEY UPDATE seconds=LEAST(times.seconds,VALUES(seconds))",
      [userId, courseId, seconds],
    );
  }

  timeTrial(courseId: string, offset: number): Promise<BoardRow[]> {
    return this.db.query(
      `SELECT users.id,username,display_name AS displayName,seconds,0 AS wins,0 AS matches,0 AS points,0 AS score
      FROM times JOIN users ON users.id=times.user_id WHERE course_id=? ORDER BY seconds,username LIMIT 50 OFFSET ?`,
      [courseId, offset],
    );
  }

  levels(offset: number): Promise<BoardRow[]> {
    return this.db.query(
      `SELECT id,username,display_name AS displayName,xp AS score,wins,matches,0 AS points,0 AS seconds
      FROM users ORDER BY xp DESC,username LIMIT 50 OFFSET ?`,
      [offset],
    );
  }

  /** Totals over rankings rows, optionally limited to a season, a mode or the viewer and their friends. */
  totals(
    sort: "wins" | "points",
    filter: { season?: string; mode?: string; friendsOf?: string },
    offset: number,
  ): Promise<BoardRow[]> {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (filter.season) {
      conditions.push("r.season=?");
      parameters.push(filter.season);
    }
    if (filter.mode) {
      conditions.push("r.mode=?");
      parameters.push(filter.mode);
    }
    if (filter.friendsOf) {
      conditions.push(
        "u.id IN (SELECT CASE WHEN low=? THEN high ELSE low END FROM friends WHERE low=? OR high=? UNION SELECT ?)",
      );
      parameters.push(filter.friendsOf, filter.friendsOf, filter.friendsOf, filter.friendsOf);
    }
    // `sort` is one of two fixed column names, never client text.
    return this.db.query(
      `SELECT u.id, u.username, u.display_name AS displayName, SUM(r.wins) AS wins, SUM(r.matches) AS matches,
         SUM(r.points) AS points, 0 AS seconds, SUM(r.${sort}) AS score
       FROM rankings r JOIN users u ON u.id = r.user_id
       ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
       GROUP BY u.id
       ORDER BY ${sort} DESC, points DESC, u.username
       LIMIT 50 OFFSET ?`,
      [...parameters, offset],
    );
  }
}
