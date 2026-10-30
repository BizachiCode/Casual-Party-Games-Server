import type { Database } from "../../infrastructure/database/database.js";
import { ContentIdentity } from "../../infrastructure/database/entities/index.js";
import type { CollectionRepository } from "../collection/collection.repository.js";
import type { CharacterCatalog, GoalCatalog } from "./content.types.js";

/** What the guard asks the battle pass: the characters its running, claimable and upcoming seasons promise. */
export interface SeasonPromises {
  promisedCharacters(): Promise<string[]>;
}

/** What the guard asks the events: the characters the goals of its running, repeating and just ended events pay. */
export interface EventPromises {
  promisedCharacters(): string[];
}

/**
 * Protects players from content changes: a new export may not remove a character someone owns, equips or can still
 * claim from a season (on either pass track) or an event, and may not redefine a published character (rarity) or goal
 * (scope and metric).
 */
export class ContentGuard {
  constructor(
    private readonly db: Database,
    private readonly collection: CollectionRepository,
    private readonly seasons: SeasonPromises,
    private readonly events?: EventPromises,
  ) {}

  async validateInventory(characters: CharacterCatalog): Promise<void> {
    const ids = new Set(characters.characters.map(character => character.id));
    for (const id of await this.collection.allOwnedOrEquipped()) {
      if (!ids.has(id)) throw new Error("Content removes an owned/equipped character: " + id);
    }
    for (const id of await this.seasons.promisedCharacters()) {
      if (!ids.has(id)) throw new Error("Content removes a claimable season character: " + id);
    }
    for (const id of this.events?.promisedCharacters() ?? []) {
      if (!ids.has(id)) throw new Error("Content removes a claimable event character: " + id);
    }
  }

  /** Checks every identity against the published ones; with `register`, records the new ones (on startup). */
  checkIdentities(characters: CharacterCatalog, goals: GoalCatalog, register = false): Promise<void> {
    const entries = [
      ...characters.characters.map(character => ({ kind: "character", id: character.id, identity: character.rarity })),
      ...goals.goals.map(goal => ({ kind: "goal", id: goal.id, identity: goal.scope + ":" + goal.metric })),
    ];
    return this.db.transaction(async () => {
      const identities = this.db.repository(ContentIdentity);
      for (const entry of entries) {
        const prior = await identities.findOneBy({ kind: entry.kind, id: entry.id });
        if (prior && prior.identity !== entry.identity)
          throw new Error("Changing a content identity requires a migration: " + entry.kind + "/" + entry.id);
      }
      if (register) {
        for (const entry of entries)
          await this.db.manager.createQueryBuilder().insert().into(ContentIdentity).values(entry).orIgnore().execute();
      }
    });
  }
}
