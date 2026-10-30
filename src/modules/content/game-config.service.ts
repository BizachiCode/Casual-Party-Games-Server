import { join } from "node:path";
import { ApiError, ensure } from "../../shared/errors.js";
import { validateEventCatalog, type EventCatalog } from "../events/events.catalog.js";
import { validateMatchmakingCatalog } from "../matchmaking/matchmaking.catalog.js";
import type { MatchmakingCatalog } from "../matchmaking/matchmaking.types.js";
import type { SeasonService } from "../season/season.service.js";
import type { SeasonCatalog } from "../season/season.catalog.js";
import { validateStoreCatalog, type StoreCatalog } from "../store/store.catalog.js";
import { atomicWrite } from "./content-bundle.js";
import type { ContentGuard } from "./content.guard.js";
import type { CharacterCatalog, GoalCatalog, PartyConfig } from "./content.types.js";
import { validateCatalogs } from "./content.validation.js";

/** What Unity's "Tools > Casual Party > Export to Server" writes to game_config: the files an upload may replace. */
export const GAME_CONFIG_FILES = [
  "party-courses.json",
  "party-characters.json",
  "party-goals.json",
  "party-matchmaking.json",
  "season.json",
  "events.json",
  "party-store.json",
] as const;
type GameConfigFile = (typeof GAME_CONFIG_FILES)[number];
const REQUIRED: GameConfigFile[] = [
  "party-courses.json",
  "party-characters.json",
  "party-goals.json",
  "party-matchmaking.json",
];

export interface GameConfigApplied {
  revision: string;
  files: string[];
}

/**
 * An export uploaded from Unity (Tools > Casual Party > Export to Server with the admin key): every file is checked
 * together, with the rules the server applies when it starts (catalogs, matchmaking, battle pass, events, store, the
 * accounts' owned characters and the season running now), and only then written to game_config. The running process
 * keeps its content; the new files load on the next start.
 */
export class GameConfigService {
  constructor(
    private readonly deps: { directory: string; guard: ContentGuard; seasons: SeasonService; bundleInUse: boolean },
  ) {}

  async apply(body: unknown): Promise<GameConfigApplied> {
    const { directory, guard, seasons, bundleInUse } = this.deps;
    ensure(!bundleInUse, 409, "This server runs a content bundle (PARTY_CONTENT_BUNDLE); upload it with that bundle.");
    const files = (body as { files?: unknown } | null)?.files;
    ensure(!!files && typeof files === "object" && !Array.isArray(files), 400, "Send the exported files.");
    const uploaded = files as Partial<Record<GameConfigFile, unknown>>;
    for (const name of Object.keys(uploaded))
      ensure((GAME_CONFIG_FILES as readonly string[]).includes(name), 400, "Unknown file " + name + ".");
    for (const name of REQUIRED) ensure(uploaded[name] !== undefined, 400, "Missing " + name + ".");
    try {
      const content = validateCatalogs(
        structuredClone(uploaded["party-courses.json"]) as PartyConfig,
        structuredClone(uploaded["party-characters.json"]) as CharacterCatalog,
        structuredClone(uploaded["party-goals.json"]) as GoalCatalog,
      );
      const matchmaking = validateMatchmakingCatalog(
        structuredClone(uploaded["party-matchmaking.json"]) as MatchmakingCatalog,
        content.config,
      );
      if (uploaded["season.json"] !== undefined)
        await seasons.checkReplacement(
          structuredClone(uploaded["season.json"]) as SeasonCatalog,
          content.characterCatalog,
        );
      if (uploaded["events.json"] !== undefined)
        validateEventCatalog(structuredClone(uploaded["events.json"]) as EventCatalog, {
          config: content.config,
          queues: matchmaking.queues,
          characters: content.characterCatalog,
        });
      if (uploaded["party-store.json"] !== undefined)
        validateStoreCatalog(structuredClone(uploaded["party-store.json"]) as StoreCatalog);
      await guard.validateInventory(content.characterCatalog);
      await guard.checkIdentities(content.characterCatalog, content.goalCatalog);
      const written = GAME_CONFIG_FILES.filter(name => uploaded[name] !== undefined);
      for (const name of written) atomicWrite(join(directory, name), JSON.stringify(uploaded[name], null, 4) + "\n");
      return { revision: content.config.revision, files: written };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, (error as Error).message);
    }
  }
}
