import assert from "node:assert/strict";
import { join } from "node:path";
import { gameConfigDirectory } from "../../src/config/paths.js";
import {
  loadMatchmakingCatalog,
  MATCHMAKING_FILE,
  validateMatchmakingCatalog,
} from "../../src/modules/matchmaking/matchmaking.catalog.js";
import { MatchmakingQueue } from "../../src/modules/matchmaking/matchmaking.queue.js";
import { skillOf } from "../../src/modules/matchmaking/matchmaking.rules.js";
import { MatchmakingService } from "../../src/modules/matchmaking/matchmaking.service.js";
import type { MatchmakingCatalog, QueueDefinition, Ticket } from "../../src/modules/matchmaking/matchmaking.types.js";
import { config } from "../support/server.js";

const shipped = loadMatchmakingCatalog(join(gameConfigDirectory, MATCHMAKING_FILE), config);

function queueDefinition(overrides: Partial<QueueDefinition> = {}): QueueDefinition {
  return {
    id: "test",
    mode: "race",
    players: { min: 2, max: 4 },
    search: { seconds: 10, startShort: true },
    bots: { fill: true, max: -1 },
    lobby: { seconds: 5, readyCheck: true, startWhenFull: true },
    backfill: { enabled: true, minLobbySeconds: 2 },
    rules: {},
    ...overrides,
  };
}

let next = 0;
function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t" + next++,
    accountId: "",
    partition: "test:classic:sky-sprint",
    playlist: "classic",
    courseId: "sky-sprint",
    skill: 1,
    region: "",
    enqueuedAt: 0,
    ...overrides,
  };
}

function withCatalog(change: (catalog: MatchmakingCatalog) => void): MatchmakingCatalog {
  const catalog = structuredClone(shipped);
  change(catalog);
  return catalog;
}

describe("matchmaking catalog", () => {
  it("loads the shipped rules: a queue for every mode, private room rules", () => {
    for (const mode of config.modes)
      assert.ok(
        shipped.queues.some(queue => queue.mode === mode.id),
        mode.id,
      );
    assert.ok(shipped.privateRooms.players.max <= config.maxPlayers);
  });

  it("rejects queues it could not run", () => {
    const broken: [string, (catalog: MatchmakingCatalog) => void][] = [
      ["unknown mode", catalog => (catalog.queues[0].mode = "missing")],
      ["minimum above seats", catalog => (catalog.queues[0].players = { min: 9, max: 8 })],
      ["more seats than the game allows", catalog => (catalog.queues[0].players.max = config.maxPlayers + 1)],
      [
        "no way to start",
        catalog => (catalog.queues[0].lobby = { seconds: 0, readyCheck: false, startWhenFull: false }),
      ],
      ["unknown rule", catalog => ((catalog.queues[0].rules as Record<string, unknown>).luck = {})],
      [
        "skill range above its cap",
        catalog => (catalog.queues[0].rules.skill = { metric: "level", range: 9, widenPerSecond: 1, maxRange: 2 }),
      ],
      [
        "skill enabled that is not a boolean",
        catalog =>
          (catalog.queues[0].rules.skill = {
            metric: "level",
            range: 1,
            widenPerSecond: 0,
            maxRange: 1,
            enabled: "yes" as never,
          }),
      ],
      [
        "region enabled that is not a boolean",
        catalog => (catalog.queues[0].rules.region = { relaxSeconds: 5, enabled: 0 as never }),
      ],
      [
        "account enabled that is not a boolean",
        catalog => (catalog.queues[0].rules.account = { required: true, enabled: null as never }),
      ],
      ["duplicate id", catalog => (catalog.queues[1].id = catalog.queues[0].id)],
      ["created rooms listed that is not a boolean", catalog => (catalog.privateRooms.listed = "yes" as never)],
    ];
    for (const [label, change] of broken)
      assert.throws(
        () => validateMatchmakingCatalog(withCatalog(change), config),
        /Invalid matchmaking catalog/,
        label,
      );
  });

  it("lists created rooms unless the catalog turns it off", () => {
    const absent = withCatalog(catalog => delete catalog.privateRooms.listed);
    assert.equal(new MatchmakingService(validateMatchmakingCatalog(absent, config), config).listsCreatedRooms, true);
    const off = withCatalog(catalog => (catalog.privateRooms.listed = false));
    assert.equal(new MatchmakingService(validateMatchmakingCatalog(off, config), config).listsCreatedRooms, false);
  });

  it("sets the party size: four when the section is missing, 1 to 16 when given", () => {
    assert.equal(shipped.parties.maxMembers, 4, "the shipped catalog states it");
    const missing = validateMatchmakingCatalog(
      withCatalog(catalog => delete (catalog as { parties?: unknown }).parties),
      config,
    );
    assert.deepEqual(missing.parties, { maxMembers: 4 });
    for (const size of [1, 2, 16])
      assert.equal(
        validateMatchmakingCatalog(
          withCatalog(edited => (edited.parties = { maxMembers: size })),
          config,
        ).parties.maxMembers,
        size,
      );
    for (const size of [0, 17, -1, 2.5, "4", null, Number.NaN])
      assert.throws(
        () =>
          validateMatchmakingCatalog(
            withCatalog(edited => (edited.parties = { maxMembers: size as number })),
            config,
          ),
        /Invalid matchmaking catalog: parties.maxMembers/,
        String(size),
      );
  });
});

