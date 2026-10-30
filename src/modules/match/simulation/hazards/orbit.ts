import type { HazardKind } from "./hazard-kind.js";
import { hazardAngle, noTravel, timedActive } from "./motion.js";

/** Orbit (kind ""): circles its point at `reach` metres, `speed` radians per second. Twin: OrbitHazard.cs. */
export const orbit: HazardKind = {
  validate: noTravel,
  position(hazard, time) {
    const angle = hazardAngle(hazard, time);
    return {
      x: hazard.x + Math.cos(angle) * hazard.reach,
      y: hazard.y,
      z: hazard.z + Math.sin(angle) * hazard.reach,
      active: timedActive(hazard, time),
    };
  },
};
