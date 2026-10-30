import type { CourseDefinition, PartyConfig, PlatformDefinition } from "../../src/modules/content/content.types.js";

const platform = (
  fields: Partial<PlatformDefinition> & Pick<PlatformDefinition, "z" | "depth">,
): PlatformDefinition => ({
  x: 0,
  y: 0,
  width: 8,
  ...fields,
});

/**
 * A climb and a descent along +Z: a ramp up with a log rolling down its left half, a plateau, a 1 m ledge, a 0.4 m
 * step, a water slide down, a lift and the finish. Every piece is solid, so lower runners meet walls.
 */
export function terrainCourse(): CourseDefinition {
  return {
    id: "terrain-test",
    title: "Terrain test",
    kind: "race",
    finish: 72,
    platforms: [
      platform({ z: 0, depth: 12, width: 10, height: 1 }),
      platform({ y: 1.5, z: 11, depth: 10, rise: 3, height: 2 }),
      platform({ y: 3, z: 20, depth: 8, height: 3 }),
      platform({ y: 4, z: 27, depth: 6, height: 4 }),
      platform({ y: 4.4, z: 33, depth: 6, height: 4.4 }),
      platform({ y: 2.4, z: 43, depth: 14, rise: -4, height: 1, slippery: 0.6, conveyorZ: 4 }),
      platform({ y: 1, z: 52, depth: 4, motionY: 1, motionSpeed: 1.5, height: 0.5 }),
      platform({ y: 1, z: 64, depth: 20, height: 1 }),
    ],
    hazards: [
      {
        kind: "roll",
        x: -2,
        y: 3.7,
        z: 16.4,
        reach: 0,
        speed: 3,
        phase: 0,
        radius: 0.6,
        travelX: 0,
        travelY: -3,
        travelZ: -10.8,
        length: 4,
        fling: true,
      },
    ],
    checkpoints: [0, 20, 58],
    lavaStart: 0,
    lavaSpeed: 0,
    targetScore: 0,
    hillRadius: 0,
    pickups: [],
    fields: [],
  };
}

/** The shipped catalogs plus the terrain course. */
export function withTerrain(config: PartyConfig): PartyConfig {
  const copy = structuredClone(config);
  copy.courses.push(terrainCourse());
  return copy;
}