describe("matchmaking queue", () => {
  it("forms a match at the minimum and fills groups up to the seats", () => {
    const queue = new MatchmakingQueue(queueDefinition());
    const first = ticket();
    queue.add(first);
    assert.deepEqual(queue.cycle(1000), []);
    assert.deepEqual(queue.status(first.id, 1000), { found: 1, min: 2, max: 4, waited: 1, search: 10 });
    for (let i = 0; i < 4; i++) queue.add(ticket({ enqueuedAt: 100 + i }));
    const placements = queue.cycle(2000);
    assert.deepEqual(
      placements.map(placement => placement.tickets.length),
      [4],
      "four seats fill first; the fifth waits for a partner",
    );
    assert.equal(queue.size, 1);
  });

  it("starts short once the oldest player has searched long enough, unless the queue waits on", () => {
    const short = new MatchmakingQueue(queueDefinition());
    short.add(ticket({ enqueuedAt: 0 }));
    assert.equal(short.cycle(9_999).length, 0);
    assert.equal(short.cycle(10_000)[0].tickets.length, 1);
    const patient = new MatchmakingQueue(queueDefinition({ search: { seconds: 10, startShort: false } }));
    patient.add(ticket({ enqueuedAt: 0 }));
    assert.equal(patient.cycle(60_000).length, 0);
  });

  it("keeps partitions apart", () => {
    const queue = new MatchmakingQueue(queueDefinition());
    queue.add(ticket({ partition: "test:classic:a" }));
    queue.add(ticket({ partition: "test:classic:b" }));
    assert.equal(queue.cycle(1000).length, 0);
  });

  it("matches by skill and widens the range while players wait", () => {
    const queue = new MatchmakingQueue(
      queueDefinition({
        search: { seconds: 600, startShort: true },
        rules: { skill: { metric: "level", range: 2, widenPerSecond: 1, maxRange: 10 } },
      }),
    );
    queue.add(ticket({ skill: 1, enqueuedAt: 0 }));
    queue.add(ticket({ skill: 6, enqueuedAt: 0 }));
    assert.equal(queue.cycle(1000).length, 0, "a gap of 5 is too wide after one second");
    assert.equal(queue.cycle(3000).length, 1, "after three seconds the range reaches 5");
    queue.add(ticket({ skill: 1, enqueuedAt: 0 }));
    queue.add(ticket({ skill: 40, enqueuedAt: 0 }));
    assert.equal(queue.cycle(500_000).length, 0, "the range never grows beyond its cap");
  });

  it("keeps regions apart until they relax, and can reserve a queue for accounts", () => {
    const regional = new MatchmakingQueue(
      queueDefinition({ search: { seconds: 600, startShort: true }, rules: { region: { relaxSeconds: 5 } } }),
    );
    regional.add(ticket({ region: "eu" }));
    regional.add(ticket({ region: "sa" }));
    assert.equal(regional.cycle(4000).length, 0);
    assert.equal(regional.cycle(5000).length, 1);
    const ranked = new MatchmakingQueue(queueDefinition({ rules: { account: { required: true } } }));
    assert.match(ranked.admit(ticket()), /Sign in/);
    assert.equal(ranked.admit(ticket({ accountId: "a" })), "");
  });

  it("treats a rule with enabled false exactly like an absent rule", () => {
    const skill = { metric: "level" as const, range: 2, widenPerSecond: 0, maxRange: 2 };
    const pairs = (rules: QueueDefinition["rules"]) => {
      const queue = new MatchmakingQueue(queueDefinition({ search: { seconds: 600, startShort: true }, rules }));
      queue.add(ticket({ skill: 1, region: "eu" }));
      queue.add(ticket({ skill: 40, region: "sa" }));
      return queue.cycle(1000).length;
    };
    assert.equal(pairs({ skill }), 0, "a wide skill gap is refused when the rule is on");
    assert.equal(pairs({ skill: { ...skill, enabled: true } }), 0, "enabled true behaves as before");
    assert.equal(pairs({ skill: { ...skill, enabled: false } }), pairs({}), "disabled matches any skill");
    assert.equal(pairs({ skill: { ...skill, enabled: false } }), 1);
    assert.equal(pairs({ region: { relaxSeconds: -1 } }), 0);
    assert.equal(pairs({ region: { relaxSeconds: -1, enabled: false } }), 1, "a disabled region rule mixes regions");
    const open = new MatchmakingQueue(queueDefinition({ rules: { account: { required: true, enabled: false } } }));
    assert.equal(open.admit(ticket()), "", "a disabled account rule lets guests in");
    const ranked = new MatchmakingQueue(queueDefinition({ rules: { account: { required: true, enabled: true } } }));
    assert.match(ranked.admit(ticket()), /Sign in/);
  });

  it("measures skill by the wins metric only while the skill rule is on", () => {
    const profile = { level: 7, wins: 30 };
    assert.equal(skillOf({ skill: { metric: "wins", range: 1, widenPerSecond: 0, maxRange: 1 } }, profile), 30);
    assert.equal(
      skillOf({ skill: { metric: "wins", range: 1, widenPerSecond: 0, maxRange: 1, enabled: false } }, profile),
      7,
    );
  });

  it("backfills open lobbies of the same partition before forming new matches", () => {
    const queue = new MatchmakingQueue(queueDefinition({ players: { min: 1, max: 4 } }));
    const late = ticket();
    const elsewhere = ticket({ partition: "test:classic:other" });
    queue.add(late);
    queue.add(elsewhere);
    const lobby = { roomId: "room", partition: late.partition, free: 1, members: [ticket()] };
    const placements = queue.cycle(1000, [lobby]);
    assert.deepEqual(
      placements.map(placement => [placement.roomId ?? "new", placement.tickets.map(entry => entry.id)]),
      [
        ["room", [late.id]],
        ["new", [elsewhere.id]],
      ],
    );
    const closed = new MatchmakingQueue(
      queueDefinition({ players: { min: 1, max: 4 }, backfill: { enabled: false, minLobbySeconds: 0 } }),
    );
    closed.add(ticket());
    assert.equal(closed.cycle(1000, [{ ...lobby, free: 4 }])[0].roomId, undefined);
  });
});

