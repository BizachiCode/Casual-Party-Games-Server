import type { ContentCheck } from "../../../content/content.validation.js";
import type { HazardDefinition } from "../../../content/content.types.js";

/** The angle a circling or swinging hazard has reached: `speed` radians per second from `phase`. */
export const hazardAngle = (hazard: HazardDefinition, time: number) => time * hazard.speed + hazard.phase;

/** On for `onSeconds` of every `period` seconds; always on without a period. */
export const timedActive = (hazard: HazardDefinition, time: number) =>
  !hazard.period || (time + hazard.phase) % hazard.period < hazard.onSeconds;

/** Kinds that do not travel: the roll fields must stay empty. */
export function noTravel(hazard: HazardDefinition, check: ContentCheck): void {
  check.require(!hazard.travelX && !hazard.travelY && !hazard.travelZ, "travel only applies to roll hazards");
}
