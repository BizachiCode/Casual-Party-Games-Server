import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { content, startServer, type TestServer } from "../support/server.js";

const NOW = "2026-10-31T12:00:00Z";
const DAY_MS = 86400000;
const starterId = content.characterCatalog.starterId;
/** A catalog character that is not the starter. */
const otherId = content.characterCatalog.characters.find(character => character.id !== starterId).id;

interface Reply {
  status: number;
  // Responses are checked field by field, so the shape stays open here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** A running server with the admin API, a fixed clock (inside season s1) and helpers to call it. */
async function setup(now = NOW) {
  const key = randomUUID();
  const server: TestServer = await startServer({ adminKey: key }, { clock: () => new Date(now) });
  const call = async (path: string, init: { method?: string; body?: unknown; operator?: string } = {}) => {
    const headers: Record<string, string> = { Authorization: "Bearer " + key, "Content-Type": "application/json" };
    if (init.operator) headers["X-GM-Operator"] = init.operator;
    const response = await fetch(server.url + "/api/admin" + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: await response.json() } as Reply;
  };
  const database = server.container.database;
  const register = async (username: string, displayName?: string) =>
    (await server.container.accounts.register({ username, password: "test-only-password", displayName })).profile.id;
  const guest = async (displayName: string) =>
    (
      await server.container.accounts.guest({
        deviceId: randomUUID(),
        deviceSecret: randomUUID().replaceAll("-", "") + "00",
        displayName,
      })
    ).profile.id;
  const audit = (action: string, targetId: string) =>
    database.query<{ operator: string; request_id: string | null; details: string | null }>(
      "SELECT operator, request_id, details FROM gm_actions WHERE action = ? AND target_id = ?",
      [action, targetId],
    );
  return { server, call, database, register, guest, audit };
}

/** Runs `work` and always stops the server. */
async function withServer(work: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>, now?: string) {
  const fixture = await setup(now);
  try {
    await work(fixture);
  } finally {
    await fixture.server.stop();
  }
}

const requestId = () => "req-" + randomUUID().slice(0, 12);

describe("admin players", () => {
  it("refuses requests without the admin key", async () => {
    await withServer(async ({ server }) => {
      const response = await fetch(server.url + "/api/admin/players");
      assert.equal(response.status, 401);
    });
  });

  it("searches by exact id, username prefix and display name, in that order", async () => {
    await withServer(async ({ call, register }) => {
      const nameMatch = await register("zulu", "Anakin Sky");
      const prefixLong = await register("anabel", "Bob");
      const prefixShort = await register("ana", "Zed");
      const target = await register("mike", "Mike");
      const percent = await register("pct", "100% Fun");

      const byPrefix = await call("/players/search?q=ANA");
      assert.equal(byPrefix.status, 200);
      assert.deepEqual(
        byPrefix.body.results.map((player: { id: string }) => player.id),
        [prefixShort, prefixLong, nameMatch],
      );
      assert.deepEqual(Object.keys(byPrefix.body.results[0]).sort(), ["displayName", "guest", "id", "username"]);

      const byId = await call("/players/search?q=" + target);
      assert.deepEqual(
        byId.body.results.map((player: { id: string }) => player.id),
        [target],
      );
      assert.deepEqual((await call("/players/search?q=")).body, { results: [] });
      assert.equal((await call("/players/search?q=ana&limit=1")).body.results.length, 1);
      assert.equal((await call("/players/search?q=ana&limit=999")).body.results.length, 3);

      // A wildcard in the search text matches only itself.
      const wildcard = await call("/players/search?q=" + encodeURIComponent("%"));
      assert.deepEqual(
        wildcard.body.results.map((player: { id: string }) => player.id),
        [percent],
      );
      assert.equal((await call("/players/search?q=" + encodeURIComponent("_"))).body.results.length, 0);
    });
  });

  it("lists players with filters, sorts and pages", async () => {
    await withServer(async ({ server, call, database, register, guest }) => {
      const now = Date.parse(NOW);
      const ann = await register("ann", "Ann");
      const ben = await register("ben", "Ben");
      const cat = await register("cat", "Cat");
      const visitor = await guest("Visitor");
      const stranger = await guest("Stranger");
      const stamp = (id: string, createdAt: number, lastSeen: number, xp: number, wins: number, matches: number) =>
        database.query("UPDATE users SET created_at=?, last_seen=?, xp=?, wins=?, matches=? WHERE id=?", [
          createdAt,
          lastSeen,
          xp,
          wins,
          matches,
          id,
        ]);
      await stamp(ann, now - 10 * DAY_MS, now - 5000, 900, 3, 10);
      await stamp(ben, now - 3 * DAY_MS, now - 9000, 100, 7, 8);
      await stamp(cat, now - 12 * 3600000, now - 1000, 500, 1, 12);
      await stamp(visitor, now - 3600000, now - 3000, 0, 0, 0);
      await stamp(stranger, now - 20 * DAY_MS, 0, 0, 0, 0);
      await server.container.collection.init(ann);
      await database.query("UPDATE wallets SET credits=777, shards=5 WHERE user_id=?", [ann]);
      await database.query("INSERT INTO bans (user_id, reason, until, created_at, created_by) VALUES (?,?,?,?,?)", [
        ben,
        "cheating",
        null,
        now - 1000,
        "gm",
      ]);
      // An expired ban and an expired mute count as absent.
      await database.query("INSERT INTO bans (user_id, reason, until, created_at, created_by) VALUES (?,?,?,?,?)", [
        cat,
        "old",
        now - 5000,
        now - 90000,
        "gm",
      ]);
      await database.query("INSERT INTO mutes (user_id, reason, until, created_at, created_by) VALUES (?,?,?,?,?)", [
        ann,
        "spam",
        now + 3600000,
        now - 1000,
        "gm",
      ]);
      await database.query("INSERT INTO mutes (user_id, reason, until, created_at, created_by) VALUES (?,?,?,?,?)", [
        visitor,
        "expired",
        now - 1,
        now - 90000,
        "gm",
      ]);
      server.container.presence.touch(cat, "room-1");

      const ids = async (query: string) =>
        (await call("/players" + query)).body.players.map((player: { id: string }) => player.id);

      const everyone = await call("/players");
      assert.equal(everyone.status, 200);
      assert.equal(everyone.body.total, 5);
      assert.equal(everyone.body.page, 1);
      assert.equal(everyone.body.pageSize, 50);
      // Default sort: last seen, newest first.
      assert.deepEqual(await ids(""), [cat, visitor, ann, ben, stranger]);

      assert.deepEqual((await ids("?filter=guest")).sort(), [stranger, visitor].sort());
      assert.deepEqual(await ids("?filter=registered&sort=name&dir=asc"), [ann, ben, cat]);
      assert.deepEqual(await ids("?filter=banned"), [ben]);
      assert.deepEqual(await ids("?filter=muted"), [ann]);
      assert.deepEqual(await ids("?filter=online"), [cat]);
      assert.deepEqual((await ids("?filter=new")).sort(), [cat, visitor].sort());

      // Zero-XP ties are broken by id.
      assert.deepEqual(await ids("?sort=xp"), [ann, cat, ben, ...[visitor, stranger].sort().reverse()]);
      assert.deepEqual((await ids("?sort=wins&dir=desc")).slice(0, 2), [ben, ann]);
      assert.deepEqual(await ids("?sort=matches&dir=asc&filter=registered"), [ben, ann, cat]);
      assert.deepEqual((await ids("?sort=createdAt&dir=asc")).slice(0, 2), [stranger, ann]);
      assert.equal((await ids("?sort=stars"))[0], ann);
      assert.deepEqual(await ids("?q=ann"), [ann]);
      assert.deepEqual(await ids("?q=vis&filter=guest"), [visitor]);

      const page = await call("/players?sort=name&dir=asc&page=2&pageSize=10");
      assert.equal(page.body.players.length, 0);
      assert.equal(page.body.total, 5);
      assert.equal(page.body.page, 2);

      const row = (await call("/players?q=ann")).body.players[0];
      assert.deepEqual(row, {
        id: ann,
        username: "ann",
        displayName: "Ann",
        guest: false,
        level: 4,
        xp: 900,
        wins: 3,
        matches: 10,
        stars: 777,
        shards: 5,
        createdAt: now - 10 * DAY_MS,
        lastSeen: now - 5000,
        banned: null,
        muted: { reason: "spam", until: now + 3600000 },
        online: false,
        roomId: "",
        partyId: "",
      });
      const banned = (await call("/players?q=ben")).body.players[0];
      assert.deepEqual(banned.banned, { reason: "cheating", until: null });
      assert.equal(banned.stars, 0);
      const online = (await call("/players?q=cat")).body.players[0];
      assert.equal(online.online, true);
      assert.equal(online.roomId, "room-1");
      assert.equal(online.banned, null);

      assert.equal((await call("/players?filter=nonsense")).status, 400);
      assert.equal((await call("/players?sort=password")).status, 400);
      assert.equal((await call("/players?dir=sideways")).status, 400);
    });
  });

  it("shows a player in detail without creating a wallet", async () => {
    await withServer(async ({ server, call, database, register }) => {
      const id = await register("viewed", "Viewed");
      const friend = await register("pal", "Pal");
      await database.query("INSERT INTO rankings VALUES (?,?,?,?,?,?)", [id, "race", "2026-10", 2, 3, 45]);
      await database.query("INSERT INTO times VALUES (?,?,?)", [id, "sky-sprint", 31.5]);
      await database.query("INSERT INTO blocks VALUES (?,?)", [id, friend]);
      await database.query("INSERT INTO requests VALUES (?,?)", [friend, id]);
      await database.query(
        "INSERT INTO reports (id, reporter_id, target_id, reason, details, room_id, status, resolution, note," +
          " handled_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        ["r1", friend, id, "abuse", "", "", "open", "", "", "", Date.parse(NOW)],
      );
      const before = await call("/players/" + id);
      assert.equal(before.status, 200);
      const detail = before.body;
      assert.equal(detail.wallet, null);
      assert.equal(detail.player.id, id);
      assert.equal(detail.player.level, 1);
      assert.equal(detail.player.sessions, 1);
      assert.deepEqual(detail.player.devices, []);
      assert.deepEqual(detail.presence, { online: false, roomId: "", partyId: "" });
      assert.equal(detail.characters.length, content.characterCatalog.characters.length);
      assert.deepEqual(
        detail.characters.map((character: { id: string }) => character.id),
        content.characterCatalog.characters.map(character => character.id),
      );
      assert.ok(detail.characters.every((character: { owned: boolean }) => !character.owned));
      assert.equal(detail.characters.find((character: { starter: boolean }) => character.starter).id, starterId);
      assert.deepEqual(detail.season, { id: "s1", xp: 0, tier: 0, tiers: detail.season.tiers, premium: false });
      assert.ok(detail.season.tiers > 0);
      assert.deepEqual(detail.rankings, [{ mode: "race", season: "2026-10", wins: 2, matches: 3, points: 45 }]);
      assert.deepEqual(detail.times, [{ courseId: "sky-sprint", seconds: 31.5 }]);
      assert.deepEqual(detail.social, { friends: 0, blocking: 1, blockedBy: 0, incoming: 1, outgoing: 0 });
      assert.deepEqual(detail.moderation, {
        ban: null,
        mute: null,
        reportsAgainst: { open: 1, total: 1 },
        reportsFiled: 0,
      });
      assert.deepEqual(detail.ledger, { entries: 0, gm: [] });
      assert.deepEqual(detail.history, []);
      assert.ok(!JSON.stringify(detail).includes("passwordHash"));
      assert.equal(
        (await database.query<{ total: number }>("SELECT COUNT(*) AS total FROM wallets WHERE user_id=?", [id]))[0]
          .total,
        0,
      );

      // After the wallet exists the detail shows it, and a live ban shows with its author.
      await server.container.collection.init(id);
      await database.query("INSERT INTO bans (user_id, reason, until, created_at, created_by) VALUES (?,?,?,?,?)", [
        id,
        "toxic",
        null,
        Date.parse(NOW),
        "ops",
      ]);
      const after = (await call("/players/" + id)).body;
      assert.deepEqual(after.wallet, {
        stars: content.characterCatalog.initialCredits,
        shards: 0,
        pityEpic: 0,
        pityLegendary: 0,
        equipped: starterId,
      });
      assert.deepEqual(after.moderation.ban, {
        reason: "toxic",
        until: null,
        createdAt: Date.parse(NOW),
        createdBy: "ops",
      });
      assert.deepEqual(
        after.characters
          .filter((character: { owned: boolean }) => character.owned)
          .map((character: { id: string }) => character.id),
        [starterId],
      );
      assert.equal((await call("/players/" + randomUUID())).status, 404);
      assert.equal((await call("/players/" + randomUUID())).body.error, "Player not found.");
    });
  });

  it("renames a player and writes the operator to the audit log", async () => {
    await withServer(async ({ call, register, audit, server }) => {
      const id = await register("renamed", "Before");
      const result = await call("/players/" + id + "/rename", {
        body: { displayName: "  <b>After</b>  " },
        operator: "alice",
      });
      assert.deepEqual(result.body, { ok: true, displayName: "bAfter/b" });
      assert.equal((await server.container.accounts.profile(id)).displayName, "bAfter/b");
      const [entry] = await audit("player.rename", id);
      assert.equal(entry.operator, "alice");
      assert.deepEqual(JSON.parse(entry.details), { from: "Before", to: "bAfter/b" });
      assert.equal((await call("/players/" + id + "/rename", { body: { displayName: "   " } })).status, 400);
      assert.equal((await call("/players/" + id + "/rename", { body: { displayName: "x".repeat(21) } })).status, 400);
      assert.equal((await call("/players/" + id + "/rename", { body: {} })).status, 400);
      assert.equal((await call("/players/" + randomUUID() + "/rename", { body: { displayName: "Ok" } })).status, 404);
      assert.equal((await call("/players/" + id)).body.history[0].operator, "alice");
    });
  });

  it("adds and removes Stars once per request id and refuses an overdraft", async () => {
    await withServer(async ({ call, register, database, audit }) => {
      const id = await register("richer", "Richer");
      const start = content.characterCatalog.initialCredits;
      const first = requestId();
      const grant = await call("/players/" + id + "/stars", {
        body: { delta: 200, requestId: first, note: "compensation" },
        operator: "bob",
      });
      assert.deepEqual(grant.body, { ok: true, stars: start + 200 });
      const again = await call("/players/" + id + "/stars", { body: { delta: 200, requestId: first } });
      assert.deepEqual(again.body, { ok: true, duplicate: true, stars: start + 200 });
      const ledger = await database.query<{ source: string; amount: number }>(
        "SELECT source, amount FROM credit_ledger WHERE user_id=? AND source LIKE 'gm:%'",
        [id],
      );
      assert.deepEqual(ledger, [{ source: "gm:" + first, amount: 200 }]);
      assert.equal((await audit("player.stars", id)).length, 1);
      assert.equal((await audit("player.stars", id))[0].operator, "bob");

      const take = await call("/players/" + id + "/stars", { body: { delta: -150, requestId: requestId() } });
      assert.deepEqual(take.body, { ok: true, stars: start + 50 });

      const rows = (await audit("player.stars", id)).length;
      const refused = await call("/players/" + id + "/stars", {
        body: { delta: -(start + 51), requestId: requestId() },
      });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, `The player has only ${start + 50} Stars.`);
      assert.equal((await audit("player.stars", id)).length, rows);
      const wallet = (await call("/players/" + id)).body;
      assert.equal(wallet.wallet.stars, start + 50);
      assert.deepEqual(
        wallet.ledger.gm
          .map((entry: { amount: number }) => entry.amount)
          .sort((left: number, right: number) => left - right),
        [-150, 200],
      );
      assert.equal(wallet.history[0].action, "player.stars");

      for (const body of [
        { delta: 0, requestId: requestId() },
        { delta: 1.5, requestId: requestId() },
        { delta: 2_000_000_000, requestId: requestId() },
        { delta: "10", requestId: requestId() },
        { delta: 10 },
        { delta: 10, requestId: "short" },
        { delta: 10, requestId: requestId(), note: "n".repeat(141) },
      ]) {
        assert.equal((await call("/players/" + id + "/stars", { body })).status, 400, JSON.stringify(body));
      }
      assert.equal(
        (await call("/players/" + randomUUID() + "/stars", { body: { delta: 5, requestId: requestId() } })).status,
        404,
      );
    });
  });

  it("adds and removes shards once per request id", async () => {
    await withServer(async ({ call, register, audit }) => {
      const id = await register("sharder", "Sharder");
      const key = requestId();
      assert.deepEqual((await call("/players/" + id + "/shards", { body: { delta: 40, requestId: key } })).body, {
        ok: true,
        shards: 40,
      });
      assert.deepEqual((await call("/players/" + id + "/shards", { body: { delta: 40, requestId: key } })).body, {
        ok: true,
        duplicate: true,
        shards: 40,
      });
      assert.deepEqual(
        (await call("/players/" + id + "/shards", { body: { delta: -15, requestId: requestId() } })).body,
        {
          ok: true,
          shards: 25,
        },
      );
      const refused = await call("/players/" + id + "/shards", { body: { delta: -26, requestId: requestId() } });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, "The player has only 25 shards.");
      assert.equal((await audit("player.shards", id)).length, 2);
      assert.equal((await call("/players/" + id)).body.wallet.shards, 25);
    });
  });

