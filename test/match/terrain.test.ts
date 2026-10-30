import assert from "node:assert/strict";
import type { PartyConfig } from "../../src/modules/content/content.types.js";
import { validateCatalogs } from "../../src/modules/content/content.validation.js";
import { platformPosition, platformTop } from "../../src/modules/match/simulation/course-rules.js";
import { PartySimulation } from "../../src/modules/match/simulation/party-simulation.js";
import { config, content } from "../support/server.js";
import { terrainCourse, withTerrain } from "../support/terrain-course.js";

const TICK = 1 / config.tickRate;

function race(edit: (testConfig: PartyConfig) => void = () => {}, bots = false) {
  const testConfig = withTerrain(config);
  edit(testConfig);
  const options = { mode: "race", playlist: "classic", courseId: "terrain-test", fillBots: bots, seed: 5 };
  const simulation = new PartySimulation(testConfig, bots ? 8 : 1, options);
  simulation.addPlayer("p", "Climber");
  simulation.ready("p");
  while (simulation.phase !== "running") simulation.step();
  const runner = simulation.players[0];
  let seq = 0;
  /** One tick holding the stick; `jump` presses the button on this tick only. */
  const hold = (x: number, z: number, jump = false) => {
    simulation.input("p", { seq: ++seq, x, z, jump, dive: false });
    simulation.step();
  };
  return { simulation, runner, hold };
}
const noHazards = (testConfig: PartyConfig) => {
  testConfig.courses.at(-1).hazards = [];
};
/** Ground height of the terrain course's platform `index` at this z, now. */
const topOf = (simulation: PartySimulation, index: number, z: number) => {
  const platform = simulation.course.platforms[index];
  return platformTop(platform, platformPosition(platform, simulation.elapsed), z);
};

describe("terrain: heights, ramps, walls, lifts and rolling logs", () => {
  it("walks up a ramp on its feet and stops at a ledge it has to jump", () => {
    const { simulation, runner, hold } = race(noHazards);
    let samples = 0;
    for (let tick = 0; tick < 150; tick++) {
      hold(0, 1);
      if (runner.z > 7 && runner.z < 15) {
        samples++;
        assert.ok(runner.grounded, `grounded on the ramp at z=${runner.z}`);
        assert.ok(Math.abs(runner.y - topOf(simulation, 1, runner.z)) < 1e-9, `on the slope at z=${runner.z}`);
      }
    }
    assert.ok(samples > 20, "crossed the ramp");
    assert.equal(runner.y, 3);
    assert.ok(runner.grounded);
    assert.ok(runner.z < 24 && runner.z > 23.5, `held by the ledge at z=${runner.z}`);
  });

  it("climbs the ledge with a jump, takes a 0.4 m step without one and rides the slide down fast", () => {
    const { simulation, runner, hold } = race(noHazards);
    for (let tick = 0; tick < 150; tick++) hold(0, 1);
    hold(0, 1, true);
    for (let tick = 0; tick < 25; tick++) hold(0, 1);
    assert.equal(runner.y, 4, "on the ledge");
    while (runner.z < 33) hold(0, 1);
    assert.equal(runner.y, 4.4, "walked up the step");
    assert.ok(runner.grounded);
    while (runner.z < 36.5) hold(0, 1);
    const start = runner.z;
    let ticks = 0;
    while (runner.z < 48) {
      hold(0, 1);
      ticks++;
      assert.ok(runner.grounded, `on the slide at z=${runner.z}`);
      assert.ok(Math.abs(runner.y - topOf(simulation, 5, runner.z)) < 1e-9);
    }
    const speed = (runner.z - start) / (ticks * TICK);
    assert.ok(speed > config.speed + 2, `slide speed ${speed}`);
  });

  it("carries a runner up and down on a lift", () => {
    const { simulation, runner, hold } = race(noHazards);
    const lift = simulation.course.platforms[6];
    Object.assign(runner, { x: 0, z: 52, y: topOf(simulation, 6, 52), grounded: true, groundIndex: 6, vy: 0 });
    const heights: number[] = [];
    for (let tick = 0; tick < 90; tick++) {
      hold(0, 0);
      assert.ok(runner.grounded, "stays on the lift");
      assert.ok(Math.abs(runner.y - platformPosition(lift, simulation.elapsed).y) < 1e-9);
      heights.push(runner.y);
    }
    assert.ok(Math.max(...heights) - Math.min(...heights) > 1, "rode up and down");
  });

  it("knocks runners along its whole length down the slope with a rolling log, and misses the ones beside it", () => {
    for (const [x, hit] of [
      [-2, true],
      [0, true],
      [2.5, false],
    ] as const) {
      const { simulation, runner, hold } = race();
      Object.assign(runner, { x, z: 10, y: topOf(simulation, 1, 10), grounded: true, groundIndex: 1 });
      let hitTick = 0;
      for (let tick = 0; tick < 130 && !hitTick; tick++) {
        hold(0, 0);
        if (runner.hitTick) hitTick = runner.hitTick;
      }
      assert.equal(hitTick > 0, hit, `x=${x}`);
      if (hit) assert.ok(runner.vz < 0 && runner.vy > 0, "thrown down the slope");
    }
  });

  it("respawns on top of a checkpoint that sits up a climb", () => {
    const { simulation, runner } = race(noHazards);
    runner.checkpoint = 20;
    simulation.respawn(runner);
    assert.equal(runner.y, 3);
    assert.equal(runner.z, 20);
    assert.ok(runner.grounded);
  });

  it("is beatable by bots: some climb, slide and finish", () => {
    const { simulation } = race(() => {}, true);
    for (let tick = 0; tick < config.tickRate * 70 && simulation.phase === "running"; tick++) {
      simulation.step();
      simulation.qualifySlots = 99;
    }
    const finishers = simulation.players.filter(runner => runner.bot && runner.finishTime > 0);
    assert.ok(finishers.length >= 3, `${finishers.length} bots finished`);
  });

  it("accepts the terrain pieces and rejects tops below 0, steep ramps and misplaced travel", () => {
    const check = (edit: (course: ReturnType<typeof terrainCourse>) => void) => {
      const testConfig = withTerrain(config);
      edit(testConfig.courses.at(-1));
      return () => validateCatalogs(testConfig, content.characterCatalog, content.goalCatalog);
    };
    assert.doesNotThrow(check(() => {}));
    for (const edit of [
      (course: ReturnType<typeof terrainCourse>) => (course.platforms[0].y = -1),
      (course: ReturnType<typeof terrainCourse>) => (course.platforms[1].rise = 13),
      (course: ReturnType<typeof terrainCourse>) => (course.platforms[1].y = 1),
      (course: ReturnType<typeof terrainCourse>) => (course.platforms[6].motionY = 1.5),
      (course: ReturnType<typeof terrainCourse>) => (course.platforms[2].height = -1),
      (course: ReturnType<typeof terrainCourse>) => (course.hazards[0].kind = ""),
      (course: ReturnType<typeof terrainCourse>) => (course.hazards[0].travelZ = course.hazards[0].travelY = 0),
      (course: ReturnType<typeof terrainCourse>) => (course.hazards[0].speed = 0),
    ])
      assert.throws(check(edit));
  });
});
