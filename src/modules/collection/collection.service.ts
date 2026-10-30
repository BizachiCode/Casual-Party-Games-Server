import { randomInt } from "node:crypto";
import type { Database } from "../../infrastructure/database/database.js";
import { ApiError } from "../../shared/errors.js";
import type { CharacterCatalog, Rarity } from "../content/content.types.js";
import type { CollectionRepository } from "./collection.repository.js";

export interface CollectionState {
  credits: number;
  shards: number;
  pityEpic: number;
  pityLegendary: number;
  equipped: string;
  owned: string[];
  dailyAvailable: boolean;
}
export interface PullItem {
  characterId: string;
  rarity: Rarity;
  duplicate: boolean;
  shards: number;
}
export interface PullResult {
  requestId: string;
  spent: number;
  items: PullItem[];
  state: CollectionState;
}

/**
 * The character collection: Stars earned in matches and missions, gacha pulls with pity, duplicates converted to
 * shards, crafting with shards and the equipped character every match shows.
 */
export class CollectionService {
  /** Replaceable for tests: an integer in [0, max). */
  random: (max: number) => number = randomInt;
  clock: () => Date = () => new Date();

  constructor(
    private readonly db: Database,
    private readonly collection: CollectionRepository,
    readonly catalog: CharacterCatalog,
  ) {
    for (const banner of catalog.banners) {
      for (const weight of banner.weights) {
        if (weight.weight <= 0 || !catalog.characters.some(character => character.rarity === weight.rarity))
          throw new Error("Invalid banner catalogue.");
      }
    }
  }

  /** Creates the wallet and starter character on first use. */
  async init(id: string): Promise<void> {
    await this.db.lockUsers([id]);
    await this.collection.ensureWallet(id, this.catalog.initialCredits, this.catalog.starterId);
  }

  private dayKey(): string {
    return "daily:" + this.clock().toISOString().slice(0, 10);
  }

  async state(id: string): Promise<CollectionState> {
    await this.init(id);
    return {
      ...(await this.collection.wallet(id)),
      owned: await this.collection.owned(id),
      dailyAvailable: !(await this.collection.creditRecorded(id, this.dayKey())),
    };
  }

  /** Grants Stars once per `source` (a match, a goal, a season tier, a day). */
  async reward(id: string, source: string, amount: number): Promise<void> {
    await this.init(id);
    if (!Number.isSafeInteger(amount) || amount <= 0) return;
    if (await this.collection.recordCredit(id, source, amount)) await this.collection.addCredits(id, amount);
  }

  /**
   * Charges Stars once per `source` (a battle pass, a purchase): the ledger keeps the charge as a negative amount, so a
   * retry pays nothing twice. Returns false, charging nothing, when the balance is too low.
   */
  async spend(id: string, source: string, amount: number): Promise<boolean> {
    await this.init(id);
    if (!Number.isSafeInteger(amount) || amount <= 0 || (await this.collection.creditRecorded(id, source))) return true;
    if ((await this.collection.wallet(id)).credits < amount) return false;
    await this.collection.recordCredit(id, source, -amount);
    await this.collection.spendCredits(id, amount);
    return true;
  }

  daily(id: string): Promise<CollectionState> {
    return this.db.transaction(async () => {
      await this.db.lockUsers([id]);
      if (!(await this.state(id)).dailyAvailable) throw new ApiError(409, "Daily reward already claimed.");
      await this.reward(id, this.dayKey(), this.catalog.dailyCredits);
      return this.state(id);
    });
  }

  async equip(id: string, characterId: unknown): Promise<CollectionState> {
    await this.init(id);
    if (
      typeof characterId !== "string" ||
      !this.catalog.characters.some(character => character.id === characterId) ||
      !(await this.collection.owns(id, characterId))
    ) {
      throw new ApiError(403, "Unlock this character first.");
    }
    await this.collection.setEquipped(id, characterId);
    return this.state(id);
  }

  craft(id: string, characterId: unknown): Promise<CollectionState> {
    return this.db.transaction(async () => {
      await this.db.lockUsers([id]);
      const character = this.catalog.characters.find(candidate => candidate.id === characterId);
      const state = await this.state(id);
      if (!character || state.owned.includes(character.id))
        throw new ApiError(409, "Character unavailable or already owned.");
      if (state.shards < character.craftCost) throw new ApiError(400, "Not enough shards.");
      await this.collection.spendShards(id, character.craftCost);
      await this.collection.addCharacter(id, character.id);
      return this.state(id);
    });
  }

  /**
   * One or ten draws. `requestId` makes a pull idempotent: retrying it (a lost response) returns the stored result
   * instead of charging twice.
   */
  async pull(id: string, body: { bannerId?: unknown; count?: unknown; requestId?: unknown } = {}): Promise<PullResult> {
    const { bannerId, count, requestId } = body;
    const banner = this.catalog.banners.find(candidate => candidate.id === bannerId);
    if (
      !banner ||
      (count !== 1 && count !== 10) ||
      typeof requestId !== "string" ||
      !/^[\w-]{8,100}$/.test(requestId)
    ) {
      throw new ApiError(400, "Invalid banner, draw count or request id.");
    }
    return this.db.transaction(async () => {
      await this.db.lockUsers([id]);
      const fingerprint = bannerId + ":" + count;
      const previous = await this.collection.receipt(id, requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ApiError(409, "Request id already used with different parameters.");
        return JSON.parse(previous.response) as PullResult;
      }
      const state = await this.state(id);
      const cost = count === 10 ? banner.tenCost : banner.cost;
      if (state.credits < cost) throw new ApiError(400, "Not enough Stars.");
      const items: PullItem[] = [];
      for (let i = 0; i < count; i++) {
        // Pity: the draw that reaches a counter is guaranteed that rarity (or better).
        const guarantee =
          state.pityLegendary + 1 >= banner.legendaryPity
            ? "legendary"
            : state.pityEpic + 1 >= banner.epicPity
              ? "epic"
              : "";
        const pool = banner.weights.filter(
          weight => !guarantee || weight.rarity === "legendary" || (guarantee === "epic" && weight.rarity === "epic"),
        );
        let roll = this.random(pool.reduce((sum, weight) => sum + weight.weight, 0));
        const rarity = pool.find(weight => {
          roll -= weight.weight;
          return roll < 0;
        }).rarity;
        const choices = this.catalog.characters.filter(candidate => candidate.rarity === rarity);
        const character = choices[this.random(choices.length)];
        const duplicate = state.owned.includes(character.id);
        const shards = duplicate ? character.duplicateShards : 0;
        if (!duplicate) {
          await this.collection.addCharacter(id, character.id);
          state.owned.push(character.id);
        }
        state.shards += shards;
        state.pityEpic = ["epic", "legendary"].includes(rarity) ? 0 : state.pityEpic + 1;
        state.pityLegendary = rarity === "legendary" ? 0 : state.pityLegendary + 1;
        items.push({ characterId: character.id, rarity, duplicate, shards });
      }
      await this.collection.saveWallet(id, {
        credits: state.credits - cost,
        shards: state.shards,
        pityEpic: state.pityEpic,
        pityLegendary: state.pityLegendary,
      });
      const result: PullResult = { requestId, spent: cost, items, state: await this.state(id) };
      await this.collection.saveReceipt(id, requestId, fingerprint, JSON.stringify(result));
      return result;
    });
  }
}