describe("match plans", () => {
  const service = new MatchmakingService(shipped, config);

  it("take public seats and lobby rules from the queue, never from the client", () => {
    const race = shipped.queues.find(queue => queue.mode === "race");
    const plan = service.publicPlan({ mode: "race", courseId: "sky-sprint", matchSize: 2, playlist: "storm-cup" });
    assert.equal(plan.queue, race.id);
    assert.equal(plan.matchSize, race.players.max);
    assert.equal(plan.options.lobbySeconds, race.lobby.seconds);
    assert.equal(plan.options.minPlayers, 1);
    assert.equal(plan.partition, `${race.id}:${config.playlists[0].id}:sky-sprint`, "race ignores the playlist");
  });

  it("keep the host's size within the private room rules", () => {
    const plan = service.privatePlan({ mode: "duos", matchSize: 999 });
    assert.equal(plan.queue, "");
    assert.equal(plan.matchSize, shipped.privateRooms.players.max);
    assert.equal(plan.options.readyCheck, shipped.privateRooms.lobby.readyCheck);
  });

  it("allow one search per account", () => {
    assert.equal(service.beginSearch("account"), true);
    assert.equal(service.beginSearch("account"), false);
    service.endSearch("account");
    assert.equal(service.beginSearch("account"), true);
    assert.equal(service.beginSearch(""), true, "guests are not tracked");
  });
});
