import type { HazardKind } from "./hazard-kind.js";
import { hazardAngle, noTravel, timedActive } from "./motion.js";

/** Bounce: hops up to `reach` metres above its point and back down. Twin: BounceHazard.cs. */
export const bounce: HazardKind = {
  validate: noTravel,
  position(hazard, time) {
    return {
      x: hazard.x,
      y: hazard.y + Math.abs(Math.sin(hazardAngle(hazard, time))) * hazard.reach,
      z: hazard.z,
      active: timedActive(hazard, time),
    };
  },
};
