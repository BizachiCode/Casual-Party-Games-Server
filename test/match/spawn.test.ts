import assert from "node:assert/strict";
import type { PartyConfig } from "../../src/modules/content/content.types.js";
import { validateCatalogs } from "../../src/modules/content/content.validation.js";
import { PartySimulation } from "../../src/modules/match/simulation/party-simulation.js";
import { config, content } from "../support/server.js";

const copy = (): PartyConfig => structuredClone(config);
/** A full race lobby that starts at once: one human ready, the bots fill the other seats when it starts. */
const startedRace = (testConfig: PartyConfig, seats: number) => {
  const simulation = new PartySimulation(testConfig, seats, {
    mode: "race",
    playlist: "classic",
    courseId: "sky-sprint",
    readyCheck: true,
  });
  simulation.addPlayer("p", "Host");
  simulation.ready("p");
  simulation.step();
  assert.equal(simulation.phase, "countdown");
  return simulation;
};

describe("spawn grid", () => {
  it("keeps every runner of a full race start at least one body width from the others", () => {
    const simulation = startedRace(copy(), config.maxPlayers);
    const runners = simulation.players;
    assert.equal(runners.length, config.maxPlayers);
    let closest = Infinity;
    for (let first = 0; first < runners.length; first++) {
      for (let second = first + 1; second < runners.length; second++) {
        const distance = Math.hypot(runners[first].x - runners[second].x, runners[first].z - runners[second].z);
        closest = Math.min(closest, distance);
      }
    }
    assert.ok(closest >= 2 * config.radius, `closest runners ${closest.toFixed(3)} m apart`);
    const behindTheLine = runners.every(runner => runner.z <= 0 && runner.grounded);
    assert.ok(behindTheLine, "everyone stands behind the line, on the floor");
  });

  it("places the start line from the exported spawn settings", () => {
    const testConfig = copy();
    testConfig.spawn = { ...testConfig.spawn, startPerRow: 2, startColumnGap: 3, startRowGap: 2, startStagger: 0 };
    const runners = startedRace(testConfig, 4).players;
    assert.deepEqual(
      runners.map(runner => [runner.x, runner.z]),
      [
        [-1.5, 0],
        [1.5, 0],
        [-1.5, -2],
        [1.5, -2],
      ],
    );
  });

  it("rejects invalid spawn settings", () => {
    const invalid = (edit: (testConfig: PartyConfig) => void) => {
      const testConfig = copy();
      edit(testConfig);
      assert.throws(() => validateCatalogs(testConfig, content.characterCatalog, content.goalCatalog));
    };
    invalid(testConfig => delete testConfig.spawn);
    invalid(testConfig => (testConfig.spawn.startPerRow = 0));
    invalid(testConfig => (testConfig.spawn.checkpointPerRow = 1.5));
    invalid(testConfig => (testConfig.spawn.arenaGap = 0));
    invalid(testConfig => (testConfig.spawn.startStagger = -1));
  });
});
