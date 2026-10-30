import assert from "node:assert/strict";
import { join } from "node:path";
import { Client, type Room } from "@colyseus/sdk";
import { gameConfigDirectory } from "../../src/config/paths.js";
import { loadMatchmakingCatalog, MATCHMAKING_FILE } from "../../src/modules/matchmaking/matchmaking.catalog.js";
import type { SquadState } from "../../src/modules/squad/squad.types.js";
import { config, startServer, waitFor, type TestServer } from "../support/server.js";

const base = { protocol: config.protocol, revision: config.revision };

/** A server whose catalog allows parties of `maxMembers`. */
function serverWith(maxMembers: number): Promise<TestServer> {
  const catalog = structuredClone(loadMatchmakingCatalog(join(gameConfigDirectory, MATCHMAKING_FILE), config));
  catalog.parties = { maxMembers };
  return startServer({}, { matchmaking: catalog });
}

describe("party size from the matchmaking catalog", () => {
  let server: TestServer;
  let counter = 0;
  const open: Room[] = [];

  afterEach(async () => {
    for (const room of open.splice(0)) if (room.connection.isOpen) await room.leave();
    await waitFor(() => server.container.squads.all().length === 0, "squads disposed");
    await server.stop();
  });

  async function account() {
    const signedIn = await server.container.accounts.register({
      username: `size_${++counter}`,
      password: "test-only-password",
    });
    return { id: signedIn.profile.id, token: signedIn.token };
  }

  /** Creates a party (no room id) or joins one. */
  async function sit(player: { token: string }, roomId = "") {
    const client = new Client(server.url);
    const options = { ...base, sessionToken: player.token };
    const room = roomId ? await client.joinById(roomId, options) : await client.create("squad", options);
    open.push(room);
    const seat: { room: Room; state?: SquadState } = { room };
    room.onMessage("state", (state: SquadState) => (seat.state = state));
    for (const type of ["search", "cancelled", "notice"]) room.onMessage(type, () => {});
    return seat;
  }

  async function invitedTo(
    leader: { id: string; token: string },
    guest: { id: string; token: string },
    roomId: string,
  ) {
    const { social, accounts } = server.container;
    await social.request(leader.id, (await accounts.profile(guest.id)).username);
    await social.respond(guest.id, leader.id, true);
    await social.invite(leader.id, guest.id, roomId);
    const pending = (await social.state(guest.id)).invites[0];
    return fetch(server.url + "/api/social/invite/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + guest.token },
      body: JSON.stringify({ inviteId: pending.id, accept: true }),
    });
  }

  it("refuses a third member when the catalog allows two", async () => {
    server = await serverWith(2);
    const [leader, friend, third] = [await account(), await account(), await account()];
    const first = await sit(leader);
    await sit(friend, first.room.roomId);
    await waitFor(() => first.state?.members.length === 2, "two members");
    assert.equal(first.room.roomId.length > 0 && server.container.squads.get(first.room.roomId).maxMembers, 2);
    assert.equal((await invitedTo(leader, third, first.room.roomId)).status, 409, "the invitation sees a full party");
    await assert.rejects(sit(third, first.room.roomId));
    assert.equal(first.state.members.length, 2);
  });

  it("takes five members when the catalog allows six, and no more than six", async () => {
    server = await serverWith(6);
    const players = await Promise.all(Array.from({ length: 7 }, () => account()));
    const first = await sit(players[0]);
    for (const player of players.slice(1, 5)) await sit(player, first.room.roomId);
    await waitFor(() => first.state?.members.length === 5, "five members");
    const sixth = await sit(players[5], first.room.roomId);
    await waitFor(() => first.state?.members.length === 6 && sixth.state?.members.length === 6, "six members");
    await assert.rejects(sit(players[6], first.room.roomId));
    assert.equal(first.state.members.length, 6);
  });

  it("keeps a party of one when the catalog turns inviting off", async () => {
    server = await serverWith(1);
    const [leader, friend] = [await account(), await account()];
    const first = await sit(leader);
    await waitFor(() => first.state?.members.length === 1, "leader");
    await assert.rejects(sit(friend, first.room.roomId));
    assert.equal((await invitedTo(leader, friend, first.room.roomId)).status, 409);
  });

  it("uses four without a parties section", async () => {
    const catalog = structuredClone(loadMatchmakingCatalog(join(gameConfigDirectory, MATCHMAKING_FILE), config));
    delete catalog.parties;
    server = await startServer({}, { matchmaking: catalog });
    const players = await Promise.all(Array.from({ length: 5 }, () => account()));
    const first = await sit(players[0]);
    for (const player of players.slice(1, 4)) await sit(player, first.room.roomId);
    await waitFor(() => first.state?.members.length === 4, "four members");
    await assert.rejects(sit(players[4], first.room.roomId));
  });
});