  it("sets XP and answers the level", async () => {
    await withServer(async ({ call, register, audit }) => {
      const id = await register("leveler", "Leveler");
      const result = await call("/players/" + id + "/xp", { body: { xp: 1000 } });
      assert.deepEqual(result.body, { ok: true, xp: 1000, level: 5 });
      assert.equal((await call("/players/" + id)).body.player.level, 5);
      assert.deepEqual(JSON.parse((await audit("player.xp", id))[0].details), { from: 0, to: 1000 });
      assert.equal((await call("/players/" + id + "/xp", { body: { xp: -1 } })).status, 400);
      assert.equal((await call("/players/" + id + "/xp", { body: { xp: 100_000_001 } })).status, 400);
      assert.equal((await call("/players/" + id + "/xp", { body: { xp: 2.5 } })).status, 400);
    });
  });

  it("grants, revokes and equips characters", async () => {
    await withServer(async ({ call, register, audit }) => {
      const id = await register("collector", "Collector");
      const grant = await call("/players/" + id + "/characters/grant", { body: { characterId: otherId } });
      assert.deepEqual(grant.body, { ok: true, added: true });
      assert.deepEqual((await call("/players/" + id + "/characters/grant", { body: { characterId: otherId } })).body, {
        ok: true,
        added: false,
      });
      assert.equal(
        (await call("/players/" + id + "/characters/grant", { body: { characterId: "nobody" } })).status,
        400,
      );

      const equip = await call("/players/" + id + "/equip", { body: { characterId: otherId } });
      assert.deepEqual(equip.body, { ok: true });
      assert.equal((await call("/players/" + id)).body.wallet.equipped, otherId);
      const unowned = content.characterCatalog.characters.find(
        character => character.id !== starterId && character.id !== otherId,
      ).id;
      const refused = await call("/players/" + id + "/equip", { body: { characterId: unowned } });
      assert.equal(refused.status, 409);

      const starter = await call("/players/" + id + "/characters/revoke", { body: { characterId: starterId } });
      assert.equal(starter.status, 409);
      assert.equal(starter.body.error, "The starter character cannot be removed.");

      // Removing the equipped character puts the starter back on.
      const revoke = await call("/players/" + id + "/characters/revoke", { body: { characterId: otherId } });
      assert.deepEqual(revoke.body, { ok: true, removed: true });
      const detail = (await call("/players/" + id)).body;
      assert.equal(detail.wallet.equipped, starterId);
      assert.deepEqual(
        detail.characters
          .filter((character: { owned: boolean }) => character.owned)
          .map((character: { id: string }) => character.id),
        [starterId],
      );
      assert.deepEqual((await call("/players/" + id + "/characters/revoke", { body: { characterId: otherId } })).body, {
        ok: true,
        removed: false,
      });
      assert.equal((await audit("player.character.grant", id)).length, 2);
      assert.equal((await audit("player.character.revoke", id)).length, 2);
      assert.equal((await audit("player.equip", id)).length, 1);
      assert.equal((await call("/players/" + id + "/characters/grant", { body: {} })).status, 400);
    });
  });

