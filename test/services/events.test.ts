import assert from "node:assert/strict";
import { join } from "node:path";
import { gameConfigDirectory } from "../../src/config/paths.js";
import { CollectionRepository } from "../../src/modules/collection/collection.repository.js";
import {
  loadEventCatalog,
  validateEventCatalog,
  type EventCatalog,
  type EventDefinition,
} from "../../src/modules/events/events.catalog.js";
import { EventRepository } from "../../src/modules/events/events.repository.js";
import {
  currentOccurrence,
  lastEndedOccurrence,
  nextOccurrence,
  occurrenceOf,
} from "../../src/modules/events/events.schedule.js";
import { EventService } from "../../src/modules/events/events.service.js";
import type { MatchSnapshot } from "../../src/modules/match/simulation/party-simulation.js";
import { loadMatchmakingCatalog, MATCHMAKING_FILE } from "../../src/modules/matchmaking/matchmaking.catalog.js";
import type { MatchReward } from "../../src/modules/ranking/ranking.service.js";
import { config, content, startServer, startServices } from "../support/server.js";

const shipped = loadEventCatalog();
const queues = loadMatchmakingCatalog(join(gameConfigDirectory, MATCHMAKING_FILE), config).queues;
const context = { config, queues, characters: content.characterCatalog };

function withCatalog(change: (catalog: EventCatalog) => void): EventCatalog {
  const catalog = structuredClone(shipped);
  change(catalog);
  return catalog;
}
const eventOf = (catalog: EventCatalog, id: string): EventDefinition =>
  catalog.events.find(candidate => candidate.id === id);

/** A finished race for "p" (the winner) and "q". */
const raceState = {
  phase: "finished",
  mode: "race",
  courseId: "slime-slalom",
  winnerIds: ["p"],
  players: [
    { id: "p", totalScore: 10 },
    { id: "q", totalScore: 5 },
  ],
} as unknown as MatchSnapshot;

async function setup(start = "2026-10-30T12:00:00Z", catalog: EventCatalog = shipped) {
  let date = new Date(start);
  const clock = () => date;
  const services = await startServices({ clock, events: catalog });
  const first = (await services.accounts.register({ username: "event_a", password: "test-only-password-a" })).profile
    .id;
  const second = (await services.accounts.register({ username: "event_b", password: "test-only-password-b" })).profile
    .id;
  const passes: { userId: string; key: string; xp: number }[] = [];
  const events = new EventService(
    services.database,
    new EventRepository(services.database),
    services.collection,
    new CollectionRepository(services.database),
    services.matchmaking,
    config,
    catalog,
    {
      grantXp: async (userId, key, xp) => {
        passes.push({ userId, key, xp });
        return xp;
      },
    },
    clock,
  );
  const rewards = (firstWon = true): MatchReward[] => [
    { id: first, won: firstWon, credits: 150 },
    { id: second, won: !firstWon, credits: 50 },
  ];
  return {
    services,
    events,
    passes,
    first,
    second,
    rewards,
    clock: (value: string) => {
      date = new Date(value);
    },
    /** `first` finishes a match of the event (and wins it), `second` finishes it too. */
    play: (matchId: string, eventId = "slime-weekend", firstWon = true) =>
      events.record(matchId, eventId, raceState, rewards(firstWon)),
    goal: async (account: string, eventId: string, goalId: string) =>
      (await events.state(account)).events
        .find(candidate => candidate.id === eventId && candidate.active)
        ?.goals.find(candidate => candidate.id === goalId),
  };
}

