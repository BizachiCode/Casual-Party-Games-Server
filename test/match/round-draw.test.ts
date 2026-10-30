import assert from "node:assert/strict";
import type { PartyConfig } from "../../src/modules/content/content.types.js";
import { validateCatalogs } from "../../src/modules/content/content.validation.js";
import { matchRules } from "../../src/modules/match/simulation/course-rules.js";
import { PartySimulation } from "../../src/modules/match/simulation/party-simulation.js";
import { config, content } from "../support/server.js";

const copy = (): PartyConfig => structuredClone(config);
const kindOf = (index: number) => config.courses[index].kind;

describe("round draw", () => {
  it("draws each round of the shuffle playlist from its pool, never the same course twice, the same for a seed", () => {
    const pools = config.roundDraw.rounds.map(round => round.kinds);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const rules = matchRules(config, { mode: "tournament", playlist: "shuffle", seed });
      assert.equal(rules.indices.length, pools.length);
      rules.indices.forEach((index, round) => assert.ok(pools[round].includes(kindOf(index)), "round " + round));
      assert.equal(new Set(rules.indices).size, rules.indices.length, "no course twice in a match");
      assert.deepEqual(matchRules(config, { mode: "tournament", playlist: "shuffle", seed }).indices, rules.indices);
      seen.add(rules.indices.join(","));
    }
    assert.ok(seen.size > 20, "different seeds draw different matches");
  });

  it("draws a round from its course list instead of its kinds when the list is set", () => {
    const listed = copy();
    const picks = ["sky-sprint", "crown-dash", "iceway"];
    listed.roundDraw.rounds = [
      { kinds: [], courseIds: picks },
      { kinds: ["survival"] },
      { kinds: ["race"], courseIds: picks },
    ];
    validateCatalogs(listed, content.characterCatalog, content.goalCatalog);
    const drawn = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const rules = matchRules(listed, { mode: "tournament", playlist: "shuffle", seed });
      const [first, , third] = rules.indices.map(index => listed.courses[index].id);
      assert.ok(picks.includes(first) && picks.includes(third), `${first} ${third}`);
      assert.notEqual(first, third, "never the same course twice");
      assert.equal(listed.courses[rules.indices[1]].kind, "survival");
      drawn.add(first);
    }
    assert.equal(drawn.size, picks.length, "every listed course comes up");
  });

  it("keeps a fixed playlist and the course a player chose, and draws one when nobody chose", () => {
    const classic = config.playlists.find(playlist => playlist.id === "classic");
    assert.deepEqual(
      matchRules(config, { mode: "tournament", playlist: "classic", seed: 7 }).indices.map(i => config.courses[i].id),
      classic.courseIds,
    );
    const chosen = matchRules(config, { mode: "race", playlist: "classic", courseId: "aqua-rush", seed: 3 });
    assert.equal(config.courses[chosen.indices[0]].id, "aqua-rush");
    const drawn = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const index = matchRules(config, { mode: "race", playlist: "classic", seed }).indices[0];
      assert.equal(kindOf(index), "race");
      drawn.add(config.courses[index].id);
    }
    assert.ok(drawn.size > 5, "a race without a chosen course is drawn among the races");
  });

  it("adds the map carousel to the countdown of every round", () => {
    const withCarousel = copy();
    withCarousel.roundDraw.revealSeconds = 3.5;
    const simulation = new PartySimulation(withCarousel, 1, { playlist: "shuffle", seed: 5 });
    simulation.addPlayer("p", "Runner");
    simulation.ready("p");
    simulation.step();
    assert.equal(simulation.phase, "countdown");
    assert.ok(Math.abs(simulation.remaining - (withCarousel.countdownSeconds + 3.5)) < 0.1);
  });

  it("refuses round draws that cannot be played", () => {
    const invalid = (edit: (testConfig: PartyConfig) => void) => {
      const testConfig = copy();
      edit(testConfig);
      assert.throws(() => validateCatalogs(testConfig, content.characterCatalog, content.goalCatalog), /roundDraw/);
    };
    invalid(testConfig => delete testConfig.roundDraw);
    invalid(testConfig => (testConfig.roundDraw.revealSeconds = 11));
    invalid(testConfig => (testConfig.roundDraw.rounds = []));
    // Rounds drawn by kind (the course list of the demo's first round cleared).
    const byKind = (testConfig: PartyConfig): void => {
      testConfig.roundDraw.rounds[0].courseIds = [];
    };
    invalid(testConfig => (testConfig.roundDraw.rounds[0].kinds = ["volcano"]));
    invalid(testConfig => {
      byKind(testConfig);
      testConfig.roundDraw.rounds[0].kinds = [];
    });
    invalid(testConfig => (testConfig.roundDraw.rounds[0].courseIds = ["no-such-course"]));
    invalid(testConfig => {
      byKind(testConfig);
      testConfig.courses = testConfig.courses.filter(course => course.kind !== "hill");
      testConfig.roundDraw.rounds[0].kinds = ["hill"];
    });
  });
});
