// Test support: every test gets its own disposable MySQL schema (dropped after the run) and, when needed, a real server
// on a free port. Tests use real MySQL, never an in-memory stand-in: set PARTY_TEST_MYSQL_URL
// (e.g. mysql://root@127.0.0.1:3316/mysql for the dev backend).
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createConnection } from "mysql2/promise";
import { createPartyServer, type PartyServer } from "../../src/app/server.js";
import { PartyContainer, type ContainerOptions } from "../../src/app/container.js";
import type { ServerSettings } from "../../src/config/env.js";
import { openDatabase, type Database } from "../../src/infrastructure/database/database.js";
import { loadContent } from "../../src/modules/content/active-content.js";
import { loadMatchmakingCatalog } from "../../src/modules/matchmaking/matchmaking.catalog.js";
import type { MatchmakingCatalog } from "../../src/modules/matchmaking/matchmaking.types.js";
import { gameConfigDirectory } from "../../src/config/paths.js";
import { join } from "node:path";
import type { MatchRoomSettings, PartyContent } from "../../src/modules/content/content.types.js";

const base = process.env.PARTY_TEST_MYSQL_URL;
const schemas: string[] = [];
const databases: Database[] = [];
const containers: PartyContainer[] = [];

const exported = loadContent();
/** The game's content with the map carousel off (roundDraw.revealSeconds 0), so rounds start as fast as before it. */
export const content: PartyContent = {
  ...exported,
  config: { ...exported.config, roundDraw: { ...exported.config.roundDraw, revealSeconds: 0 } },
};
export const config = content.config;

/**
 * The game's matchmaking rules with the ready check on in every queue, for tests that start public rooms by getting
 * ready (the shipped queues wait for the room to fill instead).
 */
export function readyMatchmaking(): MatchmakingCatalog {
  const catalog = loadMatchmakingCatalog(join(gameConfigDirectory, "party-matchmaking.json"), config);
  for (const queue of catalog.queues) queue.lobby.readyCheck = true;
  return catalog;
}

/** The test content with other match room settings (reconnection window, close after the finish). */
export function contentWithRoom(room: Partial<MatchRoomSettings>): PartyContent {
  return { ...content, config: { ...content.config, room: { ...content.config.room, ...room } } };
}

/** A new empty schema; returns its URL. */
export async function testDatabaseUrl(): Promise<string> {
  if (!base) throw new Error("PARTY_TEST_MYSQL_URL is required: tests use real MySQL, never an in-memory database.");
  const uri = new URL(base);
  const schema = "party_test_" + randomUUID().replaceAll("-", "");
  const admin = await createConnection(base);
  try {
    await admin.query("CREATE DATABASE `" + schema + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin");
  } finally {
    await admin.end();
  }
  schemas.push(schema);
  uri.pathname = "/" + schema;
  return uri.href;
}

/** A migrated Database on a new schema (or on `url`), closed after the run. */
export async function testDatabase(url?: string): Promise<Database> {
  const db = await openDatabase(url ?? (await testDatabaseUrl()));
  databases.push(db);
  return db;
}

export function testSettings(overrides: Partial<ServerSettings> = {}): ServerSettings {
  return {
    databaseUrl: "",
    redisPrefix: "party:test",
    allowedOrigins: [],
    maintenance: false,
    maintenanceMessage: "",
    apiRequestsPerMinute: 10000,
    trustProxyHops: 0,
    drainSeconds: 0,
    ...overrides,
  };
}

/** Every service on a migrated schema (a new one unless `databaseUrl` is given), without HTTP or rooms. */
export async function startServices(options: ContainerOptions = {}, databaseUrl?: string): Promise<PartyContainer> {
  const container = new PartyContainer(testSettings({ databaseUrl: databaseUrl ?? (await testDatabaseUrl()) }), {
    content,
    ...options,
  });
  await container.start();
  containers.push(container);
  return container;
}

export interface TestServer extends PartyServer {
  url: string;
  port: number;
  stop(): Promise<void>;
}

/** A listening server on 127.0.0.1 and a free port, with its own schema unless `databaseUrl` is given. */
export async function startServer(
  overrides: Partial<ServerSettings> = {},
  options: ContainerOptions = {},
): Promise<TestServer> {
  const settings = testSettings({ ...overrides, databaseUrl: overrides.databaseUrl || (await testDatabaseUrl()) });
  const party = createPartyServer(settings, { content, ...options, handleSignals: false });
  await party.server.listen(0, "127.0.0.1");
  const port = (party.server.transport.server.address() as AddressInfo).port;
  return { ...party, port, url: `http://127.0.0.1:${port}`, stop: () => party.server.gracefullyShutdown(false) };
}

/** Waits up to six seconds for `condition`. */
export async function waitFor(condition: () => unknown, label: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Timed out: " + label);
}

/** Closes the connections of every container and database opened so far (their schemas stay until cleanup()). */
async function closeConnections(): Promise<void> {
  for (const container of containers.splice(0)) await container.stop();
  for (const db of databases.splice(0)) await db.close();
}

/** Closes every connection and drops every schema created so far. Mocha runs it after the suite; scripts call it. */
export async function cleanup(): Promise<void> {
  await closeConnections();
  const dropped = schemas.splice(0);
  if (!dropped.length) return;
  const admin = await createConnection(base);
  try {
    for (const schema of dropped) await admin.query("DROP DATABASE `" + schema + "`");
  } finally {
    await admin.end();
  }
}

// MySQL allows a limited number of connections and a suite starts dozens of containers, so each test lets go of the
// connections of the services it started (a server started with startServer() is stopped by its own test).
if (typeof afterEach === "function") {
  afterEach(async function () {
    this.timeout(60_000);
    await closeConnections();
  });
}

// Dropping every schema of the run can take longer than a single test on a local MySQL.
if (typeof after === "function") {
  after(async function () {
    this.timeout(300_000);
    await cleanup();
  });
}