describe("event catalog", () => {
  it("validates the shipped events against the game's queues, playlists, courses and characters", () => {
    assert.doesNotThrow(() => validateEventCatalog(shipped, context));
    assert.deepEqual(
      shipped.events.map(event => event.id),
      ["slime-weekend", "timber-rush", "survival-showdown"],
    );
  });

  it("rejects events it could not run", () => {
    const broken: [string, RegExp, (catalog: EventCatalog) => void][] = [
      ["bad id", /needs an id/, catalog => (catalog.events[0].id = "Slime Weekend")],
      ["duplicate id", /appears twice/, catalog => (catalog.events[1].id = catalog.events[0].id)],
      ["no title", /title/, catalog => (catalog.events[0].title = " ")],
      ["bad instant", /UTC instants/, catalog => (catalog.events[0].startsAt = "2026-10-30")],
      ["offset instant", /UTC instants/, catalog => (catalog.events[0].endsAt = "2026-11-02T00:00:00+02:00")],
      ["ends before it starts", /end after it starts/, catalog => (catalog.events[0].endsAt = "2026-10-30T00:00:00Z")],
      ["repeat shorter than the event", /overlap/, catalog => (catalog.events[0].repeatDays = 2)],
      ["repeat above a year", /repeatDays/, catalog => (catalog.events[0].repeatDays = 367)],
      ["fractional repeat", /repeatDays/, catalog => (catalog.events[0].repeatDays = 3.5)],
      ["unknown queue", /not a matchmaking queue/, catalog => (catalog.events[0].queue = "missing")],
      ["unranked queue", /unranked/, catalog => (catalog.events[0].queue = "arcade")],
      ["unknown playlist", /playlist "nope"/, catalog => (catalog.events[0].playlist = "nope")],
      ["unknown course", /course "nope"/, catalog => (catalog.events[0].courseId = "nope")],
      ["course mode without a course", /courseId is required/, catalog => (catalog.events[0].courseId = "")],
      ["survival course in a race", /cannot be played/, catalog => (catalog.events[0].courseId = "spin-survival")],
      ["race course in survival", /cannot be played/, catalog => (catalog.events[2].courseId = "sky-sprint")],
      [
        "playlist mode without a playlist",
        /playlist is required/,
        catalog => {
          catalog.events[0].queue = "tournament";
          catalog.events[0].playlist = "";
        },
      ],
      ["minimum level 0", /minLevel/, catalog => (catalog.events[0].minLevel = 0)],
      ["minimum level 101", /minLevel/, catalog => (catalog.events[0].minLevel = 101)],
      [
        "eleven goals",
        /at most 10 goals/,
        catalog =>
          (catalog.events[0].goals = Array.from({ length: 11 }, (_, index) => ({
            ...catalog.events[0].goals[0],
            id: "goal-" + index,
          }))),
      ],
      ["duplicate goal", /twice/, catalog => (catalog.events[0].goals[1].id = catalog.events[0].goals[0].id)],
      ["bad goal id", /goal "Play"/, catalog => (catalog.events[0].goals[0].id = "Play")],
      ["unknown metric", /metric/, catalog => ((catalog.events[0].goals[0] as { metric: string }).metric = "teams")],
      ["target 0", /target/, catalog => (catalog.events[0].goals[0].target = 0)],
      ["target 1001", /target/, catalog => (catalog.events[0].goals[0].target = 1001)],
      ["negative Stars", /credits/, catalog => (catalog.events[0].goals[0].credits = -1)],
      ["too many Stars", /credits/, catalog => (catalog.events[0].goals[0].credits = 10001)],
      ["too many shards", /shards/, catalog => (catalog.events[0].goals[0].shards = 1001)],
      ["too much pass XP", /passXp/, catalog => (catalog.events[0].goals[0].passXp = 10001)],
      ["unknown character", /not a catalog character/, catalog => (catalog.events[0].goals[0].characterId = "ghost")],
    ];
    for (const [label, pattern, change] of broken)
      assert.throws(() => validateEventCatalog(withCatalog(change), context), pattern, label);
    assert.throws(() => validateEventCatalog({ version: 2, events: [] } as never, context), /Invalid events catalog/);
  });

  it("is checked when the service is built, so a bad file stops the server from starting", async () => {
    const services = await startServices();
    const broken = withCatalog(catalog => (catalog.events[0].queue = "missing"));
    assert.throws(
      () =>
        new EventService(
          services.database,
          new EventRepository(services.database),
          services.collection,
          new CollectionRepository(services.database),
          services.matchmaking,
          config,
          broken,
        ),
      /Invalid events catalog: event "slime-weekend"/,
    );
  });
});

