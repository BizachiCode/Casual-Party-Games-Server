import type { SkillDefinition } from "../../../content/content.types.js";
import type { Runner } from "../runner.js";
import { dive } from "./dive.js";
import { SKILL_ACTIVE, SKILL_LANDED, SKILL_READY, SKILL_RECOVER, ticks } from "./phases.js";
import { punch } from "./punch.js";
import type { SkillKind, SkillWorld } from "./skill-kind.js";

export { SKILL_ACTIVE, SKILL_LANDED, SKILL_READY, SKILL_RECOVER, cancelSkill } from "./phases.js";
export type { SkillKind, SkillSlot, SkillWorld } from "./skill-kind.js";

/**
 * Every skill kind by name. To add one, write a kind file next to dive.ts and punch.ts, list it here and in
 * PartySkills.cs (Core/Simulation/Skills), then add a SkillDefinition with that kind to the content catalog.
 */
export const skillKinds: Record<string, SkillKind> = { dive, punch };

/** The dive slot's skill: the configured id, else the first skill. */
export function findSkill(skills: SkillDefinition[], id: string): SkillDefinition {
  return skills.find(skill => skill.id === id) || skills[0];
}

/** The action slot's skill, or undefined when the catalog has none (the action button then does nothing). */
export function findAction(skills: SkillDefinition[], id: string | undefined): SkillDefinition | undefined {
  return id ? skills.find(skill => skill.id === id) : undefined;
}

// ---- Dive slot ---------------------------------------------------------------------------------------------------

export function startSkill(runner: Runner, skill: SkillDefinition, tick: number): boolean {
  const airChargeUsed = !runner.grounded && runner.skillUsed;
  if (runner.skillPhase !== SKILL_READY || tick < runner.skillUntil || runner.knockedDown || airChargeUsed)
    return false;
  skillKinds[skill.kind].start(runner, skill);
  runner.skillPhase = SKILL_ACTIVE;
  runner.skillUsed = true;
  runner.diveTick = tick;
  return true;
}

/** Timed phase changes, run at the start of every movement step. */
export function advanceSkill(runner: Runner, skill: SkillDefinition, tick: number, tickRate: number): void {
  if (runner.skillPhase === SKILL_LANDED && tick >= runner.skillUntil) {
    if (runner.grounded) {
      runner.skillPhase = SKILL_RECOVER;
      runner.skillUntil = tick + ticks(skill.recoverSeconds, tickRate);
    } else {
      runner.skillPhase = SKILL_READY;
      runner.skillUntil = tick + ticks(skill.cooldownSeconds, tickRate);
    }
  }
  if (runner.skillPhase === SKILL_RECOVER && tick >= runner.skillUntil) {
    runner.skillPhase = SKILL_READY;
    runner.skillUntil = tick + ticks(skill.cooldownSeconds, tickRate);
  }
}

export function landSkill(runner: Runner, skill: SkillDefinition, tick: number, tickRate: number): void {
  if (runner.skillPhase !== SKILL_ACTIVE) return;
  runner.skillPhase = SKILL_LANDED;
  runner.skillUntil = tick + ticks(skill.landedSeconds, tickRate);
}

export function slideSkill(runner: Runner, skill: SkillDefinition, dt: number): void {
  if (runner.skillPhase >= SKILL_LANDED) skillKinds[skill.kind].slide?.(runner, skill, dt);
}

// ---- Action slot -------------------------------------------------------------------------------------------------

/** Whether the action skill has cooled down since it was last used. */
export function actionReady(runner: Runner, skill: SkillDefinition, tick: number, tickRate: number): boolean {
  return !runner.actionTick || tick - runner.actionTick >= ticks(skill.cooldownSeconds, tickRate);
}

/**
 * Uses the action skill when its button was pressed this tick, it has cooled down and the runner is in control (not
 * reeling from a hit, knocked down or lying after a dive). Runs inside the movement step, so the client predicts it.
 */
export function triggerAction(
  runner: Runner,
  skill: SkillDefinition | undefined,
  tick: number,
  tickRate: number,
  elapsed: number,
): void {
  const pressed = runner.action;
  runner.action = false;
  if (!pressed || !skill || !actionReady(runner, skill, tick, tickRate)) return;
  if (runner.knockedDown || elapsed < runner.hitUntil || runner.skillPhase >= SKILL_LANDED) return;
  skillKinds[skill.kind].start(runner, skill);
  runner.actionTick = tick;
}

/** The effect of every action skill used this tick, in runner order, once every runner has moved. Authority only. */
export function resolveActions(
  runners: readonly Runner[],
  skill: SkillDefinition | undefined,
  world: SkillWorld,
): void {
  if (!skill) return;
  const kind = skillKinds[skill.kind];
  for (const user of runners)
    if (user.status === "racing" && user.actionTick === world.tick) kind.affect?.(user, runners, skill, world);
}
