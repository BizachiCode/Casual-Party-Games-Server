import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrations } from "../../src/infrastructure/database/migrations/index.js";
import { startServer, startServices } from "../support/server.js";

const PASSWORD = "test-only-password";
const GUEST_NAME = /^Guest-\d{5}$/;

/** A device id and secret shaped like the ones the Unity client keeps. */
function device(displayName: string) {
  return {
    deviceId: randomUUID(),
    deviceSecret: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    displayName,
  };
}

describe("unique display names", () => {
  it("gives a guest whose name is taken a free guest name, ignoring case and spacing", async () => {
    const { accounts } = await startServices();
    const first = await accounts.guest(device("Guest-48213"));
    assert.equal(first.profile.displayName, "Guest-48213");
    const same = await accounts.guest(device("Guest-48213"));
    const upper = await accounts.guest(device("GUEST-48213"));
    const names = [first, same, upper].map(signedIn => signedIn.profile.displayName);
    for (const name of names.slice(1)) assert.match(name, GUEST_NAME);
    assert.equal(new Set(names.map(name => name.toLowerCase())).size, 3, "three accounts, three names");

    await accounts.register({ username: "pat_owner", password: PASSWORD, displayName: "Pat Runner" });
    const spaced = await accounts.guest(device("  pat   runner "));
    assert.match(spaced.profile.displayName, GUEST_NAME);
  });

  it("refuses a chosen name at registration when taken and replaces a taken default name", async () => {
    const { accounts } = await startServices();
    await accounts.register({ username: "first_one", password: PASSWORD, displayName: "Bouncy Bean" });
    await assert.rejects(
      accounts.register({ username: "second_one", password: PASSWORD, displayName: "bouncy BEAN" }),
      (error: { status?: number; code?: string }) => error.status === 409 && error.code === "NAME_TAKEN",
    );
    // The username is the default name; another account already shows it, so the new one gets a guest name.
    await accounts.register({ username: "third_one", password: PASSWORD, displayName: "Taken_Name" });
    const fallback = await accounts.register({ username: "taken_name", password: PASSWORD });
    assert.match(fallback.profile.displayName, GUEST_NAME);
    const own = await accounts.register({ username: "free_name", password: PASSWORD });
    assert.equal(own.profile.displayName, "free_name");
  });

  it("refuses a rename to a name another account has, and lets a player change the case of their own", async () => {
    const server = await startServer();
    try {
      const { accounts } = server.container;
      const taken = await accounts.register({
        username: "name_holder",
        password: PASSWORD,
        displayName: "Lucky Otter",
      });
      const player = await accounts.register({ username: "name_seeker", password: PASSWORD, displayName: "Seeker" });
      const rename = (token: string, displayName: string) =>
        fetch(server.url + "/api/account/name", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ displayName }),
        });
      const refused = await rename(player.token, "lucky otter");
      assert.equal(refused.status, 409);
      assert.equal((await refused.json()).code, "NAME_TAKEN");
      assert.equal((await accounts.profile(player.profile.id)).displayName, "Seeker");
      const recased = await rename(taken.token, "LUCKY OTTER");
      assert.equal(recased.status, 200);
      assert.equal((await accounts.profile(taken.profile.id)).displayName, "LUCKY OTTER");
    } finally {
      await server.stop();
    }
  });

  it("refuses a GM rename to a name another account has", async () => {
    const key = randomUUID();
    const server = await startServer({ adminKey: key });
    try {
      const { accounts } = server.container;
      await accounts.register({ username: "gm_holder", password: PASSWORD, displayName: "Turbo Taco" });
      const player = await accounts.register({ username: "gm_target", password: PASSWORD, displayName: "Target" });
      const response = await fetch(server.url + "/api/admin/players/" + player.profile.id + "/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({ displayName: "TURBO taco" }),
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "NAME_TAKEN");
      assert.equal((await accounts.profile(player.profile.id)).displayName, "Target");
    } finally {
      await server.stop();
    }
  });

  it("migrates accounts that share a name: the oldest keeps it, the others get free guest names", async () => {
    const { database } = await startServices();
    // The schema as it was before the migration: no name key and duplicate names.
    await database.query("ALTER TABLE `users` DROP INDEX `UQ_users_name_key`, DROP COLUMN `name_key`");
    const insert = (id: string, displayName: string, createdAt: number) =>
      database.query(
        "INSERT INTO `users` (`id`, `username`, `display_name`, `salt`, `password_hash`, `created_at`) " +
          "VALUES (?, ?, ?, '', '', ?)",
        [id, "user_" + id, displayName, createdAt],
      );
    await insert("a", "Runner", 3);
    await insert("b", "Runner", 1);
    await insert("c", "runner", 2);
    await insert("d", "Solo", 4);
    const runner = database.source.createQueryRunner();
    try {
      const UniqueNames = migrations.find(migration => migration.name === "UniqueDisplayNames1792886400008");
      await new UniqueNames().up(runner);
    } finally {
      await runner.release();
    }
    const rows = await database.query<{ id: string; display_name: string; name_key: string }>(
      "SELECT `id`, `display_name`, `name_key` FROM `users` ORDER BY `id`",
    );
    const byId = Object.fromEntries(rows.map(row => [row.id, row]));
    assert.equal(byId.b.display_name, "Runner", "the oldest account keeps the name");
    assert.match(byId.a.display_name, GUEST_NAME);
    assert.match(byId.c.display_name, GUEST_NAME);
    assert.equal(byId.d.display_name, "Solo");
    assert.equal(byId.d.name_key, "solo");
    assert.equal(new Set(rows.map(row => row.name_key)).size, rows.length);
    await assert.rejects(
      database.query(
        "INSERT INTO `users` (`id`, `username`, `display_name`, `name_key`, `salt`, `password_hash`) " +
          "VALUES ('e', 'user_e', 'SOLO', 'solo', '', '')",
      ),
      /Duplicate entry/,
      "the unique index refuses a second account with the same name",
    );
  });
});