describe("event schedule", () => {
  const at = (value: string) => Date.parse(value);
  const weekly = eventOf(shipped, "slime-weekend");
  const single = eventOf(shipped, "timber-rush");

  it("runs a repeating event every period, and keys each occurrence by its start date", () => {
    assert.equal(currentOccurrence(weekly, at("2026-10-29T23:59:59Z")), null);
    assert.equal(nextOccurrence(weekly, at("2026-10-29T23:59:59Z")).key, "slime-weekend@2026-10-30");
    const first = currentOccurrence(weekly, at("2026-10-30T00:00:00Z"));
    assert.equal(first.key, "slime-weekend@2026-10-30");
    assert.equal(first.endsAt, at("2026-11-02T00:00:00Z"));
    assert.equal(currentOccurrence(weekly, at("2026-11-01T23:59:59Z")).key, first.key);
    assert.equal(currentOccurrence(weekly, at("2026-11-02T00:00:00Z")), null, "the end is exclusive");
    assert.equal(nextOccurrence(weekly, at("2026-11-02T00:00:00Z")).key, "slime-weekend@2026-11-06");
    assert.equal(lastEndedOccurrence(weekly, at("2026-11-02T00:00:00Z")).key, first.key);
    const third = currentOccurrence(weekly, at("2026-11-13T12:00:00Z"));
    assert.equal(third.key, "slime-weekend@2026-11-13");
    assert.equal(third.index, 2);
    assert.equal(lastEndedOccurrence(weekly, at("2026-11-13T12:00:00Z")).key, "slime-weekend@2026-11-06");
    assert.equal(
      lastEndedOccurrence(weekly, at("2026-10-31T00:00:00Z")),
      null,
      "nothing has ended during the first run",
    );
    assert.equal(occurrenceOf(weekly, 1).startsAt, at("2026-11-06T00:00:00Z"));
  });

  it("runs a single-window event once", () => {
    assert.equal(nextOccurrence(single, at("2026-10-01T00:00:00Z")).key, "timber-rush@2026-10-27");
    assert.equal(currentOccurrence(single, at("2026-11-09T23:59:59Z")).key, "timber-rush@2026-10-27");
    assert.equal(currentOccurrence(single, at("2026-11-10T00:00:00Z")), null);
    assert.equal(nextOccurrence(single, at("2026-11-10T00:00:00Z")), null);
    assert.equal(nextOccurrence(single, at("2026-11-01T00:00:00Z")), null, "it has begun, so it is not upcoming");
    assert.equal(lastEndedOccurrence(single, at("2027-06-01T00:00:00Z")).key, "timber-rush@2026-10-27");
    assert.equal(lastEndedOccurrence(single, at("2026-11-01T00:00:00Z")), null);
  });

  it("lists running events first and the ones starting within two weeks by start", async () => {
    const fixture = await setup("2026-10-27T12:00:00Z");
    const listed = fixture.events.list().events;
    assert.deepEqual(
      listed.map(event => [event.id, event.active, event.startsAt]),
      [
        ["timber-rush", true, "2026-10-27T00:00:00.000Z"],
        ["survival-showdown", false, "2026-10-28T00:00:00.000Z"],
        ["slime-weekend", false, "2026-10-30T00:00:00.000Z"],
      ],
    );
    fixture.clock("2026-10-28T06:00:00Z");
    assert.deepEqual(
      fixture.events.list().events.map(event => [event.id, event.active, event.endsAt]),
      [
        ["timber-rush", true, "2026-11-10T00:00:00.000Z"],
        ["survival-showdown", true, "2026-10-29T00:00:00.000Z"],
        ["slime-weekend", false, "2026-11-02T00:00:00.000Z"],
      ],
    );
    fixture.clock("2026-11-10T00:00:00Z");
    assert.deepEqual(
      fixture.events.list().events.map(event => [event.id, event.active, event.startsAt]),
      [
        ["survival-showdown", false, "2026-11-11T00:00:00.000Z"],
        ["slime-weekend", false, "2026-11-13T00:00:00.000Z"],
      ],
      "a finished single-window event disappears",
    );
    fixture.clock("2026-10-01T00:00:00Z");
    assert.deepEqual(fixture.events.list().events, [], "nothing starts within 14 days");
  });
});

