import type { ContentCheck } from "../../../content/content.validation.js";
import type { HazardDefinition } from "../../../content/content.types.js";

/** Where a hazard is at a match time, and whether it can hit then. */
export interface HazardState {
  x: number;
  y: number;
  z: number;
  active: boolean;
}

/**
 * One kind of hazard: how it moves. Hitting is shared (hazards/index.ts): a ball, or a log along X when the definition
 * has a length, that throws runners through knockBack. Motion is a pure function of match time, so the client draws
 * hazards with no network traffic.
 *
 * Every kind has a twin in Assets/CasualPartyMultiplayer/Core/Simulation/Hazards (bounce.ts -> BounceHazard.cs) doing
 * the same operations in the same order; register both (hazards/index.ts, PartyHazards.cs). test:parity compares them.
 */
export interface HazardKind {
  /** Checks the definition fields this kind reads beyond the common ones. */
  validate(hazard: HazardDefinition, check: ContentCheck): void;
  position(hazard: HazardDefinition, time: number): HazardState;
}
