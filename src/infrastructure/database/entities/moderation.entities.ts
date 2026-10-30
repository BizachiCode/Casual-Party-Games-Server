import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm";
import { bigintNumber } from "./transformers.js";

/** An account a GM suspended: it cannot sign in until `until` (never, when null). */
@Entity({ name: "bans" })
export class Ban {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @Column({ type: "varchar", length: 280 })
  reason: string;
  @Column({ type: "bigint", transformer: bigintNumber, nullable: true })
  until: number | null;
  @Column({ type: "bigint", transformer: bigintNumber, name: "created_at" })
  createdAt: number;
  @Column({ type: "varchar", length: 64, name: "created_by" })
  createdBy: string;
}

/** An account whose match chat a GM silenced until `until`. */
@Entity({ name: "mutes" })
export class Mute {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @Column({ type: "varchar", length: 280 })
  reason: string;
  @Column({ type: "bigint", transformer: bigintNumber })
  until: number;
  @Column({ type: "bigint", transformer: bigintNumber, name: "created_at" })
  createdAt: number;
  @Column({ type: "varchar", length: 64, name: "created_by" })
  createdBy: string;
}

/** A player's report about another player, with the chat lines that were on record when it was filed. */
@Entity({ name: "reports" })
export class PlayerReport {
  @PrimaryColumn({ type: "varchar", length: 64 })
  id: string;
  @Column({ type: "varchar", length: 64, name: "reporter_id" })
  reporterId: string;
  @Column({ type: "varchar", length: 64, name: "target_id" })
  targetId: string;
  @Column({ type: "varchar", length: 32 })
  reason: string;
  @Column({ type: "varchar", length: 280 })
  details: string;
  @Column({ type: "varchar", length: 191, name: "room_id" })
  roomId: string;
  /** JSON array of chat lines. */
  @Column({ type: "longtext", nullable: true })
  evidence: string | null;
  /** "open", "resolved" or "dismissed". */
  @Column({ type: "varchar", length: 16 })
  status: string;
  /** What the GM did when resolving: none, warn, mute, kick or ban. */
  @Column({ type: "varchar", length: 32 })
  resolution: string;
  @Column({ type: "varchar", length: 280 })
  note: string;
  @Column({ type: "varchar", length: 64, name: "handled_by" })
  handledBy: string;
  @Column({ type: "bigint", transformer: bigintNumber, name: "created_at" })
  createdAt: number;
  @Column({ type: "bigint", transformer: bigintNumber, nullable: true, name: "handled_at" })
  handledAt: number | null;
}

/**
 * One GM action: who (the operator name the console sent, and the address), what, on which account. A request id makes
 * a grant idempotent: the row is written first, so a retried request finds it and pays nothing twice.
 */
@Entity({ name: "gm_actions" })
export class GmAction {
  @PrimaryGeneratedColumn({ type: "bigint", unsigned: true })
  id: string;
  @Column({ type: "bigint", transformer: bigintNumber })
  at: number;
  @Column({ type: "varchar", length: 64 })
  operator: string;
  @Column({ type: "varchar", length: 64 })
  address: string;
  @Column({ type: "varchar", length: 64 })
  action: string;
  @Column({ type: "varchar", length: 64, name: "target_id", nullable: true })
  targetId: string | null;
  @Column({ type: "varchar", length: 100, name: "request_id", nullable: true })
  requestId: string | null;
  /** JSON object with the parameters of the action. */
  @Column({ type: "longtext", nullable: true })
  details: string | null;
}
