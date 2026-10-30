import { Column, Entity, PrimaryColumn } from "typeorm";

/** Matches and wins per account and event occurrence (the key is `<event id>@<start date>`). */
@Entity({ name: "event_progress" })
export class EventProgress {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191 })
  occurrence: string;
  @Column({ type: "int" })
  matches: number;
  @Column({ type: "int" })
  wins: number;
}

/** Marks a match as counted for an event, so a retried settlement never counts it twice. */
@Entity({ name: "event_receipts" })
export class EventReceipt {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191, name: "match_id" })
  matchId: string;
}

/** A claimed event goal reward, per occurrence. */
@Entity({ name: "event_claims" })
export class EventClaim {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191 })
  occurrence: string;
  @PrimaryColumn({ type: "varchar", length: 191, name: "goal_id" })
  goalId: string;
}