describe("event progress", () => {
  it("counts a finished match once per account, wins included, and only inside the running event", async () => {
    const fixture = await setup();
    await fixture.play("m1");
    await fixture.play("m1");
    await fixture.play("m2", "slime-weekend", false);
    const mine = (await fixture.events.state(fixture.first)).events.find(event => event.id === "slime-weekend");
    assert.equal(mine.occurrence, "slime-weekend@2026-10-30");
    assert.deepEqual([mine.matches, mine.wins], [2, 1]);
    const theirs = (await fixture.events.state(fixture.second)).events.find(event => event.id === "slime-weekend");
    assert.deepEqual([theirs.matches, theirs.wins], [2, 1]);
    assert.equal(Number((await fixture.services.database.query("SELECT COUNT(*) AS n FROM event_receipts"))[0].n), 4);

    await fixture.events.record("m3", "timber-rush", raceState, fixture.rewards());
    await fixture.events.record("m4", "slime-weekend", { ...raceState, mode: "survival" }, fixture.rewards());
    await fixture.events.record("m5", "slime-weekend", raceState, [{ id: fixture.first, won: true, credits: 0 }]);
    await fixture.events.record("m6", "unknown-event", raceState, fixture.rewards());
    await fixture.events.record("m7", "", raceState, fixture.rewards());
    fixture.clock("2026-11-02T00:00:00Z");
    await fixture.events.record("m8", "slime-weekend", raceState, fixture.rewards());
    fixture.clock("2026-10-30T13:00:00Z");
    const after = (await fixture.events.state(fixture.first)).events;
    assert.deepEqual(
      [
        after.find(event => event.id === "slime-weekend").matches,
        after.find(event => event.id === "timber-rush").matches,
      ],
      [2, 1],
      "only the two real matches and the timber-rush match count",
    );
    await assert.rejects(
      fixture.events.record("m9", "slime-weekend", { ...raceState, phase: "playing" } as never, fixture.rewards()),
      /finished/,
    );
  });

  it("settles through the reward service in the same transaction as the match", async () => {
    const fixture = await setup();
    const accounts = new Map([
      ["p", fixture.first],
      ["q", fixture.second],
    ]);
    const { rewards, events } = fixture.services;
    await rewards.complete("settle-1", raceState, accounts, "slime-weekend");
    await rewards.complete("settle-1", raceState, accounts, "slime-weekend");
    await rewards.complete("plain", raceState, accounts);
    const mine = (await events.state(fixture.first)).events.find(event => event.id === "slime-weekend");
    assert.deepEqual([mine.matches, mine.wins], [1, 1], "a match without an event id counts nowhere");
    const theirs = (await events.state(fixture.second)).events.find(event => event.id === "slime-weekend");
    assert.deepEqual([theirs.matches, theirs.wins], [1, 0]);
    assert.equal((await fixture.services.accounts.profile(fixture.first)).matches, 2);

    const original = events.record.bind(events);
    events.record = async (...args) => {
      await original(...args);
      throw new Error("event write failure");
    };
    await assert.rejects(rewards.complete("rollback", raceState, accounts, "slime-weekend"), /event write failure/);
    events.record = original;
    assert.equal((await fixture.services.accounts.profile(fixture.first)).matches, 2, "the match rolled back with it");
    assert.equal((await events.state(fixture.first)).events.find(event => event.id === "slime-weekend").matches, 1);
  });
});

