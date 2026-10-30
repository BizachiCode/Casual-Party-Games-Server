import type { BotProfile, BotSettings, CourseDefinition, SkillDefinition } from "../../content/content.types.js";
import { hazardPosition, platformPosition } from "./course-rules.js";
import type { Runner } from "./runner.js";
import { SKILL_READY, type SkillWorld, actionReady, skillKinds } from "./skills/index.js";

// Bots play by habits drawn when they join and by decisions drawn on every platform, all from a seeded stream of their
// own, so the server and the offline simulation (Core/Simulation/PartyBots.cs) make the same mistakes on the same
// ticks. Decisions only use + - * /, sqrt and the course's own motion, which keeps both engines bit-identical.

/** Where a race bot takes off before a platform edge when its jump is perfect, in metres. */
const TAKE_OFF = 1.5;
/** Hops per second in the arenas. */
const ARENA_HOPS = 0.7;
/** Distance a lane keeps from the side of a platform, in metres. */
const EDGE_MARGIN = 0.6;
/** Seconds a race bot pushes against a wall or a ledge before it jumps. */
const STUCK_JUMP = 0.4;
/** How far ahead a race bot watches for logs rolling at it, in metres. */
const LOG_WATCH = 9;
/** Room a dodging bot leaves between itself and the end of a log, in metres. */
const LOG_CLEARANCE = 1.2;

/** A bot's habits for the whole match and the decisions it made for the platform it stands on. */
export interface BotBrain {
  profile: BotProfile;
  seed: number;
  /** Fraction of full stick it runs at. */
  speed: number;
  /** Where its sway and its orbit start, in seconds of an 8 s cycle. */
  phase: number;
  orbitRadius: number;
  /** Radians per second; negative orbits the other way. */
  orbitSpeed: number;
  /** The platform the decisions below belong to; -1 before the first. */
  floor: number;
  /** Offset from the centre line it keeps on this platform. */
  lane: number;
  /** Distance before the edge it jumps at, and whether it forgets to. */
  jumpLead: number;
  missJump: boolean;
  /** Whether it dives across the gap after this platform. */
  dive: boolean;
  /** The x it steers to; kept while airborne. */
  target: number;
  /** Match time its current hesitation ends. */
  pauseUntil: number;
  /** Seconds it has been pushing on without getting anywhere, against a wall or a ledge. */
  stuck: number;
  /** The log rolling at it (a hazard index, -1 for none) and whether it noticed that one. */
  threat: number;
  dodge: boolean;
  /** The tick of the last hit it reacted to. */
  hitTick: number;
}

/** What a bot reads from the match to steer. */
export interface BotWorld extends SkillWorld {
  course: CourseDefinition;
  dt: number;
  /** Per platform: -1 while intact, otherwise the match time it disappears. */
  collapses: number[];
  /** Per pickup: the match time it is collectable again. */
  pickups: number[];
  runners: readonly Runner[];
  /** The action button's skill, if the catalog has one. */
  action: SkillDefinition | undefined;
}

/** One step of the 32-bit linear congruential generator both engines share. */
export function nextSeed(seed: number): number {
  return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}

