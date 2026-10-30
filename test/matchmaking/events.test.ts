import assert from "node:assert/strict";
import { join } from "node:path";
import { Client, type Room, type SeatReservation } from "@colyseus/sdk";
import { gameConfigDirectory } from "../../src/config/paths.js";
import type { EventCatalog, EventDefinition } from "../../src/modules/events/events.catalog.js";
import { loadMatchmakingCatalog, MATCHMAKING_FILE } from "../../src/modules/matchmaking/matchmaking.catalog.js";
import { MatchmakingQueue } from "../../src/modules/matchmaking/matchmaking.queue.js";
import { MatchmakingService } from "../../src/modules/matchmaking/matchmaking.service.js";
import type { MatchmakingCatalog, Ticket } from "../../src/modules/matchmaking/matchmaking.types.js";
import { config, startServer, waitFor, type TestServer } from "../support/server.js";

const shipped = loadMatchmakingCatalog(join(gameConfigDirectory, MATCHMAKING_FILE), config);

describe("event match plans", () => {
  const service = new MatchmakingService(shipped, config);

  it("give an event match a partition of its own and keep the event id in the plan", () => {
    const ordinary = service.publicPlan({ queue: "race", courseId: "timber-falls" });
    const event = service.publicPlan({ queue: "race", courseId: "timber-falls", eventId: "timber-rush" });
    assert.equal(ordinary.eventId, "");
    assert.equal(event.eventId, "timber-rush");
    assert.equal(event.partition, ordinary.partition + ":event:timber-rush");
    assert.equal(event.queue, "race");
    assert.equal(event.matchSize, ordinary.matchSize, "an event uses the queue's seats and lobby rules");
    assert.equal(event.options.courseId, "timber-falls");
    assert.notEqual(
      service.publicPlan({ queue: "race", courseId: "timber-falls", eventId: "other-event" }).partition,
      event.partition,
      "two events never share a match",
    );
  });

  it("ignore event ids in private rooms and anything that is not text", () => {
    assert.equal(
      service.privatePlan({ mode: "race", courseId: "sky-sprint", eventId: "timber-rush" } as never).eventId,
      "",
    );
    assert.equal(
      service.privatePlan({ mode: "race", eventId: "timber-rush" } as never).partition,
      service.privatePlan({ mode: "race" }).partition,
    );
    assert.equal(service.publicPlan({ queue: "race", eventId: 7 } as never).eventId, "");
  });

  it("never put an event search and an ordinary one in the same match", () => {
    const definition = structuredClone(shipped.queues.find(queue => queue.id === "race"));
    definition.players = { min: 1, max: 4 };
    const ticket = (id: string, partition: string): Ticket => ({
      id,
      accountId: "",
      partition,
      playlist: "classic",
      courseId: "timber-falls",
      skill: 1,
      region: "",
      enqueuedAt: 0,
    });
    const ordinary = service.publicPlan({ queue: "race", courseId: "timber-falls" }).partition;
    const event = service.publicPlan({ queue: "race", courseId: "timber-falls", eventId: "timber-rush" }).partition;
    const mixed = new MatchmakingQueue(definition);
    mixed.add(ticket("a", ordinary));
    mixed.add(ticket("b", event));
    assert.deepEqual(
      mixed
        .cycle(1000)
        .map(placement => placement.tickets.length)
        .sort(),
      [1, 1],
    );
    const together = new MatchmakingQueue(definition);
    together.add(ticket("a", event));
    together.add(ticket("b", event));
    assert.deepEqual(
      together.cycle(1000).map(placement => placement.tickets.length),
      [2],
    );
  });
});

const eventDefaults: Omit<EventDefinition, "id" | "queue" | "startsAt" | "endsAt"> = {
  title: "Test event",
  repeatDays: 0,
  playlist: "",
  courseId: "slime-slalom",
  minLevel: 1,
  goals: [],
};

