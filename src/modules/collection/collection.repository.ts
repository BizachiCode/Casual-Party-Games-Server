import type { EntityTarget, ObjectLiteral } from "typeorm";
import type { Database } from "../../infrastructure/database/database.js";
import {
  CreditLedgerEntry,
  GachaReceipt,
  OwnedCharacter,
  Wallet,
} from "../../infrastructure/database/entities/index.js";

export interface WalletRow {
  credits: number;
  shards: number;
  pityEpic: number;
  pityLegendary: number;
  equipped: string;
}

/** Stars, shards, owned characters and gacha receipts (tables wallets, characters, credit_ledger, gacha_receipts). */
export class CollectionRepository {
  constructor(private readonly db: Database) {}

  private insertIgnore(entity: EntityTarget<ObjectLiteral>, values: ObjectLiteral) {
    return this.db.manager.createQueryBuilder().insert().into(entity).values(values).orIgnore().execute();
  }

  /** Creates the wallet and grants the starter character on first use; does nothing afterwards. */
  async ensureWallet(userId: string, initialCredits: number, starterId: string): Promise<void> {
    await this.insertIgnore(Wallet, {
      userId,
      credits: initialCredits,
      shards: 0,
      pityEpic: 0,
      pityLegendary: 0,
      equipped: starterId,
    });
    await this.insertIgnore(OwnedCharacter, { userId, characterId: starterId });
  }
  wallet(userId: string): Promise<WalletRow> {
    return this.db.repository(Wallet).findOne({
      where: { userId },
      select: { credits: true, shards: true, pityEpic: true, pityLegendary: true, equipped: true },
    });
  }
  async owned(userId: string): Promise<string[]> {
    const rows = await this.db.repository(OwnedCharacter).find({ where: { userId }, order: { characterId: "ASC" } });
    return rows.map(row => row.characterId);
  }
  owns(userId: string, characterId: string): Promise<boolean> {
    return this.db.repository(OwnedCharacter).existsBy({ userId, characterId });
  }
  async addCharacter(userId: string, characterId: string): Promise<void> {
    await this.db.repository(OwnedCharacter).insert({ userId, characterId });
  }
  /** Grants a character unless already owned; returns whether it was new. */
  async grantCharacter(userId: string, characterId: string): Promise<boolean> {
    return (await this.insertIgnore(OwnedCharacter, { userId, characterId })).raw.affectedRows > 0;
  }

  /** Takes a character away; returns whether the account owned it. */
  async removeCharacter(userId: string, characterId: string): Promise<boolean> {
    const result = await this.db.repository(OwnedCharacter).delete({ userId, characterId });
    return !!result.affected;
  }

  async setEquipped(userId: string, characterId: string): Promise<void> {
    await this.db.repository(Wallet).update({ userId }, { equipped: characterId });
  }
  async addShards(userId: string, shards: number): Promise<void> {
    await this.db.repository(Wallet).increment({ userId }, "shards", shards);
  }
  async spendShards(userId: string, shards: number): Promise<void> {
    await this.db.repository(Wallet).decrement({ userId }, "shards", shards);
  }
  async saveWallet(userId: string, wallet: Omit<WalletRow, "equipped">): Promise<void> {
    await this.db.repository(Wallet).update({ userId }, wallet);
  }

  /** Records a Star grant from `source` once; returns whether it was new (the caller then credits the wallet). */
  async recordCredit(userId: string, source: string, amount: number): Promise<boolean> {
    return (await this.insertIgnore(CreditLedgerEntry, { userId, source, amount })).raw.affectedRows > 0;
  }
  creditRecorded(userId: string, source: string): Promise<boolean> {
    return this.db.repository(CreditLedgerEntry).existsBy({ userId, source });
  }
  async addCredits(userId: string, amount: number): Promise<void> {
    await this.db.repository(Wallet).increment({ userId }, "credits", amount);
  }
  async spendCredits(userId: string, amount: number): Promise<void> {
    await this.db.repository(Wallet).decrement({ userId }, "credits", amount);
  }

  receipt(userId: string, requestId: string): Promise<GachaReceipt | null> {
    return this.db.repository(GachaReceipt).findOneBy({ userId, requestId });
  }
  async saveReceipt(userId: string, requestId: string, fingerprint: string, response: string): Promise<void> {
    await this.db.repository(GachaReceipt).insert({ userId, requestId, fingerprint, response });
  }

  /** Every character id held or equipped by anyone (content exports must keep them). */
  async allOwnedOrEquipped(): Promise<string[]> {
    const rows: { id: string }[] = await this.db.query(
      "SELECT DISTINCT character_id AS id FROM characters UNION SELECT DISTINCT equipped AS id FROM wallets",
    );
    return rows.map(row => row.id);
  }
}
