import assert from "node:assert/strict";
import { Client, type Room } from "@colyseus/sdk";
import { PartySimulation, type MatchSnapshot } from "../../src/modules/match/simulation/party-simulation.js";
import { wireSnapshot } from "../../src/modules/match/wire/match-wire.js";
import { config, readyMatchmaking, startServer, waitFor, type TestServer } from "../support/server.js";

/** Decodes the room state the way the Unity client does and records the identity the server assigns. */
function observe(room: Room) {
  const view: { state: MatchSnapshot; identity: string } = { state: null, identity: null };
  room.onMessage("presence", () => {});
  room.onMessage("reconnectWindow", () => {});
  room.onStateChange(state => {
    view.state = wireSnapshot(state);
  });
  room.onMessage("identity", (id: string) => {
    view.identity = id;
  });
  room.send("sync");
  return view;
}
const options = { protocol: config.protocol, revision: config.revision, name: "Test runner" };

describe("match rooms", () => {
  let server: TestServer;
  before(async () => {
    server = await startServer({}, { matchmaking: readyMatchmaking() });
  });
  after(async () => {
    await server.stop();
  });

  it("answers health and rejects a client with another content version", async () => {
    assert.deepEqual(await (await fetch(server.url + "/health")).json(), {
      ok: true,
      protocol: config.protocol,
      revision: config.revision,
    });
    await assert.rejects(
      new Client(server.url).joinOrCreate("party", { ...options, protocol: -1 }),
      /version mismatch/,
    );
  });

  it("shares a room, starts when everyone is ready, applies only authoritative input and cleans up", async () => {
    const first = await new Client(server.url).joinOrCreate("party", options);
    const second = await new Client(server.url).joinById(first.roomId, { ...options, name: "Second" });
    try {
      const firstView = observe(first);
      const secondView = observe(second);
      await waitFor(() => firstView.state?.players.length === 2 && secondView.state?.players.length === 2, "lobby");
      assert.equal(firstView.identity, first.sessionId);
      assert.equal(secondView.identity, second.sessionId);
      first.send("ready");
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(firstView.state.phase, "lobby");
      second.send("ready");
      await waitFor(() => firstView.state?.phase === "running" && secondView.state?.phase === "running", "countdown");
      // Public rooms take their seats from the matchmaking queue of the mode; bots fill empty ones, up to their cap.
      const queue = server.container.matchmaking.queue(undefined, "tournament");
      const seats = queue.bots.max < 0 ? queue.players.max : Math.min(queue.players.max, 2 + queue.bots.max);
      assert.equal(firstView.state.players.length, seats);
      await assert.rejects(new Client(server.url).joinById(first.roomId, options));
      first.send("finish", { winnerId: first.sessionId });
      first.send("input", { seq: 0, x: 0, z: 1, jump: false, dive: false, position: { z: 10000 } });
      await waitFor(() => firstView.state.players.find(player => player.id === first.sessionId)?.vz > 0, "movement");
      const player = firstView.state.players.find(player => player.id === first.sessionId);
      assert.ok(player.z < 2);
      assert.equal(firstView.state.winnerId, "");
      assert.equal(secondView.state.players.find(player => player.id === first.sessionId).seq, 0);
      await first.leave();
      await waitFor(
        () => !secondView.state.players.some(player => player.id === first.sessionId),
        "disconnect cleanup",
      );
    } finally {
      if (first.connection.isOpen) await first.leave();
      if (second.connection.isOpen) await second.leave();
    }
  });

  it("sanitizes and throttles lobby chat, toggles readiness and lets only the host kick", async () => {
    const lobby = { ...options, mode: "duos", matchSize: 4 };
    const host = await new Client(server.url).create("party_private", lobby);
    const guest = await new Client(server.url).joinById(host.roomId, lobby);
    try {
      let state: MatchSnapshot;
      const messages: { text: string }[] = [];
      for (const room of [host, guest]) {
        room.onStateChange(wire => {
          if (room === host) state = wireSnapshot(wire);
        });
        room.onMessage("chat", (json: string) => {
          if (room === guest) messages.push(JSON.parse(json));
        });
        room.onMessage("notice", () => {});
      }
      const hostPlayer = () => state.players.find(player => player.id === host.sessionId);
      host.send("team", 2);
      guest.send("team", 2);
      await waitFor(() => state?.players.length === 2 && state.players.every(player => player.team === 2), "teams");
      host.send("setReady", true);
      await waitFor(() => hostPlayer().ready, "ready");
      host.send("setReady", false);
      await waitFor(() => !hostPlayer().ready, "not ready");
      guest.send("kick", host.sessionId);
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(host.connection.isOpen, true, "only the host may kick");
      host.send("chat", "<hello>\nworld");
      host.send("chat", "spam");
      await waitFor(() => messages.length > 0, "chat");
      assert.equal(messages[0].text, "helloworld");
      assert.equal(messages.length, 1);
      host.send("kick", guest.sessionId);
      await waitFor(() => !guest.connection.isOpen, "kick");
      assert.equal(server.container.matches.get(host.roomId).simulation.players.length, 1);
    } finally {
      if (host.connection.isOpen) await host.leave();
      if (guest.connection.isOpen) await guest.leave();
    }
  });
});

describe("lobby rules", () => {
  it("enforces team capacity, keeps teammates together, migrates the host and rate-limits emotes", () => {
    const simulation = new PartySimulation(config, 8, { mode: "duos" });
    for (const id of ["a", "b", "c"]) simulation.addPlayer(id, id);
    assert.equal(simulation.selectTeam("a", 2), true);
    assert.equal(simulation.selectTeam("b", 2), true);
    assert.equal(simulation.selectTeam("c", 2), false);
    assert.equal(simulation.selectTeam("c", 99), false);
    assert.equal(simulation.emote("a", "unknown"), false);
    assert.equal(simulation.emote("a", "gg"), true);
    assert.equal(simulation.emote("a", "wave"), false);
    for (const id of ["a", "b", "c"]) simulation.ready(id);
    simulation.step();
    assert.equal(simulation.players.find(player => player.id === "a").team, 2);
    assert.equal(simulation.players.find(player => player.id === "b").team, 2);
    assert.equal(simulation.selectTeam("a", 1), false);
    assert.ok(
      simulation.players.every(player => simulation.players.filter(other => other.team === player.team).length <= 2),
    );
    simulation.removePlayer("a");
    assert.equal(simulation.hostId, "b");
  });

  it("rejects sequence numbers the C# client could not decode", () => {
    const simulation = new PartySimulation(config, 1);
    simulation.addPlayer("p", "p");
    simulation.ready("p");
    while (simulation.phase !== "running") simulation.step();
    assert.equal(simulation.input("p", { seq: 2147483648, x: 0, z: 0, jump: false, dive: false }), false);
    assert.equal(simulation.snapshot().players[0].seq, -1);
  });
});