/** The shipped rules with test queues, and events on them that run around the fake clock below. */
function testCatalogs(): { matchmaking: MatchmakingCatalog; events: EventCatalog } {
  const matchmaking = structuredClone(shipped);
  const queue = (id: string, searchSeconds: number): MatchmakingCatalog["queues"][number] => ({
    id,
    mode: "race",
    players: { min: 2, max: 4 },
    search: { seconds: searchSeconds, startShort: true },
    bots: { fill: true, max: -1 },
    lobby: { seconds: 30, readyCheck: true, startWhenFull: true },
    backfill: { enabled: true, minLobbySeconds: 2 },
    rules: {},
  });
  matchmaking.queues.push(queue("pairs", 60), queue("short", 2));
  const running = { startsAt: "2026-10-30T00:00:00.000Z", endsAt: "2026-11-02T00:00:00.000Z" };
  return {
    matchmaking,
    events: {
      version: 1,
      events: [
        { ...eventDefaults, ...running, id: "test-event", queue: "pairs" },
        { ...eventDefaults, ...running, id: "elite-event", queue: "pairs", minLevel: 5 },
        { ...eventDefaults, ...running, id: "short-event", queue: "short" },
        {
          ...eventDefaults,
          id: "later-event",
          queue: "pairs",
          startsAt: "2026-12-01T00:00:00.000Z",
          endsAt: "2026-12-02T00:00:00.000Z",
        },
      ],
    },
  };
}

const base = { protocol: config.protocol, revision: config.revision, courseId: "sky-sprint" };

/** Takes the reserved seat; the match's own messages are not under test here. */
async function take(client: Client, seat: SeatReservation): Promise<Room> {
  const match = await client.consumeSeatReservation(seat);
  for (const type of ["presence", "reconnectWindow", "identity", "notice"]) match.onMessage(type, () => {});
  return match;
}

/** Joins a queue (optionally for an event) and records its status reports, notices and the seat it is given. */
async function search(server: TestServer, queue: string, name: string, extra: Record<string, unknown> = {}) {
  const client = new Client(server.url);
  const room = await client.joinOrCreate("matchmaking", { ...base, queue, name, ...extra });
  const view: { client: Client; room: Room; notices: string[]; seat?: SeatReservation } = {
    client,
    room,
    notices: [],
  };
  room.onMessage("status", () => {});
  room.onMessage("notice", (notice: string) => view.notices.push(notice));
  room.onMessage("seat", (seat: SeatReservation) => (view.seat = seat));
  return view;
}

