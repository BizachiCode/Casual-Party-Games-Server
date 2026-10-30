import assert from "node:assert/strict";
import type { PartyConfig } from "../../src/modules/content/content.types.js";
import { PartySimulation, type PlayerInput } from "../../src/modules/match/simulation/party-simulation.js";
import { config } from "../support/server.js";

const copy = (): PartyConfig => structuredClone(config);
function running(options: Partial<PartyConfig> = {}, withoutHazards = false) {
  const testConfig = copy();
  Object.assign(testConfig, options);
  if (withoutHazards) testConfig.courses[0].hazards = [];
  const simulation = new PartySimulation(testConfig, 1);
  simulation.addPlayer("p", "Runner");
  simulation.ready("p");
  while (simulation.phase !== "running") simulation.step();
  return simulation;
}
const input = (
  simulation: PartySimulation,
  seq: number,
  x = 0,
  z = 0,
  extra: Partial<PlayerInput> & Record<string, unknown> = {},
) => simulation.input("p", { seq, x, z, jump: false, dive: false, ...extra } as PlayerInput);

describe("match simulation", () => {
  it("starts only after all humans are ready and fills the match with bots", () => {
    const simulation = new PartySimulation(copy());
    simulation.addPlayer("a", "<A>");
    simulation.addPlayer("b", "B");
    simulation.ready("a");
    simulation.step();
    assert.equal(simulation.phase, "lobby");
    simulation.ready("b");
    simulation.step();
    assert.equal(simulation.phase, "countdown");
    assert.equal(simulation.players.length, 8);
    assert.equal(simulation.players[0].name, "A");
    assert.equal(simulation.addPlayer("late", "Late"), false);
    assert.equal(simulation.addPlayer("a", "Duplicate"), false);
  });

  it("rejects malformed, stale, non-finite and unknown-player inputs", () => {
    const simulation = running();
    for (const bad of [
      null,
      {},
      { seq: 1 },
      { seq: 1, x: NaN, z: 0, jump: false, dive: false },
      { seq: 1, x: Infinity, z: 0, jump: false, dive: false },
      { seq: 1, x: "1", z: 0, jump: false, dive: false },
      { seq: 1, x: 0, z: 0, jump: 1, dive: false },
    ])
      assert.equal(simulation.input("p", bad as PlayerInput), false);
    assert.equal(simulation.input("attacker", { seq: 1 } as PlayerInput), false);
    assert.equal(input(simulation, 10), true);
    assert.equal(input(simulation, 10), false);
    assert.equal(input(simulation, 9), false);
  });

  it("ignores input magnitude, packet count, forged positions and result flags", () => {
    const simulation = running();
    const start = simulation.players[0].z;
    for (let seq = 0; seq < 500; seq++)
      input(simulation, seq, 99999, 99999, { position: { z: 999 }, winnerId: "p", status: "qualified" });
    assert.equal(simulation.players[0].z, start);
    for (let i = 0; i < 8; i++) {
      input(simulation, 500 + i, 9999, 9999);
      simulation.step();
    }
    const runner = simulation.players[0];
    assert.ok(Math.hypot(runner.vx, runner.vz) <= config.speed + 1e-9);
    assert.equal(runner.status, "racing");
    assert.equal(simulation.winnerId, "");
    assert.ok(runner.z < 2);
  });

  it("expires missing input, never bunny-hops on a held jump and allows one air dive per airtime", () => {
    const simulation = running();
    input(simulation, 0, 0, 1);
    for (let i = 0; i < 30; i++) simulation.step();
    assert.equal(simulation.players[0].vz, 0);
    input(simulation, 1, 0, 0, { jump: true });
    simulation.step();
    assert.ok(simulation.players[0].vy > 0);
    input(simulation, 2, 0, 1, { jump: true, dive: true });
    simulation.step();
    const skill = simulation.skill;
    const runner = simulation.players[0];
    assert.equal(runner.skillUsed, true);
    assert.equal(runner.skillPhase, 1);
    assert.equal(runner.dashing, true);
    assert.ok(Math.abs(runner.vy - (skill.airLift - config.gravity / config.tickRate)) < 1e-9);
    for (let i = 3; i < 5; i++) {
      input(simulation, i, 0, 0, { jump: true });
      simulation.step();
    }
    const vy = runner.vy;
    const diveTick = runner.diveTick;
    input(simulation, 20, 0, 0, { jump: true, dive: true });
    simulation.step();
    assert.equal(runner.diveTick, diveTick);
    assert.ok(runner.vy < vy);
    for (let i = 21; i < 100; i++) {
      input(simulation, i, 0, 0, { jump: true });
      simulation.step();
    }
    assert.equal(runner.grounded, true);
    assert.equal(runner.vy, 0);
    assert.equal(runner.skillPhase, 0);
  });

  it("dives: a hop along the facing, a belly slide, a get-up without control, then a cooldown", () => {
    const simulation = running();
    const runner = simulation.players[0];
    const skill = simulation.skill;
    const rate = config.tickRate;
    input(simulation, 0, 1, 0);
    for (let i = 0; i < 20; i++) simulation.step();
    assert.equal(runner.facingX, 1);
    assert.equal(runner.facingZ, 0);
    input(simulation, 1, 0, 0, { dive: true });
    simulation.step();
    assert.equal(runner.diveTick, simulation.tick);
    assert.equal(runner.skillPhase, 1);
    assert.equal(runner.grounded, false);
    assert.ok(
      Math.abs(runner.vx - Math.max(skill.speed, config.speed)) < 1e-9 && runner.vz === 0,
      "an idle stick dives where the runner faced",
    );
    input(simulation, 2, -1, 0, { jump: true });
    simulation.step();
    assert.ok(runner.vx > 0, "no air steering while diving");
    let guard = 0;
    while (runner.skillPhase === 1 && guard++ < 60) {
      input(simulation, 3 + guard, -1, 0, { jump: true });
      simulation.step();
    }
    assert.equal(runner.skillPhase, 2);
    assert.equal(runner.grounded, true);
    assert.equal(runner.dashing, true);
    const landed = simulation.tick;
    const slideSpeed = runner.vx;
    input(simulation, 100, 0, 0, { jump: true });
    simulation.step();
    assert.equal(runner.jumpTick, 0, "no jump off the belly");
    assert.ok(runner.vx < slideSpeed && runner.vx > 0, "friction slows the slide");
    while (runner.skillPhase === 2) {
      simulation.step();
      input(simulation, simulation.tick + 200, -1, 0);
    }
    assert.equal(runner.skillPhase, 3);
    assert.equal(simulation.tick - landed, Math.round(skill.landedSeconds * rate));
    assert.equal(runner.dashing, false);
    const recovering = simulation.tick;
    while (runner.skillPhase === 3) {
      input(simulation, simulation.tick + 200, -1, 0);
      simulation.step();
    }
    assert.equal(simulation.tick - recovering, Math.round(skill.recoverSeconds * rate));
    assert.equal(runner.skillUntil, simulation.tick + Math.round(skill.cooldownSeconds * rate));
    input(simulation, 1000, 0, 0, { dive: true });
    simulation.step();
    assert.equal(runner.skillPhase, 0, "the cooldown blocks a second dive");
    for (let i = 0; i < rate; i++) {
      input(simulation, 1001 + i * 2, 0, 0, { dive: false });
      simulation.step();
    }
    input(simulation, 2000, 0, 1, { dive: true });
    simulation.step();
    assert.equal(runner.skillPhase, 1);
    assert.ok(runner.vz > 0, "the stick aims the dive");
  });

  it("cancels a dive on a hazard hit", () => {
    const simulation = running();
    const runner = simulation.players[0];
    input(simulation, 0, 0, 0, { dive: true });
    simulation.step();
    assert.equal(runner.skillPhase, 1);
    simulation.course.hazards.push({ x: runner.x, y: 0, z: runner.z, reach: 0, speed: 0, phase: 0, radius: 1 });
    simulation.step();
    simulation.course.hazards.pop();
    assert.equal(runner.knockedDown, true);
    assert.equal(runner.skillPhase, 0);
    assert.equal(runner.dashing, false);
  });

  it("respawns at the server checkpoint in races and eliminates in survival", () => {
    const simulation = running();
    const runner = simulation.players[0];
    runner.checkpoint = 25;
    runner.y = -9;
    simulation.step();
    assert.equal(runner.z, 25);
    assert.equal(runner.y, 0);
    assert.equal(runner.status, "racing");
    simulation.round = 1;
    runner.y = -9;
    simulation.step();
    assert.equal(runner.status, "eliminated");
    assert.equal(simulation.phase, "finished");
    assert.equal(simulation.winnerId, "");
  });

  it("runs qualification, results, survival and the final to one winner", () => {
    const testConfig = copy();
    testConfig.countdownSeconds = testConfig.resultSeconds = 0.1;
    testConfig.survivalSeconds = 1;
    testConfig.courses.forEach(course => {
      course.hazards = [];
    });
    const simulation = new PartySimulation(testConfig, 8);
    simulation.addPlayer("p", "Spectator");
    simulation.ready("p");
    const phases = new Set<string>();
    for (let i = 0; i < 5000 && simulation.phase !== "finished"; i++) {
      simulation.step();
      phases.add(simulation.round + ":" + simulation.phase);
    }
    assert.equal(simulation.phase, "finished");
    assert.equal(simulation.round, 2);
    assert.ok(simulation.winnerId.startsWith("bot-"));
    assert.equal(simulation.players.filter(runner => runner.status === "qualified").length, 1);
    for (const phase of ["0:results", "1:running", "1:results", "2:running"]) assert.ok(phases.has(phase), phase);
    assert.equal(simulation.players[0].status, "eliminated");
    const frozen = JSON.stringify(simulation.snapshot());
    simulation.step();
    assert.equal(simulation.snapshot().winnerId, JSON.parse(frozen).winnerId);
  });

  it("completes a match on the real obstacle courses; snapshots cannot mutate the authority", () => {
    const simulation = new PartySimulation(copy());
    simulation.addPlayer("p", "Spectator");
    simulation.ready("p");
    simulation.snapshot().players[0].z = 1000;
    assert.equal(simulation.players[0].z, 0);
    for (let i = 0; i < 6000 && simulation.phase !== "finished"; i++) simulation.step();
    assert.equal(simulation.phase, "finished");
    assert.notEqual(simulation.winnerId, "");
  });

  it("removes a disconnected player from qualification without electing a peer", () => {
    const simulation = running();
    simulation.finishOrder.push("p");
    simulation.removePlayer("p");
    simulation.step();
    assert.equal(simulation.players.length, 0);
    assert.equal(simulation.winnerId, "");
    assert.equal(simulation.phase, "finished");
  });

  it("publishes monotonic jump, dive and landing clocks in immutable snapshots", () => {
    const sim = running({}, true);
    input(sim, 1, 0, 0, { jump: true, hitTick: 99999 });
    sim.step();
    let runner = sim.snapshot().players[0];
    assert.equal(runner.jumpTick, sim.tick);
    assert.equal(runner.hitTick, 0);
    input(sim, 2, 0, 0, { dive: true });
    sim.step();
    assert.equal(sim.snapshot().players[0].diveTick, sim.tick);
    for (let i = 0; i < 60 && !sim.players[0].grounded; i++) sim.step();
    runner = sim.snapshot().players[0];
    assert.ok(runner.landTick > runner.jumpTick);
    assert.ok(runner.landSpeed > 0);
    runner.hitTick = 99999;
    assert.equal(sim.snapshot().players[0].hitTick, 0);
  });

  it("decides knockdown, impact direction, control lock and recovery on the server", () => {
    const sim = running({}, true);
    const runner = sim.players[0];
    runner.x = runner.z = 0;
    sim.course.hazards.push({ x: 0, y: 0.85, z: 0, reach: 0, speed: 0, phase: 0, radius: 0.9 });
    sim.step();
    const first = sim.snapshot().players[0];
    assert.equal(first.hitTick, sim.tick);
    assert.equal(first.knockedDown, true);
    assert.equal(first.stunned, true);
    assert.ok(first.stunRemaining > 0);
    assert.ok(first.impactX > 0);
    assert.equal(first.impactY, 7);
    input(sim, 1, -1, -1, { jump: true, dive: true });
    sim.step();
    assert.equal(runner.jumpTick, 0);
    assert.equal(runner.diveTick, 0);
    assert.equal(runner.vx, first.impactX);
    sim.course.hazards.length = 0;
    for (let i = 0; i < 90 && runner.knockedDown; i++) sim.step();
    assert.equal(runner.knockedDown, false);
    assert.equal(runner.grounded, true);
    assert.ok(runner.landTick > first.hitTick);
  });

  it("flings without a knockdown: the hazard's own throw, no ragdoll pose and air control after the stun", () => {
    const sim = running({}, true);
    const runner = sim.players[0];
    runner.x = runner.z = 0;
    sim.course.hazards.push({
      x: -1,
      y: 0.85,
      z: 0,
      reach: 0,
      speed: 0,
      phase: 0,
      radius: 0.9,
      push: 14,
      lift: 10,
      stun: 0.2,
      fling: true,
    });
    sim.step();
    sim.course.hazards.length = 0;
    const thrown = sim.snapshot().players[0];
    assert.equal(thrown.hitTick, sim.tick);
    assert.equal(thrown.knockedDown, false);
    assert.equal(thrown.stunned, true);
    assert.equal(thrown.impactX, 14);
    assert.equal(thrown.impactY, 10);
    // Wire pose 10 is the ragdoll (1 + Pose.Ragdoll); a flung runner never shows it.
    for (let i = 0; i < 4; i++) {
      sim.step();
      assert.notEqual(sim.snapshot().players[0].animationState, 10);
    }
    // Inside the stun the stick does nothing; after it, the runner steers back while still airborne.
    input(sim, 1, -1, 0);
    sim.step();
    assert.equal(runner.vx, 14);
    for (let i = 0; i < 6; i++) sim.step();
    assert.equal(runner.grounded, false);
    assert.ok(runner.vx < 14);
    for (let i = 0; i < 90 && !runner.grounded; i++) sim.step();
    assert.equal(runner.grounded, true);
    assert.equal(runner.knockedDown, false);
  });
});
