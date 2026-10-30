import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, type Room } from "@colyseus/sdk";
import type { ColumnMetadata } from "typeorm/metadata/ColumnMetadata.js";
import type { Database } from "../../src/infrastructure/database/database.js";
import {
  AccountDeletionRepository,
  ACCOUNT_COLUMNS,
  KEPT_TABLES,
  UNRELATED_TABLES,
} from "../../src/modules/account/account-deletion.repository.js";
import { config, startServer, waitFor, type TestServer } from "../support/server.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const PASSWORD = "test-only-password";

describe("account deletion", () => {
  let server: TestServer;
  let counter = 0;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.stop();
  });

  const db = () => server.container.database;

  async function call(
    method: string,
    path: string,
    token = "",
    body?: unknown,
  ): Promise<{ status: number; data: Json }> {
    const response = await fetch(server.url + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }

  async function account(prefix = "gone") {
    const username = `${prefix}_${++counter}_${randomUUID().slice(0, 4)}`;
    const signedIn = await server.container.accounts.register({ username, password: PASSWORD });
    return { id: signedIn.profile.id, token: signedIn.token, username };
  }

  const count = async (sql: string, parameters: unknown[]) => Number((await db().query(sql, parameters))[0].total);
  const remove = (token: string, confirm: unknown = "DELETE") =>
    call("POST", "/api/account/delete", token, { confirm });

  /** Every row of a table that names the account in one of these columns. */
  const rowsNaming = (table: string, columns: string[], id: string) =>
    count(
      `SELECT COUNT(*) AS total FROM \`${table}\` WHERE ${columns.map(column => `\`${column}\` = ?`).join(" OR ")}`,
      columns.map(() => id),
    );

  /** A value for a column the seeding does not care about. */
  function sample(column: ColumnMetadata, index: number): unknown {
    const type = String(column.type);
    if (/int|double|float|decimal/.test(type)) return 1;
    if (/bool|tinyint/.test(type)) return 1;
    if (/text|json/.test(type)) return "{}";
    return `v${index}`;
  }

  async function insertRow(table: string, overrides: Record<string, unknown>, index: number) {
    const metadata = db().source.entityMetadatas.find(entity => entity.tableName === table);
    const columns = metadata.columns.filter(column => !column.isGenerated);
    const names = columns.map(column => `\`${column.databaseName}\``).join(", ");
    const values = columns.map(column =>
      column.databaseName in overrides ? overrides[column.databaseName] : sample(column, index),
    );
    await db().query(`INSERT INTO \`${table}\` (${names}) VALUES (${values.map(() => "?").join(", ")})`, values);
  }

  it("deletes the account and everything that names it, seats and sessions included", async () => {
    const [victim, friend] = [await account("victim"), await account("friend")];
    const second = await server.container.accounts.login({ username: victim.username, password: PASSWORD });
    // Real data: a collection, a friendship, a block, reports in both directions, a ban and a mute.
    await server.container.collection.state(victim.id);
    await call("POST", "/api/social/request", victim.token, { username: friend.username });
    await call("POST", "/api/social/accept", friend.token, { userId: victim.id });
    const { moderation } = server.container;
    await moderation.fileReport({
      reporterId: friend.id,
      targetId: victim.id,
      reason: "abuse",
      details: "",
      roomId: "",
      evidence: [],
    });
    await moderation.fileReport({
      reporterId: victim.id,
      targetId: friend.id,
      reason: "other",
      details: "",
      roomId: "",
      evidence: [],
    });
    await moderation.ban(victim.id, { reason: "Test", minutes: null, operator: "Rita" });
    await moderation.mute(victim.id, { reason: "Test", minutes: 30, operator: "Rita" });
    await db().query(
      "INSERT INTO gm_actions (at, operator, address, action, target_id) VALUES (?, 'Rita', '', 'x', ?)",
      [Date.now(), victim.id],
    );
    await insertRow("iap_transactions", { user_id: victim.id }, 0);
    assert.equal(
      ((await call("GET", "/api/social", friend.token)).data as Json).friends.length,
      1,
      "the friendship exists before the deletion",
    );

    const room: Room = await new Client(server.url).create("party_private", {
      protocol: config.protocol,
      revision: config.revision,
      sessionToken: victim.token,
    });
    let closed = 0;
    room.reconnection.enabled = false;
    room.onLeave(code => {
      closed = code;
    });
    for (const type of ["presence", "reconnectWindow", "identity", "notice"]) room.onMessage(type, () => {});
    room.onStateChange(() => {});
    assert.equal(server.container.matches.hasAccount(victim.id), true);

    assert.equal((await remove(victim.token, "")).status, 400);
    assert.equal((await remove(victim.token, "delete")).status, 400);
    assert.equal((await remove(victim.token, "DELETE ")).status, 400);
    assert.equal((await call("POST", "/api/account/delete", victim.token, {})).status, 400);
    assert.equal((await call("POST", "/api/account/delete", "", { confirm: "DELETE" })).status, 401);
    assert.equal((await call("GET", "/api/account/profile", victim.token)).status, 200, "a refusal deletes nothing");

    const response = await remove(victim.token);
    assert.deepEqual(response.data, { ok: true });
    await waitFor(() => closed !== 0, "seat ended");
    assert.equal(closed, 4001);
    assert.equal(server.container.matches.hasAccount(victim.id), false);
    assert.equal(server.container.presence.status(victim.id).online, false);

    assert.equal((await remove(victim.token)).status, 401, "the token is gone");
    assert.equal((await call("GET", "/api/account/profile", second.token)).status, 401, "so is every other session");
    const login = await call("POST", "/api/account/login", "", { username: victim.username, password: PASSWORD });
    assert.equal(login.status, 401);
    assert.equal(await count("SELECT COUNT(*) AS total FROM users WHERE id = ?", [victim.id]), 0);

    for (const { table, columns } of new AccountDeletionRepository(db()).references())
      assert.equal(await rowsNaming(table, columns, victim.id), 0, table);
    assert.equal(await count("SELECT COUNT(*) AS total FROM reports", []), 0);
    assert.equal(await count("SELECT COUNT(*) AS total FROM bans", []), 0);
    assert.equal(await count("SELECT COUNT(*) AS total FROM mutes", []), 0);

    assert.equal(await rowsNaming("iap_transactions", ["user_id"], victim.id), 1, "purchase receipts stay");
    assert.equal(await rowsNaming("gm_actions", ["target_id"], victim.id), 1, "and so does the audit log");
    const friends = (await call("GET", "/api/social", friend.token)).data;
    assert.deepEqual(friends.friends, [], "the friend's list no longer shows the deleted player");
    assert.equal((await call("GET", "/api/account/profile", friend.token)).status, 200, "other accounts are untouched");
  });

  it("deletes a banned account that still holds a session, and a guest with its device", async () => {
    const banned = await account("banned");
    await server.container.moderation.ban(banned.id, { reason: "Cheating", minutes: 60, operator: "Rita" });
    assert.equal((await call("POST", "/api/account/delete", banned.token, { confirm: "DELETE" })).status, 200);
    assert.equal(await count("SELECT COUNT(*) AS total FROM bans WHERE user_id = ?", [banned.id]), 0);

    const phone = {
      deviceId: randomUUID(),
      deviceSecret: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      displayName: "Pat",
    };
    const guest = (await call("POST", "/api/account/guest", "", phone)).data;
    assert.equal((await remove(guest.token)).status, 200);
    assert.equal(await count("SELECT COUNT(*) AS total FROM device_logins WHERE user_id = ?", [guest.profile.id]), 0);
    const again = (await call("POST", "/api/account/guest", "", phone)).data;
    assert.notEqual(again.profile.id, guest.profile.id, "the device starts a fresh guest account");
  });

  it("removes a row in every table that names the account and no row of anybody else", async () => {
    const [victim, other, third] = [await account("victim"), await account("other"), await account("third")];
    const references = new AccountDeletionRepository(db()).references();
    await insertRow("season_definitions", { id: "seed-season", policy: "{}" }, 0);
    const overrides = { season: "seed-season" };
    for (const { table, columns } of references) {
      const named = (first: string, second: string) =>
        Object.fromEntries(columns.map((column, position) => [column, position === 0 ? first : second]));
      // The account in each of the table's account columns in turn, then a row of two other accounts.
      for (const [index, column] of columns.entries()) {
        await insertRow(table, { ...overrides, ...named(other.id, other.id), [column]: victim.id }, index);
      }
      await insertRow(table, { ...overrides, ...named(other.id, third.id) }, 100);
    }
    const seeded = references.map(({ table, columns }) => ({ table, columns }));
    for (const { table, columns } of seeded)
      assert.ok((await rowsNaming(table, columns, victim.id)) >= columns.length, table + " was seeded");
    await insertRow("iap_transactions", { user_id: victim.id }, 7);

    const signedIn = await server.container.accounts.login({ username: victim.username, password: PASSWORD });
    assert.equal((await remove(signedIn.token)).status, 200);

    for (const { table, columns } of seeded) {
      assert.equal(await rowsNaming(table, columns, victim.id), 0, table + " still names the account");
      assert.equal(
        (await rowsNaming(table, [columns[0]], other.id)) > 0,
        true,
        table + " lost a row of another account",
      );
    }
    assert.equal(await count("SELECT COUNT(*) AS total FROM users WHERE id IN (?, ?)", [other.id, third.id]), 2);
    assert.equal(await rowsNaming("iap_transactions", ["user_id"], victim.id), 1);
    assert.ok(references.length >= 25, "the tables were derived from the entities: " + references.length);
  });
});

