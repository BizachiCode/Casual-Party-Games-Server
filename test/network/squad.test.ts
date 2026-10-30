import assert from "node:assert/strict";
import { Client, type Room, type SeatReservation } from "@colyseus/sdk";
import type { EventCatalog, EventDefinition } from "../../src/modules/events/events.catalog.js";
import type { SearchOrder, SquadState } from "../../src/modules/squad/squad.types.js";
import { config, startServer, waitFor, type TestServer } from "../support/server.js";

const base = { protocol: config.protocol, revision: config.revision };

/** An elite event (level 5) and an open one, both running around the fake clock below. */
const events: EventCatalog = {
  version: 1,
  events: ["elite-event:5", "open-event:1"].map((entry): EventDefinition => {
    const [id, minLevel] = entry.split(":");
    return {
      id,
      title: id,
      startsAt: "2026-10-30T00:00:00.000Z",
      endsAt: "2026-11-02T00:00:00.000Z",
      repeatDays: 0,
      queue: "race",
      playlist: "",
      courseId: "slime-slalom",
      minLevel: Number(minLevel),
      goals: [],
    };
  }),
};

interface Account {
  id: string;
  token: string;
}

/** One player's side of a squad room: what the server told them. */
interface Seat {
  room: Room;
  account: Account;
  state?: SquadState;
  searches: SearchOrder[];
  cancelled: number;
  notices: string[];
  closed?: number;
}

