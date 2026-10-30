import type { ContentCheck } from "../../../content/content.validation.js";
import type { CourseDefinition, HazardDefinition, PartyConfig } from "../../../content/content.types.js";
import { knockBack } from "../effects.js";
import type { Runner } from "../runner.js";
import { bounce } from "./bounce.js";
import type { HazardKind, HazardState } from "./hazard-kind.js";
import { orbit } from "./orbit.js";
import { roll } from "./roll.js";
import { swingX, swingZ } from "./swing.js";
import { planarLength } from "../planar-length.js";

export type { HazardKind, HazardState } from "./hazard-kind.js";

/**
 * Every hazard kind by name ("" is the orbit). To add one, write a kind file next to these, list it here and in
 * PartyHazards.cs (Core/Simulation/Hazards), then use the kind in a course.
 */
export const hazardKinds: Record<string, HazardKind> = { "": orbit, swingX, swingZ, bounce, roll };

const HAZARD_PUSH = 11;
const HAZARD_LIFT = 7;
const HAZARD_STUN_SECONDS = 0.45;

export function hazardPosition(hazard: HazardDefinition, time: number): HazardState {
  return hazardKinds[hazard.kind || ""].position(hazard, time);
}

/** The rules every hazard follows, then its kind's own. */
export function validateHazard(hazard: HazardDefinition, check: ContentCheck): void {
  check.require(
    hazard && (hazard.kind === undefined || hazard.kind === null || Object.hasOwn(hazardKinds, hazard.kind)),
    "hazard.kind",
  );
  for (const key of ["x", "y", "z", "phase"] as const) check.number(hazard[key], -10000, 10000, "hazard." + key);
  check.number(hazard.reach, 0, 100, "hazard.reach");
  check.number(hazard.speed, -30, 30, "hazard.speed");
  check.number(hazard.radius, 0.05, 20, "hazard.radius");
  check.number(hazard.period ?? 0, 0, 120, "hazard.period");
  check.number(hazard.onSeconds ?? 0, 0, hazard.period ?? 0, "hazard.onSeconds");
  check.number(hazard.push ?? 0, 0, 30, "hazard.push");
  check.number(hazard.lift ?? 0, 0, 20, "hazard.lift");
  check.number(hazard.stun ?? 0, 0, 2, "hazard.stun");
  check.require(hazard.fling === undefined || typeof hazard.fling === "boolean", "hazard.fling");
  for (const key of ["travelX", "travelY", "travelZ"] as const)
    check.number(hazard[key] ?? 0, -1000, 1000, "hazard." + key);
  check.number(hazard.length ?? 0, 0, 100, "hazard.length");
  hazardKinds[hazard.kind || ""].validate(hazard, check);
}

/**
 * Hazards throw the runner away from their center. By default the runner is knocked down until it lands; a fling
 * hazard keeps it on its feet and hands control back once its stun ends, even in the air.
 */
export function hitHazards(
  runner: Runner,
  config: PartyConfig,
  course: CourseDefinition,
  elapsed: number,
  tick: number,
): void {
  for (const hazard of course.hazards) {
    const position = hazardPosition(hazard, elapsed);
    let offsetX = runner.x - position.x;
    // A log is a ball stretched along X: measure from the nearest point of its axis.
    if (hazard.length) {
      const half = hazard.length / 2;
      offsetX = offsetX > half ? offsetX - half : offsetX < -half ? offsetX + half : 0;
    }
    const offsetZ = runner.z - position.z;
    const distance = planarLength(offsetX, offsetZ);
    const touching =
      position.active &&
      distance < config.radius + hazard.radius &&
      runner.y < position.y + hazard.radius &&
      runner.y + config.height > position.y - hazard.radius;
    if (!touching || elapsed < runner.hitUntil) continue;
    const awayX = distance > 0.001 ? offsetX / distance : 1;
    const awayZ = distance > 0.001 ? offsetZ / distance : 0;
    const push = hazard.push || HAZARD_PUSH;
    knockBack(
      runner,
      awayX * push,
      hazard.lift || HAZARD_LIFT,
      awayZ * push,
      elapsed + (hazard.stun || HAZARD_STUN_SECONDS),
      !hazard.fling,
      tick,
    );
  }
}
