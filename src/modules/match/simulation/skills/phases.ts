import type { Runner } from "../runner.js";

// Phases of the dive slot, shared by every dive-slot kind: ready -> active (launched, until landing) -> landed (timed)
// -> recover (timed) -> ready after a cooldown. Presentation reads them generically. Mirrored by SkillPhase in
// Core/Simulation/Skills/PartySkills.cs.
export const SKILL_READY = 0;
export const SKILL_ACTIVE = 1;
export const SKILL_LANDED = 2;
export const SKILL_RECOVER = 3;

/** Seconds to whole ticks, rounding halves up like the C# twin. */
export const ticks = (seconds: number, tickRate: number) => Math.round(seconds * tickRate);

/** Hits, launches and respawns take the body away from the dive slot's skill. */
export function cancelSkill(runner: Runner): void {
  runner.skillPhase = SKILL_READY;
  runner.skillUntil = 0;
}
