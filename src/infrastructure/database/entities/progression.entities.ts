import { Column, Entity, PrimaryColumn } from "typeorm";

/** Matches, wins and team matches per account and UTC day. */
@Entity({ name: "daily_progress" })
export class DailyProgress {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191 })
  day: string;
  @Column({ type: "int", nullable: true })
  matches: number | null;
  @Column({ type: "int", nullable: true })
  wins: number | null;
  @Column({ type: "int", nullable: true })
  teams: number | null;
}

/** Marks a match as counted for daily goals. */
@Entity({ name: "progression_receipts" })
export class ProgressionReceipt {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191, name: "match_id" })
  matchId: string;
}

/** A claimed goal reward, per period (UTC day or lifetime). */
@Entity({ name: "goal_claims" })
export class GoalClaim {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191, name: "goal_id" })
  goalId: string;
  @PrimaryColumn({ type: "varchar", length: 191 })
  period: string;
}
