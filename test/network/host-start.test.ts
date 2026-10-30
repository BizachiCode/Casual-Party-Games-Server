import assert from "node:assert/strict";
import { Client, type Room } from "@colyseus/sdk";
import type { PartyRoom } from "../../src/modules/match/party.room.js";
import { config, startServer, waitFor, type TestServer } from "../support/server.js";

const options = { protocol: config.protocol, revision: config.revision, name: "Host start" };
const quiet = (room: Room) => {
  for (const type of ["presence", "reconnectWindow", "identity", "notice", "chat"]) room.onMessage(type, () => {});
  room.onStateChange(() => {});
  return room;
};

describe("created rooms", () => {
  let server: TestServer;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.stop();
  });

  it("start when their host asks, with bots in the empty seats, and never on a guest's request", async () => {
    const host = quiet(await new Client(server.url).create("party_private", { ...options, matchSize: 6 }));
    const guest = quiet(await new Client(server.url).joinById(host.roomId, { ...options, name: "Guest" }));
    try {
      const room: PartyRoom = server.container.matches.get(host.roomId);
      await waitFor(() => room.simulation.players.length === 2, "both players in");
      guest.send("ready");
      host.send("ready");
      guest.send("start", true);
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(room.simulation.phase, "lobby", "neither readiness nor a guest starts a created room");
      assert.equal(room.simulation.players.filter(runner => runner.bot).length, 0, "and no bot joins on its own");
      host.send("start", true);
      await waitFor(() => room.simulation.phase === "countdown", "host start");
      assert.equal(room.simulation.players.length, 6, "bots took the four empty seats");
    } finally {
      await guest.leave();
      await host.leave();
    }
  });

  it("start with only the humans when the host turns bots off", async () => {
    const host = quiet(await new Client(server.url).create("party_private", { ...options, matchSize: 6 }));
    try {
      const room: PartyRoom = server.container.matches.get(host.roomId);
      host.send("start", false);
      await waitFor(() => room.simulation.phase === "countdown", "host start");
      assert.deepEqual(
        room.simulation.players.map(runner => runner.bot),
        [false],
      );
    } finally {
      await host.leave();
    }
  });
});
