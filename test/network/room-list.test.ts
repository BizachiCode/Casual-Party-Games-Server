import assert from "node:assert/strict";
import { Client, type Room } from "@colyseus/sdk";
import type { PartyRoom } from "../../src/modules/match/party.room.js";
import { config, readyMatchmaking, startServer, waitFor, type TestServer } from "../support/server.js";

const quiet = (room: Room) => {
  for (const type of ["presence", "reconnectWindow", "identity", "notice", "chat"]) room.onMessage(type, () => {});
  room.onStateChange(() => {});
  return room;
};
const options = (name: string) => ({ protocol: config.protocol, revision: config.revision, name });

interface Listing {
  id: string;
  hostName: string;
  players: number;
  capacity: number;
}
const listRooms = async (server: TestServer): Promise<Listing[]> =>
  (await (await fetch(server.url + "/api/rooms")).json()).rooms;

describe("the room list shows created rooms", () => {
  it("lists a created room, lets another player join it from the list and drops it when full or started", async () => {
    const server = await startServer();
    const rooms: Room[] = [];
    try {
      const host = quiet(
        await new Client(server.url).create("party_private", { ...options("List Host"), matchSize: 2 }),
      );
      rooms.push(host);
      assert.deepEqual(
        (await listRooms(server)).map(entry => [entry.id, entry.hostName, entry.players, entry.capacity]),
        [[host.roomId, "List Host", 1, 2]],
      );

      const [listed] = await listRooms(server);
      const guest = quiet(await new Client(server.url).joinById(listed.id, options("List Guest")));
      rooms.push(guest);
      await waitFor(() => server.container.matches.get(host.roomId).humanCount === 2, "both players seated");
      assert.deepEqual(await listRooms(server), [], "a full room leaves the list");

      await guest.leave();
      await waitFor(async () => (await listRooms(server)).length === 1, "the freed seat lists the room again");
      host.send("start", false);
      const room: PartyRoom = server.container.matches.get(host.roomId);
      await waitFor(() => room.simulation.phase !== "lobby", "the host started the match");
      assert.deepEqual(await listRooms(server), [], "a started match leaves the list");
    } finally {
      for (const room of rooms) if (room.connection.isOpen) await room.leave();
      await server.stop();
    }
  });

  it("keeps created rooms join-by-code when the matchmaking catalog turns listing off", async () => {
    const matchmaking = readyMatchmaking();
    matchmaking.privateRooms.listed = false;
    const server = await startServer({}, { matchmaking });
    let host: Room | undefined;
    try {
      host = quiet(await new Client(server.url).create("party_private", options("Hidden Host")));
      assert.deepEqual(await listRooms(server), []);
      const guest = quiet(await new Client(server.url).joinById(host.roomId, options("Code Guest")));
      await guest.leave();
    } finally {
      if (host?.connection.isOpen) await host.leave();
      await server.stop();
    }
  });
});
