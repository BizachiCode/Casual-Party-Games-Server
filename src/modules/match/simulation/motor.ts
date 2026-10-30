import type { CourseDefinition, PartyConfig, SkillDefinition } from "../../content/content.types.js";
import { platformPosition, platformTop } from "./course-rules.js";
import { applyFields } from "./fields/index.js";
import { hitHazards } from "./hazards/index.js";
import type { Runner } from "./runner.js";
import {
  SKILL_ACTIVE,
  SKILL_LANDED,
  SKILL_READY,
  advanceSkill,
  landSkill,
  slideSkill,
  startSkill,
  triggerAction,
} from "./skills/index.js";
import { planarLength } from "./planar-length.js";

/** Everything outside the runner that one movement step reads (and the platform collapse timers it may start). */
export interface MotorWorld {
  config: PartyConfig;
  course: CourseDefinition;
  /** The dive button's skill. */
  skill: SkillDefinition;
  /** The action button's skill, if the catalog has one. */
  action?: SkillDefinition;
  /** Per platform: -1 while intact, otherwise the match time it disappears. */
  collapses: number[];
  elapsed: number;
  tick: number;
  dt: number;
}

/** A grounded runner walks up onto a top this much higher (stairs, ramps, a rising lift)... */
const STEP_UP = 0.45;
/** ...and keeps its feet on a top this much lower (going down a ramp or a step). */
const SNAP_DOWN = 0.6;

/**
 * One fixed movement step: course fields, jump, skills, steering, platforms and hazards. The Unity client runs the
 * same step to predict its own runner (Core/Simulation/PartyMotor.cs), so keep both in sync; test:parity compares them.
 * Course fields, hazards and skills live in their own folders, one file per kind. Returns true when the runner fell
 * out of the course (below the floor or into the lava).
 */
export function move(runner: Runner, world: MotorWorld): boolean {
  const { config, course, skill, elapsed, tick, dt } = world;
  const previousFloor = course.platforms[runner.groundIndex];
  if (runner.grounded && previousFloor) {
    const before = platformPosition(previousFloor, elapsed - dt);
    const after = platformPosition(previousFloor, elapsed);
    runner.x += after.x - before.x;
    runner.y += after.y - before.y;
    runner.z += after.z - before.z;
  }
  applyFields(runner, course, elapsed, tick);
  advanceSkill(runner, skill, tick, config.tickRate);
  if (runner.jump && runner.grounded && !runner.knockedDown && runner.skillPhase === SKILL_READY) {
    runner.vy = config.jumpSpeed;
    runner.grounded = false;
    runner.jumpTick = tick;
  }
  if (runner.dive) startSkill(runner, skill, tick);
  triggerAction(runner, world.action, tick, config.tickRate, elapsed);
  runner.jump = false;
  runner.dive = false;

  // Steering: only a runner in control accelerates toward its stick; diving and lying runners keep their momentum.
  if (runner.skillPhase === SKILL_READY && !runner.knockedDown && elapsed >= runner.hitUntil) {
    const acceleration = config.acceleration * (1 - (previousFloor?.slippery || 0));
    const approach = (velocity: number, target: number) =>
      velocity + Math.max(-acceleration * dt, Math.min(acceleration * dt, target - velocity));
    // Same multiplication order as the C# motor, so prediction stays bit-identical.
    const boost = elapsed < runner.boostUntil ? runner.boostFactor : 1;
    runner.vx = approach(runner.vx, runner.inputX * config.speed * runner.slimeFactor * boost);
    runner.vz = approach(runner.vz, runner.inputZ * config.speed * runner.slimeFactor * boost);
    const stickLength = planarLength(runner.inputX, runner.inputZ);
    if (stickLength > 0.1) {
      runner.facingX = runner.inputX / stickLength;
      runner.facingZ = runner.inputZ / stickLength;
    }
  } else {
    slideSkill(runner, skill, dt);
  }

  integrate(runner, world, previousFloor);
  if (runner.grounded) landSkill(runner, skill, tick, config.tickRate);
  runner.dashing = runner.skillPhase === SKILL_ACTIVE || runner.skillPhase === SKILL_LANDED;
  if (runner.grounded && elapsed >= runner.hitUntil) runner.knockedDown = false;
  hitHazards(runner, config, course, elapsed, tick);
  const inLava = course.kind === "lava" && runner.y < course.lavaStart + elapsed * course.lavaSpeed;
  return runner.y < -8 || inLava;
}

/**
 * Gravity, motion, conveyors and solid sides, then landing on the highest top crossed this step. A runner that was
 * grounded also walks up a step or a ramp and keeps its feet on a top that drops away below it.
 */