describe("event claims", () => {
  it("pays Stars and shards once, sends the pass XP with the receipt key and survives retries", async () => {
    const fixture = await setup();
    const collection = fixture.services.collection;
    await assert.rejects(fixture.events.claim(fixture.first, "slime-weekend", "play"), /not completed/);
    await fixture.play("c1");
    await fixture.play("c2");
    assert.equal((await fixture.goal(fixture.first, "slime-weekend", "play")).claimable, false);
    await fixture.play("c3");
    const play = await fixture.goal(fixture.first, "slime-weekend", "play");
    assert.deepEqual([play.current, play.claimable, play.claimed], [3, true, false]);

    const before = await collection.state(fixture.first);
    await fixture.events.claim(fixture.first, "slime-weekend", "play");
    await fixture.events.claim(fixture.first, "slime-weekend", "play");
    const after = await collection.state(fixture.first);
    assert.equal(after.credits, before.credits + 150);
    assert.equal(after.shards, before.shards);
    assert.deepEqual(fixture.passes, [{ userId: fixture.first, key: "event:slime-weekend@2026-10-30:play", xp: 300 }]);
    const claimed = await fixture.goal(fixture.first, "slime-weekend", "play");
    assert.deepEqual([claimed.claimed, claimed.claimable], [true, false]);

    const win = await fixture.goal(fixture.first, "slime-weekend", "win");
    assert.equal(win.claimable, true, "the three matches included wins");
    const returned = await fixture.events.claim(fixture.first, "slime-weekend", "win");
    assert.equal((await collection.state(fixture.first)).credits, after.credits + 300);
    assert.equal((await collection.state(fixture.first)).shards, after.shards + 10);
    assert.equal(fixture.passes.at(-1).xp, 500);
    assert.equal(returned.events.find(event => event.id === "slime-weekend").goals[1].claimed, true);
    assert.equal(
      Number(
        (
          await fixture.services.database.query("SELECT COUNT(*) AS n FROM credit_ledger WHERE source LIKE 'event:%'")
        )[0].n,
      ),
      2,
    );
    assert.equal((await collection.state(fixture.second)).credits, 300, "other accounts are untouched");
  });

  it("rejects unknown events and goals and claims that are not earned", async () => {
    const fixture = await setup();
    await assert.rejects(fixture.events.claim(fixture.first, "nope", "play"), /Unknown event/);
    await assert.rejects(fixture.events.claim(fixture.first, "slime-weekend", "nope"), /Unknown goal/);
    await assert.rejects(fixture.events.claim(fixture.first, 7, "play"), /required/);
    await assert.rejects(fixture.events.claim(fixture.first, "slime-weekend", undefined), /required/);
    await assert.rejects(fixture.events.claim(fixture.first, "survival-showdown", "play"), /not running/);
    await assert.rejects(fixture.events.claim(fixture.first, "slime-weekend", "win"), /not completed/);
    assert.deepEqual(fixture.passes, []);
  });

  it("grants a character, or its duplicate shards when the player owns it", async () => {
    const fixture = await setup("2026-10-30T12:00:00Z");
    const collection = fixture.services.collection;
    const robot = content.characterCatalog.characters.find(character => character.id === "robot");
    for (let i = 0; i < 5; i++) await fixture.play("robot-" + i, "timber-rush");
    const before = await collection.state(fixture.first);
    assert.equal(before.owned.includes("robot"), false);
    await fixture.events.claim(fixture.first, "timber-rush", "champion");
    const first = await collection.state(fixture.first);
    assert.equal(first.owned.includes("robot"), true);
    assert.equal(first.credits, before.credits + 600);
    assert.equal(first.shards, before.shards + 25);
    // The second account already owns it.
    await fixture.services.database.query("INSERT INTO characters VALUES(?,?)", [fixture.second, "robot"]);
    const owner = await collection.state(fixture.second);
    for (let i = 0; i < 5; i++) await fixture.play("owner-" + i, "timber-rush", false);
    await fixture.events.claim(fixture.second, "timber-rush", "champion");
    const second = await collection.state(fixture.second);
    assert.equal(second.shards, owner.shards + 25 + robot.duplicateShards);
    assert.equal(second.owned.filter(id => id === "robot").length, 1);
  });

  it("rolls the claim back with the Stars, shards and character when a later step fails", async () => {
    const fixture = await setup();
    const collection = fixture.services.collection;
    for (let i = 0; i < 5; i++) await fixture.play("fail-" + i, "timber-rush");
    const failing = new EventService(
      fixture.services.database,
      new EventRepository(fixture.services.database),
      collection,
      new CollectionRepository(fixture.services.database),
      fixture.services.matchmaking,
      config,
      shipped,
      {
        grantXp: async () => {
          throw new Error("pass xp failure");
        },
      },
      () => new Date("2026-10-30T12:00:00Z"),
    );
    const wallet = await collection.state(fixture.first);
    await assert.rejects(failing.claim(fixture.first, "timber-rush", "champion"), /pass xp failure/);
    assert.deepEqual(await collection.state(fixture.first), wallet);
    assert.equal((await fixture.goal(fixture.first, "timber-rush", "champion")).claimed, false);
    await fixture.events.claim(fixture.first, "timber-rush", "champion");
    assert.equal((await fixture.goal(fixture.first, "timber-rush", "champion")).claimed, true);
  });

  it("allows a claim for a day after the window ends and lists the finished occurrence meanwhile", async function () {
    // Three settled matches and two claims against MySQL: about 20 s alone, longer when the whole suite runs.
    this.timeout(90000);
    const fixture = await setup();
    for (let i = 0; i < 3; i++) await fixture.play("late-" + i);
    fixture.clock("2026-11-02T10:00:00Z");
    const listed = (await fixture.events.state(fixture.first)).events.filter(event => event.id === "slime-weekend");
    assert.deepEqual(
      listed.map(event => [event.occurrence, event.active]),
      [
        ["slime-weekend@2026-10-30", false],
        ["slime-weekend@2026-11-06", false],
      ],
      "the finished occurrence is listed before the upcoming one",
    );
    assert.equal(listed[0].goals.find(goal => goal.id === "play").claimable, true);
    assert.equal(listed[1].matches, 0);
    const before = await fixture.services.collection.state(fixture.first);
    await fixture.events.claim(fixture.first, "slime-weekend", "play");
    assert.equal((await fixture.services.collection.state(fixture.first)).credits, before.credits + 150);
    assert.equal(fixture.passes[0].key, "event:slime-weekend@2026-10-30:play");
    await fixture.events.claim(fixture.first, "slime-weekend", "play");
    assert.equal(fixture.passes.length, 1);
    // The unclaimed win goal stays open to the end of the day, then the occurrence disappears.
    fixture.clock("2026-11-02T23:59:59Z");
    assert.equal(
      (await fixture.events.state(fixture.second)).events.some(
        event => event.occurrence === "slime-weekend@2026-10-30",
      ),
      true,
    );
    fixture.clock("2026-11-03T00:00:00Z");
    assert.equal(
      (await fixture.events.state(fixture.second)).events.some(
        event => event.occurrence === "slime-weekend@2026-10-30",
      ),
      false,
    );
    await assert.rejects(fixture.events.claim(fixture.first, "slime-weekend", "win"), /not running/);
    // A player with nothing to claim never sees the finished occurrence.
    const idle = await setup("2026-11-02T10:00:00Z");
    assert.deepEqual(
      (await idle.events.state(idle.first)).events
        .filter(event => event.id === "slime-weekend")
        .map(event => event.active),
      [false],
    );
  });

  it("keeps each occurrence apart: progress and claims start over with every one", async () => {
    const fixture = await setup();
    for (let i = 0; i < 3; i++) await fixture.play("week1-" + i);
    await fixture.events.claim(fixture.first, "slime-weekend", "play");
    fixture.clock("2026-11-06T12:00:00Z");
    const next = (await fixture.events.state(fixture.first)).events.find(event => event.id === "slime-weekend");
    assert.deepEqual([next.occurrence, next.matches, next.active], ["slime-weekend@2026-11-06", 0, true]);
    assert.equal(next.goals[0].claimed, false);
    for (let i = 0; i < 3; i++) await fixture.play("week2-" + i);
    await fixture.events.claim(fixture.first, "slime-weekend", "play");
    assert.deepEqual(
      fixture.passes.map(pass => pass.key),
      ["event:slime-weekend@2026-10-30:play", "event:slime-weekend@2026-11-06:play"],
    );
    assert.equal((await fixture.services.collection.state(fixture.first)).credits, 300 + 150 * 2);
  });

  it("claims the finished occurrence when the next one starts at once and has not reached the goal", async () => {
    const daily = withCatalog(catalog => {
      catalog.events = [
        {
          ...eventOf(catalog, "slime-weekend"),
          id: "daily-cup",
          startsAt: "2026-11-01T00:00:00.000Z",
          endsAt: "2026-11-02T00:00:00.000Z",
          repeatDays: 1,
        },
      ];
    });
    const fixture = await setup("2026-11-01T12:00:00Z", daily);
    for (let i = 0; i < 3; i++) await fixture.play("day1-" + i, "daily-cup");
    fixture.clock("2026-11-02T01:00:00Z");
    const entries = (await fixture.events.state(fixture.first)).events;
    assert.deepEqual(
      entries.map(event => [event.occurrence, event.active, event.matches]),
      [
        ["daily-cup@2026-11-02", true, 0],
        ["daily-cup@2026-11-01", false, 3],
      ],
    );
    await fixture.events.claim(fixture.first, "daily-cup", "play");
    assert.equal(fixture.passes[0].key, "event:daily-cup@2026-11-01:play");
    assert.equal((await fixture.events.state(fixture.first)).events.length, 2, "the win goal is still open");
    await fixture.events.claim(fixture.first, "daily-cup", "win");
    assert.equal(fixture.passes[1].key, "event:daily-cup@2026-11-01:win");
    assert.equal(
      (await fixture.events.state(fixture.first)).events.length,
      1,
      "nothing left to claim from the old one",
    );
  });
});

