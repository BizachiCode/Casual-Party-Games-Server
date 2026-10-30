import { Column, Entity, PrimaryColumn } from "typeorm";
import { bigintNumber } from "./transformers.js";

/** A pending friend request. */
@Entity({ name: "requests" })
export class FriendRequest {
  @PrimaryColumn({ type: "varchar", length: 64 })
  sender: string;
  @PrimaryColumn({ type: "varchar", length: 64 })
  recipient: string;
}

/** An accepted friendship, stored once per pair (low id, high id). */
@Entity({ name: "friends" })
export class Friendship {
  @PrimaryColumn({ type: "varchar", length: 64 })
  low: string;
  @PrimaryColumn({ type: "varchar", length: 64 })
  high: string;
}

/** A block: hides chat and refuses invites, requests and shared lobbies both ways. */
@Entity({ name: "blocks" })
export class Block {
  @PrimaryColumn({ type: "varchar", length: 64 })
  owner: string;
  @PrimaryColumn({ type: "varchar", length: 64 })
  target: string;
}

/** An invitation to a private lobby; expires after two minutes. */
@Entity({ name: "invites" })
export class LobbyInvite {
  @PrimaryColumn({ type: "varchar", length: 64 })
  id: string;
  @Column({ type: "varchar", length: 64, nullable: true })
  sender: string | null;
  @Column({ type: "varchar", length: 64, nullable: true })
  recipient: string | null;
  @Column({ type: "varchar", length: 191, name: "room_id", nullable: true })
  roomId: string | null;
  @Column({ type: "bigint", nullable: true, transformer: bigintNumber })
  expires: number | null;
}