function integrate(runner: Runner, world: MotorWorld, previousFloor: CourseDefinition["platforms"][number]): void {
  const { course, collapses, elapsed, tick, dt } = world;
  const wasGrounded = runner.grounded;
  const previousY = runner.y;
  const previousZ = runner.z;
  runner.vy -= world.config.gravity * dt;
  runner.x += (runner.vx + runner.windX) * dt;
  runner.y += runner.vy * dt;
  runner.z += (runner.vz + runner.windZ) * dt;
  if (previousFloor && runner.grounded) {
    runner.x += (previousFloor.conveyorX || 0) * dt;
    runner.z += (previousFloor.conveyorZ || 0) * dt;
  }
  // Survival arenas shrink by a quarter metre per second after the first eight seconds.
  const shrink = course.kind === "survival" ? Math.max(0, elapsed - 8) * 0.25 : 0;
  blockSides(runner, world, shrink);
  runner.grounded = false;
  runner.groundIndex = -1;
  let highest: number | undefined;
  for (let index = 0; index < course.platforms.length; index++) {
    const top = landingTop(runner, world, index, shrink, previousY, previousZ, wasGrounded);
    if (top !== undefined && (highest === undefined || top > highest)) highest = top;
  }
  if (highest === undefined) return;
  for (const [index, platform] of course.platforms.entries()) {
    if (landingTop(runner, world, index, shrink, previousY, previousZ, wasGrounded) !== highest) continue;
    if (!wasGrounded && runner.vy < -0.1) {
      runner.landTick = tick;
      runner.landSpeed = -runner.vy;
    }
    runner.y = highest;
    runner.vy = 0;
    runner.grounded = true;
    runner.skillUsed = false;
    runner.groundIndex = index;
    if (platform.vanishDelay > 0 && collapses[index] < 0) collapses[index] = elapsed + platform.vanishDelay;
  }
}

/** The top a runner would stand on over this platform this step, or undefined. */
function landingTop(
  runner: Runner,
  { config, course, collapses, elapsed }: MotorWorld,
  index: number,
  shrink: number,
  previousY: number,
  previousZ: number,
  wasGrounded: boolean,
): number | undefined {
  const platform = course.platforms[index];
  if (collapses[index] >= 0 && elapsed >= collapses[index]) return undefined;
  const center = platformPosition(platform, elapsed);
  const overX = Math.abs(runner.x - center.x) <= platform.width / 2 - shrink + config.radius * 0.5;
  const overZ = Math.abs(runner.z - center.z) <= platform.depth / 2 - shrink + config.radius * 0.5;
  if (!overX || !overZ) return undefined;
  const top = platformTop(platform, center, runner.z);
  // Crossed: above the surface where it was, at or below it where it is. On a ramp the surface can rise under a runner
  // moving uphill faster than the runner rises, so this holds whatever way the runner is moving.
  const crossed = previousY >= platformTop(platform, center, previousZ) - 0.01 && runner.y <= top;
  const held = wasGrounded && top <= previousY + STEP_UP && top >= previousY - SNAP_DOWN;
  return crossed || held ? top : undefined;
}

/**
 * Solid platforms (a height above 0) stop a runner whose feet are lower than a step below their top: it is pushed out
 * through the nearest side and loses the speed that drove it in, so it slides along walls and ledges.
 */
function blockSides(runner: Runner, { config, course, collapses, elapsed }: MotorWorld, shrink: number): void {
  for (const [index, platform] of course.platforms.entries()) {
    if (!platform.height || (collapses[index] >= 0 && elapsed >= collapses[index])) continue;
    const center = platformPosition(platform, elapsed);
    const top = platformTop(platform, center, runner.z);
    if (runner.y >= top - STEP_UP || runner.y + config.height <= top - platform.height) continue;
    const halfX = platform.width / 2 - shrink + config.radius * 0.5;
    const halfZ = platform.depth / 2 - shrink + config.radius * 0.5;
    const offsetX = runner.x - center.x;
    const offsetZ = runner.z - center.z;
    const insideX = halfX - Math.abs(offsetX);
    const insideZ = halfZ - Math.abs(offsetZ);
    if (insideX <= 0 || insideZ <= 0) continue;
    if (insideX < insideZ) {
      runner.x = center.x + (offsetX < 0 ? -halfX : halfX);
      if (runner.vx * offsetX < 0) runner.vx = 0;
    } else {
      runner.z = center.z + (offsetZ < 0 ? -halfZ : halfZ);
      if (runner.vz * offsetZ < 0) runner.vz = 0;
    }
  }
}
