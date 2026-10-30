import assert from "node:assert/strict";
import { Client, type Room } from "@colyseus/sdk";
import type { PartyConfig } from "../../src/modules/content/content.types.js";
import { validateCatalogs } from "../../src/modules/content/content.validation.js";
import { MATCH_OVER, type PartyRoom } from "../../src/modules/match/party.room.js";
import {
  config,
  content,
  contentWithRoom,
  readyMatchmaking,
  startServer,
  waitFor,
  type TestServer,
} from "../support/server.js";

const options = { protocol: config.protocol, revision: config.revision, name: "Recovery test" };

/**
 * A server with a short reconnection window (and a finished match closing after `closeSeconds`) and a client whose own
 * automatic reconnection is off.
 */
async function fixture(seconds = 2, closeSeconds = 30) {
  const room = { reconnectSeconds: seconds, closeAfterFinishSeconds: closeSeconds };
  const server = await startServer({}, { content: contentWithRoom(room), matchmaking: readyMatchmaking() });
  const client = new Client(server.url);
  const joined: Room[] = [];
  const observe = (room: Room) => {
    room.reconnection.enabled = false;
    room.onMessage("presence", () => {});
    room.onMessage("reconnectWindow", () => {});
    room.onStateChange(() => {});
    room.onMessage("identity", () => {});
    joined.push(room);
    return room;
  };
  const close = async () => {
    for (const room of joined) if (room.connection.isOpen) await room.leave();
    await server.stop();
  };
  return { server, client, observe, close };
}
const roomOf = (server: TestServer, roomId: string): PartyRoom => server.container.matches.get(roomId);
/** A trusted fixture ends the match on the server with the session as its winner; no client message can. */
function finish(room: PartyRoom, id: string) {
  const player = room.simulation.players.find(runner => runner.id === id);
  player.status = "qualified";
  player.totalScore = 30;
  room.simulation.phase = "finished";
  room.simulation.winnerId = id;
  room.simulation.winnerIds = [id];
}
/** Cuts the player's socket on the server side, as a network loss would. */
async function drop(room: PartyRoom, id: string) {
  await waitFor(() => room.clients.find(seat => seat.sessionId === id)?.state === 1, "join acknowledgement");
  (room.clients.find(seat => seat.sessionId === id).ref as unknown as { terminate(): void }).terminate();
}

