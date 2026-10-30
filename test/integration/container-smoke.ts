// Builds nothing: runs the image from Tools/build-server-image.sh with real MySQL and Redis containers and checks
// migrations, accounts, the season, backup/restore inside the container, a real match over the native Schema and data
// surviving a restart. Usage:
//   npm run content -- export && bash Tools/build-server-image.sh && npx tsx test/integration/container-smoke.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Client, type Room } from "@colyseus/sdk";
import { exportedBundlePath, gameConfigDirectory } from "../../src/config/paths.js";
import { readBundle } from "../../src/modules/content/content-bundle.js";
import { MATCHMAKING_FILE } from "../../src/modules/matchmaking/matchmaking.catalog.js";
import { wireSnapshot } from "../../src/modules/match/wire/match-wire.js";
import type { MatchSnapshot } from "../../src/modules/match/simulation/party-simulation.js";

const bundle = process.argv[2] || exportedBundlePath;
const { config, characterCatalog } = readBundle(bundle);
const prefix = "party-smoke-" + randomUUID().slice(0, 8);
const image = process.env.PARTY_DOCKER_IMAGE || "casualparty-server:local";
const names = {
  app: prefix + "-app",
  mysql: prefix + "-mysql",
  redis: prefix + "-redis",
  network: prefix + "-net",
  prepare: prefix + "-prepare",
};
const volumes = { data: prefix + "-data", content: prefix + "-content", database: prefix + "-mysql-data" };
const containers: string[] = [];
const createdVolumes: string[] = [];
let networkCreated = false;
let room: Room;
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const waitFor = async (check: () => unknown, label: string) => {
  for (let i = 0; i < 600; i++) {
    try {
      if (await check()) return;
    } catch {
      /* not ready yet */
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error("Timed out: " + label);
};
try {
  docker("network", "create", names.network);
  networkCreated = true;
  for (const volume of Object.values(volumes)) {
    docker("volume", "create", volume);
    createdVolumes.push(volume);
  }
  process.env.MYSQL_ROOT_PASSWORD = randomUUID();
  process.env.MYSQL_PWD = process.env.MYSQL_ROOT_PASSWORD;
  docker(
    "create",
    "--name",
    names.mysql,
    "--network",
    names.network,
    "-e",
    "MYSQL_ROOT_PASSWORD",
    "-e",
    "MYSQL_ROOT_HOST=%",
    "-e",
    "MYSQL_DATABASE=party",
    "-v",
    volumes.database + ":/var/lib/mysql",
    "mysql:8.4",
  );
  containers.push(names.mysql);
  docker("start", names.mysql);
  await waitFor(
    () => docker("exec", "-e", "MYSQL_PWD", names.mysql, "mysql", "-uroot", "-e", "SELECT 1").includes("1"),
    "MySQL startup",
  );
  docker(
    "create",
    "--name",
    names.redis,
    "--network",
    names.network,
    "redis:7.4-alpine",
    "redis-server",
    "--save",
    "",
    "--appendonly",
    "no",
  );
  containers.push(names.redis);
  docker("start", names.redis);
  docker(
    "create",
    "--name",
    names.prepare,
    "--user",
    "0",
    "-v",
    volumes.content + ":/app/content",
    image,
    "sh",
    "-c",
    "chmod 0644 /app/content/party-bundle.json /app/content/party-matchmaking.json",
  );
  containers.push(names.prepare);
  docker("cp", bundle, names.prepare + ":/app/content/party-bundle.json");
  docker("cp", join(gameConfigDirectory, MATCHMAKING_FILE), names.prepare + ":/app/content/party-matchmaking.json");
  docker("start", "-a", names.prepare);
  process.env.DATABASE_URL =
    "mysql://root:" + encodeURIComponent(process.env.MYSQL_ROOT_PASSWORD) + "@" + names.mysql + ":3306/party";
  process.env.REDIS_URL = "redis://" + names.redis + ":6379";
  docker(
    "create",
    "--name",
    names.app,
    "--network",
    names.network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--tmpfs",
    "/tmp",
    "-e",
    "DATABASE_URL",
    "-e",
    "REDIS_URL",
    "-v",
    volumes.data + ":/app/data",
    "-v",
    volumes.content + ":/app/content:ro",
    "-p",
    "127.0.0.1::2567",
    image,
  );
  containers.push(names.app);
  docker("start", names.app);
  assert.equal(docker("inspect", "--format", "{{.Config.User}}", names.app), "node");

  let url: string;
  const locate = () => {
    const port = JSON.parse(docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", names.app))?.[
      "2567/tcp"
    ]?.[0]?.HostPort;
    if (port) url = "http://127.0.0.1:" + port;
    return !!port;
  };
  const ready = async () => locate() && (await fetch(url + "/ready", { signal: AbortSignal.timeout(1000) })).ok;
  await waitFor(ready, "application readiness");
  assert.equal((await (await fetch(url + "/health")).json()).revision, config.revision);
  const post = async (path: string, body: unknown, token = "") => {
    const response = await fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(body),
    });
    assert.ok(response.ok, path + " " + response.status);
    return response.json();
  };
  const credentials = { username: "smoke", password: randomUUID() };
  const account = await post("/api/account/register", credentials);
  await post("/api/gacha/daily", {}, account.token);
  const season = await (
    await fetch(url + "/api/season/state?season=s1", { headers: { Authorization: "Bearer " + account.token } })
  ).json();
  assert.equal(season.tiers.length, 30);

  const backup = JSON.parse(
    docker("exec", names.app, "node", "build/infrastructure/database/backup.cli.js", "backup", "/app/data/smoke.jsonl"),
  );
  assert.equal(backup.counts.users, 1);
  docker(
    "exec",
    "-e",
    "MYSQL_PWD",
    names.mysql,
    "mysql",
    "-uroot",
    "-e",
    "CREATE DATABASE restored CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
  );
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = original.replace(/\/party$/, "/restored");
  assert.equal(
    JSON.parse(
      docker(
        "exec",
        "-e",
        "DATABASE_URL",
        names.app,
        "node",
        "build/infrastructure/database/backup.cli.js",
        "restore",
        "/app/data/smoke.jsonl",
      ),
    ).ok,
    true,
  );
  process.env.DATABASE_URL = original;

  room = await new Client(url).create("party_private", {
    protocol: config.protocol,
    revision: config.revision,
    sessionToken: account.token,
    matchSize: 1,
    mode: "race",
    courseId: "sky-sprint",
  });
  room.reconnection.enabled = false;
  room.onMessage("*", () => {});
  let state: MatchSnapshot;
  room.onStateChange(wire => {
    state = wireSnapshot(wire);
  });
  room.send("sync");
  await waitFor(() => state?.players.length === 1, "Schema full state");
  room.send("ready");
  await waitFor(() => state?.phase === "running", "countdown");
  room.send("input", { seq: 0, x: 0, z: 1, jump: false, dive: false });
  await waitFor(
    () => state.players[0].vz > 0 && state.players[0].animationState > 0,
    "Schema movement and animation deltas",
  );
  await room.leave();
  room = null;

  docker("restart", "--time", "60", names.app);
  await waitFor(ready, "restart");
  const login = await post("/api/account/login", credentials);
  assert.equal(login.profile.id, account.profile.id);
  const wallet = await (
    await fetch(url + "/api/gacha/state", { headers: { Authorization: "Bearer " + login.token } })
  ).json();
  assert.equal(wallet.credits, characterCatalog.initialCredits + characterCatalog.dailyCredits);
  assert.equal(wallet.dailyAvailable, false);
  console.log(
    "PASS: non-root/read-only server image with real MySQL/Redis, migrations, season, consistent backup/restore," +
      " native Schema movement/animation and restart persistence.",
  );
} finally {
  if (room?.connection.isOpen) await room.leave();
  for (const name of containers.reverse()) docker("rm", "-f", name);
  for (const volume of createdVolumes) docker("volume", "rm", volume);
  if (networkCreated) docker("network", "rm", names.network);
}
