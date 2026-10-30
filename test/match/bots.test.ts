import assert from "node:assert/strict";
import type { BotProfile, PartyConfig } from "../../src/modules/content/content.types.js";
import { steerBot, type BotWorld } from "../../src/modules/match/simulation/bots.js";
import { validateCatalogs } from "../../src/modules/content/content.validation.js";
import type { MatchOptions } from "../../src/modules/match/simulation/course-rules.js";
import { PartySimulation } from "../../src/modules/match/simulation/party-simulation.js";
import { config, content } from "../support/server.js";

const copy = (): PartyConfig => structuredClone(config);
const lobby = (options: MatchOptions = {}, matchSize = 8, testConfig = copy()) => {
  const simulation = new PartySimulation(testConfig, matchSize, {
    mode: "race",
    playlist: "classic",
    courseId: "sky-sprint",
    ...options,
  });
  simulation.addPlayer("p", "Host");
  return simulation;
};
const bots = (simulation: PartySimulation) => simulation.players.filter(runner => runner.bot);
/** Ticks until `count` bots have certainly joined with the exported timing, plus half a second of margin. */
const fillTicks = (count: number) =>
  Math.ceil((config.bots.joinDelay + (count - 1) * config.bots.joinIntervalMax + 0.5) * config.tickRate);
/** A runner that never makes a mistake: full speed, centre line, every jump on time. */
const PERFECT: BotProfile = {
  id: "perfect",
  weight: 0,
  speedMin: 1,
  speedMax: 1,
  lane: 0,
  sway: 0,
  jumpError: 0,
  missChance: 0,
  diveChance: 1,
  dodgeChance: 1,
  actionChance: 0,
  pauseChance: 0,
  pauseSeconds: 0,
};

/** The world a bot reads to steer, as the simulation builds it every tick. */
const botWorld = (simulation: PartySimulation): BotWorld => ({
  tick: simulation.tick,
  tickRate: config.tickRate,
  elapsed: simulation.elapsed,
  teamSize: simulation.rules.teamSize,
  course: simulation.course,
  dt: 1 / config.tickRate,
  collapses: simulation.collapses,
  pickups: simulation.pickups,
  runners: simulation.players,
  action: simulation.action,
});
/** A lobby of `count` bots that has started its first round and is running. */
const runningLobby = (options: MatchOptions, count: number, testConfig = copy()) => {
  const simulation = lobby({ ...options, readyCheck: true }, count + 1, testConfig);
  simulation.ready("p");
  while (simulation.phase !== "running") simulation.step();
  return simulation;
};

/**
 * Plays a match and returns, over all racing bots, the longest time a bot kept its stick at zero and the longest it
 * made no 0.5 m of horizontal progress over three seconds, with where it happened.
 */
function longestIdle(simulation: PartySimulation, seconds: number) {
  const tickRate = config.tickRate;
  const window = tickRate * 3;
  const trails = new Map<string, { x: number; z: number }[]>();
  const stickIdle = new Map<string, number>();
  const stillTicks = new Map<string, number>();
  let worstStick = { seconds: 0, where: "" };
  let worstStill = { seconds: 0, where: "" };
  let round = simulation.round;
  for (let tick = 0; tick < tickRate * seconds && simulation.phase !== "finished"; tick++) {
    simulation.step();
    if (simulation.course.kind === "race") simulation.qualifySlots = 99;
    if (simulation.phase !== "running" || round !== simulation.round) {
      trails.clear();
      stickIdle.clear();
      stillTicks.clear();
      round = simulation.round;
      continue;
    }
    for (const bot of bots(simulation)) {
      if (bot.status !== "racing") {
        trails.delete(bot.id);
        continue;
      }
      const course = simulation.course.id;
      const who = `${bot.id} (${bot.brain.profile.id})`;
      const where = `${course} round ${simulation.round} ${who} at ${simulation.elapsed.toFixed(1)} s`;
      const idle = bot.inputX === 0 && bot.inputZ === 0 ? (stickIdle.get(bot.id) || 0) + 1 : 0;
      stickIdle.set(bot.id, idle);
      if (idle / tickRate > worstStick.seconds) worstStick = { seconds: idle / tickRate, where };
      const trail = trails.get(bot.id) || [];
      trail.push({ x: bot.x, z: bot.z });
      trails.set(bot.id, trail);
      if (trail.length <= window) continue;
      const before = trail.shift();
      const still = Math.hypot(bot.x - before.x, bot.z - before.z) < 0.5 ? (stillTicks.get(bot.id) || 0) + 1 : 0;
      stillTicks.set(bot.id, still);
      if (still / tickRate > worstStill.seconds) worstStill = { seconds: still / tickRate, where };
    }
  }
  return { worstStick, worstStill };
}

