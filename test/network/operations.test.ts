import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Client, type Room } from "@colyseus/sdk";
import { serverRoot } from "../../src/config/paths.js";
import { loadSettings } from "../../src/config/env.js";
import { config, readyMatchmaking, startServer, testDatabaseUrl } from "../support/server.js";

const options = {
  protocol: config.protocol,
  revision: config.revision,
  name: "Operations",
  matchSize: 2,
  mode: "race",
  courseId: "sky-sprint",
};

describe("operations", () => {
  it("closes new admissions in maintenance while running matches and reconnection go on", async () => {
    const key: string = randomUUID();
    const server = await startServer({ adminKey: key }, { matchmaking: readyMatchmaking() });
    let room: Room;
    let resumed: Room;
    const change = (body: unknown, secret = key) =>
      fetch(server.url + "/api/admin/service", {
        method: "POST",
        headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      assert.equal((await fetch(server.url + "/ready")).status, 200);
      room = await new Client(server.url).create("party", options);
      room.reconnection.enabled = false;
      room.onMessage("*", () => {});
      room.send("sync");
      assert.equal((await change({ action: "maintenance", enabled: true }, "wrong")).status, 401);
      assert.equal(
        (await change({ action: "maintenance", enabled: true, message: "Scheduled maintenance" })).status,
        200,
      );
      assert.equal((await fetch(server.url + "/ready")).status, 503);
      assert.equal((await fetch(server.url + "/health")).status, 200);
      assert.equal((await (await fetch(server.url + "/api/service/status")).json()).admissionsOpen, false);
      await assert.rejects(new Client(server.url).joinById(room.roomId, options), /Scheduled maintenance/);
      const actual = server.container.matches.get(room.roomId);
      room.send("setReady", true);
      await delay(100);
      assert.notEqual(actual.simulation.phase, "lobby");
      const token = room.reconnectionToken;
      (
        actual.clients.find(seat => seat.sessionId === room.sessionId).ref as unknown as { terminate(): void }
      ).terminate();
      await delay(80);
      resumed = await new Client(server.url).reconnect(token);
      resumed.onMessage("*", () => {});
      assert.equal(resumed.sessionId, room.sessionId);
      assert.equal((await change({ action: "maintenance", enabled: false })).status, 200);
      assert.equal((await fetch(server.url + "/ready")).status, 200);
      assert.equal((await change({ action: "drain" })).status, 200);
      assert.equal((await fetch(server.url + "/ready")).status, 503);
      assert.equal(
        (await (await fetch(server.url + "/api/admin/service", { headers: { Authorization: "Bearer " + key } })).json())
          .rooms,
        1,
      );
    } finally {
      await resumed?.leave();
      await server.stop();
    }
  });

  it("keeps the admin API off by default and never rate-limits liveness or readiness", async () => {
    const server = await startServer({ apiRequestsPerMinute: 30 });
    try {
      assert.equal((await fetch(server.url + "/api/admin/service")).status, 404);
      for (let i = 0; i < 29; i++) assert.equal((await fetch(server.url + "/api/service/status")).status, 200);
      const denied = await fetch(server.url + "/api/service/status");
      assert.equal(denied.status, 429);
      assert.ok(Number(denied.headers.get("retry-after")) > 0);
      assert.equal((await fetch(server.url + "/health")).status, 200);
      assert.equal((await fetch(server.url + "/ready")).status, 200);
    } finally {
      await server.stop();
    }
    assert.throws(
      () => loadSettings({ DATABASE_URL: "mysql://localhost/party", PARTY_TRUST_PROXY_HOPS: "4" }),
      /TRUST_PROXY/,
    );
    assert.throws(
      () => loadSettings({ DATABASE_URL: "mysql://localhost/party", PARTY_API_REQUESTS_PER_MINUTE: "1" }),
      /API_REQUESTS/,
    );
  });

  it("drains by waiting for running matches to finish before shutdown", async () => {
    const server = await startServer({}, { matchmaking: readyMatchmaking() });
    let room: Room;
    try {
      room = await new Client(server.url).create("party", options);
      room.reconnection.enabled = false;
      room.onMessage("*", () => {});
      room.send("sync");
      room.send("ready");
      for (let i = 0; i < 30 && server.container.matches.get(room.roomId)?.simulation.phase === "lobby"; i++)
        await delay(10);
      const active = server.container.matches.get(room.roomId);
      let drained = false;
      const draining = server.container.operations.drain(2).then(() => {
        drained = true;
      });
      await delay(100);
      assert.equal(drained, false);
      assert.equal(server.container.operations.admissionsOpen, false);
      active.simulation.phase = "finished";
      await draining;
      assert.equal(drained, true);
    } finally {
      await server.stop();
    }
  });

  it("drains and exits cleanly on SIGTERM when started from the command line", async function () {
    // Windows cannot deliver SIGTERM to a Node process; the kill would be immediate.
    if (process.platform === "win32") this.skip();
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: serverRoot,
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        DATABASE_URL: await testDatabaseUrl(),
        PARTY_DRAIN_SECONDS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", data => {
      output += data;
    });
    child.stderr.resume();
    try {
      for (let i = 0; i < 300 && !output.includes("server listening"); i++) {
        if (child.exitCode !== null) throw new Error("The server exited before listening.");
        await delay(20);
      }
      assert.match(output, /server listening/);
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      const [code] = await Promise.race([
        exit,
        delay(5000).then(() => {
          throw new Error("Shutdown deadline exceeded");
        }),
      ]);
      assert.equal(code, 0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
