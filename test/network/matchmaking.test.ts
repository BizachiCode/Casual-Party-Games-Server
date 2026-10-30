import assert from "node:assert/strict";
import { join } from "node:path";
import { Client, type Room, type SeatReservation } from "@colyseus/sdk";
import { gameConfigDirectory } from "../../src/config/paths.js";
import { loadMatchmakingCatalog, MATCHMAKING_FILE } from "../../src/modules/matchmaking/matchmaking.catalog.js";
import type { MatchmakingCatalog } from "../../src/modules/matchmaking/matchmaking.types.js";
import { config, startServer, waitFor, type TestServer } from "../support/server.js";

/** The shipped rules with test queues: a race queue that waits for two players and a solo queue that starts short. */
function testCatalog(): MatchmakingCatalog {
  const catalog = structuredClone(loadMatchmakingCatalog(join(gameConfigDirectory, MATCHMAKING_FILE), config));
  catalog.queues.push(
    {
      id: "pairs",
      mode: "race",
      players: { min: 2, max: 4 },
      search: { seconds: 60, startShort: true },
      bots: { fill: true, max: -1 },
      lobby: { seconds: 30, readyCheck: true, startWhenFull: true },
      backfill: { enabled: true, minLobbySeconds: 2 },
      rules: {},
    },
    {
      id: "solo",
      mode: "arcade",
      players: { min: 3, max: 3 },
      search: { seconds: 1, startShort: true },
      bots: { fill: false, max: 0 },
      lobby: { seconds: 0, readyCheck: true, startWhenFull: false },
      backfill: { enabled: false, minLobbySeconds: 0 },
      rules: {},
    },
    {
      id: "ranked",
      mode: "race",
      players: { min: 2, max: 8 },
      search: { seconds: 30, startShort: true },
      bots: { fill: true, max: -1 },
      lobby: { seconds: 10, readyCheck: true, startWhenFull: true },
      backfill: { enabled: true, minLobbySeconds: 2 },
      rules: { account: { required: true } },
    },
  );
  return catalog;
}

const base = { protocol: config.protocol, revision: config.revision, courseId: "sky-sprint" };

/** Takes the reserved seat; the match's own messages are not under test here. */
async function take(client: Client, seat: SeatReservation): Promise<Room> {
  const match = await client.consumeSeatReservation(seat);
  for (const type of ["presence", "reconnectWindow", "identity", "notice"]) match.onMessage(type, () => {});
  return match;
}

/** Joins a queue and records its status reports and the seat it is given. */
async function search(server: TestServer, queue: string, name: string) {
  const client = new Client(server.url);
  const room = await client.joinOrCreate("matchmaking", { ...base, queue, name });
  const view: { client: Client; room: Room; statuses: { found: number; max: number }[]; seat?: SeatReservation } = {
    client,
    room,
    statuses: [],
  };
  room.onMessage("status", status => view.statuses.push(status));
  room.onMessage("seat", (seat: SeatReservation) => (view.seat = seat));
  return view;
}

describe("matchmaking", () => {
  let server: TestServer;
  const open: Room[] = [];
  before(async () => {
    server = await startServer({}, { matchmaking: testCatalog() });
  });
  afterEach(async () => {
    for (const room of open.splice(0)) if (room.connection.isOpen) await room.leave();
  });
  after(async () => {
    await server.stop();
  });

  it("forms a match at the queue's minimum, hands out seats and backfills the lobby", async () => {
    const first = await search(server, "pairs", "First");
    open.push(first.room);
    await waitFor(() => first.statuses.length > 0, "status");
    assert.deepEqual([first.statuses[0].found, first.statuses[0].max], [1, 4]);
    const second = await search(server, "pairs", "Second");
    open.push(second.room);
    await waitFor(() => first.seat && second.seat, "seats");
    assert.equal(first.seat.roomId, second.seat.roomId);
    const matches = await Promise.all([first, second].map(view => take(view.client, view.seat)));
    open.push(...matches);
    const room = server.container.matches.get(matches[0].roomId);
    assert.equal(room.queue, "pairs");
    assert.equal(room.maxClients, 4, "seats come from the queue");
    assert.equal(room.simulation.lobby.lobbySeconds, 30, "lobby rules come from the queue");
    await waitFor(() => room.simulation.players.length === 2, "players seated");
    const late = await search(server, "pairs", "Late");
    open.push(late.room);
    await waitFor(() => late.seat, "backfill seat");
    assert.equal(late.seat.roomId, room.roomId, "a searching player joins the open lobby");
    open.push(await take(late.client, late.seat));
    await waitFor(() => room.simulation.players.length === 3, "backfilled player seated");
  });

  it("starts short once the search time is up", async () => {
    const lonely = await search(server, "solo", "Lonely");
    open.push(lonely.room);
    const started = Date.now();
    await waitFor(() => lonely.seat, "short start");
    assert.ok(Date.now() - started >= 500, "it searched before starting short");
    const match = await take(lonely.client, lonely.seat);
    open.push(match);
    const room = server.container.matches.get(match.roomId);
    assert.equal(room.simulation.lobby.fillBots, false);
  });

  it("refuses unknown queues and guests in queues reserved for accounts", async () => {
    await assert.rejects(new Client(server.url).joinOrCreate("matchmaking", { ...base, queue: "missing" }), /Unknown/);
    await assert.rejects(new Client(server.url).joinOrCreate("matchmaking", { ...base, queue: "ranked" }), /Sign in/);
    await assert.rejects(
      new Client(server.url).joinOrCreate("matchmaking", { ...base, queue: "pairs", protocol: -1 }),
      /version mismatch/,
    );
  });
});
