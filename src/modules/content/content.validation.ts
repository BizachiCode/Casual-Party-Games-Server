import { validateField } from "../match/simulation/fields/index.js";
import { validateHazard } from "../match/simulation/hazards/index.js";
import { skillKinds } from "../match/simulation/skills/index.js";
import type { CharacterCatalog, CourseDefinition, GoalCatalog, PartyConfig, PartyContent } from "./content.types.js";

// Mirrors Assets/CasualPartyMultiplayer/Core/Content/ContentValidator.cs; test:content-parity checks both reject the
// same catalogs. Every rule names the field it guards.

export const PROTOCOL = 7;

function requireValue(ok: unknown, path: string): asserts ok {
  if (!ok) throw new Error("Invalid content: " + path);
}

function number(value: unknown, min: number, max: number, path: string): void {
  requireValue(typeof value === "number" && Number.isFinite(value) && value >= min && value <= max, path);
}

function integer(value: unknown, min: number, max: number, path: string): void {
  number(value, min, max, path);
  requireValue(Number.isSafeInteger(value), path);
}

function label(value: unknown, path: string): void {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= 120, path);
}

/**
 * What a kind module (a skill, hazard or field kind) uses to check its own definition fields, with the same rules and
 * messages as the rest of the catalog. The C# twin is ContentCheck in Core/Content/ContentValidator.cs.
 */
export interface ContentCheck {
  number(value: unknown, min: number, max: number, path: string): void;
  require(ok: unknown, path: string): void;
}
const check: ContentCheck = { number, require: requireValue };

function list<T>(value: T[], min: number, max: number, path: string): T[] {
  requireValue(Array.isArray(value) && value.length >= min && value.length <= max, path);
  return value;
}

/** Checks that every item has a well-formed, unique id (or `key`) and returns the ids. */
function unique(items: unknown[], path: string, max = 256, key = "id"): Set<string> {
  list(items, 1, max, path);
  const ids = new Set<string>();
  for (const item of items) {
    const id = (item as Record<string, unknown>)?.[key];
    requireValue(
      typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(id) && !ids.has(id),
      path + " unique id",
    );
    ids.add(id as string);
  }
  return ids;
}

function validateGameplay(config: PartyConfig): void {
  requireValue(config.protocol === PROTOCOL, `protocol (expected ${PROTOCOL})`);
  label(config.revision, "revision");
  integer(config.tickRate, 10, 60, "tickRate");
  integer(config.maxPlayers, 4, 32, "maxPlayers");
  integer(config.matchSize, 1, config.maxPlayers, "matchSize");
  for (const key of ["raceSeconds", "survivalSeconds", "countdownSeconds", "resultSeconds", "scoreSeconds"] as const) {
    number(config[key], 0.1, 3600, key);
  }
  for (const key of ["speed", "acceleration", "gravity", "jumpSpeed"] as const) number(config[key], 0.1, 200, key);
  number(config.radius, 0.1, 2, "radius");
  number(config.height, 0.2, 5, "height");
  validateSkills(config);
  validateBots(config);
  validateSpawn(config);
  validateRoom(config);
  validateRoundDraw(config);

  const courseIds = unique(config.courses, "courses", 128);
  const hasRace = config.courses.some(course => course.kind === "race");
  const hasSurvival = config.courses.some(course => ["survival", "lava", "tiles"].includes(course.kind));
  requireValue(hasRace && hasSurvival, "race and survival courses required");
  for (const course of config.courses) validateCourse(course);

  const playlistIds = unique(config.playlists, "playlists");
  requireValue(playlistIds.has("classic"), "classic playlist required");
  for (const playlist of config.playlists) {
    label(playlist.title, "playlist.title");
    requireValue(playlist.shuffle === undefined || typeof playlist.shuffle === "boolean", "shuffle");
    list(playlist.courseIds, playlist.shuffle ? 0 : 1, 32, "playlist rounds");
    for (const id of playlist.courseIds) requireValue(courseIds.has(id), "playlist course " + id);
  }

  const modeIds = unique(config.modes, "modes");
  const expectedModes = ["tournament", "race", "survival", "arcade", "timeTrial", "duos", "squads"];
  requireValue(modeIds.size === expectedModes.length && expectedModes.every(id => modeIds.has(id)), "supported modes");
  for (const mode of config.modes) {
    label(mode.title, "mode.title");
    const teamSize = mode.id === "duos" ? 2 : mode.id === "squads" ? 4 : 1;
    requireValue(mode.teamSize === teamSize, "mode.teamSize");
  }
}

