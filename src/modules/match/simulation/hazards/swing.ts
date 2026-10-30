import type { HazardKind } from "./hazard-kind.js";
import { hazardAngle, noTravel, timedActive } from "./motion.js";

// Twin: SwingHazard.cs.

/** Swing (kinds "swingX" and "swingZ"): sways `reach` metres either side of its point along one axis. */
export const swingX: HazardKind = {
  validate: noTravel,
  position(hazard, time) {
    return {
      x: hazard.x + Math.cos(hazardAngle(hazard, time)) * hazard.reach,
      y: hazard.y,
      z: hazard.z,
      active: timedActive(hazard, time),
    };
  },
};

export const swingZ: HazardKind = {
  validate: noTravel,
  position(hazard, time) {
    return {
      x: hazard.x,
      y: hazard.y,
      z: hazard.z + Math.sin(hazardAngle(hazard, time)) * hazard.reach,
      active: timedActive(hazard, time),
    };
  },
};