describe("event matchmaking", () => {
  let server: TestServer;
  let now = new Date("2026-10-31T12:00:00Z");
  const open: Room[] = [];
  const catalogs = testCatalogs();
  before(async () => {
    server = await startServer({}, { ...catalogs, clock: () => now });
  });
  beforeEach(() => {
    now = new Date("2026-10-31T12:00:00Z");
  });
  afterEach(async () => {
    for (const room of open.splice(0)) if (room.connection.isOpen) await room.leave();
  });
  after(async () => {
    await server.stop();
  });

  it("seats event players apart from ordinary searches, on the event's course and never the client's", async () => {
    const first = await search(server, "pairs", "First", { eventId: "test-event" });
    const second = await search(server, "pairs", "Second", { eventId: "test-event" });
    open.push(first.room, second.room);
    await waitFor(() => first.seat && second.seat, "event seats");
    assert.equal(first.seat.roomId, second.seat.roomId);
    open.push(...(await Promise.all([first, second].map(view => take(view.client, view.seat)))));
    const room = server.container.matches.get(first.seat.roomId);
    assert.equal(room.eventId, "test-event");
    assert.equal(room.queue, "pairs");
    assert.ok(room.partition.endsWith(":event:test-event"), room.partition);
    assert.equal(room.simulation.course.id, "slime-slalom", "the client asked for sky-sprint");

    // Ordinary searchers of the same queue form a match of their own, even with an event lobby open.
    const plain = [await search(server, "pairs", "PlainA"), await search(server, "pairs", "PlainB")];
    open.push(...plain.map(view => view.room));
    await waitFor(() => plain.every(view => view.seat), "ordinary seats");
    assert.notEqual(plain[0].seat.roomId, room.roomId);
    const ordinary = server.container.matches.get(plain[0].seat.roomId);
    assert.equal(ordinary.eventId, "");
    assert.ok(!ordinary.partition.includes(":event:"));
    open.push(...(await Promise.all(plain.map(view => take(view.client, view.seat)))));

    // A late event searcher backfills the event lobby.
    const late = await search(server, "pairs", "Late", { eventId: "test-event" });
    open.push(late.room);
    await waitFor(() => late.seat, "event backfill");
    assert.equal(late.seat.roomId, room.roomId);
  });

  it("refuses unknown, finished or upcoming events, other queues and players below the minimum level", async () => {
    const join = (options: Record<string, unknown>) =>
      new Client(server.url).joinOrCreate("matchmaking", { ...base, queue: "pairs", ...options });
    await assert.rejects(join({ eventId: "missing" }), /Unknown event/);
    await assert.rejects(join({ eventId: "later-event" }), /not running/);
    await assert.rejects(join({ eventId: "test-event", queue: "race" }), /another queue/);
    await assert.rejects(join({ eventId: "elite-event" }), /level 5/);
    now = new Date("2026-11-02T00:00:00Z");
    await assert.rejects(join({ eventId: "test-event" }), /not running/);
    now = new Date("2026-10-31T12:00:00Z");

    const account = await server.container.accounts.register({
      username: "event_level",
      password: "test-only-password",
    });
    await assert.rejects(join({ eventId: "elite-event", sessionToken: account.token }), /level 5/);
    await server.container.database.query("UPDATE users SET xp=1000 WHERE id=?", [account.profile.id]);
    const qualified = await join({ eventId: "elite-event", sessionToken: account.token });
    open.push(qualified);
    assert.ok(qualified.connection.isOpen);
  });

  it("applies the same rules to rooms created or joined directly, and ignores events in private rooms", async () => {
    const create = (name: string, options: Record<string, unknown>) =>
      new Client(server.url).create(name, { ...base, ...options });
    await assert.rejects(create("party", { queue: "pairs", eventId: "later-event" }), /not running/);
    await assert.rejects(create("party", { queue: "race", eventId: "test-event" }), /another queue/);
    await assert.rejects(create("party", { queue: "pairs", eventId: "missing" }), /Unknown event/);

    const direct = await create("party", { queue: "pairs", eventId: "test-event" });
    open.push(direct);
    const room = server.container.matches.get(direct.roomId);
    assert.equal(room.eventId, "test-event");
    assert.equal(room.simulation.course.id, "slime-slalom");
    assert.ok(room.partition.endsWith(":event:test-event"));
    assert.equal(
      server.container.matches.publicLobbies().some(lobby => lobby.id === direct.roomId),
      false,
      "event lobbies are not in the server browser",
    );
    await assert.rejects(new Client(server.url).joinById(direct.roomId, base), /event match/);
    await assert.rejects(new Client(server.url).joinById(direct.roomId, { ...base, eventId: "" }), /event match/);
    open.push(await new Client(server.url).joinById(direct.roomId, { ...base, eventId: "test-event" }));

    const elite = await create("party", { queue: "pairs", eventId: "elite-event" }).catch(error => error);
    assert.match(String(elite?.message ?? elite), /level 5/, "a guest cannot even sit at an elite event");

    const priv = await create("party_private", { eventId: "test-event", courseId: "sky-sprint" });
    open.push(priv);
    const privateRoom = server.container.matches.get(priv.roomId);
    assert.equal(privateRoom.eventId, "");
    assert.ok(!privateRoom.partition.includes(":event:"));
  });

  it("sends searchers home when the event ends while they wait", async () => {
    const lonely = await search(server, "short", "Lonely", { eventId: "short-event" });
    open.push(lonely.room);
    now = new Date("2026-11-02T00:00:00Z");
    await waitFor(() => !lonely.room.connection.isOpen, "search closed");
    assert.deepEqual(lonely.notices, ["This event has ended."]);
    assert.equal(lonely.seat, undefined);
  });
});