describe("bots", () => {
  it("join one by one after the join delay, at intervals inside the configured range", () => {
    const simulation = lobby();
    const tickSeconds = 1 / config.tickRate;
    const arrivals: number[] = [];
    for (let tick = 1; tick <= fillTicks(7); tick++) {
      const before = bots(simulation).length;
      simulation.step();
      assert.equal(simulation.phase, "lobby");
      if (bots(simulation).length > before) arrivals.push(tick * tickSeconds);
    }
    assert.equal(arrivals.length, 7, "every empty seat filled");
    assert.ok(Math.abs(arrivals[0] - config.bots.joinDelay) < tickSeconds + 1e-9, `first bot at ${arrivals[0]}`);
    for (let index = 1; index < arrivals.length; index++) {
      const gap = arrivals[index] - arrivals[index - 1];
      assert.ok(gap >= config.bots.joinIntervalMin - 1e-9, `gap ${gap}`);
      assert.ok(gap <= config.bots.joinIntervalMax + tickSeconds + 1e-9, `gap ${gap}`);
    }
    assert.equal(new Set(arrivals.map((_time, index) => bots(simulation)[index].id)).size, 7);
  });

  it("wait for the lobby's minimum of humans and respect the bot limit and switch", () => {
    const waiting = lobby({ minPlayers: 2 });
    for (let tick = 0; tick < config.tickRate * 3; tick++) waiting.step();
    assert.equal(bots(waiting).length, 0);
    const limited = lobby({ maxBots: 2 });
    const disabled = lobby({ fillBots: false });
    for (let tick = 0; tick < fillTicks(7); tick++) {
      limited.step();
      disabled.step();
    }
    assert.equal(bots(limited).length, 2);
    assert.equal(bots(disabled).length, 0);
  });

  it("give their seat to a human, newest bot first, and fill the seats left empty when the match starts", () => {
    const simulation = lobby({}, 4);
    for (let tick = 0; tick < fillTicks(3); tick++) simulation.step();
    assert.equal(simulation.players.length, 4);
    const newest = bots(simulation).at(-1).id;
    assert.equal(simulation.addPlayer("q", "Late friend"), true);
    assert.equal(simulation.players.length, 4);
    assert.ok(!simulation.players.some(runner => runner.id === newest));
    const quick = lobby({ readyCheck: true });
    quick.ready("p");
    quick.step();
    assert.equal(quick.phase, "countdown");
    assert.equal(quick.players.length, 8);
  });

  it("draw different profiles, speeds and colours, the same for the same seed", () => {
    const roster = (seed: number) => {
      const simulation = lobby({ seed, readyCheck: true }, 32);
      simulation.ready("p");
      simulation.step();
      return bots(simulation).map(bot => [bot.brain.profile.id, bot.brain.speed, bot.color].join(":"));
    };
    const first = roster(11);
    assert.deepEqual(roster(11), first);
    assert.notDeepEqual(roster(12), first);
    const profiles = new Set(first.map(entry => entry.split(":")[0]));
    assert.ok(profiles.size >= 3, [...profiles].join());
    assert.ok(new Set(first.map(entry => entry.split(":")[2])).size >= 4, "colours");
  });

  it("are beatable: a mistake-free runner finishes ahead of most bots, and the bots finish spread out", () => {
    const testConfig = copy();
    testConfig.bots.profiles.push(PERFECT);
    let ahead = 0;
    let total = 0;
    for (const seed of [1, 2, 3]) {
      const simulation = lobby({ seed, readyCheck: true }, 16, testConfig);
      simulation.ready("p");
      simulation.step();
      const hero = bots(simulation)[0];
      hero.brain.profile = PERFECT;
      hero.brain.speed = 1;
      while (simulation.phase !== "running") simulation.step();
      for (let tick = 0; tick < config.tickRate * 70 && simulation.phase === "running"; tick++) {
        simulation.step();
        simulation.qualifySlots = 99;
      }
      assert.ok(hero.finishTime > 0, "the mistake-free runner finishes");
      const others = bots(simulation).filter(bot => bot !== hero);
      const times = others.filter(bot => bot.finishTime > 0).map(bot => bot.finishTime);
      assert.ok(times.length >= others.length / 2, "most bots finish");
      assert.ok(Math.max(...times) - Math.min(...times) > 3, "finish times spread out");
      ahead += others.filter(bot => bot.finishTime < 0 || bot.finishTime > hero.finishTime).length;
      total += others.length;
    }
    assert.ok(ahead / total >= 0.75, `ahead of ${ahead}/${total}`);
  });

  it("never stand still: on every course and in every cup round, no bot freezes or stalls", function () {
    this.timeout(240000);
    const failures: string[] = [];
    const check = (simulation: PartySimulation, seconds: number) => {
      const { worstStick, worstStill } = longestIdle(simulation, seconds);
      if (worstStick.seconds > 4)
        failures.push(`stick at zero for ${worstStick.seconds.toFixed(1)} s: ${worstStick.where}`);
      if (worstStill.seconds > 4)
        failures.push(`no progress for ${worstStill.seconds.toFixed(1)} s: ${worstStill.where}`);
    };
    for (const course of config.courses) {
      for (const seed of [1, 2]) check(runningLobby({ mode: "arcade", courseId: course.id, seed }, 12), 45);
    }
    // Whole cups: the later rounds used to inherit the pauses of the first.
    for (const playlist of ["classic", "mixed", "shuffle"]) {
      for (const seed of [1, 2]) check(runningLobby({ mode: "tournament", playlist, seed }, 12), 300);
    }
    assert.deepEqual(failures, []);
  });

  it("start every round fresh: a pause drawn late in one round does not hold the bot still in the next", () => {
    const testConfig = copy();
    testConfig.bots.profiles = [PERFECT];
    testConfig.playlists.push({
      id: "arena-cup",
      title: "Arena Cup",
      courseIds: ["spin-survival", "pulse-arena", "spin-survival"],
      shuffle: false,
    });
    const simulation = runningLobby({ mode: "tournament", playlist: "arena-cup" }, 8, testConfig);
    const phase = () => simulation.phase as string;
    while (phase() === "running") simulation.step();
    assert.equal(phase(), "results");
    // The pause is measured in the match time of round 0, which ran for tens of seconds.
    for (const bot of bots(simulation)) bot.brain.pauseUntil = 40;
    while (simulation.round === 0) simulation.step();
    const playing = bots(simulation).filter(bot => bot.status === "racing");
    assert.ok(playing.length >= 2, "bots go on to the next round");
    for (const bot of playing) assert.equal(bot.brain.pauseUntil, 0, "pause forgotten");
    while (phase() !== "running") simulation.step();
    const start = new Map(bots(simulation).map(bot => [bot.id, { x: bot.x, z: bot.z }]));
    for (let tick = 0; tick < config.tickRate * 2; tick++) simulation.step();
    for (const bot of playing.filter(candidate => candidate.status === "racing")) {
      const from = start.get(bot.id);
      assert.ok(Math.hypot(bot.x - from.x, bot.z - from.z) > 1, `${bot.id} moved in the first two seconds of round 1`);
    }
  });

  it("start over after a fall: what a bot decided before it respawned is not repeated", () => {
    const testConfig = copy();
    testConfig.bots.profiles = [PERFECT];
    const simulation = runningLobby({ mode: "race", courseId: "sky-sprint" }, 4, testConfig);
    const bot = bots(simulation)[0];
    while (!bot.grounded || bot.brain.floor < 0) simulation.step();
    // It had decided to forget the jump at the edge of its platform, and fell.
    bot.brain.missJump = true;
    bot.brain.lane = 3;
    bot.brain.pauseUntil = simulation.elapsed + 30;
    simulation.respawn(bot);
    assert.equal(bot.brain.floor, -1);
    assert.equal(bot.brain.pauseUntil, 0);
    for (let tick = 0; tick < config.tickRate * 3; tick++) simulation.step();
    assert.equal(bot.brain.missJump, false, "decides again on the platform it lands on");
    assert.ok(Math.abs(bot.brain.lane) < 1, "a new lane");
  });

  it("push all the way against the wind and a belt running backwards, whatever their speed", () => {
    const simulation = runningLobby({ mode: "race", courseId: "sky-sprint" }, 2);
    const bot = bots(simulation)[0];
    bot.brain.profile = PERFECT;
    bot.brain.speed = 0.5;
    const push = (prepare: () => void) => {
      bot.grounded = true;
      bot.groundIndex = 0;
      bot.inWind = false;
      prepare();
      steerBot(bot, botWorld(simulation));
      return Math.hypot(bot.inputX, bot.inputZ);
    };
    const platform = simulation.course.platforms[0];
    assert.ok(Math.abs(push(() => {}) - 0.5) < 1e-9, "slower on plain ground");
    assert.ok(Math.abs(push(() => (bot.inWind = true)) - 1) < 1e-9, "full stick in wind");
    platform.conveyorZ = -2;
    assert.ok(Math.abs(push(() => {}) - 1) < 1e-9, "full stick against a belt");
    platform.conveyorZ = 2;
    assert.ok(Math.abs(push(() => {}) - 0.5) < 1e-9, "slower on a belt that helps");
  });

  it("reject invalid bot settings", () => {
    const invalid = (edit: (testConfig: PartyConfig) => void) => {
      const testConfig = copy();
      edit(testConfig);
      assert.throws(() => validateCatalogs(testConfig, content.characterCatalog, content.goalCatalog));
    };
    invalid(testConfig => delete testConfig.bots);
    invalid(testConfig => (testConfig.bots.joinIntervalMax = testConfig.bots.joinIntervalMin / 2));
    invalid(testConfig => (testConfig.bots.profiles = []));
    invalid(testConfig => testConfig.bots.profiles.forEach(profile => (profile.weight = 0)));
    invalid(testConfig => (testConfig.bots.profiles[0].speedMin = 2));
    invalid(testConfig => (testConfig.bots.profiles[0].missChance = 1.5));
    invalid(testConfig => (testConfig.bots.profiles[1].id = testConfig.bots.profiles[0].id));
  });
});
