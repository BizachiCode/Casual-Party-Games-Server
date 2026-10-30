import assert from "node:assert/strict";
import type { CourseFieldDefinition, FieldKind } from "../../src/modules/content/content.types.js";
import { validateCatalogs } from "../../src/modules/content/content.validation.js";
import { fieldActive } from "../../src/modules/match/simulation/fields/index.js";
import { PartySimulation, type PlayerInput } from "../../src/modules/match/simulation/party-simulation.js";
import { config, content } from "../support/server.js";

function running(fields: CourseFieldDefinition[] = []) {
  const testConfig = structuredClone(config);
  testConfig.courses[0].hazards = [];
  testConfig.courses[0].fields = fields;
  const sim = new PartySimulation(testConfig, 2, {
    mode: "race",
    playlist: "classic",
    courseId: testConfig.courses[0].id,
  });
  sim.addPlayer("p", "Field test");
  sim.ready("p");
  while (sim.phase !== "running") sim.step();
  const player = sim.players[0];
  player.x = player.z = 0;
  return { sim, player };
}
const field = (kind: string, extra: Partial<CourseFieldDefinition> = {}): CourseFieldDefinition => ({
  kind: kind as FieldKind,
  x: 0,
  y: 0,
  z: 0,
  width: 6,
  depth: 6,
  height: 0.3,
  strength: kind === "launch" ? 18 : kind === "boost" ? 1.6 : 0,
  duration: kind === "boost" ? 1 : 0,
  flowX: 0,
  flowZ: 0,
  period: 0,
  onSeconds: 0,
  phase: 0,
  ...extra,
});
const forward = (sim: PartySimulation, seq: number) => sim.input("p", { seq, x: 0, z: 1, jump: false, dive: false });
const rejects = (fields: CourseFieldDefinition[]) => {
  for (const invalidField of fields) {
    const testConfig = structuredClone(config);
    testConfig.courses[0].fields = [invalidField];
    assert.throws(
      () => validateCatalogs(testConfig, content.characterCatalog, content.goalCatalog),
      JSON.stringify(invalidField),
    );
  }
};

