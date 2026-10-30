import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AdminInsightsRepository } from "../../src/modules/admin/admin-insights.repository.js";
import { AdminInsightsService } from "../../src/modules/admin/admin-insights.service.js";
import { content, startServer } from "../support/server.js";

const NOW = "2026-10-31T12:00:00Z";
const DAY_MS = 86400000;

/** A running server with the admin API and a fixed clock (inside season s1 and the slime weekend event). */
async function setup() {
  const key = randomUUID();
  const server = await startServer({ adminKey: key }, { clock: () => new Date(NOW) });
  const call = async (path: string) => {
    const response = await fetch(server.url + "/api/admin" + path, { headers: { Authorization: "Bearer " + key } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, body: (await response.json()) as any };
  };
  const register = async (username: string, displayName?: string) =>
    (await server.container.accounts.register({ username, password: "test-only-password", displayName })).profile.id;
  return { server, call, database: server.container.database, register };
}

describe("admin insights", () => {
  it("counts accounts, economy, reports and 14 days of activity", async () => {
    const { server, call, database, register } = await setup();
    try {
      const now = Date.parse(NOW);
      const today = Math.floor(now / DAY_MS) * DAY_MS;
      const old = await register("old_timer", "Old Timer");
      const recent = await register("recent", "Recent");
      const banned = await register("banned_one", "Banned");
      const muted = await register("muted_one", "Muted");
      const visitor = (
        await server.container.accounts.guest({
          deviceId: randomUUID(),
          deviceSecret: randomUUID().replaceAll("-", "") + "00",
          displayName: "Visitor",
        })
      ).profile.id;
      const stamp = (id: string, createdAt: number, lastSeen: number) =>
        database.query("UPDATE users SET created_at=?, last_seen=? WHERE id=?", [createdAt, lastSeen, id]);
      await stamp(old, now - 30 * DAY_MS, now - 20 * DAY_MS);
      await stamp(recent, now - 3 * DAY_MS, now - 3600000);
      await stamp(banned, today - 3 * DAY_MS + 1000, now - 3 * DAY_MS);
      await stamp(muted, now - 3600000, now - 60000);
      await stamp(visitor, now - 1000, now - 1000);

      await database.query("INSERT INTO bans (user_id, reason, until, created_at, created_by) VALUES (?,?,?,?,?)", [
        banned,
        "x",
        null,
        now,
        "gm",
      ]);
      await database.query("INSERT INTO bans (user_id, reason, until, created_at, created_by) VALUES (?,?,?,?,?)", [
        old,
        "expired",
        now - 1,
        now - 9999,
        "gm",
      ]);
      await database.query("INSERT INTO mutes (user_id, reason, until, created_at, created_by) VALUES (?,?,?,?,?)", [
        muted,
        "x",
        now + 5000,
        now,
        "gm",
      ]);
      for (const [index, status] of ["open", "open", "resolved"].entries()) {
        await database.query(
          "INSERT INTO reports (id, reporter_id, target_id, reason, details, room_id, status, resolution, note," +
            " handled_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          ["r" + index, old, recent, "abuse", "", "", status, "", "", "", now],
        );
      }
      await server.container.collection.init(old);
      await server.container.collection.init(recent);
      await database.query("UPDATE wallets SET credits=1000, shards=11 WHERE user_id=?", [old]);
      await database.query("UPDATE wallets SET credits=500, shards=4 WHERE user_id=?", [recent]);
      await database.query("INSERT INTO season_premium VALUES (?,?,?)", [old, "s1", now]);
      await database.query("INSERT INTO season_premium VALUES (?,?,?)", [recent, "s1", now]);
      const todayKey = new Date(today).toISOString().slice(0, 10);
      const oldKey = new Date(today - 13 * DAY_MS).toISOString().slice(0, 10);
      const tooOldKey = new Date(today - 14 * DAY_MS).toISOString().slice(0, 10);
      const progress = [
        [old, todayKey, 5, 2],
        [recent, todayKey, 3, 1],
        [old, oldKey, 4, 4],
        [old, tooOldKey, 9, 9],
      ];
      for (const [user, day, matches, wins] of progress)
        await database.query("INSERT INTO daily_progress VALUES (?,?,?,?,0)", [user, day, matches, wins]);
      server.container.presence.touch(old);
      server.container.presence.touch(recent);

      const result = await call("/overview");
      assert.equal(result.status, 200);
      const overview = result.body;
      const { onlineNow, ...counts } = overview.accounts;
      assert.deepEqual(counts, {
        total: 5,
        registered: 4,
        guests: 1,
        new24h: 2,
        new7d: 4,
        active24h: 3,
        active7d: 3 + 1,
        banned: 1,
        muted: 1,
      });
      // The container does not pass presence yet, so the counter itself is checked in its own test.
      assert.equal(typeof onlineNow, "number");
      assert.deepEqual(overview.reports, { open: 2 });
      assert.deepEqual(overview.economy, {
        stars: 1500,
        shards: 15,
        wallets: 2,
        premium: { seasonId: "s1", owners: 2 },
      });
      assert.equal(overview.activity.days.length, 14);
      assert.equal(overview.activity.days[13], todayKey);
      assert.equal(overview.activity.days[0], oldKey);
      assert.deepEqual(
        overview.activity.days.slice(1),
        Array.from({ length: 13 }, (_, i) => new Date(today - (12 - i) * DAY_MS).toISOString().slice(0, 10)),
      );
      for (const series of ["newAccounts", "players", "matches", "wins"])
        assert.equal(overview.activity[series].length, 14, series);
      assert.deepEqual(overview.activity.players.slice(-1), [2]);
      assert.equal(overview.activity.players[0], 1);
      assert.deepEqual([overview.activity.matches[0], overview.activity.matches[13]], [4, 8]);
      assert.deepEqual([overview.activity.wins[0], overview.activity.wins[13]], [4, 3]);
      // Two accounts today, two on the day three days back, the 30 day old one is outside the window.
      assert.equal(overview.activity.newAccounts[13], 2);
      assert.equal(overview.activity.newAccounts[10], 2);
      assert.equal(
        overview.activity.newAccounts.reduce((sum: number, value: number) => sum + value, 0),
        4,
      );
      assert.deepEqual(overview.season, {
        id: "s1",
        startsAt: Date.parse("2026-10-01T00:00:00.000Z"),
        endsAt: Date.parse("2026-12-01T00:00:00.000Z"),
      });
      assert.equal(overview.service.squads, 0);
      assert.equal(overview.service.partyMembers, 0);
      assert.equal(overview.service.searching, 0);
      assert.equal(overview.service.rooms, 0);
      assert.equal(overview.service.maintenance, false);
      assert.equal(typeof overview.service.uptimeSeconds, "number");
      server.container.matchmaking.beginSearch(old);
      assert.equal((await call("/overview")).body.service.searching, 1);
    } finally {
      await server.stop();
    }
  });

  it("counts online accounts through presence, or the seated ones without it", async () => {
    const { server, register } = await setup();
    try {
      const { container } = server;
      const id = await register("watcher", "Watcher");
      container.presence.touch(id);
      const build = (presence?: typeof container.presence) =>
        new AdminInsightsService({
          db: container.database,
          records: new AdminInsightsRepository(container.database),
          content: container.content,
          matchmaking: container.matchmaking,
          seasons: container.seasons,
          events: container.events,
          rankings: container.rankings,
          operations: container.operations,
          matches: container.matches,
          squads: container.squads,
          clock: () => new Date(NOW),
          presence,
        });
      assert.equal((await build(container.presence).overview()).accounts.onlineNow, 1);
      assert.equal((await build().overview()).accounts.onlineNow, 0);
      assert.equal(typeof (await container.adminInsights.overview()).accounts.onlineNow, "number");
    } finally {
      await server.stop();
    }
  });

  it("describes the running content in the catalog", async () => {
    const { server, call } = await setup();
    try {
      const result = await call("/catalog");
      assert.equal(result.status, 200);
      const catalog = result.body;
      const { config, characterCatalog, goalCatalog } = content;
      assert.equal(catalog.protocol, config.protocol);
      assert.equal(catalog.revision, config.revision);
      assert.equal(catalog.initialCredits, characterCatalog.initialCredits);
      assert.equal(catalog.dailyCredits, characterCatalog.dailyCredits);
      assert.equal(catalog.starterId, characterCatalog.starterId);
      assert.deepEqual(
        catalog.characters.map((character: { id: string }) => character.id),
        characterCatalog.characters.map(character => character.id),
      );
      assert.deepEqual(catalog.characters[0], {
        id: characterCatalog.characters[0].id,
        name: characterCatalog.characters[0].name,
        rarity: characterCatalog.characters[0].rarity,
        craftCost: characterCatalog.characters[0].craftCost,
        duplicateShards: characterCatalog.characters[0].duplicateShards,
      });
      assert.deepEqual(
        catalog.banners.map((banner: { id: string; cost: number; tenCost: number }) => [
          banner.id,
          banner.cost,
          banner.tenCost,
        ]),
        characterCatalog.banners.map(banner => [banner.id, banner.cost, banner.tenCost]),
      );
      assert.equal(catalog.courses.length, config.courses.length);
      assert.deepEqual(catalog.courses[0], {
        id: config.courses[0].id,
        name: config.courses[0].title,
        kind: config.courses[0].kind,
      });
      assert.equal(catalog.playlists.length, config.playlists.length);
      assert.deepEqual(catalog.playlists[0].courseIds, config.playlists[0].courseIds);
      assert.deepEqual(
        catalog.modes.map((mode: { id: string }) => mode.id),
        config.modes.map(mode => mode.id),
      );
      assert.deepEqual(
        catalog.queues.map((queue: { id: string }) => queue.id),
        server.container.matchmaking.catalog.queues.map(queue => queue.id),
      );
      assert.ok(catalog.queues.every((queue: { maxPlayers: number }) => queue.maxPlayers >= 1));

      const seasons = catalog.seasons as { id: string; running: boolean; tiers: number; premiumCost: number }[];
      assert.deepEqual(
        seasons.map(season => [season.id, season.running]),
        [
          ["s1", true],
          ["s2", false],
        ],
      );
      assert.equal(seasons[0].tiers, 30);
      assert.equal(seasons[0].premiumCost, 1500);
      assert.equal(catalog.seasons[0].premiumCurrency, "credits");
      assert.equal(catalog.seasons[0].startsAt, Date.parse("2026-10-01T00:00:00.000Z"));

      const events = Object.fromEntries(catalog.events.map((event: { id: string }) => [event.id, event]));
      assert.equal(events["slime-weekend"].running, true);
      assert.equal(events["slime-weekend"].repeatDays, 7);
      assert.equal(events["slime-weekend"].queue, "race");
      assert.equal(events["slime-weekend"].startsAt, Date.parse("2026-10-30T00:00:00.000Z"));
      assert.equal(events["timber-rush"].running, true);
      assert.equal(events["survival-showdown"].running, false);
      // The next occurrence of the repeating event that is over today.
      assert.equal(events["survival-showdown"].startsAt, Date.parse("2026-11-04T00:00:00.000Z"));

      assert.equal(catalog.goals.length, goalCatalog.goals.length);
      assert.deepEqual(catalog.goals[0], {
        id: goalCatalog.goals[0].id,
        name: goalCatalog.goals[0].title,
        scope: goalCatalog.goals[0].scope,
        metric: goalCatalog.goals[0].metric,
        target: goalCatalog.goals[0].target,
        credits: goalCatalog.goals[0].credits,
        xp: goalCatalog.goals[0].xp,
        passXp: goalCatalog.goals[0].passXp ?? 0,
      });
    } finally {
      await server.stop();
    }
  });

  it("serves the player boards with the account id on every row", async () => {
    const { server, call, database, register } = await setup();
    try {
      const alpha = await register("alpha", "Alpha");
      const beta = await register("beta", "Beta");
      await database.query("UPDATE users SET xp=600 WHERE id=?", [alpha]);
      await database.query("UPDATE users SET xp=100 WHERE id=?", [beta]);
      await database.query("INSERT INTO rankings VALUES (?,?,?,?,?,?)", [alpha, "race", "2026-10", 5, 9, 80]);
      await database.query("INSERT INTO rankings VALUES (?,?,?,?,?,?)", [beta, "race", "2026-10", 7, 9, 60]);
      await database.query("INSERT INTO rankings VALUES (?,?,?,?,?,?)", [alpha, "squads", "2026-09", 1, 1, 10]);

      const wins = await call("/rankings?board=wins");
      assert.equal(wins.status, 200);
      assert.equal(wins.body.board, "wins");
      assert.equal(wins.body.season, "2026-10");
      assert.deepEqual(
        wins.body.entries.map((entry: { id: string; rank: number; wins: number }) => [
          entry.id,
          entry.rank,
          entry.wins,
        ]),
        [
          [beta, 1, 7],
          [alpha, 2, 6],
        ],
      );
      assert.equal(wins.body.entries[0].username, "beta");
      assert.equal(wins.body.entries[0].displayName, "Beta");

      const points = await call("/rankings?board=points");
      assert.deepEqual(
        points.body.entries.map((entry: { id: string }) => entry.id),
        [alpha, beta],
      );
      const season = await call("/rankings?board=season");
      assert.deepEqual(
        season.body.entries.map((entry: { id: string }) => entry.id),
        [beta, alpha],
      );
      assert.equal(season.body.entries[1].wins, 5);
      const mode = await call("/rankings?board=mode&mode=squads");
      assert.deepEqual(
        mode.body.entries.map((entry: { id: string }) => entry.id),
        [alpha],
      );
      const level = await call("/rankings?board=level");
      assert.deepEqual(
        level.body.entries.map((entry: { id: string; score: number }) => [entry.id, entry.score]),
        [
          [alpha, 600],
          [beta, 100],
        ],
      );
      const skipped = await call("/rankings?board=level&offset=1");
      assert.deepEqual(
        skipped.body.entries.map((entry: { id: string; rank: number }) => [entry.id, entry.rank]),
        [[beta, 2]],
      );

      const course = content.config.courses.find(candidate => candidate.kind === "race").id;
      await database.query("INSERT INTO times VALUES (?,?,?)", [alpha, course, 42.5]);
      await database.query("INSERT INTO times VALUES (?,?,?)", [beta, course, 40.25]);
      const times = await call("/rankings?board=timeTrial&courseId=" + course);
      assert.deepEqual(
        times.body.entries.map((entry: { id: string; seconds: number }) => [entry.id, entry.seconds]),
        [
          [beta, 40.25],
          [alpha, 42.5],
        ],
      );

      assert.equal((await call("/rankings?board=nonsense")).status, 400);
      assert.equal((await call("/rankings?board=timeTrial")).status, 400);
      assert.equal((await call("/rankings?board=wins&mode=nonsense")).status, 400);
      const friends = await call("/rankings?board=friends");
      assert.equal(friends.status, 400);
      assert.match(friends.body.error, /friends ranking/);
      assert.equal((await fetch(server.url + "/api/admin/rankings")).status, 401);
    } finally {
      await server.stop();
    }
  });
});
