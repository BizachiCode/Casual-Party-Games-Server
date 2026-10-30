import { Column, Entity, PrimaryColumn } from "typeorm";

/** Stars, shards, gacha pity counters and the equipped character. */
@Entity({ name: "wallets" })
export class Wallet {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @Column({ type: "int" })
  credits: number;
  @Column({ type: "int" })
  shards: number;
  @Column({ type: "int", name: "pity_epic" })
  pityEpic: number;
  @Column({ type: "int", name: "pity_legendary" })
  pityLegendary: number;
  @Column({ type: "varchar", length: 191 })
  equipped: string;
}

/** A character the player owns. */
@Entity({ name: "characters" })
export class OwnedCharacter {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191, name: "character_id" })
  characterId: string;
}

/** The stored response of a gacha pull, so a retried request returns the same result. */
@Entity({ name: "gacha_receipts" })
export class GachaReceipt {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191, name: "request_id" })
  requestId: string;
  @Column({ type: "varchar", length: 191, nullable: true })
  fingerprint: string | null;
  @Column({ type: "longtext", nullable: true })
  response: string | null;
}

/** Every Star grant, keyed by its source so a reward is paid once. */
@Entity({ name: "credit_ledger" })
export class CreditLedgerEntry {
  @PrimaryColumn({ type: "varchar", length: 64, name: "user_id" })
  userId: string;
  @PrimaryColumn({ type: "varchar", length: 191 })
  source: string;
  @Column({ type: "int", nullable: true })
  amount: number | null;
}
