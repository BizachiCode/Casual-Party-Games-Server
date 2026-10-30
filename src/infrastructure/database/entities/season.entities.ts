import { Column, Entity, PrimaryColumn } from "typeorm";
import { bigintNumber } from "./transformers.js";

/** The season policy frozen when the season first runs. */
@Entity({ name: "season_definitions" })
export class SeasonDefinition {
  @PrimaryColumn({ type: "varchar", length: 64 })
  id: string;
  @Column({ type: "longtext" })
  policy: string;
}

/** Season XP per account. */
@Entity({ name: "season_progress" })
export class SeasonProgress {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191 })
  season: string;
  @Column({ type: "int" })
  xp: number;
}

/** Season matches per account and UTC day (daily XP cap). */
@Entity({ name: "season_daily" })
export class SeasonDaily {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191 })
  day: string;
  @Column({ type: "int" })
  matches: number;
}

/** Marks a match (or a pass XP grant, keyed by its receipt) as counted for the season. */
@Entity({ name: "season_receipts" })
export class SeasonReceipt {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191, name: "match_id" })
  matchId: string;
  @Column({ type: "varchar", length: 191 })
  season: string;
  @Column({ type: "int" })
  xp: number;
}

/** A claimed season reward: one tier on one track ("free" or "premium"). */
@Entity({ name: "season_claims" })
export class SeasonClaim {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191 })
  season: string;
  @PrimaryColumn({ type: "varchar", length: 191, name: "tier_id" })
  tierId: string;
  @PrimaryColumn({ type: "varchar", length: 8, default: "free" })
  track: string;
}

/** The premium track of a season, bought by an account. */
@Entity({ name: "season_premium" })
export class SeasonPremium {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191 })
  season: string;
  @Column({ type: "bigint", transformer: bigintNumber, name: "purchased_at" })
  purchasedAt: number;
}