describe("course fields", () => {
  it("launches only grounded runners entering the pad and publishes an immutable cue", () => {
    const { sim, player: runner } = running([field("launch")]);
    sim.step();
    assert.equal(runner.launchTick, sim.tick);
    assert.equal(runner.grounded, false);
    assert.ok(runner.vy > 17 && runner.y > 0);
    const first = runner.launchTick;
    sim.step();
    assert.equal(runner.launchTick, first);
    const snapshot = sim.snapshot();
    snapshot.players[0].launchTick = 999999;
    assert.notEqual(sim.snapshot().players[0].launchTick, 999999);
  });

  it("boosts for a fixed time, without refreshing while inside, and again on re-entry", () => {
    const { sim, player: runner } = running([field("boost")]);
    sim.step();
    const tick = runner.boostTick;
    for (let i = 0; i < 40; i++) sim.step();
    assert.equal(runner.boostTick, tick);
    assert.equal(sim.snapshot().players[0].boostRemaining, 0);
    runner.x = 4;
    sim.step();
    runner.x = 0;
    sim.step();
    assert.ok(runner.boostTick > tick);
    assert.ok(sim.snapshot().players[0].boostRemaining > 0.9);
  });

  it("bounds boosted speed by the authored multiplier and returns to normal speed", () => {
    const { sim, player: runner } = running([field("boost")]);
    for (let i = 0; i < 20; i++) {
      forward(sim, i);
      sim.step();
    }
    assert.ok(runner.vz > config.speed);
    assert.ok(runner.vz <= config.speed * 1.6 + 1e-8);
    for (let i = 20; i < 65; i++) {
      forward(sim, i);
      sim.step();
    }
    assert.ok(runner.vz <= config.speed + 1e-8);
  });

  it("pushes grounded and airborne runners with timed wind and caps overlapping drift", () => {
    const { sim, player: runner } = running([
      field("wind", { flowX: 20, flowZ: 20, height: 8 }),
      field("wind", { flowX: 20, flowZ: 20, height: 8 }),
    ]);
    sim.step();
    assert.equal(runner.inWind, true);
    assert.ok(Math.abs(Math.hypot(runner.x, runner.z) - 20 / config.tickRate) < 1e-8);
    runner.y = 3;
    runner.grounded = false;
    sim.step();
    assert.equal(runner.inWind, true);
    runner.y = 12;
    sim.step();
    assert.equal(runner.inWind, false);
    const timed = field("wind", { flowX: 3, period: 1, onSeconds: 0.5, phase: -0.25 });
    assert.equal(fieldActive(timed, 0), false);
    assert.equal(fieldActive(timed, 0.5), true);
  });

  it("suppresses launch and boost while knocked down; respawn clears buffs and contacts", () => {
    const { sim, player: runner } = running([field("launch"), field("boost")]);
    runner.knockedDown = true;
    runner.hitUntil = 99;
    sim.step();
    assert.equal(runner.launchTick, 0);
    assert.equal(runner.boostTick, 0);
    runner.knockedDown = false;
    runner.hitUntil = 0;
    runner.fieldContacts = [];
    sim.step();
    assert.ok(runner.boostUntil > 0);
    sim.respawn(runner);
    assert.equal(sim.snapshot().players[0].boostRemaining, 0);
    assert.deepEqual(runner.fieldContacts, []);
  });

  it("gives forged field events and buffs in client input no authority", () => {
    const { sim } = running();
    sim.input("p", {
      seq: 0,
      x: 0,
      z: 0,
      jump: false,
      dive: false,
      launchTick: 999,
      boostRemaining: 999,
      inWind: true,
    } as PlayerInput);
    sim.step();
    const runner = sim.snapshot().players[0];
    assert.equal(runner.launchTick, 0);
    assert.equal(runner.boostTick, 0);
    assert.equal(runner.boostRemaining, 0);
    assert.equal(runner.inWind, false);
  });

  it("rejects unknown fields, unsafe multipliers, broken duty cycles and invalid launch geometry", () => {
    rejects([
      field("teleport"),
      field("boost", { strength: 20 }),
      field("launch", { height: 8 }),
      field("wind", { flowX: 0 }),
      field("launch", { period: 2, onSeconds: 3 }),
    ]);
  });

  it("finishes every shipped field course, and race routes have bot finishers", () => {
    for (const course of config.courses.filter(testConfig => testConfig.fields?.length)) {
      const sim = new PartySimulation(config, 8, { mode: "arcade", playlist: "classic", courseId: course.id });
      sim.addPlayer("p", "Route smoke");
      sim.ready("p");
      for (let tick = 0; tick < 4000 && sim.phase !== "finished"; tick++) sim.step();
      assert.equal(sim.phase, "finished", course.id);
      assert.ok(sim.winnerIds.length > 0, course.id + " winner");
      if (course.kind === "race")
        assert.ok(
          sim.players.some(runner => runner.bot && runner.finishTime > 0),
          course.id + " has a reachable finish",
        );
    }
  });

  it("slows only grounded runners in slime, the strongest overlap wins, and leaving restores speed", () => {
    const { sim, player: runner } = running([
      field("slime", { strength: 0.5, width: 30, depth: 30 }),
      field("slime", { strength: 0.3, width: 30, depth: 30 }),
    ]);
    for (let i = 0; i < 20; i++) {
      assert.equal(forward(sim, i), true);
      sim.step();
    }
    assert.ok(Math.abs(runner.vz - config.speed * 0.3) < 1e-8);
    runner.x = 18;
    sim.step();
    assert.equal(runner.slimeFactor, 1);
    runner.x = 0;
    runner.y = 2;
    runner.grounded = false;
    sim.step();
    assert.equal(runner.slimeFactor, 1);
    runner.slimeFactor = 0.3;
    sim.respawn(runner);
    assert.equal(runner.slimeFactor, 1);
  });

  it("punches with the authored direction and stun, never again while held, stunned or inactive", () => {
    const { sim, player: runner } = running([
      field("punch", { strength: 6, duration: 0.5, flowX: 12, flowZ: -3, height: 3 }),
    ]);
    sim.step();
    const hit = runner.hitTick;
    assert.equal(hit, sim.tick);
    assert.equal(runner.knockedDown, true);
    assert.equal(runner.impactX, 12);
    assert.equal(runner.impactZ, -3);
    assert.equal(runner.impactY, 6);
    sim.step();
    assert.equal(runner.hitTick, hit);
    runner.fieldContacts = [];
    sim.step();
    assert.equal(runner.hitTick, hit);
    const forged = sim.snapshot();
    forged.players[0].impactX = 999;
    assert.equal(sim.snapshot().players[0].impactX, 12);
    const off = running([
      field("punch", { strength: 6, duration: 0.5, flowX: 12, period: 2, onSeconds: 0.5, phase: 1 }),
    ]);
    off.sim.elapsed = 0;
    off.sim.step();
    assert.equal(off.player.hitTick, 0);
  });

  it("rejects unsafe slime strength, a punch without direction and an excessive stun", () => {
    rejects([
      field("slime", { strength: 0 }),
      field("slime", { strength: 1 }),
      field("punch", { strength: 6, duration: 0.5 }),
      field("punch", { strength: 6, duration: 5, flowX: 10 }),
      field("punch", { strength: 6, duration: 0.5, flowX: 20, flowZ: 20 }),
    ]);
  });
});