describe("event API", () => {
  it("lists events to everyone, keeps progress and claims behind sign-in and ignores client-sent rewards", async () => {
    const server = await startServer({}, { clock: () => new Date("2026-10-30T12:00:00Z") });
    const get = (path: string, token = "") =>
      fetch(server.url + path, { headers: token ? { Authorization: "Bearer " + token } : {} });
    const post = (path: string, body: unknown, token = "") =>
      fetch(server.url + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(body),
      });
    try {
      const publicList = await (await get("/api/events")).json();
      assert.deepEqual(Object.keys(publicList).sort(), ["events", "serverTime"]);
      assert.equal(publicList.serverTime, "2026-10-30T12:00:00.000Z");
      assert.deepEqual(
        publicList.events.map((event: { id: string; active: boolean }) => [event.id, event.active]),
        [
          ["timber-rush", true],
          ["slime-weekend", true],
          ["survival-showdown", false],
        ],
      );
      assert.deepEqual(Object.keys(publicList.events[1]).sort(), [
        "active",
        "courseId",
        "endsAt",
        "goals",
        "id",
        "minLevel",
        "mode",
        "playlist",
        "queue",
        "startsAt",
        "title",
      ]);
      assert.deepEqual(Object.keys(publicList.events[1].goals[0]).sort(), [
        "characterId",
        "credits",
        "id",
        "metric",
        "passXp",
        "shards",
        "target",
        "title",
      ]);
      assert.equal(publicList.events[1].mode, "race");
      assert.equal((await get("/api/events/state")).status, 401);
      assert.equal((await post("/api/events/claim", { eventId: "slime-weekend", goalId: "play" })).status, 401);

      const account = await (
        await post("/api/account/register", { username: "event_api", password: "test-only-password" })
      ).json();
      const state = await (await get("/api/events/state", account.token)).json();
      const slime = state.events.find((event: { id: string }) => event.id === "slime-weekend");
      assert.equal(slime.occurrence, "slime-weekend@2026-10-30");
      assert.deepEqual([slime.matches, slime.wins], [0, 0]);
      assert.deepEqual(Object.keys(slime.goals[0]).sort(), [
        "characterId",
        "claimable",
        "claimed",
        "credits",
        "current",
        "id",
        "metric",
        "passXp",
        "shards",
        "target",
        "title",
      ]);
      assert.equal(
        (
          await post(
            "/api/events/claim",
            { eventId: "slime-weekend", goalId: "play", credits: 99999, matches: 99, passXp: 99999 },
            account.token,
          )
        ).status,
        409,
      );
      assert.equal((await post("/api/events/claim", { eventId: "slime-weekend" }, account.token)).status, 400);
      assert.equal((await post("/api/events/claim", { eventId: "nope", goalId: "play" }, account.token)).status, 400);
      assert.equal((await post("/api/events/state", {}, account.token)).status, 404);

      const { events } = server.container;
      const result = (matchId: string) =>
        events.record(matchId, "slime-weekend", raceState, [{ id: account.profile.id, won: true, credits: 150 }]);
      for (let i = 0; i < 3; i++) await result("api-" + i);
      const claim = await post(
        "/api/events/claim",
        { eventId: "slime-weekend", goalId: "play", credits: 99999 },
        account.token,
      );
      assert.equal(claim.status, 200);
      const claimed = (await claim.json()).events.find((event: { id: string }) => event.id === "slime-weekend")
        .goals[0];
      assert.deepEqual([claimed.claimed, claimed.claimable, claimed.current], [true, false, 3]);
      assert.equal(
        (await post("/api/events/claim", { eventId: "slime-weekend", goalId: "play" }, account.token)).status,
        200,
      );
      assert.equal((await server.container.collection.state(account.profile.id)).credits, 300 + 150);
      assert.equal(
        (await server.container.seasons.state(account.profile.id)).xp,
        300,
        "the real season service received the goal's pass XP once",
      );
    } finally {
      await server.stop();
    }
  });
});