  it("grants battle pass XP once per request id and needs a running season", async () => {
    await withServer(async ({ call, register, audit }) => {
      const id = await register("passer", "Passer");
      const key = requestId();
      assert.deepEqual((await call("/players/" + id + "/pass-xp", { body: { xp: 400, requestId: key } })).body, {
        ok: true,
        granted: 400,
      });
      assert.deepEqual((await call("/players/" + id + "/pass-xp", { body: { xp: 400, requestId: key } })).body, {
        ok: true,
        granted: 0,
      });
      const detail = (await call("/players/" + id)).body;
      assert.equal(detail.season.xp, 400);
      assert.ok(detail.season.tier >= 1);
      assert.equal((await audit("player.passXp", id)).length, 2);
      assert.equal(
        (await call("/players/" + id + "/pass-xp", { body: { xp: 0, requestId: requestId() } })).status,
        400,
      );
      assert.equal((await call("/players/" + id + "/pass-xp", { body: { xp: 5 } })).status, 400);
    });
    await withServer(async ({ call, register }) => {
      const id = await register("passless", "Passless");
      const result = await call("/players/" + id + "/pass-xp", { body: { xp: 10, requestId: requestId() } });
      assert.equal(result.status, 409);
      assert.equal(result.body.error, "No season is running.");
      assert.equal((await call("/players/" + id)).body.season, null);
    }, "2027-06-01T00:00:00Z");
  });

