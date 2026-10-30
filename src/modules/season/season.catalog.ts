import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gameConfigDirectory } from "../../config/paths.js";
import type { CharacterCatalog } from "../content/content.types.js";

export const DAY_MS = 86400000;

/** What one track gives at a tier. All zero and no character is an empty reward (nothing to claim). */
export interface SeasonReward {
  credits: number;
  shards: number;
  characterId: string;
}
export interface SeasonTier {
  id: string;
  /** Cumulative season XP needed to reach the tier. */
  xp: number;
  free: SeasonReward;
  premium: SeasonReward;
}
export type PremiumCurrency = "credits" | "shards";
/** What the premium track costs: Stars ("credits") or gems ("shards"). A cost of 0 gives it to everyone. */
export interface SeasonPremium {
  currency: PremiumCurrency;
  cost: number;
}
/** One scheduled season. This exact text (canonical JSON) is frozen in season_definitions once it is running. */
export interface SeasonPolicy {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  matchXp: number;
  winBonus: number;
  dailyMatchCap: number;
  minimumParticipants: number;
  claimGraceDays: number;
  premium: SeasonPremium;
  tiers: SeasonTier[];
}
export interface SeasonCatalog {
  version: 2;
  seasons: SeasonPolicy[];
}

/** game_config/season.json, or the file in PARTY_SEASON_CATALOG. */
export function loadSeasonCatalog(path = join(gameConfigDirectory, "season.json")): SeasonCatalog {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The moments that bound a season, in milliseconds since the epoch. */
export function seasonWindow(season: SeasonPolicy) {
  const start = Date.parse(season.startsAt);
  const end = Date.parse(season.endsAt);
  return { start, end, claimUntil: end + season.claimGraceDays * DAY_MS };
}

/** A frozen policy as stored text, or null for the monthly (version 1) rows older builds left behind. */
export function parseFrozenPolicy(text: string): SeasonPolicy | null {
  try {
    const policy = JSON.parse(text) as Partial<SeasonPolicy>;
    const scheduled = typeof policy?.id === "string" && typeof policy.startsAt === "string";
    return scheduled && typeof policy.endsAt === "string" && Array.isArray(policy.tiers)
      ? (policy as SeasonPolicy)
      : null;
  } catch {
    return null;
  }
}

function fail(path: string): never {
  throw new Error("Invalid season catalog: " + path);
}
function requireValue(ok: unknown, path: string): asserts ok {
  if (!ok) fail(path);
}
function integer(value: unknown, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
function label(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 120;
}
/** The time in milliseconds of an ISO UTC text like 2026-10-01T00:00:00.000Z, NaN for anything else. */
function instant(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : Number.NaN;
}

function validateReward(reward: SeasonReward, characters: CharacterCatalog, path: string): void {
  requireValue(reward && typeof reward === "object", path);
  requireValue(integer(reward.credits, 0, 10000), path + ".credits");
  requireValue(integer(reward.shards, 0, 1000), path + ".shards");
  requireValue(
    typeof reward.characterId === "string" &&
      (reward.characterId === "" || characters.characters.some(character => character.id === reward.characterId)),
    path + ".characterId",
  );
}

/**
 * Throws unless the catalog is well formed: seasons sorted and not overlapping, each one to 366 days long, tier XP
 * strictly rising, every rewarded character present in the character catalog.
 */
export function validateSeasonCatalog(catalog: SeasonCatalog, characters: CharacterCatalog): void {
  requireValue(catalog?.version === 2, "version");
  requireValue(
    Array.isArray(catalog.seasons) && catalog.seasons.length >= 1 && catalog.seasons.length <= 200,
    "seasons",
  );
  const ids = new Set<string>();
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const season of catalog.seasons) {
    requireValue(season && typeof season === "object", "season");
    const where = "season " + season.id;
    requireValue(typeof season.id === "string" && /^[a-z0-9-]{1,64}$/.test(season.id), "season id");
    requireValue(!ids.has(season.id), where + " is listed twice");
    ids.add(season.id);
    requireValue(label(season.title), where + " title");
    const start = instant(season.startsAt);
    const end = instant(season.endsAt);
    requireValue(Number.isFinite(start), where + " startsAt (an ISO UTC time like 2026-10-01T00:00:00.000Z)");
    requireValue(Number.isFinite(end), where + " endsAt (an ISO UTC time like 2026-12-01T00:00:00.000Z)");
    requireValue(end - start >= DAY_MS && end - start <= 366 * DAY_MS, where + " length (1 to 366 days)");
    requireValue(
      start >= previousEnd,
      where + " starts before the previous season ends (sort by startsAt, no overlap)",
    );
    previousEnd = end;
    requireValue(integer(season.matchXp, 1, 1000), where + " matchXp");
    requireValue(integer(season.winBonus, 0, 1000), where + " winBonus");
    requireValue(integer(season.dailyMatchCap, 1, 100), where + " dailyMatchCap");
    requireValue(integer(season.minimumParticipants, 1, 32), where + " minimumParticipants");
    requireValue(integer(season.claimGraceDays, 0, 31), where + " claimGraceDays");
    requireValue(
      season.premium && ["credits", "shards"].includes(season.premium.currency),
      where + " premium.currency (credits or shards)",
    );
    requireValue(integer(season.premium.cost, 0, 100000), where + " premium.cost");
    requireValue(
      Array.isArray(season.tiers) && season.tiers.length >= 1 && season.tiers.length <= 100,
      where + " tiers",
    );
    const tierIds = new Set<string>();
    let before = 0;
    for (const tier of season.tiers) {
      const tierWhere = where + " tier " + tier?.id;
      requireValue(typeof tier?.id === "string" && /^[a-z0-9-]{1,64}$/.test(tier.id), where + " tier id");
      requireValue(!tierIds.has(tier.id), tierWhere + " is listed twice");
      tierIds.add(tier.id);
      requireValue(integer(tier.xp, before + 1, 1000000), tierWhere + " xp (must rise from tier to tier)");
      before = tier.xp;
      validateReward(tier.free, characters, tierWhere + " free");
      validateReward(tier.premium, characters, tierWhere + " premium");
    }
  }
}

/** Key-sorted JSON, so the same policy always freezes to the same text. */
export function canonicalJson(value: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map(key => [key, canonical(record[key])]),
    );
  };
  return JSON.stringify(canonical(value));
}