/** Spreads a seed's bits, so streams started from consecutive values of one generator are unrelated. */
export function scramble(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

/** The bot's next number in [0, 1). */
function draw(brain: BotBrain): number {
  brain.seed = nextSeed(brain.seed);
  return brain.seed / 4294967296;
}

/** Gives a new bot a profile picked by weight, its own habits and a colour. */
export function equipBot(bot: Runner, settings: BotSettings, seed: number): void {
  const profiles = settings.profiles;
  const brain: BotBrain = {
    profile: profiles[profiles.length - 1],
    seed: scramble(seed),
    speed: 1,
    phase: 0,
    orbitRadius: 0,
    orbitSpeed: 0,
    floor: -1,
    lane: 0,
    jumpLead: TAKE_OFF,
    missJump: false,
    dive: false,
    target: 0,
    pauseUntil: 0,
    stuck: 0,
    threat: -1,
    dodge: false,
    hitTick: 0,
  };
  let total = 0;
  for (const profile of profiles) total += profile.weight;
  let pick = draw(brain) * total;
  for (const profile of profiles) {
    if (pick < profile.weight) {
      brain.profile = profile;
      break;
    }
    pick -= profile.weight;
  }
  const profile = brain.profile;
  brain.speed = profile.speedMin + draw(brain) * (profile.speedMax - profile.speedMin);
  brain.phase = draw(brain) * 8;
  brain.orbitRadius = 1.2 + draw(brain) * 1.6;
  brain.orbitSpeed = 0.5 + draw(brain) * 0.6;
  if (draw(brain) < 0.5) brain.orbitSpeed = -brain.orbitSpeed;
  bot.color = Math.floor(draw(brain) * 8);
  bot.brain = brain;
}

/**
 * Forgets what a bot decided before it was put back on a spot, at the start of a round or after a fall. Its pause, its
 * platform and its threat are measured in the previous round's clock and course, so left alone a bot would stand still
 * until the new round's clock caught up; and a jump it forgot to make on a platform would be forgotten on every try.
 */
export function resetBrain(brain: BotBrain): void {
  brain.floor = -1;
  brain.target = 0;
  brain.pauseUntil = 0;
  brain.stuck = 0;
  brain.threat = -1;
  brain.dodge = false;
}

/** Writes this tick's stick and buttons for a bot, the same input a player sends. */
export function steerBot(bot: Runner, world: BotWorld): void {
  const brain = bot.brain;
  const profile = brain.profile;
  bot.jump = false;
  bot.dive = false;
  // Now and then a bot stops for a moment, more often the less skilled it is.
  if (bot.grounded && world.elapsed >= brain.pauseUntil && draw(brain) < profile.pauseChance * world.dt)
    brain.pauseUntil = world.elapsed + profile.pauseSeconds * (0.5 + draw(brain));
  if (world.elapsed < brain.pauseUntil) {
    bot.inputX = 0;
    bot.inputZ = 0;
    return;
  }
  if (world.course.kind === "race") steerRace(bot, brain, world);
  else steerArena(bot, brain, world);
  const length = Math.sqrt(bot.inputX * bot.inputX + bot.inputZ * bot.inputZ);
  if (length > 1) {
    bot.inputX /= length;
    bot.inputZ /= length;
  }
  // A slower bot only runs slower: in the air it pushes the stick all the way, like a player, so it clears the gaps.
  // The same goes for wind and a belt running against it: a half-hearted push there would only hold it in place.
  if (bot.grounded && !bot.jump && !carriedBack(bot, world.course)) {
    bot.inputX *= brain.speed;
    bot.inputZ *= brain.speed;
  }
  // The action button (a punch) when it is ready and would reach someone, as often as the profile says.
  const action = world.action;
  if (
    action &&
    actionReady(bot, action, world.tick, world.tickRate) &&
    skillKinds[action.kind].useful?.(bot, world.runners, action, world) &&
    draw(brain) < profile.actionChance * world.dt
  )
    bot.action = true;
}

/**
 * Race bots run forward in a lane of their own and take off before each platform edge. How far before, whether they
 * forget, and whether they dive over the gap are drawn per platform from their profile.
 */
function steerRace(bot: Runner, brain: BotBrain, { course, elapsed, dt }: BotWorld): void {
  const profile = brain.profile;
  const floor = bot.grounded ? course.platforms[bot.groundIndex] : undefined;
  // Knocked back: try another lane on the way back.
  if (bot.hitTick !== brain.hitTick) {
    brain.hitTick = bot.hitTick;
    brain.floor = -1;
  }
  if (floor && bot.groundIndex !== brain.floor) {
    brain.floor = bot.groundIndex;
    brain.lane = (draw(brain) * 2 - 1) * profile.lane;
    brain.jumpLead = TAKE_OFF + (draw(brain) * 2 - 1) * profile.jumpError;
    brain.missJump = draw(brain) < profile.missChance;
    brain.dive = draw(brain) < profile.diveChance;
  }
  if (bot.grounded) {
    brain.target = brain.lane + profile.sway * wave(elapsed * 0.5 + brain.phase);
    // A log rolling down its lane: notice it (or not), then step aside to the nearer end until it has passed.
    const log = rollingAt(course, brain.target, bot, elapsed);
    if (log >= 0 && log !== brain.threat) brain.dodge = draw(brain) < profile.dodgeChance;
    brain.threat = log;
    if (log >= 0 && brain.dodge) {
      const hazard = course.hazards[log];
      const position = hazardPosition(hazard, elapsed);
      const span = (hazard.length || 0) / 2 + hazard.radius + LOG_CLEARANCE;
      brain.target = brain.target <= position.x ? position.x - span : position.x + span;
    }
    if (floor) {
      const center = platformPosition(floor, elapsed);
      const room = Math.max(0, floor.width / 2 - EDGE_MARGIN);
      brain.target = Math.max(center.x - room, Math.min(center.x + room, brain.target));
      bot.jump = !brain.missJump && center.z + floor.depth / 2 - bot.z < brain.jumpLead;
    }
    // Blocked by a wall or a ledge in the middle of a platform: hop up after a moment.
    brain.stuck = bot.vz < 1 ? brain.stuck + dt : 0;
    if (brain.stuck >= STUCK_JUMP) {
      bot.jump = true;
      brain.stuck = 0;
    }
  } else {
    // Stretch a jump over a gap with a dive once the runner starts dropping.
    bot.dive =
      brain.dive && bot.vy < 1 && bot.skillPhase === SKILL_READY && !bot.skillUsed && !overPlatform(course, bot.z);
  }
  bot.inputX = clamp((brain.target - bot.x) * 0.7);
  bot.inputZ = 1;
}

/**
 * Arena bots orbit the middle at their own radius, pace and direction, hop now and then, and head for coins, the hill
 * or tiles still standing.
 */
function steerArena(bot: Runner, brain: BotBrain, { course, elapsed, dt, collapses, pickups }: BotWorld): void {
  const angle = elapsed * brain.orbitSpeed + brain.phase;
  let targetX = Math.cos(angle) * brain.orbitRadius;
  let targetZ = Math.sin(angle) * brain.orbitRadius;
  let found = -1;
  if (course.kind === "collect") found = nearest(course.pickups || [], bot, index => elapsed >= pickups[index]);
  if (course.kind === "tiles") found = nearest(course.platforms, bot, index => collapses[index] < 0);
  if (found >= 0) {
    const item = course.kind === "collect" ? course.pickups[found] : course.platforms[found];
    targetX = item.x;
    targetZ = item.z;
  }
  if (course.kind === "hill") {
    targetX = Math.cos(angle);
    targetZ = Math.sin(angle);
  }
  bot.inputX = clamp(targetX - bot.x);
  bot.inputZ = clamp(targetZ - bot.z);
  bot.jump = bot.grounded && draw(brain) < ARENA_HOPS * dt;
}

/** Whether the wind or a belt running backwards is pushing a grounded bot back. */
function carriedBack(bot: Runner, course: CourseDefinition): boolean {
  const floor = course.platforms[bot.groundIndex];
  return bot.inWind || (floor !== undefined && (floor.conveyorZ || 0) < 0);
}

/** The nearest log ahead rolling back down the course across this lane, or -1. */
function rollingAt(course: CourseDefinition, lane: number, bot: Runner, elapsed: number): number {
  let best = -1;
  let bestAhead = 0;
  course.hazards.forEach((hazard, index) => {
    if (hazard.kind !== "roll" || !((hazard.travelZ || 0) < 0)) return;
    const position = hazardPosition(hazard, elapsed);
    if (!position.active) return;
    const ahead = position.z - bot.z;
    const span = (hazard.length || 0) / 2 + hazard.radius + LOG_CLEARANCE;
    if (ahead < -1 || ahead > LOG_WATCH || Math.abs(position.y - bot.y) > 4 || Math.abs(lane - position.x) > span)
      return;
    if (best < 0 || ahead < bestAhead) {
      best = index;
      bestAhead = ahead;
    }
  });
  return best;
}

/** Index of the closest item that passes the filter, the first on a tie; -1 when none does. */
function nearest(items: { x: number; z: number }[], bot: Runner, usable: (index: number) => boolean): number {
  let best = -1;
  let bestDistance = 0;
  items.forEach((item, index) => {
    if (!usable(index)) return;
    const distance = (item.x - bot.x) * (item.x - bot.x) + (item.z - bot.z) * (item.z - bot.z);
    if (best < 0 || distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** Whether any platform spans this z, wherever it sits sideways. */
function overPlatform(course: CourseDefinition, z: number): boolean {
  return course.platforms.some(
    platform => z >= platform.z - platform.depth / 2 && z <= platform.z + platform.depth / 2,
  );
}

/** A triangle wave between -1 and 1 with a period of 4. */
function wave(time: number): number {
  return Math.abs((time % 4) - 2) - 1;
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