  it("gives and takes the premium track", async () => {
    await withServer(async ({ call, register, audit }) => {
      const id = await register("premium", "Premium");
      assert.equal((await call("/players/" + id + "/premium", { body: { seasonId: "s1", owned: true } })).status, 200);
      assert.equal((await call("/players/" + id)).body.season.premium, true);
      assert.equal((await call("/players/" + id + "/premium", { body: { seasonId: "s1", owned: true } })).status, 200);
      assert.deepEqual((await call("/players/" + id + "/premium", { body: { seasonId: "s1", owned: false } })).body, {
        ok: true,
        changed: true,
      });
      assert.equal((await call("/players/" + id)).body.season.premium, false);
      const upcoming = await call("/players/" + id + "/premium", { body: { seasonId: "s2", owned: true } });
      assert.equal(upcoming.status, 409);
      assert.equal(upcoming.body.error, "That season has not started yet.");
      assert.equal((await call("/players/" + id + "/premium", { body: { seasonId: "s99", owned: true } })).status, 404);
      assert.equal((await call("/players/" + id + "/premium", { body: { seasonId: "S 1", owned: true } })).status, 400);
      assert.equal((await call("/players/" + id + "/premium", { body: { seasonId: "s1" } })).status, 400);
      assert.equal((await audit("player.premium", id)).length, 3);
    });
  });