describe("account deletion coverage", () => {
  let server: TestServer;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.stop();
  });

  it("covers every table of the schema: a new table with an account column must be handled", async () => {
    const records = new AccountDeletionRepository(server.container.database);
    assert.deepEqual(
      records.unclassifiedTables(),
      [],
      "an entity table has no known account column and is neither kept nor unrelated: " +
        "add its account column to ACCOUNT_COLUMNS or list it in KEPT_TABLES / UNRELATED_TABLES " +
        "(src/modules/account/account-deletion.repository.ts)",
    );
    const handled = new Map(records.references().map(reference => [reference.table, reference.columns]));
    for (const table of [...KEPT_TABLES, ...UNRELATED_TABLES, "users"]) assert.equal(handled.has(table), false, table);

    // Every foreign key to users in the real schema is cleaned.
    const keys = await server.container.database.query<{ table_name: string; column_name: string }>(
      "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name FROM information_schema.KEY_COLUMN_USAGE" +
        " WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'users'",
    );
    assert.ok(keys.length > 25);
    for (const key of keys)
      assert.ok(
        handled.get(key.table_name)?.includes(key.column_name),
        `${key.table_name}.${key.column_name} is not deleted`,
      );

    // Every table of the database is an entity table, so the entity list is the schema.
    const tables = await server.container.database.query<{ name: string }>(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
    );
    const entityTables = new Set(server.container.database.source.entityMetadatas.map(entity => entity.tableName));
    for (const { name } of tables)
      if (name !== "migrations") assert.ok(entityTables.has(name), name + " has no entity");
  });

  it("notices a new entity: an account column is cleaned, an unknown one fails the check", () => {
    const entity = (tableName: string, columns: string[]) => ({
      tableName,
      columns: columns.map(databaseName => ({ databaseName })),
    });
    const fake = (entities: ReturnType<typeof entity>[]) =>
      new AccountDeletionRepository({ source: { entityMetadatas: entities } } as unknown as Database);
    const base = [
      entity("users", ["id"]),
      entity("iap_transactions", ["user_id"]),
      entity("season_definitions", ["id"]),
    ];

    const known = fake([...base, entity("badges", ["user_id", "badge"])]);
    assert.deepEqual(known.references(), [{ table: "badges", columns: ["user_id"] }]);
    assert.deepEqual(known.unclassifiedTables(), []);
    for (const column of ACCOUNT_COLUMNS)
      assert.deepEqual(fake([...base, entity("t", [column])]).unclassifiedTables(), [], column);

    const forgotten = fake([...base, entity("medals", ["player", "medal"])]);
    assert.deepEqual(forgotten.references(), []);
    assert.deepEqual(forgotten.unclassifiedTables(), ["medals"]);
  });
});
