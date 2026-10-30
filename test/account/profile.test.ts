import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNameRules, NameRules } from "../../src/modules/account/name-rules.js";
import { startServer, type TestServer } from "../support/server.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const PASSWORD = "test-only-password";
const HOUR = 3600000;

function device(displayName = "Pat") {
  return {
    deviceId: randomUUID(),
    deviceSecret: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    displayName,
  };
}

describe("player profile", () => {
  let server: TestServer;
  let counter = 0;
  const adminKey = randomUUID();

  after(async () => {
    await server?.stop();
  });

  /** A server with a mutable clock (for the rename cooldown). */
  async function start(cooldownHours: number, extra: Record<string, unknown> = {}) {
    await server?.stop();
    const time = { now: Date.parse("2026-11-01T12:00:00Z") };
    server = await startServer(
      { adminKey, renameCooldownHours: cooldownHours, ...extra },
      { clock: () => new Date(time.now) },
    );
    return time;
  }

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

  async function account(displayName?: string) {
    const username = `profile_${++counter}_${randomUUID().slice(0, 4)}`;
    const registered = await call("POST", "/api/account/register", "", { username, password: PASSWORD, displayName });
    assert.equal(registered.status, 201, JSON.stringify(registered.data));
    return { id: registered.data.profile.id as string, token: registered.data.token as string, username };
  }

  const rename = (token: string, displayName: unknown) => call("POST", "/api/account/name", token, { displayName });

  it("answers the profile with the new fields, statistics and the rename state", async () => {
    await start(24);
    const before = Date.now();
    const player = await account();
    assert.equal((await call("GET", "/api/account/profile")).status, 401);

    const first = (await call("GET", "/api/account/profile", player.token)).data;
    assert.deepEqual(Object.keys(first).sort(), ["profile", "rename", "stats"]);
    assert.equal(first.profile.id, player.id);
    assert.equal(first.profile.avatar, "");
    assert.ok(first.profile.createdAt >= before);
    assert.equal(first.profile.displayName, player.username);
    const characters = server.container.collection.catalog.characters;
    assert.deepEqual(first.stats, {
      level: 1,
      xp: 0,
      xpIntoLevel: 0,
      xpForLevel: 250,
      wins: 0,
      matches: 0,
      winRate: 0,
      createdAt: first.profile.createdAt,
      charactersOwned: 1,
      charactersTotal: characters.length,
      bestTimes: 0,
    });
    assert.deepEqual(first.rename, { cooldownHours: 24, nextAt: 0 });

    const { database } = server.container;
    await database.query("UPDATE users SET xp = 600, wins = 3, matches = 4 WHERE id = ?", [player.id]);
    await database.query("INSERT INTO times (user_id, course_id, seconds) VALUES (?, 'course-a', 12.5)", [player.id]);
    const later = (await call("GET", "/api/account/profile", player.token)).data;
    assert.equal(later.stats.level, 3);
    assert.equal(later.stats.xpIntoLevel, 100);
    assert.equal(later.stats.winRate, 0.75);
    assert.equal(later.stats.bestTimes, 1);
    assert.equal(later.profile.level, 3);

    const login = await call("POST", "/api/account/login", "", { username: player.username, password: PASSWORD });
    assert.equal(login.data.profile.avatar, "");
    assert.equal(login.data.profile.createdAt, first.profile.createdAt);
    const social = (await call("GET", "/api/social", player.token)).data;
    assert.equal(social.profile.avatar, "");
    assert.equal(social.profile.createdAt, first.profile.createdAt);
  });

  it("refuses names with a bad shape and cleans the accepted ones", async () => {
    await start(0);
    const player = await account();
    const refused = async (displayName: unknown, code = "NAME_INVALID") => {
      const response = await rename(player.token, displayName);
      assert.equal(response.status, 400, String(displayName));
      assert.equal(response.data.code, code, String(displayName));
      return response.data.error as string;
    };
    assert.equal(await refused("ab"), "The name must have 3 to 20 characters.");
    await refused("x".repeat(21));
    await refused("   ");
    await refused("12345");
    await refused("1 2 3");
    assert.equal(await refused("!!!"), "The name needs a letter or a digit.");
    assert.equal((await rename(player.token, 42)).status, 400);
    assert.equal((await call("POST", "/api/account/name", player.token, {})).status, 400);
    assert.equal((await call("POST", "/api/account/name", "", { displayName: "Nobody" })).status, 401);

    const spaced = await rename(player.token, "  Cool    Runner  ");
    assert.equal(spaced.data.profile.displayName, "Cool Runner");
    const tags = await rename(player.token, "<b>Neo</b>");
    assert.equal(tags.data.profile.displayName, "bNeo/b");
    const edge = await rename(player.token, "R2D");
    assert.equal(edge.data.profile.displayName, "R2D");
    assert.equal((await rename(player.token, "abc123")).status, 200, "letters and digits are fine");
    assert.equal((await rename(player.token, "9x")).status, 400, "two characters are too few");
    assert.equal((await rename(player.token, "7 Up")).status, 200, "a digit can start a name");
  });

  it("refuses blocklisted words, also written in leetspeak, in camel case or with accents", async () => {
    await start(0);
    const player = await account();
    const blocked = [
      "fuck",
      "FUCK",
      "FuckYou",
      "sh1t",
      "$hit",
      "p0rn",
      "n1gg3r",
      "Fuuuuck",
      "xx_shit_xx",
      "caralho",
      "Mièrda",
      "PUTA",
      "p0rra",
    ];
    for (const name of blocked) {
      const response = await rename(player.token, name);
      assert.equal(response.status, 400, name);
      assert.equal(response.data.error, "That name is not allowed.", name);
      assert.equal(response.data.code, "NAME_NOT_ALLOWED", name);
    }
    for (const name of ["Assassin", "Scunthorpe", "Classic", "Cocktail", "Shiitake", "Pussycat", "Grape", "Tracer"]) {
      assert.equal((await rename(player.token, name)).status, 200, name + " is a whole different word");
    }
  });

  it("reads extra forbidden words from a file, and refuses a missing file that was asked for", async () => {
    const folder = mkdtempSync(join(tmpdir(), "party-names-"));
    try {
      const file = join(folder, "blocklist.txt");
      writeFileSync(file, "# our words\n\nZebra\n  Qu1x  \n");
      await start(0, { nameBlocklistPath: file });
      const player = await account();
      assert.equal((await rename(player.token, "ZEBRA")).data.code, "NAME_NOT_ALLOWED");
      assert.equal((await rename(player.token, "quix")).data.code, "NAME_NOT_ALLOWED");
      assert.equal((await rename(player.token, "Giraffe")).status, 200);
      assert.equal((await rename(player.token, "fuck")).status, 400, "the built-in words still apply");
      assert.throws(() => loadNameRules(join(folder, "missing.txt"), join(folder, "default.txt")), /does not exist/);
      assert.ok(loadNameRules(undefined, join(folder, "missing-default.txt")) instanceof NameRules);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("limits renames by the cooldown, never the first one, and the same name changes nothing", async () => {
    const time = await start(2);
    const player = await account();
    const start0 = time.now;
    const first = await rename(player.token, "First Name");
    assert.equal(first.status, 200);
    assert.equal(first.data.profile.displayName, "First Name");
    assert.deepEqual(first.data.rename, { cooldownHours: 2, nextAt: start0 + 2 * HOUR });
    const view = (await call("GET", "/api/account/profile", player.token)).data;
    assert.deepEqual(view.rename, { cooldownHours: 2, nextAt: start0 + 2 * HOUR });

    time.now = start0 + 30 * 60000;
    const early = await rename(player.token, "Second Name");
    assert.equal(early.status, 429);
    assert.equal(early.data.code, "NAME_COOLDOWN");
    assert.equal(early.data.retryAt, start0 + 2 * HOUR);
    assert.equal(early.data.error, "You can change your name again in 2 hours.");
    time.now = start0 + HOUR;
    const soon = await rename(player.token, "Second Name");
    assert.equal(soon.data.error, "You can change your name again in 1 hour.");
    assert.equal((await call("GET", "/api/account/profile", player.token)).data.profile.displayName, "First Name");

    const same = await rename(player.token, "  First   Name ");
    assert.equal(same.status, 200, "the same name is a no-op, also inside the cooldown");
    assert.equal(same.data.rename.nextAt, start0 + 2 * HOUR, "and it does not restart the cooldown");

    time.now = start0 + 2 * HOUR;
    const allowed = await rename(player.token, "Second Name");
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.data.rename, { cooldownHours: 2, nextAt: start0 + 4 * HOUR });
    const rows = await server.container.database.query("SELECT name_changed_at FROM users WHERE id = ?", [player.id]);
    assert.equal(Number(rows[0].name_changed_at), start0 + 2 * HOUR);
    time.now = start0 + 4 * HOUR + 1;
    assert.deepEqual((await call("GET", "/api/account/profile", player.token)).data.rename, {
      cooldownHours: 2,
      nextAt: 0,
    });
  });

  it("has no limit at all with a cooldown of 0 hours, and a name change keeps live data of the account", async () => {
    await start(0);
    const player = await account();
    for (const name of ["One", "Two", "Three", "Four"]) {
      const response = await rename(player.token, name);
      assert.equal(response.status, 200, name);
      assert.deepEqual(response.data.rename, { cooldownHours: 0, nextAt: 0 });
    }
  });

  it("applies the name rules to sign-up and guests, which fall back to a guest name", async () => {
    await start(24);
    const username = "signup_" + randomUUID().slice(0, 6);
    const refused = await call("POST", "/api/account/register", "", {
      username,
      password: PASSWORD,
      displayName: "Fuck",
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.data.code, "NAME_NOT_ALLOWED");
    const taken = await call("POST", "/api/account/register", "", {
      username,
      password: PASSWORD,
      displayName: "Fine",
    });
    assert.equal(taken.status, 201, "the refused sign-up created nothing");
    assert.equal(taken.data.profile.displayName, "Fine");
    const defaulted = await call("POST", "/api/account/register", "", {
      username: "plain_" + randomUUID().slice(0, 6),
      password: PASSWORD,
    });
    assert.ok(defaulted.data.profile.displayName.startsWith("plain_"));
    const numeric = await call("POST", "/api/account/register", "", { username: "12345678", password: PASSWORD });
    assert.match(numeric.data.profile.displayName, /^Guest-\d{5}$/, "a default that breaks the rules: a guest name");

    for (const name of ["Fuck", "ab", "12345", "", undefined]) {
      const guest = await call("POST", "/api/account/guest", "", { ...device(), displayName: name });
      assert.equal(guest.status, 200, String(name));
      assert.match(guest.data.profile.displayName, /^Guest-\d{5}$/, String(name));
    }
    const fine = await call("POST", "/api/account/guest", "", device("Pat"));
    assert.equal(fine.data.profile.displayName, "Pat");
    const long = await call("POST", "/api/account/guest", "", device("y".repeat(60)));
    assert.equal(long.data.profile.displayName, "y".repeat(20));
  });

  it("applies the name rules to the GM rename but not the cooldown", async () => {
    await start(24);
    const player = await account();
    const gm = (displayName: string) =>
      fetch(server.url + `/api/admin/players/${player.id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminKey, "X-GM-Operator": "Rita" },
        body: JSON.stringify({ displayName }),
      }).then(async response => ({ status: response.status, data: (await response.json()) as Json }));
    assert.equal((await gm("First")).status, 200);
    assert.equal((await gm("Second")).status, 200, "no cooldown for the GM");
    const refused = await gm("Fuck");
    assert.equal(refused.status, 400);
    assert.equal(refused.data.error, "That name is not allowed.");
    assert.equal((await gm("ab")).status, 400);
    const rows = await server.container.database.query("SELECT display_name, name_changed_at FROM users WHERE id = ?", [
      player.id,
    ]);
    assert.equal(rows[0].display_name, "Second");
    assert.equal(Number(rows[0].name_changed_at), 0, "a GM rename does not start the player's cooldown");
    assert.equal((await rename(player.token, "Mine")).status, 200, "so the player's first change is still free");
  });

  it("sets the icon to a character the player owns, or empty", async () => {
    await start(24);
    const player = await account();
    const { collection } = server.container;
    const characters = collection.catalog.characters.map(character => character.id);
    const state = await collection.state(player.id);
    const starter = state.equipped;
    const foreign = characters.find(id => !state.owned.includes(id));
    assert.ok(foreign, "the catalog has a character the new player does not own");

    const set = await call("POST", "/api/account/avatar", player.token, { avatar: starter });
    assert.equal(set.status, 200);
    assert.equal(set.data.profile.avatar, starter);
    assert.equal((await call("GET", "/api/account/profile", player.token)).data.profile.avatar, starter);

    const locked = await call("POST", "/api/account/avatar", player.token, { avatar: foreign });
    assert.equal(locked.status, 400);
    assert.equal(locked.data.error, "Unlock this character first.");
    assert.equal(locked.data.code, "AVATAR_NOT_OWNED");
    assert.equal(
      (await call("POST", "/api/account/avatar", player.token, { avatar: "no-such-character" })).data.code,
      "AVATAR_NOT_OWNED",
    );
    assert.equal((await call("GET", "/api/account/profile", player.token)).data.profile.avatar, starter, "unchanged");

    await server.container.database.query("INSERT INTO characters (user_id, character_id) VALUES (?, ?)", [
      player.id,
      foreign,
    ]);
    assert.equal(
      (await call("POST", "/api/account/avatar", player.token, { avatar: foreign })).data.profile.avatar,
      foreign,
    );

    const cleared = await call("POST", "/api/account/avatar", player.token, { avatar: "" });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.profile.avatar, "");
    await call("POST", "/api/account/avatar", player.token, { avatar: starter });
    assert.equal(
      (await call("POST", "/api/account/avatar", player.token, {})).data.profile.avatar,
      "",
      "absent = empty",
    );
    assert.equal((await call("POST", "/api/account/avatar", player.token, { avatar: 5 })).status, 400);
    assert.equal((await call("POST", "/api/account/avatar", "", { avatar: starter })).status, 401);
  });

  it("shows each friend's icon on the friends, request and block lists", async () => {
    await start(24);
    const [owner, friend, asker, hated] = [await account(), await account(), await account(), await account()];
    const { collection } = server.container;
    const starter = (await collection.state(friend.id)).equipped;
    await call("POST", "/api/account/avatar", friend.token, { avatar: starter });
    await call("POST", "/api/account/avatar", asker.token, { avatar: starter });
    await call("POST", "/api/social/request", owner.token, { username: friend.username });
    await call("POST", "/api/social/accept", friend.token, { userId: owner.id });
    await call("POST", "/api/social/request", asker.token, { username: owner.username });
    await call("POST", "/api/social/block", owner.token, { userId: hated.id });

    const state = (await call("GET", "/api/social", owner.token)).data;
    assert.equal(state.friends.length, 1);
    assert.equal(state.friends[0].id, friend.id);
    assert.equal(state.friends[0].avatar, starter);
    assert.equal(state.incoming[0].avatar, starter);
    assert.equal(state.blocked[0].id, hated.id);
    assert.equal(state.blocked[0].avatar, "");
    const theirs = (await call("GET", "/api/social", asker.token)).data;
    assert.equal(theirs.incoming.length + theirs.outgoing.length > 0, true);
    for (const row of [...theirs.incoming, ...theirs.outgoing]) assert.equal(typeof row.avatar, "string");
  });
});

describe("name rules", () => {
  it("matches whole words only and understands the usual substitutions", () => {
    const rules = new NameRules(["Água"]);
    for (const name of ["agua", "4gua", "Água", "Fucker", "fuck", "sh1t"])
      assert.equal(rules.blocked(name), true, name);
    for (const name of ["Aguas", "Shitake", "Runner", "Ana", "Cumulus", "Passion"])
      assert.equal(rules.blocked(name), false, name);
    assert.throws(() => rules.check("ab"), /3 to 20/);
    assert.equal(rules.check("  A   b  c "), "A b c");
    assert.equal(rules.orElse("fuck", "Runner"), "Runner");
    assert.equal(rules.orElse("Sam", "Runner"), "Sam");
  });
});