  it("resets a player's boards and times", async () => {
    await withServer(async ({ call, register, database, audit }) => {
      const id = await register("raced", "Raced");
      const other = await register("rival", "Rival");
      const seed = async () => {
        await database.query("INSERT IGNORE INTO rankings VALUES (?,?,?,?,?,?)", [id, "race", "2026-10", 1, 1, 10]);
        await database.query("INSERT IGNORE INTO rankings VALUES (?,?,?,?,?,?)", [id, "squads", "2026-10", 1, 1, 5]);
        await database.query("INSERT IGNORE INTO times VALUES (?,?,?)", [id, "sky-sprint", 30]);
        await database.query("INSERT IGNORE INTO rankings VALUES (?,?,?,?,?,?)", [other, "race", "2026-10", 1, 1, 10]);
      };
      const count = async (table: string, userId: string) =>
        Number(
          (
            await database.query<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table} WHERE user_id=?`, [userId])
          )[0].total,
        );
      await seed();
      assert.deepEqual((await call("/players/" + id + "/rankings/reset", { body: { scope: "times" } })).body, {
        ok: true,
        removed: 1,
      });
      assert.equal(await count("rankings", id), 2);
      assert.deepEqual((await call("/players/" + id + "/rankings/reset", { body: { scope: "boards" } })).body, {
        ok: true,
        removed: 2,
      });
      await seed();
      assert.deepEqual((await call("/players/" + id + "/rankings/reset", { body: { scope: "all" } })).body, {
        ok: true,
        removed: 3,
      });
      assert.equal(await count("times", id), 0);
      assert.equal(await count("rankings", other), 1);
      assert.equal((await audit("player.rankings.reset", id)).length, 3);
      assert.equal((await call("/players/" + id + "/rankings/reset", { body: { scope: "everything" } })).status, 400);
    });
  });

  it("grants rewards in bulk to ids and usernames, reporting each target", async () => {
    await withServer(async ({ call, register, database, audit }) => {
      const byId = await register("bulk_a", "Bulk A");
      const byName = await register("bulk_b", "Bulk B");
      const start = content.characterCatalog.initialCredits;
      const key = requestId();
      const body = {
        targets: [byId, "BULK_B", "nobody_here"],
        stars: 100,
        shards: 7,
        characterId: otherId,
        passXp: 50,
        note: "launch gift",
        requestId: key,
      };
      const first = await call("/grants", { body, operator: "carol" });
      assert.equal(first.status, 200);
      assert.deepEqual(first.body.results, [
        { target: byId, id: byId, name: "Bulk A", ok: true },
        { target: "BULK_B", id: byName, name: "Bulk B", ok: true },
        { target: "nobody_here", id: null, name: null, ok: false, error: "Player not found." },
      ]);
      for (const id of [byId, byName]) {
        const detail = (await call("/players/" + id)).body;
        assert.equal(detail.wallet.stars, start + 100);
        assert.equal(detail.wallet.shards, 7);
        assert.equal(detail.season.xp, 50);
        assert.ok(detail.characters.find((character: { id: string }) => character.id === otherId).owned);
        assert.equal(detail.history[0].action, "grant");
        assert.equal(detail.history[0].operator, "carol");
        assert.equal(detail.history[0].requestId, key + ":" + id);
        assert.equal(detail.history[0].details.note, "launch gift");
        assert.equal(detail.ledger.gm[0].source, "gm:" + key + ":" + id);
      }

      // The same request again pays nobody; a new target in it is still paid.
      const third = await register("bulk_c", "Bulk C");
      const retry = await call("/grants", { body: { ...body, targets: [byId, third] } });
      assert.deepEqual(retry.body.results, [
        { target: byId, id: byId, name: "Bulk A", ok: true, duplicate: true },
        { target: third, id: third, name: "Bulk C", ok: true },
      ]);
      assert.equal((await call("/players/" + byId)).body.wallet.stars, start + 100);
      assert.equal((await call("/players/" + third)).body.wallet.stars, start + 100);
      assert.equal((await audit("grant", byId)).length, 1);
      const rows = await database.query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM gm_actions WHERE action='grant'",
      );
      assert.equal(Number(rows[0].total), 3);

      for (const invalid of [
        { targets: [], stars: 5, requestId: requestId() },
        { targets: [byId], requestId: requestId() },
        { targets: [byId], stars: 0, requestId: requestId() },
        { targets: [byId], stars: 2_000_000, requestId: requestId() },
        { targets: [byId], characterId: "nobody", requestId: requestId() },
        { targets: Array.from({ length: 101 }, (_, i) => "t" + i), stars: 5, requestId: requestId() },
        { targets: [byId], stars: 5 },
      ]) {
        assert.equal((await call("/grants", { body: invalid })).status, 400, JSON.stringify(invalid).slice(0, 80));
      }
    });
  });

  it("refuses a pass XP grant in bulk while no season runs, and a failing target does not stop the rest", async () => {
    await withServer(async ({ call, register }) => {
      const id = await register("seasonless", "Seasonless");
      const result = await call("/grants", { body: { targets: [id], passXp: 10, requestId: requestId() } });
      assert.equal(result.status, 409);
      assert.equal(result.body.error, "No season is running.");
    }, "2027-06-01T00:00:00Z");
    await withServer(async ({ call, register, database }) => {
      const full = await register("full_wallet", "Full");
      const fine = await register("fine_wallet", "Fine");
      await call("/players/" + full + "/shards", { body: { delta: 1, requestId: requestId() } });
      await database.query("UPDATE wallets SET shards=2147483647 WHERE user_id=?", [full]);
      const result = await call("/grants", { body: { targets: [full, fine], shards: 5, requestId: requestId() } });
      assert.equal(result.status, 200);
      assert.deepEqual(
        result.body.results.map((entry: { ok: boolean }) => entry.ok),
        [false, true],
      );
      assert.equal(result.body.results[0].error, "The balance would be too large.");
      assert.equal((await call("/players/" + fine)).body.wallet.shards, 5);
    });
  });
});
