import { Column, Entity, PrimaryColumn } from "typeorm";

/** Reserved for per-match results; currently unused. */
@Entity({ name: "results" })
export class MatchResult {
  @PrimaryColumn({ type: "varchar", length: 191, name: "match_id" })
  matchId: string;
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @Column({ type: "int", nullable: true })
  won: number | null;
  @Column({ type: "int", nullable: true })
  xp: number | null;
}

/** Marks a finished match as recorded for an account. */
@Entity({ name: "match_receipts" })
export class MatchReceipt {
  @PrimaryColumn({ type: "varchar", length: 191, name: "match_id" })
  matchId: string;
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
}

/** Wins, matches and points per account, mode and monthly season. */
@Entity({ name: "rankings" })
export class Ranking {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191 })
  mode: string;
  @PrimaryColumn({ type: "varchar", length: 191 })
  season: string;
  @Column({ type: "int", nullable: true })
  wins: number | null;
  @Column({ type: "int", nullable: true })
  matches: number | null;
  @Column({ type: "double", nullable: true })
  points: number | null;
}

/** Best time trial per account and course. */
@Entity({ name: "times" })
export class TimeTrialRecord {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191, name: "course_id" })
  courseId: string;
  @Column({ type: "double", nullable: true })
  seconds: number | null;
}
