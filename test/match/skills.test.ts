import assert from "node:assert/strict";
import type { PartyConfig } from "../../src/modules/content/content.types.js";
import { validateCatalogs } from "../../src/modules/content/content.validation.js";
import { fieldKinds } from "../../src/modules/match/simulation/fields/index.js";
import { hazardKinds } from "../../src/modules/match/simulation/hazards/index.js";
import { PartySimulation } from "../../src/modules/match/simulation/party-simulation.js";
import type { Runner } from "../../src/modules/match/simulation/runner.js";
import { skillKinds } from "../../src/modules/match/simulation/skills/index.js";
import { config, content } from "../support/server.js";

const punchSkill = config.skills.find(skill => skill.id === config.action);
const cooldownTicks = Math.round(punchSkill.cooldownSeconds * config.tickRate);

/** A running race with the given runners placed by hand; returns a button presser for "p". */
function arena(placements: Record<string, Partial<Runner>>, options: { mode?: string } = {}) {
  const simulation = new PartySimulation(structuredClone(config), 8, {
    mode: options.mode ?? "race",
    playlist: "classic",
    courseId: "sky-sprint",
    fillBots: false,
  });
  for (const id of Object.keys(placements)) simulation.addPlayer(id, id);
  for (const id of Object.keys(placements)) simulation.ready(id);
  while (simulation.phase !== "running") simulation.step();
  const runner = (id: string) => simulation.players.find(candidate => candidate.id === id);
  for (const [id, fields] of Object.entries(placements))
    Object.assign(runner(id), { y: 0, grounded: true, vx: 0, vz: 0, facingX: 0, facingZ: 1, ...fields });
  let seq = 0;
  /** One tick with "p" holding the action button (or not) and the stick at rest. */
  const press = (action: boolean) => {
    simulation.input("p", { seq: ++seq, x: 0, z: 0, jump: false, dive: false, action });
    simulation.step();
  };
  return { simulation, runner, press };
}

