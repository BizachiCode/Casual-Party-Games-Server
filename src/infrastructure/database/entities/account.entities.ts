import { Column, Entity, PrimaryColumn } from "typeorm";
import { bigintNumber } from "./transformers.js";

/** A player account. Passwords are scrypt digests with a per-user salt. */
@Entity({ name: "users" })
export class User {
  @PrimaryColumn({ type: "varchar", length: 64 })
  id: string;
  @Column({ type: "varchar", length: 191 })
  username: string;
  @Column({ type: "varchar", length: 191, name: "display_name" })
  displayName: string;
  /** The display name in comparison form (see nameKey); unique, so two accounts never share a name. */
  @Column({ type: "varchar", length: 191, name: "name_key" })
  nameKey: string;
  @Column({ type: "varchar", length: 128 })
  salt: string;
  @Column({ type: "varchar", length: 128, name: "password_hash" })
  passwordHash: string;
  @Column({ type: "int", default: 0 })
  xp: number;
  @Column({ type: "int", default: 0 })
  wins: number;
  @Column({ type: "int", default: 0 })
  matches: number;
  @Column({ type: "int", default: 0 })
  color: number;
  /** A device guest account that has not chosen a username and password yet. */
  @Column({ type: "boolean", default: false })
  guest: boolean;
  /** Milliseconds; 0 for accounts created before the GM console. */
  @Column({ type: "bigint", transformer: bigintNumber, name: "created_at", default: 0 })
  createdAt: number;
  /** The last sign-in or authenticated request (written at most every few minutes); 0 when unknown. */
  @Column({ type: "bigint", transformer: bigintNumber, name: "last_seen", default: 0 })
  lastSeen: number;
  /** The player's icon: a character id the player owns, or empty (the client then shows the equipped character). */
  @Column({ type: "varchar", length: 64, default: "" })
  avatar: string;
  /** When the display name last changed through the rename endpoint; 0 when it never did. */
  @Column({ type: "bigint", transformer: bigintNumber, name: "name_changed_at", default: 0 })
  nameChangedAt: number;
}

/** The device a guest account belongs to. Only the SHA-256 of the device secret is stored. */
@Entity({ name: "device_logins" })
export class DeviceLogin {
  @PrimaryColumn({ type: "varchar", length: 64, name: "device_id" })
  deviceId: string;
  @Column({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @Column({ type: "varchar", length: 128, name: "secret_hash" })
  secretHash: string;
  @Column({ type: "bigint", transformer: bigintNumber, name: "created_at" })
  createdAt: number;
}

/** A signed-in device. Only the SHA-256 of the bearer token is stored. */
@Entity({ name: "sessions" })
export class Session {
  @PrimaryColumn({ type: "varchar", length: 128, name: "token_hash" })
  tokenHash: string;
  @Column({ type: "varchar", length: 64, name: "user_id", nullable: true })
  userId: string | null;
  @Column({ type: "bigint", transformer: bigintNumber })
  expires: number;
}
