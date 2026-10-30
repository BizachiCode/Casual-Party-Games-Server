import assert from "node:assert/strict";
import { join } from "node:path";
import { Client, type Room, type SeatReservation } from "@colyseus/sdk";
import { gameConfigDirectory } from "../../src/config/paths.js";
import { loadMatchmakingCatalog, MATCHMAKING_FILE } from "../../src/modules/matchmaking/matchmaking.catalog.js";
import type { MatchmakingCatalog, QueueDefinition } from "../../src/modules/matchmaking/matchmaking.types.js";
import type { MatchSnapshot } from "../../src/modules/match/simulation/party-simulation.js";
import { wireSnapshot, type MatchWire } from "../../src/modules/match/wire/match-wire.js";
import type { SearchOrder, SquadState } from "../../src/modules/squad/squad.types.js";
import { config, startServer, waitFor, type TestServer } from "../support/server.js";

const base = { protocol: config.protocol, revision: config.revision };

/** A team-mode queue that starts with as few as two players and takes nobody else into a forming lobby. */
const queue = (id: string, mode: string, min: number, max: number): QueueDefinition => ({
  id,
  mode,
  players: { min, max },
  search: { seconds: 60, startShort: true },
  bots: { fill: false, max: 0 },
  lobby: { seconds: 30, readyCheck: true, startWhenFull: true },
  backfill: { enabled: false, minLobbySeconds: 0 },
  rules: {},
});

/** The shipped rules plus small duos and squads queues, so a party alone is enough to start a match. */
function testCatalog(): MatchmakingCatalog {
  const catalog = structuredClone(loadMatchmakingCatalog(join(gameConfigDirectory, MATCHMAKING_FILE), config));
  catalog.queues.push(queue("duo-cup", "duos", 2, 4), queue("squad-cup", "squads", 3, 8));
  return catalog;
}

interface Account {
  id: string;
  token: string;
}
interface Member {
  account: Account;
  squad: Room;
  state?: SquadState;
  orders: SearchOrder[];
}

describe("party members on a team", () => {
  let server: TestServer;
  let counter = 0;
  const open: Room[] = [];

  before(async () => {
    server = await startServer({}, { matchmaking: testCatalog() });
  });
  afterEach(async () => {
    for (const room of open.splice(0)) if (room.connection.isOpen) await room.leave();
    await waitFor(() => server.container.squads.all().length === 0, "squads disposed");
  });
  after(async () => {
    await server.stop();
  });

  async function account(): Promise<Account> {
    const signedIn = await server.container.accounts.register({
      username: `teams_${++counter}`,
      password: "test-only-password",
    });
    return { id: signedIn.profile.id, token: signedIn.token };
  }

  /** Takes a seat the way the client does, decoding the lobby state the way the Unity client does. */
  async function sit(seat: SeatReservation): Promise<{ room: Room; state?: MatchSnapshot }> {
    const match = await new Client(server.url).consumeSeatReservation(seat);
    for (const type of ["presence", "reconnectWindow", "identity", "notice"]) match.onMessage(type, () => {});
    const view: { room: Room; state?: MatchSnapshot } = { room: match };
    match.onStateChange(wire => (view.state = wireSnapshot(wire as MatchWire)));
    open.push(match);
    return view;
  }

  /** A party gathers in a squad room, its leader starts the search, and every member queues with the order. */
  async function searchTogether(size: number, queueId: string, mode: string) {
    const players = await Promise.all(Array.from({ length: size }, () => account()));
    const members: Member[] = [];
    for (const player of players) {
      const client = new Client(server.url);
      const options = { ...base, sessionToken: player.token };
      const squad = members.length
        ? await client.joinById(members[0].squad.roomId, options)
        : await client.create("squad", options);
      open.push(squad);
      const member: Member = { account: player, squad, orders: [] };
      squad.onMessage("state", (state: SquadState) => (member.state = state));
      squad.onMessage("search", (order: SearchOrder) => member.orders.push(order));
      for (const type of ["cancelled", "notice"]) squad.onMessage(type, () => {});
      members.push(member);
    }
    await waitFor(() => members.every(member => member.state?.members.length === size), "party gathered");
    members[0].squad.send("play", { queue: queueId, mode });
    await waitFor(() => members.every(member => member.orders.length === 1), "search order");
    const order = members[0].orders[0];
    const seats = new Map<string, SeatReservation>();
    for (const member of members) {
      const searching = await new Client(server.url).joinOrCreate("matchmaking", {
        ...base,
        sessionToken: member.account.token,
        queue: order.queue,
        mode: order.mode,
        party: order.partyId,
        partySize: order.size,
      });
      searching.onMessage("status", () => {});
      searching.onMessage("seat", (seat: SeatReservation) => seats.set(member.account.id, seat));
      open.push(searching);
    }
    await waitFor(() => seats.size === size, "seats");
    const matches = await Promise.all(players.map(player => sit(seats.get(player.id))));
    const room = server.container.matches.get(matches[0].room.roomId);
    await waitFor(() => room.simulation.players.length === size, "party seated");
    return { matches, room };
  }

  /** The team of each runner in the server's lobby, in seating order. */
  const teams = (room: { simulation: { players: { team: number }[] } }) =>
    room.simulation.players.map(runner => runner.team);

  it("puts the two members of a duo on the same team of a duos lobby", async () => {
    const { matches, room } = await searchTogether(2, "duo-cup", "duos");
    assert.equal(room.simulation.rules.teamSize, 2);
    const [first, second] = teams(room);
    assert.ok(first > 0, "the party is on a team");
    assert.equal(first, second, "the party plays together");
    // The clients see it in the lobby state too.
    for (const match of matches) {
      await waitFor(
        () => match.state?.players.length === 2 && match.state.players.every(player => player.team === first),
        "team in the lobby state",
      );
    }
  });

  it("keeps a party of three on one team of a squads lobby", async () => {
    const { room } = await searchTogether(3, "squad-cup", "squads");
    assert.equal(room.simulation.rules.teamSize, 4);
    const [first, ...rest] = teams(room);
    assert.ok(first > 0);
    assert.deepEqual(rest, [first, first]);
  });

  it("fills one team and continues on the next when the party is larger than a team", async () => {
    const { room } = await searchTogether(4, "duo-cup", "duos");
    const placed = teams(room);
    assert.ok(placed.every(team => team > 0));
    assert.equal(new Set(placed).size, 2, "two duo teams");
    for (const team of new Set(placed)) assert.equal(placed.filter(candidate => candidate === team).length, 2);
  });

  it("leaves players who search alone for the match to seat", async () => {
    const seats: SeatReservation[] = [];
    for (const name of ["Solo one", "Solo two"]) {
      const searching = await new Client(server.url).joinOrCreate("matchmaking", { ...base, queue: "duo-cup", name });
      searching.onMessage("status", () => {});
      searching.onMessage("seat", (seat: SeatReservation) => seats.push(seat));
      open.push(searching);
    }
    await waitFor(() => seats.length === 2, "seats");
    const matches = await Promise.all(seats.map(sit));
    const room = server.container.matches.get(matches[0].room.roomId);
    await waitFor(() => room.simulation.players.length === 2, "both seated");
    assert.deepEqual(teams(room), [0, 0], "no team until the match starts");
  });
});