function validateSkills(config: PartyConfig): void {
  const skillIds = unique(config.skills, "skills", 32);
  for (const skill of config.skills) {
    requireValue(Object.hasOwn(skillKinds, skill.kind), skill.id + ".kind");
    number(skill.cooldownSeconds, 0, 30, skill.id + ".cooldownSeconds");
    skillKinds[skill.kind].validate(skill, check);
  }
  // Each button uses a skill of its own slot; the action button may have none.
  const slotOf = (id: string) => skillKinds[config.skills.find(skill => skill.id === id)?.kind]?.slot;
  requireValue(skillIds.has(config.skill) && slotOf(config.skill) === "dive", "skill (dive button skill id)");
  requireValue(!config.action || slotOf(config.action) === "action", "action (action button skill id)");
}

function validateBots(config: PartyConfig): void {
  const bots = config.bots;
  requireValue(bots && typeof bots === "object", "bots");
  number(bots.joinDelay, 0, 60, "bots.joinDelay");
  number(bots.joinIntervalMin, 0.05, 30, "bots.joinIntervalMin");
  number(bots.joinIntervalMax, bots.joinIntervalMin, 30, "bots.joinIntervalMax");
  unique(bots.profiles, "bots.profiles", 16);
  let weight = 0;
  for (const profile of bots.profiles) {
    number(profile.weight, 0, 1000, profile.id + ".weight");
    weight += profile.weight;
    number(profile.speedMin, 0.3, 1, profile.id + ".speedMin");
    number(profile.speedMax, profile.speedMin, 1, profile.id + ".speedMax");
    number(profile.lane, 0, 5, profile.id + ".lane");
    number(profile.sway, 0, 5, profile.id + ".sway");
    number(profile.jumpError, 0, 3, profile.id + ".jumpError");
    number(profile.missChance, 0, 1, profile.id + ".missChance");
    number(profile.diveChance, 0, 1, profile.id + ".diveChance");
    number(profile.dodgeChance, 0, 1, profile.id + ".dodgeChance");
    number(profile.actionChance, 0, 10, profile.id + ".actionChance");
    number(profile.pauseChance, 0, 2, profile.id + ".pauseChance");
    number(profile.pauseSeconds, 0, 5, profile.id + ".pauseSeconds");
  }
  requireValue(weight > 0, "bots.profiles weight");
}

function validateSpawn(config: PartyConfig): void {
  const spawn = config.spawn;
  requireValue(spawn && typeof spawn === "object", "spawn");
  const rows = ["startPerRow", "checkpointPerRow", "arenaPerRow"] as const;
  const gaps = ["startColumnGap", "startRowGap", "checkpointColumnGap", "checkpointRowGap", "arenaGap"] as const;
  for (const key of rows) integer(spawn[key], 1, 64, "spawn." + key);
  for (const key of gaps) number(spawn[key], 0.1, 20, "spawn." + key);
  number(spawn.startStagger, 0, 20, "spawn.startStagger");
}

const COURSE_KINDS = ["race", "survival", "lava", "tiles", "collect", "hill"];

