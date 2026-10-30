import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gameConfigDirectory } from "../../config/paths.js";
import type { PartyConfig } from "../content/content.types.js";
import { RULE_NAMES } from "./matchmaking.rules.js";
import {
  DEFAULT_PARTY_MEMBERS,
  type BotPolicy,
  type LobbyPolicy,
  type MatchmakingCatalog,
  type PlayerLimits,
  type QueueDefinition,
  type RuleSettings,
} from "./matchmaking.types.js";

export const MATCHMAKING_FILE = "party-matchmaking.json";

/**
 * Where the matchmaking catalog is read from: an explicit path, else next to the exported content bundle the server
 * runs (both are exported together), else the game_config folder used in development.
 */
export function matchmakingCatalogPath(explicitPath?: string, contentBundlePath?: string): string {
  if (explicitPath) return explicitPath;
  if (contentBundlePath) return join(dirname(contentBundlePath), MATCHMAKING_FILE);
  return join(gameConfigDirectory, MATCHMAKING_FILE);
}

export function loadMatchmakingCatalog(path: string, config: PartyConfig): MatchmakingCatalog {
  return validateMatchmakingCatalog(JSON.parse(readFileSync(path, "utf8")), config);
}

function requireValue(ok: unknown, path: string): asserts ok {
  if (!ok) throw new Error("Invalid matchmaking catalog: " + path);
}

const number = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && number(value, min, max);

function validatePlayers(players: PlayerLimits, config: PartyConfig, path: string): void {
  requireValue(integer(players?.max, 1, config.maxPlayers), path + ".players.max");
  requireValue(integer(players.min, 1, players.max), path + ".players.min");
}

function validateBots(bots: BotPolicy, config: PartyConfig, path: string): void {
  requireValue(typeof bots?.fill === "boolean", path + ".bots.fill");
  requireValue(integer(bots.max, -1, config.maxPlayers), path + ".bots.max");
}

function validateLobby(lobby: LobbyPolicy, path: string): void {
  requireValue(number(lobby?.seconds, 0, 600), path + ".lobby.seconds");
  requireValue(typeof lobby.readyCheck === "boolean", path + ".lobby.readyCheck");
  requireValue(typeof lobby.startWhenFull === "boolean", path + ".lobby.startWhenFull");
  requireValue(lobby.hostStart === undefined || typeof lobby.hostStart === "boolean", path + ".lobby.hostStart");
  // Some rule has to start the match.
  requireValue(
    lobby.seconds > 0 || lobby.readyCheck || lobby.startWhenFull || lobby.hostStart === true,
    path + ".lobby (no way to start)",
  );
}

function validateRules(rules: RuleSettings, path: string): void {
  requireValue(rules && typeof rules === "object" && !Array.isArray(rules), path + ".rules");
  for (const name of Object.keys(rules)) requireValue(RULE_NAMES.includes(name as never), path + ".rules." + name);
  for (const name of RULE_NAMES) {
    const enabled = rules[name]?.enabled;
    requireValue(enabled === undefined || typeof enabled === "boolean", path + ".rules." + name + ".enabled");
  }
  if (rules.skill) {
    const skill = rules.skill;
    requireValue(skill.metric === "level" || skill.metric === "wins", path + ".rules.skill.metric");
    requireValue(number(skill.range, 0, 1e6), path + ".rules.skill.range");
    requireValue(number(skill.widenPerSecond, 0, 1e6), path + ".rules.skill.widenPerSecond");
    requireValue(number(skill.maxRange, skill.range, 1e6), path + ".rules.skill.maxRange");
  }
  if (rules.region) requireValue(number(rules.region.relaxSeconds, -1, 3600), path + ".rules.region.relaxSeconds");
  if (rules.account) requireValue(typeof rules.account.required === "boolean", path + ".rules.account.required");
}

function validateQueue(queue: QueueDefinition, config: PartyConfig, path: string): void {
  requireValue(typeof queue?.id === "string" && /^[A-Za-z0-9-]{1,32}$/.test(queue.id), path + ".id");
  requireValue(
    config.modes.some(mode => mode.id === queue.mode),
    path + ".mode",
  );
  validatePlayers(queue.players, config, path);
  requireValue(number(queue.search?.seconds, 0, 3600), path + ".search.seconds");
  requireValue(typeof queue.search.startShort === "boolean", path + ".search.startShort");
  validateBots(queue.bots, config, path);
  validateLobby(queue.lobby, path);
  requireValue(typeof queue.backfill?.enabled === "boolean", path + ".backfill.enabled");
  requireValue(number(queue.backfill.minLobbySeconds, 0, 600), path + ".backfill.minLobbySeconds");
  validateRules(queue.rules, path);
}

/** Throws unless every queue is well formed and plays a mode of the gameplay catalog. Returns the catalog. */
export function validateMatchmakingCatalog(catalog: MatchmakingCatalog, config: PartyConfig): MatchmakingCatalog {
  requireValue(catalog?.version === 1, "version");
  requireValue(Array.isArray(catalog.queues) && catalog.queues.length > 0 && catalog.queues.length <= 64, "queues");
  const ids = new Set<string>();
  catalog.queues.forEach((queue, index) => {
    validateQueue(queue, config, `queues[${index}]`);
    requireValue(!ids.has(queue.id), `queues[${index}].id (duplicate)`);
    ids.add(queue.id);
  });
  requireValue(
    catalog.privateRooms?.listed === undefined || typeof catalog.privateRooms.listed === "boolean",
    "privateRooms.listed",
  );
  validatePlayers(catalog.privateRooms?.players, config, "privateRooms");
  validateBots(catalog.privateRooms.bots, config, "privateRooms");
  validateLobby(catalog.privateRooms.lobby, "privateRooms");
  catalog.parties ??= { maxMembers: DEFAULT_PARTY_MEMBERS };
  requireValue(integer(catalog.parties?.maxMembers, 1, 16), "parties.maxMembers (a whole number from 1 to 16)");
  return catalog;
}
