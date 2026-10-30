import type { HazardKind } from "./hazard-kind.js";

/**
 * Roll: travels from its start along travelX/Y/Z at `speed` m/s, then starts over: at once, or after resting out of
 * play at its start until `period` seconds have passed since it set off. A length turns the ball into a log.
 * Twin: RollHazard.cs.
 */
export const roll: HazardKind = {
  validate(hazard, check) {
    const travelX = hazard.travelX ?? 0;
    const travelY = hazard.travelY ?? 0;
    const travelZ = hazard.travelZ ?? 0;
    const travel = Math.sqrt(travelX * travelX + travelY * travelY + travelZ * travelZ);
    check.require(travel >= 0.5 && hazard.speed >= 0.1, "roll travel and speed");
    check.require(!hazard.onSeconds, "roll hazards rest by period only");
  },
  position(hazard, time) {
    const travelX = hazard.travelX || 0;
    const travelY = hazard.travelY || 0;
    const travelZ = hazard.travelZ || 0;
    const duration = Math.sqrt(travelX * travelX + travelY * travelY + travelZ * travelZ) / hazard.speed;
    const cycle = Math.max(duration, hazard.period || 0);
    let into = (time + hazard.phase) % cycle;
    if (into < 0) into += cycle;
    if (into >= duration) return { x: hazard.x, y: hazard.y, z: hazard.z, active: false };
    const progress = into / duration;
    return {
      x: hazard.x + travelX * progress,
      y: hazard.y + travelY * progress,
      z: hazard.z + travelZ * progress,
      active: true,
    };
  },
};