function validateRoundDraw(config: PartyConfig): void {
  const draw = config.roundDraw;
  requireValue(draw && typeof draw === "object", "roundDraw");
  number(draw.revealSeconds, 0, 10, "roundDraw.revealSeconds");
  list(draw.rounds, 1, 8, "roundDraw.rounds").forEach((round, index) => {
    const path = "roundDraw.rounds[" + index + "]";
    const listed = round?.courseIds === undefined ? [] : list(round.courseIds, 0, 64, path + ".courseIds");
    for (const id of listed)
      requireValue(
        config.courses?.some(course => course.id === id),
        path + ".courseIds (" + id + ")",
      );
    const kinds = list(round?.kinds, listed.length ? 0 : 1, COURSE_KINDS.length, path + ".kinds");
    for (const kind of kinds) requireValue(COURSE_KINDS.includes(kind), path + ".kinds (" + kind + ")");
    requireValue(
      listed.length > 0 || config.courses?.some(course => kinds.includes(course.kind)),
      path + " (no course of these kinds)",
    );
  });
}

function validateRoom(config: PartyConfig): void {
  const room = config.room;
  requireValue(room && typeof room === "object", "room");
  integer(room.reconnectSeconds, 1, 60, "room.reconnectSeconds");
  number(room.closeAfterFinishSeconds, 1, 600, "room.closeAfterFinishSeconds");
}

function validateCourse(course: CourseDefinition): void {
  label(course.title, course.id + ".title");
  requireValue(COURSE_KINDS.includes(course.kind), course.id + ".kind");
  for (const platform of list(course.platforms, 1, 512, course.id + ".platforms")) {
    requireValue(platform, "platform");
    number(platform.x, -10000, 10000, "platform.x");
    number(platform.z, -10000, 10000, "platform.z");
    number(platform.y ?? 0, 0, 40, "platform.y");
    number(platform.rise ?? 0, -20, 20, "platform.rise");
    requireValue(Math.abs(platform.rise ?? 0) <= platform.depth * 1.2, "platform.rise slope");
    number(platform.height ?? 0, 0, 100, "platform.height");
    number(platform.width, 0.1, 1000, "platform.width");
    number(platform.depth, 0.1, 1000, "platform.depth");
    for (const key of ["motionX", "motionY", "motionZ", "conveyorX", "conveyorZ"] as const)
      number(platform[key] ?? 0, -100, 100, key);
    const lowest = (platform.y ?? 0) - Math.abs(platform.rise ?? 0) / 2 - Math.abs(platform.motionY ?? 0);
    requireValue(lowest >= 0, "platform top never below y=0");
    number(platform.motionSpeed ?? 0, 0, 30, "motionSpeed");
    number(platform.motionPhase ?? 0, -1000, 1000, "motionPhase");
    number(platform.slippery ?? 0, 0, 1, "slippery");
    number(platform.vanishDelay ?? 0, 0, 120, "vanishDelay");
  }
  for (const hazard of list(course.hazards, 0, 256, course.id + ".hazards")) validateHazard(hazard, check);
  for (const field of list(course.fields ?? [], 0, 64, course.id + ".fields")) validateField(field, check);
  list(course.checkpoints, 1, 256, "checkpoints");
  requireValue(course.checkpoints[0] === 0, "checkpoints start at 0");
  course.checkpoints.forEach((checkpoint, index) => {
    number(checkpoint, 0, 10000, "checkpoint");
    requireValue(index === 0 || checkpoint > course.checkpoints[index - 1], "checkpoint order");
  });
  number(course.finish ?? 0, 0, 10000, "finish");
  if (course.kind === "race") requireValue(course.finish > course.checkpoints.at(-1), "finish after checkpoints");
  number(course.lavaStart ?? 0, -100, 0, "lavaStart");
  number(course.lavaSpeed ?? 0, 0, 10, "lavaSpeed");
  number(course.hillRadius ?? 0, 0, 100, "hillRadius");
  number(course.targetScore ?? 0, 0, 100000, "targetScore");
  if (course.kind === "hill") requireValue(course.hillRadius > 0, "hillRadius");
  list(course.pickups, 0, 256, "pickups");
  if (course.kind === "collect")
    requireValue(course.pickups.length && course.targetScore > 0, "collection pickups and targetScore");
  for (const pickup of course.pickups) {
    requireValue(pickup, "pickup");
    for (const key of ["x", "y", "z"] as const) number(pickup[key], -10000, 10000, "pickup." + key);
    number(pickup.value, 1, 1000, "pickup.value");
    number(pickup.respawnSeconds, 0.1, 120, "pickup.respawnSeconds");
  }
}

