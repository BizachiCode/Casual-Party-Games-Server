import type { Runner } from "./runner.js";
import { cancelSkill } from "./skills/phases.js";

/**
 * Throws a runner: the given velocity, no control until `until` (match time), the hit cue, and a knockdown until it
 * lands when `knockedDown` is set. Hazards, punch fields and skills all hit through this, so a hit plays the same
 * everywhere. Twin: PartyEffects.KnockBack in Core/Simulation/PartyEffects.cs.
 */
export function knockBack(
  runner: Runner,
  vx: number,
  vy: number,
  vz: number,
  until: number,
  knockedDown: boolean,
  tick: number,
): void {
  runner.vx = vx;
  runner.vz = vz;
  runner.vy = vy;
  runner.hitUntil = until;
  runner.grounded = false;
  runner.knockedDown = knockedDown;
  runner.hitTick = tick;
  runner.impactX = runner.vx;
  runner.impactY = runner.vy;
  runner.impactZ = runner.vz;
  cancelSkill(runner);
  runner.dashing = false;
}
