import type { Database } from "../../infrastructure/database/database.js";
import {
  SeasonClaim,
  SeasonDaily,
  SeasonDefinition,
  SeasonPremium,
  SeasonProgress,
  SeasonReceipt,
} from "../../infrastructure/database/entities/index.js";

/** Frozen season policies, XP, daily caps, XP receipts, premium purchases and claims (season_* tables). */
export class SeasonRepository {
  constructor(private readonly db: Database) {}

  async freeze(id: string, policy: string): Promise<void> {
    await this.db.manager
      .createQueryBuilder()
      .insert()
      .into(SeasonDefinition)
      .values({ id, policy })
      .orIgnore()
      .execute();
  }
  async policy(id: string): Promise<string | null> {
    return (await this.db.repository(SeasonDefinition).findOneBy({ id }))?.policy ?? null;
  }
  definitions(): Promise<SeasonDefinition[]> {
    return this.db.repository(SeasonDefinition).find();
  }

  matchCounted(userId: string, matchId: string): Promise<boolean> {
    return this.db.repository(SeasonReceipt).existsBy({ userId, matchId });
  }
  async countMatch(userId: string, matchId: string, season: string, xp: number): Promise<void> {
    await this.db.repository(SeasonReceipt).insert({ userId, matchId, season, xp });
  }
  /** Records an XP grant under its receipt key (kept in match_id); false when that key was already recorded. */
  async countGrant(userId: string, receiptKey: string, season: string, xp: number): Promise<boolean> {
    const result = await this.db.manager
      .createQueryBuilder()
      .insert()
      .into(SeasonReceipt)
      .values({ userId, matchId: receiptKey, season, xp })
      .orIgnore()
      .execute();
    return result.raw.affectedRows > 0;
  }
  /** Matches that earned XP on `day`; the day text also names the season, so each season has its own cap. */
  async dailyMatches(userId: string, day: string): Promise<number> {
    return (await this.db.repository(SeasonDaily).findOneBy({ userId, day }))?.matches || 0;
  }
  async addDailyMatch(userId: string, day: string): Promise<void> {
    await this.db.query("INSERT INTO season_daily VALUES(?,?,1) ON DUPLICATE KEY UPDATE matches=matches+1", [
      userId,
      day,
    ]);
  }
  /** Adds XP, capped at the last tier. */
  async addXp(userId: string, season: string, xp: number, cap: number): Promise<void> {
    await this.db.query("INSERT INTO season_progress VALUES(?,?,?) ON DUPLICATE KEY UPDATE xp=LEAST(?,xp+VALUES(xp))", [
      userId,
      season,
      Math.min(xp, cap),
      cap,
    ]);
  }
  async xp(userId: string, season: string): Promise<number> {
    return (await this.db.repository(SeasonProgress).findOneBy({ userId, season }))?.xp || 0;
  }

  premiumOwned(userId: string, season: string): Promise<boolean> {
    return this.db.repository(SeasonPremium).existsBy({ userId, season });
  }
  async buyPremium(userId: string, season: string, purchasedAt: number): Promise<void> {
    await this.db.repository(SeasonPremium).insert({ userId, season, purchasedAt });
  }

  /** The claimed rewards of a season as "<track>:<tier id>". */
  async claimed(userId: string, season: string): Promise<Set<string>> {
    const claims = await this.db.repository(SeasonClaim).findBy({ userId, season });
    return new Set(claims.map(claim => claim.track + ":" + claim.tierId));
  }
  async claim(userId: string, season: string, tierId: string, track: string): Promise<void> {
    await this.db.repository(SeasonClaim).insert({ userId, season, tierId, track });
  }
}
