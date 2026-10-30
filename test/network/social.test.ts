import assert from "node:assert/strict";
import { Client, type Room } from "@colyseus/sdk";
import { config, startServer } from "../support/server.js";

describe("friends and private lobbies over the network", () => {
  it("runs friend requests, invitations, account identity and blocking end to end", async () => {
    const server = await startServer();
    const request = async (path: string, token = "", body?: unknown) => {
      const response = await fetch(server.url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", Authorization: token ? "Bearer " + token : "" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
    let room: Room;
    let guest: Room;
    try {
      const alpha = (
        await request("/api/account/register", "", {
          username: "alpha",
          displayName: "Real Alpha",
          password: "long-password-a",
        })
      ).data;
      const bravo = (await request("/api/account/register", "", { username: "bravo", password: "long-password-b" }))
        .data;
      assert.equal((await request("/api/social")).status, 401);
      assert.equal((await request("/api/social/accept", alpha.token, {})).status, 400);
      await request("/api/social/request", alpha.token, { username: "bravo" });
      assert.equal((await request("/api/social", bravo.token)).data.incoming[0].id, alpha.profile.id);
      await request("/api/social/accept", bravo.token, { userId: alpha.profile.id });

      const options = {
        protocol: config.protocol,
        revision: config.revision,
        sessionToken: alpha.token,
        name: "Spoofed",
      };
      room = await new Client(server.url).create("party_private", options);
      room.onStateChange(() => {});
      room.onMessage("identity", () => {});
      const listed = (await request("/api/rooms")).data.rooms;
      assert.deepEqual(
        listed.map((entry: { id: string; hostName: string; players: number }) => [
          entry.id,
          entry.hostName,
          entry.players,
        ]),
        [[room.roomId, "Real Alpha", 1]],
        "a created room shows in the room list",
      );
      assert.equal(
        (await request("/api/social/invite", bravo.token, { userId: alpha.profile.id, roomId: room.roomId })).status,
        403,
      );
      assert.equal(
        (await request("/api/social/invite", alpha.token, { userId: bravo.profile.id, roomId: room.roomId })).status,
        200,
      );
      const invite = (await request("/api/social", bravo.token)).data.invites[0];
      assert.equal(
        (await request("/api/social/invite/respond", alpha.token, { inviteId: invite.id, accept: true })).status,
        404,
      );
      const accepted = await request("/api/social/invite/respond", bravo.token, { inviteId: invite.id, accept: true });
      assert.equal(accepted.data.roomId, room.roomId);
      assert.equal(accepted.data.kind, "match");

      guest = await new Client(server.url).joinById(room.roomId, { ...options, sessionToken: bravo.token });
      guest.onStateChange(() => {});
      guest.onMessage("identity", () => {});
      assert.equal((await request("/api/rooms")).data.rooms[0].players, 2, "the list follows the seats");
      assert.equal(
        server.container.matches.get(room.roomId).simulation.players[0].name,
        "Real Alpha",
        "the account name wins over the client's",
      );
      await assert.rejects(new Client(server.url).joinById(room.roomId, options), /already in a match/);
      await guest.leave();
      guest = null;
      await request("/api/social/block", bravo.token, { userId: alpha.profile.id });
      assert.equal((await request("/api/social", alpha.token)).data.friends.length, 0);
      await assert.rejects(
        new Client(server.url).joinById(room.roomId, { ...options, sessionToken: bravo.token }),
        /unavailable/,
      );
      await request("/api/account/logout", bravo.token, {});
      assert.equal((await request("/api/social", bravo.token)).status, 401);
    } finally {
      if (guest?.connection.isOpen) await guest.leave();
      if (room?.connection.isOpen) await room.leave();
      await server.stop();
    }
  });
});
