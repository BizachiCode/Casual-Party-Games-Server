import { In } from "typeorm";
import type { Database } from "../../infrastructure/database/database.js";
import { EventClaim, EventProgress, EventReceipt } from "../../infrastructure/database/entities/index.js";

export interface EventTotals {
  matches: number;
  wins: number;
}

/** Event counters, counted matches and claimed goals (tables event_progress, event_receipts, event_claims). */
export class EventRepository {
  constructor(private readonly db: Database) {}

  /** Marks the match as counted for the account; false when it already was. */
  async countMatch(userId: string, matchId: string): Promise<boolean> {
    const result = await this.db.manager
      .createQueryBuilder()
      .insert()
      .into(EventReceipt)
      .values({ userId, matchId })
      .orIgnore()
      .execute();
    return result.raw.affectedRows > 0;
  }

  async addMatch(userId: string, occurrence: string, won: boolean): Promise<void> {
    await this.db.query(
      `INSERT INTO event_progress VALUES(?,?,1,?) ON DUPLICATE KEY UPDATE
      matches=event_progress.matches+1,wins=event_progress.wins+VALUES(wins)`,
      [userId, occurrence, won ? 1 : 0],
    );
  }

  /** Totals per occurrence key; occurrences without a row are absent. */
  async progress(userId: string, occurrences: string[]): Promise<Map<string, EventTotals>> {
    if (!occurrences.length) return new Map();
    const rows = await this.db.repository(EventProgress).findBy({ userId, occurrence: In(occurrences) });
    return new Map(rows.map(row => [row.occurrence, { matches: row.matches, wins: row.wins }]));
  }

  /** Goal ids already claimed, per occurrence key. */
  async claimed(userId: string, occurrences: string[]): Promise<Map<string, Set<string>>> {
    const claimed = new Map<string, Set<string>>();
    if (!occurrences.length) return claimed;
    for (const claim of await this.db.repository(EventClaim).findBy({ userId, occurrence: In(occurrences) })) {
      const goals = claimed.get(claim.occurrence) ?? new Set<string>();
      goals.add(claim.goalId);
      claimed.set(claim.occurrence, goals);
    }
    return claimed;
  }

  async claim(userId: string, occurrence: string, goalId: string): Promise<void> {
    await this.db.repository(EventClaim).insert({ userId, occurrence, goalId });
  }
}