describe("skills: the dive and action buttons", () => {
  it("registers every kind with a slot and a validator, and only lets a button use a kind of its slot", () => {
    for (const kind of Object.values(skillKinds)) {
      assert.ok(kind.slot === "dive" || kind.slot === "action");
      assert.equal(typeof kind.validate, "function");
      if (kind.slot === "action") assert.equal(typeof kind.affect, "function");
    }
    for (const kinds of [hazardKinds, fieldKinds])
      for (const kind of Object.values(kinds)) assert.equal(typeof kind.validate, "function");
    const swap = (edit: (testConfig: PartyConfig) => void) => {
      const testConfig = structuredClone(config);
      edit(testConfig);
      return () => validateCatalogs(testConfig, content.characterCatalog, content.goalCatalog);
    };
    assert.doesNotThrow(swap(() => {}));
    assert.doesNotThrow(swap(testConfig => delete testConfig.action));
    assert.throws(
      swap(testConfig => (testConfig.skill = testConfig.action)),
      /dive button/,
    );
    assert.throws(
      swap(testConfig => (testConfig.action = "dive")),
      /action button/,
    );
    assert.throws(
      swap(testConfig => (testConfig.skills.find(skill => skill.kind === "punch").reach = 50)),
      /reach/,
    );
  });

  it("punches the runner ahead: thrown away on its feet, stunned, with the hit cue", () => {
    const { simulation, runner, press } = arena({ p: { x: 0, z: 0 }, q: { x: 0.2, z: 1.2 } });
    press(true);
    const target = runner("q");
    assert.equal(runner("p").actionTick, simulation.tick);
    assert.equal(target.hitTick, simulation.tick);
    assert.equal(target.knockedDown, false);
    assert.ok(target.vz > 0 && target.vy > 0, "thrown away and up");
    assert.ok(Math.abs(Math.hypot(target.vx, target.vz) - punchSkill.speed) < 1e-9);
    assert.ok(Math.abs(target.hitUntil - (simulation.elapsed + punchSkill.stun)) < 1e-9);
  });

  it("lunges into the swing: a dash from standing, a burst above the run speed, fading back to the run", () => {
    const lungeConfig = structuredClone(config);
    const lungeSkill = lungeConfig.skills.find(skill => skill.id === lungeConfig.action);
    lungeSkill.lunge = 10;
    const simulation = new PartySimulation(lungeConfig, 8, {
      mode: "race",
      playlist: "classic",
      courseId: "sky-sprint",
      fillBots: false,
    });
    simulation.addPlayer("p", "p");
    simulation.ready("p");
    while (simulation.phase !== "running") simulation.step();
    const puncher = simulation.players.find(runner => runner.id === "p");
    Object.assign(puncher, { y: 0, grounded: true, vx: 0, vz: 0, facingX: 0, facingZ: 1 });
    const startZ = puncher.z;
    simulation.input("p", { seq: 1, x: 0, z: 0, jump: false, dive: false, action: true });
    simulation.step();
    assert.equal(puncher.actionTick, simulation.tick);
    // the steering of the same tick already slows it by acceleration / tickRate
    const expected = 10 - lungeConfig.acceleration / lungeConfig.tickRate;
    assert.ok(Math.abs(puncher.vz - expected) < 1e-9, `standing dash ${puncher.vz}`);
    for (let tick = 2; tick <= 20; tick++) {
      simulation.input("p", { seq: tick, x: 0, z: 0, jump: false, dive: false, action: false });
      simulation.step();
    }
    assert.equal(Math.abs(puncher.vz) < 1e-9, true, "the dash fades out");
    assert.ok(puncher.z - startZ > 1 && puncher.z - startZ < 2.5, `dash distance ${puncher.z - startZ}`);
    const invalid = structuredClone(lungeConfig);
    invalid.skills.find(skill => skill.id === invalid.action).lunge = 25;
    assert.throws(() => validateCatalogs(invalid, content.characterCatalog, content.goalCatalog), /lunge/);
  });

  it("misses runners behind, out of reach, a floor away, already reeling or on the same team", () => {
    const cases: [string, Partial<Runner>, string?][] = [
      ["behind", { x: 0, z: -1 }],
      // the lunge carries the puncher forward during the tick it swings in
      ["too far", { x: 0, z: punchSkill.reach + (punchSkill.lunge ?? 0) / config.tickRate + 0.3 }],
      ["outside the arc", { x: 1.5, z: 0.2 }],
      ["a floor up", { x: 0, z: 1, y: 2 }],
      ["reeling", { x: 0, z: 1, hitUntil: 99 }],
    ];
    for (const [label, placement] of cases) {
      const { runner, press } = arena({ p: { x: 0, z: 0 }, q: placement });
      const before = runner("q").hitTick;
      press(true);
      assert.equal(runner("q").hitTick, before, label);
    }
    const duos = arena({ p: { x: 0, z: 0 }, q: { x: 0, z: 1 } }, { mode: "duos" });
    duos.runner("q").team = duos.runner("p").team;
    duos.press(true);
    assert.equal(duos.runner("q").hitTick, 0, "teammate");
  });

  it("waits out its cooldown, and needs a fresh press and a runner in control", () => {
    const { simulation, runner, press } = arena({ p: { x: 0, z: 0 } });
    press(true);
    const first = runner("p").actionTick;
    press(false);
    for (let tick = 2; tick < cooldownTicks; tick++) press(tick % 2 === 0);
    assert.equal(runner("p").actionTick, first, "still cooling down");
    press(false);
    press(true);
    assert.equal(runner("p").actionTick, simulation.tick, "ready again after the cooldown");
    press(true);
    assert.equal(runner("p").actionTick, simulation.tick - 1, "holding the button does not repeat");
    const knocked = arena({ p: { x: 0, z: 0, knockedDown: true, hitUntil: 99 } });
    knocked.press(true);
    assert.equal(knocked.runner("p").actionTick, 0, "no punch while knocked down");
  });

  it("accepts inputs without the action button and refuses a malformed one", () => {
    const { simulation } = arena({ p: { x: 0, z: 0 } });
    assert.equal(simulation.input("p", { seq: 50, x: 0, z: 1, jump: false, dive: false }), true);
    assert.equal(
      simulation.input("p", { seq: 51, x: 0, z: 1, jump: false, dive: false, action: "yes" as unknown as boolean }),
      false,
    );
  });

  it("lets bots punch whoever they would reach", () => {
    const simulation = new PartySimulation(structuredClone(config), 16, {
      mode: "race",
      playlist: "classic",
      courseId: "sky-sprint",
      seed: 4,
    });
    simulation.addPlayer("p", "Watcher");
    simulation.ready("p");
    let punches = 0;
    let hits = 0;
    const seen = new Map<string, number>();
    for (let tick = 0; tick < config.tickRate * 40 && simulation.phase !== "finished"; tick++) {
      simulation.step();
      for (const runner of simulation.players) {
        if (runner.brain && runner.actionTick === simulation.tick) punches++;
        if (runner.hitTick === simulation.tick && seen.get(runner.id) !== runner.hitTick) hits++;
        seen.set(runner.id, runner.hitTick);
      }
    }
    assert.ok(punches > 3, `${punches} bot punches`);
    assert.ok(hits > 0);
  });
});