describe("squad (party) rooms", () => {
  let server: TestServer;
  let counter = 0;
  const open: Room[] = [];

  before(async () => {
    server = await startServer({}, { events, clock: () => new Date("2026-10-31T12:00:00Z"), squadSearchSeconds: 2 });
  });
  afterEach(async () => {
    for (const room of open.splice(0)) if (room.connection.isOpen) await room.leave();
    await waitFor(() => server.container.squads.all().length === 0, "squads disposed");
  });
  after(async () => {
    await server.stop();
  });

  async function account(prefix = "squad"): Promise<Account> {
    const signedIn = await server.container.accounts.register({
      username: `${prefix}_${++counter}`,
      password: "test-only-password",
    });
    return { id: signedIn.profile.id, token: signedIn.token };
  }

  async function befriend(first: Account, second: Account): Promise<void> {
    const { social } = server.container;
    const names = (id: string) => server.container.accounts.profile(id).then(profile => profile.username);
    await social.request(first.id, await names(second.id));
    await social.respond(second.id, first.id, true);
  }

  /** Creates a squad (no room id) or joins one, and listens to everything it sends. */
  async function sit(player: Account, roomId = "", options: Record<string, unknown> = {}): Promise<Seat> {
    const client = new Client(server.url);
    const joinOptions = { ...base, sessionToken: player.token, name: "Spoofed", ...options };
    const room = roomId ? await client.joinById(roomId, joinOptions) : await client.create("squad", joinOptions);
    open.push(room);
    const seat: Seat = { room, account: player, searches: [], cancelled: 0, notices: [] };
    room.onMessage("state", (state: SquadState) => (seat.state = state));
    room.onMessage("search", (order: SearchOrder) => seat.searches.push(order));
    room.onMessage("cancelled", () => seat.cancelled++);
    room.onMessage("notice", (notice: string) => seat.notices.push(notice));
    room.onLeave(code => (seat.closed = code));
    return seat;
  }

  const members = (seat: Seat) => seat.state?.members.length ?? 0;

  it("refuses players without a valid session and from another version", async () => {
    await assert.rejects(new Client(server.url).create("squad", { ...base }), /Sign in/);
    await assert.rejects(
      new Client(server.url).create("squad", { ...base, sessionToken: "nonsense" }),
      /Session expired/,
    );
    const player = await account();
    await assert.rejects(
      new Client(server.url).create("squad", { ...base, protocol: -1, sessionToken: player.token }),
      /version mismatch/,
    );
    assert.equal(server.container.squads.all().length, 0, "no party was left behind");
  });

  it("makes the creator leader and tells every member who is in the party", async () => {
    const [leader, friend] = [await account(), await account()];
    const first = await sit(leader);
    await waitFor(() => members(first) === 1, "leader state");
    assert.deepEqual(first.state.members[0], {
      sessionId: first.room.sessionId,
      accountId: leader.id,
      name: (await server.container.accounts.profile(leader.id)).displayName,
      characterId: "rookie",
      level: 1,
      ready: false,
    });
    assert.equal(first.state.id, first.room.roomId);
    assert.equal(first.state.leaderId, first.room.sessionId);
    assert.equal(first.state.status, "idle");
    assert.equal(first.state.search, null);

    const second = await sit(friend, first.room.roomId);
    await waitFor(() => members(first) === 2 && members(second) === 2, "both members");
    assert.deepEqual(
      second.state.members.map(member => member.accountId),
      [leader.id, friend.id],
      "members are listed in the order they joined",
    );
    assert.equal(second.state.leaderId, first.room.sessionId);

    second.room.send("ready", true);
    await waitFor(() => first.state.members[1].ready, "ready flag");
    second.room.send("ready", "yes");
    first.room.send("ready", true);
    await waitFor(() => first.state.members[0].ready, "leader ready");
    assert.equal(first.state.members[1].ready, true, "a value that is not a boolean changes nothing");
  });

  it("lets an account sit in one party only, refuses blocked pairs and full parties", async () => {
    const players = await Promise.all([account(), account(), account(), account(), account()]);
    const [leader, one, two, three, extra] = players;
    const first = await sit(leader);
    await assert.rejects(sit(leader), /Already in a party/);
    await assert.rejects(sit(leader, first.room.roomId), /Already in a party/);
    await server.container.social.block(one.id, extra.id);
    await sit(one, first.room.roomId);
    await assert.rejects(sit(extra, first.room.roomId), /Party unavailable/);
    await sit(two, first.room.roomId);
    await sit(three, first.room.roomId);
    await waitFor(() => members(first) === 4, "full party");
    await assert.rejects(sit(extra, first.room.roomId));
    assert.equal(members(first), 4);
  });

  it("passes the lead to the oldest member and removes members the leader kicks", async () => {
    const [leader, second, third, fourth] = await Promise.all([account(), account(), account(), account()]);
    const first = await sit(leader);
    const heir = await sit(second, first.room.roomId);
    const target = await sit(third, first.room.roomId);
    const bystander = await sit(fourth, first.room.roomId);
    await waitFor(() => members(bystander) === 4, "four members");

    await first.room.leave();
    await waitFor(() => members(heir) === 3 && heir.state.leaderId === heir.room.sessionId, "new leader");
    assert.deepEqual(
      heir.state.members.map(member => member.accountId),
      [second.id, third.id, fourth.id],
    );
    assert.equal(target.state.leaderId, heir.room.sessionId);

    bystander.room.send("kick", target.room.sessionId);
    heir.room.send("kick", "not-a-session");
    heir.room.send("kick", heir.room.sessionId);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(members(heir), 3, "only the leader can kick, and not themselves");

    heir.room.send("kick", target.room.sessionId);
    await waitFor(() => target.closed !== undefined && members(heir) === 2, "kick");
    assert.equal(target.closed, 4003);
    await assert.rejects(sit(third, heir.room.roomId), /Removed from this party/);
  });

  it("disposes a party when the last member leaves", async () => {
    const player = await account();
    const seat = await sit(player);
    await waitFor(() => members(seat) === 1, "state");
    const { roomId } = seat.room;
    assert.ok(server.container.squads.get(roomId));
    await seat.room.leave();
    await waitFor(() => !server.container.squads.get(roomId), "party disposed");
    const again = await sit(player);
    assert.notEqual(again.room.roomId, roomId, "the account is free to start another party");
  });

  it("refreshes a member's character and level when asked", async () => {
    const player = await account();
    const seat = await sit(player);
    await waitFor(() => members(seat) === 1, "state");
    const { collection, database } = server.container;
    await database.query("INSERT INTO characters VALUES(?,?)", [player.id, "coral"]);
    await collection.equip(player.id, "coral");
    await database.query("UPDATE users SET xp=600 WHERE id=?", [player.id]);
    seat.room.send("refresh");
    await waitFor(() => seat.state.members[0].characterId === "coral", "refreshed character");
    assert.equal(seat.state.members[0].level, 3);
  });

  describe("searching", () => {
    async function pair() {
      const [leader, friend] = [await account(), await account()];
      const first = await sit(leader);
      const second = await sit(friend, first.room.roomId);
      await waitFor(() => members(first) === 2 && members(second) === 2, "pair");
      return { leader, friend, first, second };
    }
    const settle = () => new Promise(resolve => setTimeout(resolve, 300));

    it("checks what a public search checks before it orders the members to search", async () => {
      const { leader, friend, first, second } = await pair();
      second.room.send("play", { queue: "race", mode: "race" });
      await settle();
      assert.equal(first.state.status, "idle", "only the leader can start a search");
      assert.deepEqual(second.notices, []);

      first.room.send("play", { queue: "missing", mode: "missing" });
      await waitFor(() => first.notices.length === 1, "unknown queue");
      assert.match(first.notices[0], /Unknown matchmaking queue/);
      first.room.send("play", "garbage");
      await waitFor(() => first.notices.length === 2, "garbage");
      first.room.send("play", { queue: "timeTrial", mode: "timeTrial" });
      await waitFor(() => first.notices.length === 3, "too few seats");
      assert.match(first.notices[2], /fewer seats/);

      first.room.send("play", { queue: "race", eventId: "elite-event" });
      await waitFor(() => first.notices.length === 4, "level");
      assert.match(first.notices[3], /Reach level 5/);
      first.room.send("play", { queue: "race", eventId: "missing-event" });
      await waitFor(() => first.notices.length === 5, "unknown event");
      assert.match(first.notices[4], /Unknown event/);
      first.room.send("play", { queue: "arcade", eventId: "open-event" });
      await waitFor(() => first.notices.length === 6, "event in another queue");
      assert.match(first.notices[5], /another queue/);
      // The leader alone qualifying is not enough: every member needs the level.
      await server.container.database.query("UPDATE users SET xp=1000 WHERE id=?", [leader.id]);
      first.room.send("play", { queue: "race", eventId: "elite-event" });
      await waitFor(() => first.notices.length === 7, "member level");
      assert.match(first.notices[6], /Reach level 5/);

      // A member who is already in a match cannot be ordered to search.
      const busy = await new Client(server.url).create("party_private", {
        ...base,
        sessionToken: friend.token,
      });
      open.push(busy);
      busy.onStateChange(() => {});
      for (const type of ["identity", "notice", "presence", "reconnectWindow"]) busy.onMessage(type, () => {});
      first.room.send("play", { queue: "race", mode: "race" });
      await waitFor(() => first.notices.length === 8, "member in a match");
      assert.match(first.notices[7], /already in a match/);
      await busy.leave();
      await waitFor(() => !server.container.matches.hasAccount(friend.id), "match left");
      assert.equal(first.state.status, "idle");
      assert.equal(second.searches.length + first.searches.length, 0);
    });

    it("orders every member to search once, and ends the search on cancel, done, timeout or a leaver", async () => {
      const { first, second } = await pair();
      first.room.send("play", { queue: "race", mode: "race", playlist: "mixed", courseId: "sky-sprint" });
      await waitFor(() => first.searches.length === 1 && second.searches.length === 1, "search order");
      const order = first.searches[0];
      assert.deepEqual(order, second.searches[0]);
      assert.deepEqual(Object.keys(order).sort(), [
        "courseId",
        "eventId",
        "mode",
        "partyId",
        "playlist",
        "queue",
        "size",
      ]);
      assert.equal(order.partyId, first.room.roomId + ":1");
      assert.deepEqual(
        [order.size, order.queue, order.mode, order.courseId, order.eventId],
        [2, "race", "race", "sky-sprint", ""],
      );
      await waitFor(() => second.state.status === "searching" && second.state.search !== null, "searching state");
      assert.deepEqual(second.state.search, order);

      first.room.send("play", { queue: "race", mode: "race" });
      second.room.send("play", { queue: "race", mode: "race" });
      await settle();
      assert.equal(first.searches.length, 1, "a search that is running is not started again");

      // Any member cancels.
      second.room.send("cancel");
      await waitFor(() => first.cancelled === 1 && second.cancelled === 1, "cancelled");
      assert.equal(first.state.status, "idle");
      assert.equal(first.state.search, null);

      // The next search has its own party id; only the leader can call it done.
      first.room.send("play", { queue: "race", mode: "race" });
      await waitFor(() => first.searches.length === 2, "second search");
      assert.equal(first.searches[1].partyId, first.room.roomId + ":2");
      second.room.send("searchDone");
      await settle();
      assert.equal(first.state.status, "searching", "a member cannot end the search as done");
      first.room.send("searchDone");
      await waitFor(() => first.state.status === "idle" && second.state.status === "idle", "search done");
      assert.equal(first.cancelled, 1, "done is not a cancellation");

      // A search nobody finishes is abandoned (the test server shortens the minute to two seconds).
      first.room.send("play", { queue: "race", mode: "race" });
      await waitFor(() => first.searches.length === 3, "third search");
      await waitFor(() => first.state.status === "idle" && first.cancelled === 2, "timeout");
      assert.equal(second.cancelled, 2);

      // A member leaving calls the search off for the rest.
      first.room.send("play", { queue: "race", mode: "race" });
      await waitFor(() => first.searches.length === 4, "fourth search");
      await second.room.leave();
      await waitFor(
        () => first.cancelled === 3 && first.state.status === "idle" && members(first) === 1,
        "member left",
      );
    });

    it("refuses new members while the party searches", async () => {
      const { first } = await pair();
      const latecomer = await account();
      first.room.send("play", { queue: "race", mode: "race" });
      await waitFor(() => first.state.status === "searching", "searching");
      await assert.rejects(sit(latecomer, first.room.roomId), /searching/);
    });

    it("searches as one unit: both members land in the same match, and forged party ids are refused", async () => {
      const { leader, friend, first, second } = await pair();
      first.room.send("play", { queue: "race", mode: "race", courseId: "sky-sprint" });
      await waitFor(() => first.searches.length === 1 && second.searches.length === 1, "order");
      const order = first.searches[0];
      const searchOptions = (player: Account, extra: Record<string, unknown> = {}) => ({
        ...base,
        sessionToken: player.token,
        queue: order.queue,
        mode: order.mode,
        party: order.partyId,
        partySize: order.size,
        ...extra,
      });

      // Someone outside the party, or a made-up party id, is not let into its search.
      const outsider = await account();
      await assert.rejects(
        new Client(server.url).joinOrCreate("matchmaking", searchOptions(outsider)),
        /party is not searching/,
      );
      await assert.rejects(
        new Client(server.url).joinOrCreate("matchmaking", searchOptions(leader, { party: first.room.roomId + ":9" })),
        /party is not searching/,
      );
      await assert.rejects(
        new Client(server.url).joinOrCreate("matchmaking", { ...searchOptions(leader), party: "forged" }),
        /party is not searching/,
      );
      await assert.rejects(
        new Client(server.url).joinOrCreate("matchmaking", { ...searchOptions(leader), party: "x", sessionToken: "" }),
        /./,
      );
      await assert.rejects(
        new Client(server.url).joinOrCreate(
          "matchmaking",
          searchOptions(leader, { queue: "tournament", mode: "tournament" }),
        ),
        /searches another queue/,
      );

      const seats: Record<string, SeatReservation> = {};
      const queues: Room[] = [];
      for (const player of [leader, friend]) {
        const client = new Client(server.url);
        const queue = await client.joinOrCreate("matchmaking", searchOptions(player));
        queue.onMessage("status", () => {});
        queue.onMessage("seat", (seat: SeatReservation) => (seats[player.id] = seat));
        queues.push(queue);
        open.push(queue);
        // The first member waits for the second: the unit is not placed with one ticket.
        if (player === leader) {
          await settle();
          assert.equal(seats[leader.id], undefined);
        }
      }
      await waitFor(() => seats[leader.id] && seats[friend.id], "seats");
      assert.equal(seats[leader.id].roomId, seats[friend.id].roomId, "the party plays one match");
      const matches = await Promise.all(
        [leader, friend].map(async player => {
          const match = await new Client(server.url).consumeSeatReservation(seats[player.id]);
          for (const type of ["presence", "reconnectWindow", "identity", "notice"]) match.onMessage(type, () => {});
          open.push(match);
          return match;
        }),
      );
      const room = server.container.matches.get(matches[0].roomId);
      await waitFor(() => room.simulation.players.length === 2, "both seated");
      assert.deepEqual([...room.accounts.values()].sort(), [leader.id, friend.id].sort());
      assert.equal(room.queue, "race");
      assert.equal(room.simulation.course.id, "sky-sprint");

      first.room.send("searchDone");
      await waitFor(() => first.state.status === "idle", "done");
    });

    it("calls the whole party off when one member leaves the queue", async () => {
      const { leader, friend, first, second } = await pair();
      // A duo never reaches the four players the tournament queue needs, so it keeps waiting.
      first.room.send("play", { queue: "tournament", mode: "tournament" });
      await waitFor(() => first.searches.length === 1 && second.searches.length === 1, "order");
      const order = first.searches[0];
      const join = async (player: Account) => {
        const queue = await new Client(server.url).joinOrCreate("matchmaking", {
          ...base,
          sessionToken: player.token,
          queue: order.queue,
          party: order.partyId,
          partySize: order.size,
        });
        const seen = { cancelled: 0, closed: false };
        queue.onMessage("status", () => {});
        queue.onMessage("seat", () => {});
        queue.onMessage("partyCancelled", () => seen.cancelled++);
        queue.onLeave(() => (seen.closed = true));
        open.push(queue);
        return { queue, seen };
      };
      const [one, other] = [await join(leader), await join(friend)];
      await settle();
      assert.equal(one.queue.connection.isOpen && other.queue.connection.isOpen, true, "waiting for more players");
      await other.queue.leave();
      await waitFor(() => one.seen.cancelled === 1 && one.seen.closed, "party cancelled");
      assert.equal(other.seen.cancelled, 0, "the one who left is not told");
      assert.equal(server.container.matchmaking.isSearching(leader.id), false);
      assert.equal(server.container.matchmaking.isSearching(friend.id), false);
    });
  });

  describe("invitations and presence", () => {
    async function request(path: string, token: string, body?: unknown) {
      const response = await fetch(server.url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    }

    it("invites friends to a party, answers with the squad kind and shows the party on the friends list", async () => {
      const [leader, friend, stranger] = [await account(), await account(), await account()];
      await befriend(leader, friend);
      await befriend(leader, stranger);
      const first = await sit(leader);
      await waitFor(() => members(first) === 1, "state");
      const invite = (userId: string, token: string, roomId: string) =>
        request("/api/social/invite", token, { userId, roomId });

      // Only a member can invite to the party.
      assert.equal((await invite(leader.id, friend.token, first.room.roomId)).status, 403);
      assert.equal((await invite(friend.id, leader.token, first.room.roomId)).status, 200);
      const pending = (await request("/api/social", friend.token)).data.invites;
      assert.equal(pending.length, 1);
      assert.equal(pending[0].roomId, first.room.roomId);

      const accepted = await request("/api/social/invite/respond", friend.token, {
        inviteId: pending[0].id,
        accept: true,
      });
      assert.deepEqual(accepted.data, { roomId: first.room.roomId, kind: "squad" });
      const second = await sit(friend, accepted.data.roomId);
      await waitFor(() => members(first) === 2, "friend joined");

      const friends = (await request("/api/social", stranger.token)).data.friends;
      assert.deepEqual(
        friends.map((entry: { id: string; partyId: string; roomId: string }) => [
          entry.id,
          entry.partyId,
          entry.roomId,
        ]),
        [[leader.id, first.room.roomId, ""]],
        "a friend in a party shows the party and no match room",
      );
      assert.equal(
        (await request("/api/social", leader.token)).data.friends.find(
          (entry: { id: string }) => entry.id === friend.id,
        ).partyId,
        first.room.roomId,
      );

      // A declined invitation answers with the kind too and sends nobody anywhere.
      assert.equal((await invite(stranger.id, leader.token, first.room.roomId)).status, 200);
      const declined = (await request("/api/social", stranger.token)).data.invites[0];
      const refusal = await request("/api/social/invite/respond", stranger.token, {
        inviteId: declined.id,
        accept: false,
      });
      assert.deepEqual(refusal.data, { roomId: "", kind: "squad" });

      // A party that is searching cannot take the invited friend.
      assert.equal((await invite(stranger.id, leader.token, first.room.roomId)).status, 200);
      const late = (await request("/api/social", stranger.token)).data.invites[0];
      first.room.send("play", { queue: "race", mode: "race" });
      await waitFor(() => first.state.status === "searching", "searching");
      const full = await request("/api/social/invite/respond", stranger.token, { inviteId: late.id, accept: true });
      assert.equal(full.status, 409);
      first.room.send("cancel");

      await second.room.leave();
      await waitFor(() => members(first) === 1, "friend left");
      const after = (await request("/api/social", leader.token)).data.friends.find(
        (entry: { id: string }) => entry.id === friend.id,
      );
      assert.equal(after.partyId, "");
    });

    it("still answers private match invitations with the match kind", async () => {
      const [host, friend] = [await account(), await account()];
      await befriend(host, friend);
      const lobby = await new Client(server.url).create("party_private", { ...base, sessionToken: host.token });
      open.push(lobby);
      lobby.onStateChange(() => {});
      for (const type of ["identity", "notice", "presence", "reconnectWindow"]) lobby.onMessage(type, () => {});
      assert.equal(
        (await request("/api/social/invite", host.token, { userId: friend.id, roomId: lobby.roomId })).status,
        200,
      );
      const pending = (await request("/api/social", friend.token)).data.invites[0];
      const accepted = await request("/api/social/invite/respond", friend.token, {
        inviteId: pending.id,
        accept: true,
      });
      assert.deepEqual(accepted.data, { roomId: lobby.roomId, kind: "match" });
    });

    it("removes a member from the party when they log out", async () => {
      const [leader, friend] = [await account(), await account()];
      const first = await sit(leader);
      const second = await sit(friend, first.room.roomId);
      await waitFor(() => members(first) === 2 && members(second) === 2, "pair");
      assert.equal((await request("/api/account/logout", friend.token, {})).status, 200);
      await waitFor(() => second.closed === 4001 && members(first) === 1, "member removed");
      assert.equal(server.container.squads.hasAccount(friend.id), false);
    });
  });
});