describe("event content protection", () => {
  const without = (characterId: string) => {
    const changed = structuredClone(content.characterCatalog);
    changed.characters = changed.characters.filter(character => character.id !== characterId);
    return changed;
  };

  it("keeps the characters event goals pay while the event runs, and lets them go a day after it ends", async () => {
    let date = new Date("2026-10-30T12:00:00Z");
    const services = await startServices({ clock: () => date });
    await assert.rejects(services.contentGuard.validateInventory(without("robot")), /claimable event character: robot/);
    assert.deepEqual(services.events.promisedCharacters(), ["robot"]);
    date = new Date("2026-11-10T23:59:59Z");
    await assert.rejects(services.contentGuard.validateInventory(without("robot")), /claimable event character: robot/);
    date = new Date("2026-11-11T00:00:00Z");
    await services.contentGuard.validateInventory(without("robot"));
    assert.deepEqual(services.events.promisedCharacters(), []);
  });

  it("keeps promising the character of an event that repeats", async () => {
    const repeating = withCatalog(catalog => {
      catalog.events[0].goals[0].characterId = "sunny";
    });
    const services = await startServices({ clock: () => new Date("2027-06-01T00:00:00Z"), events: repeating });
    assert.deepEqual(services.events.promisedCharacters(), ["sunny"]);
    await assert.rejects(services.contentGuard.validateInventory(without("sunny")), /claimable event character: sunny/);
  });
});