describe("reconnection", () => {
  it("keeps player, team and sequence across a socket loss, clears held input, rotates the token", async () => {
    const setup = await fixture();
    try {
      const account = await setup.server.container.accounts.register({
        username: "reconnectrunner",
        password: "test-recovery-password",
      });
      const first = setup.observe(
        await setup.client.create("party", { ...options, mode: "duos", matchSize: 4, sessionToken: account.token }),
      );
      const room = roomOf(setup.server, first.roomId);
      const id = first.sessionId;
      first.send("team", 1);
      first.send("ready");
      await waitFor(() => room.simulation.phase === "running", "running");
      first.send("input", { seq: 70, x: 1, z: 0, jump: false, dive: false });
      await waitFor(() => room.simulation.players.find(runner => runner.id === id)?.seq === 70, "input");
      const player = room.simulation.players.find(runner => runner.id === id);
      const token = first.reconnectionToken;
      const tick = room.simulation.tick;
      await drop(room, id);
      await waitFor(() => room.suspended.has(id), "reservation");
      await assert.rejects(
        setup.client.reconnect(first.roomId + ":" + first.sessionId),
        undefined,
        "a session id is not a resume capability",
      );
      assert.equal(player.inputX, 0);
      assert.equal(player.inputZ, 0);
      assert.equal(player.jump, false);
      await assert.rejects(
        setup.client.joinOrCreate("party", { ...options, sessionToken: account.token }),
        /already in a match/,
      );
      const resumed = setup.observe(await setup.client.reconnect(token));
      await waitFor(() => !room.suspended.has(id), "resume");
      assert.equal(resumed.sessionId, id);
      assert.equal(
        room.simulation.players.find(runner => runner.id === id),
        player,
      );
      assert.equal(player.team, 1);
      assert.equal(player.seq, 70);
      assert.ok(room.simulation.tick >= tick);
      assert.equal(room.accounts.get(id), account.profile.id);
      assert.notEqual(resumed.reconnectionToken, token);
      await assert.rejects(setup.client.reconnect(token));
      resumed.send("input", { seq: 71, x: 0, z: 1, jump: false, dive: false });
      await waitFor(() => player.seq === 71, "post-reconnect input");
      assert.equal(room.simulation.players.filter(runner => runner.id === id).length, 1);
    } finally {
      await setup.close();
    }
  });

  it("cancels readiness on a lobby loss, announces the held seat and keeps the host until it expires", async () => {
    const setup = await fixture(1);
    try {
      const host = setup.observe(await setup.client.create("party", options));
      const other = setup.observe(await setup.client.joinById(host.roomId, options));
      const room = roomOf(setup.server, host.roomId);
      let suspended: string[] = [];
      other.onMessage("presence", (ids: string[]) => {
        suspended = ids;
      });
      host.send("ready");
      await waitFor(() => room.simulation.players.find(runner => runner.id === host.sessionId)?.ready, "ready");
      await drop(room, host.sessionId);
      await waitFor(() => suspended.includes(host.sessionId), "presence");
      other.send("ready");
      assert.equal(room.simulation.hostId, host.sessionId);
      assert.equal(room.humanCount, 2);
      await waitFor(
        () => !room.simulation.players.some(runner => runner.id === host.sessionId),
        "expired seat cleanup",
      );
      assert.equal(room.simulation.hostId, other.sessionId);
      await assert.rejects(setup.client.reconnect(host.reconnectionToken));
    } finally {
      await setup.close();
    }
  });

  it("revokes a held seat on logout; its token cannot restore the session", async () => {
    const setup = await fixture();
    try {
      const account = await setup.server.container.accounts.register({
        username: "revokedrunner",
        password: "test-recovery-password",
      });
      const first = setup.observe(await setup.client.create("party", { ...options, sessionToken: account.token }));
      const room = roomOf(setup.server, first.roomId);
      const token = first.reconnectionToken;
      await drop(room, first.sessionId);
      await waitFor(() => room.suspended.has(first.sessionId), "dropped account");
      const response = await fetch(setup.server.url + "/api/account/logout", {
        method: "POST",
        headers: { Authorization: "Bearer " + account.token },
      });
      assert.equal(response.status, 200);
      await waitFor(() => !room.suspended.has(first.sessionId), "revocation cleanup");
      await assert.rejects(setup.client.reconnect(token));
      assert.equal(room.simulation.players.length, 0);
    } finally {
      await setup.close();
    }
  });

  it("releases the seat at once on an explicit leave or a kick, without a reconnection window", async () => {
    const setup = await fixture();
    try {
      const host = setup.observe(await setup.client.create("party", options));
      const victim = setup.observe(await setup.client.joinById(host.roomId, options));
      const room = roomOf(setup.server, host.roomId);
      const token = victim.reconnectionToken;
      host.send("kick", victim.sessionId);
      await waitFor(() => !room.simulation.players.some(runner => runner.id === victim.sessionId), "kick");
      assert.equal(room.suspended.size, 0);
      await assert.rejects(setup.client.reconnect(token));
      await host.leave();
      assert.equal(room.suspended.size, 0);
    } finally {
      await setup.close();
    }
  });

  it("lets the host remove a disconnected player for good", async () => {
    const setup = await fixture();
    try {
      const host = setup.observe(await setup.client.create("party", options));
      const victim = setup.observe(await setup.client.joinById(host.roomId, options));
      const room = roomOf(setup.server, host.roomId);
      const token = victim.reconnectionToken;
      await drop(room, victim.sessionId);
      await waitFor(() => room.suspended.has(victim.sessionId), "reserved victim");
      host.send("kick", victim.sessionId);
      await waitFor(() => !room.suspended.has(victim.sessionId), "reservation revoked by host");
      assert.equal(room.simulation.players.length, 1);
      await assert.rejects(setup.client.reconnect(token));
    } finally {
      await setup.close();
    }
  });

  it("pays a finished match once and holds no seat after the finish", async () => {
    const setup = await fixture();
    try {
      const { accounts, collection, rewards } = setup.server.container;
      const account = await accounts.register({ username: "resultreturn", password: "test-recovery-password" });
      const first = setup.observe(await setup.client.create("party", { ...options, sessionToken: account.token }));
      const room = roomOf(setup.server, first.roomId);
      const id = first.sessionId;
      finish(room, id);
      await waitFor(() => room.recorded, "match reward receipt");
      const results = room.simulation.snapshot();
      const paid = new Map(room.accounts);
      const before = await collection.state(account.profile.id);
      assert.equal((await accounts.profile(account.profile.id)).matches, 1);
      const token = first.reconnectionToken;
      await drop(room, id);
      await waitFor(() => !room.simulation.players.some(runner => runner.id === id), "seat released");
      assert.equal(room.suspended.size, 0);
      await assert.rejects(setup.client.reconnect(token));
      assert.deepEqual(await rewards.complete(room.roomId, results, paid), []);
      assert.equal((await collection.state(account.profile.id)).credits, before.credits);
      assert.equal((await accounts.profile(account.profile.id)).matches, 1);
    } finally {
      await setup.close();
    }
  });

  it("never holds the seat of an eliminated runner", async () => {
    const setup = await fixture();
    try {
      const first = setup.observe(await setup.client.create("party", { ...options, matchSize: 4 }));
      const room = roomOf(setup.server, first.roomId);
      const id = first.sessionId;
      first.send("ready");
      await waitFor(() => room.simulation.phase === "running", "running");
      room.simulation.players.find(runner => runner.id === id).status = "eliminated";
      const token = first.reconnectionToken;
      await drop(room, id);
      await waitFor(() => !room.simulation.players.some(runner => runner.id === id), "seat released");
      assert.equal(room.suspended.size, 0);
      await assert.rejects(setup.client.reconnect(token));
    } finally {
      await setup.close();
    }
  });

  it("holds a seat in a match against bots, ends it on elimination and closes the empty room", async () => {
    const setup = await fixture(5);
    try {
      const first = setup.observe(await setup.client.create("party", { ...options, matchSize: 4 }));
      const room = roomOf(setup.server, first.roomId);
      const id = first.sessionId;
      first.send("ready");
      await waitFor(() => room.simulation.phase === "running", "running");
      assert.ok(
        room.simulation.players.some(runner => runner.bot),
        "bots filled the match",
      );
      await drop(room, id);
      await waitFor(() => room.suspended.has(id), "seat held while only bots play");
      // Longer than Colyseus waits before disposing of an empty room: the held seat keeps it open.
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.equal(roomOf(setup.server, first.roomId), room);
      const resumed = setup.observe(await setup.client.reconnect(first.reconnectionToken));
      assert.equal(resumed.sessionId, id);
      await waitFor(() => !room.suspended.has(id), "resume");
      await drop(room, id);
      await waitFor(() => room.suspended.has(id), "second hold");
      room.simulation.players.find(runner => runner.id === id).status = "eliminated";
      await waitFor(() => !room.suspended.has(id), "held seat ended by the elimination");
      await assert.rejects(setup.client.reconnect(resumed.reconnectionToken));
      await waitFor(() => !roomOf(setup.server, first.roomId), "empty room disposed");
    } finally {
      await setup.close();
    }
  });

  it("closes a finished match once its results are stored, with the match-over code", async () => {
    const setup = await fixture(2, 1);
    try {
      const first = setup.observe(await setup.client.create("party", options));
      const room = roomOf(setup.server, first.roomId);
      let closeCode = 0;
      first.onLeave(code => {
        closeCode = code;
      });
      finish(room, first.sessionId);
      await waitFor(() => room.recorded, "results stored");
      assert.equal(closeCode, 0, "the results stay up for the configured time");
      await waitFor(() => closeCode !== 0, "room closed after the finish");
      assert.equal(closeCode, MATCH_OVER);
      await waitFor(() => !roomOf(setup.server, first.roomId), "finished room disposed");
    } finally {
      await setup.close();
    }
  });

  it("only accepts a reconnection window of 1 to 60 whole seconds and a close delay of 1 to 600 seconds", () => {
    const invalid = (edit: (testConfig: PartyConfig) => void) => {
      const testConfig = structuredClone(config);
      edit(testConfig);
      assert.throws(() => validateCatalogs(testConfig, content.characterCatalog, content.goalCatalog), /room\./);
    };
    for (const value of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 61]) {
      invalid(testConfig => (testConfig.room.reconnectSeconds = value));
    }
    for (const value of [0, 601, Number.NaN]) invalid(testConfig => (testConfig.room.closeAfterFinishSeconds = value));
    assert.throws(() => {
      const testConfig = structuredClone(config);
      delete testConfig.room;
      validateCatalogs(testConfig, content.characterCatalog, content.goalCatalog);
    }, /room/);
  });
});