function validateCharacters(catalog: CharacterCatalog): void {
  const rarities = ["common", "rare", "epic", "legendary"];
  requireValue(catalog.version === 1, "characters.version");
  label(catalog.currency, "currency");
  integer(catalog.initialCredits, 0, 1000000, "initialCredits");
  integer(catalog.dailyCredits, 1, 1000000, "dailyCredits");
  const characterIds = unique(catalog.characters, "characters", 2048);
  requireValue(characterIds.has(catalog.starterId), "starterId");
  for (const character of catalog.characters) {
    label(character.name, "character.name");
    requireValue(rarities.includes(character.rarity), "character.rarity");
    requireValue(
      [undefined, null, "", "cap", "visor", "crown", "ears", "halo"].includes(character.accessory),
      "character.accessory",
    );
    list(character.color, 3, 3, "character.color");
    for (const channel of character.color) number(channel, 0, 1, "character.color");
    integer(character.duplicateShards, 0, 1000000, "duplicateShards");
    integer(character.craftCost, 1, 1000000, "craftCost");
  }
  unique(catalog.banners, "banners", 32);
  for (const banner of catalog.banners) {
    label(banner.title, "banner.title");
    integer(banner.cost, 1, 1000000, "banner.cost");
    integer(banner.tenCost, 1, banner.cost * 10, "banner.tenCost");
    integer(banner.epicPity, 1, 10000, "epicPity");
    integer(banner.legendaryPity, banner.epicPity, 10000, "legendaryPity");
    const weighted = unique(banner.weights, "weights", 4, "rarity");
    requireValue(
      weighted.size === 4 && rarities.every(rarity => weighted.has(rarity)),
      "all four rarity weights required for pity",
    );
    for (const weight of banner.weights) {
      integer(weight.weight, 1, 1000000, "weight");
      requireValue(
        catalog.characters.some(character => character.rarity === weight.rarity),
        "empty rarity pool",
      );
    }
  }
}

function validateGoals(catalog: GoalCatalog): void {
  requireValue(catalog.version === 1, "goals.version");
  unique(catalog.goals, "goals", 512);
  for (const goal of catalog.goals) {
    requireValue(/^[a-z0-9-]+$/.test(goal.id), "goal.id");
    label(goal.title, "goal.title");
    requireValue(["daily", "weekly", "achievement"].includes(goal.scope), "goal.scope");
    const metrics =
      goal.scope === "achievement" ? ["matches", "wins", "level", "collection"] : ["matches", "wins", "teams"];
    requireValue(metrics.includes(goal.metric), "goal.metric");
    integer(goal.target, 1, 1000000, "goal.target");
    integer(goal.credits, 0, 1000000, "goal.credits");
    integer(goal.xp, 0, 1000000, "goal.xp");
    integer(goal.passXp ?? 0, 0, 10000, "goal.passXp");
  }
}

/** Validates the three catalogs together (goals and seasons reference characters) and returns them typed. */
export function validateCatalogs(
  config: PartyConfig,
  characterCatalog: CharacterCatalog,
  goalCatalog: GoalCatalog,
): PartyContent {
  requireValue(config && characterCatalog && goalCatalog, "catalogs");
  validateGameplay(config);
  validateCharacters(characterCatalog);
  validateGoals(goalCatalog);
  return { config, characterCatalog, goalCatalog };
}
