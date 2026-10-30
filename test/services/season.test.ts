import assert from "node:assert/strict";
import { MatchRewardService } from "../../src/modules/match/match-rewards.service.js";
import type { MatchSnapshot } from "../../src/modules/match/simulation/party-simulation.js";
import {
  loadSeasonCatalog,
  validateSeasonCatalog,
  type SeasonCatalog,
  type SeasonPolicy,
} from "../../src/modules/season/season.catalog.js";
import { content, startServer, startServices, testDatabaseUrl } from "../support/server.js";

const defaultCatalog = loadSeasonCatalog();
/** The default catalog with `edit` applied to a copy. */
function catalogWith(edit: (catalog: SeasonCatalog) => void): SeasonCatalog {
  const catalog = structuredClone(defaultCatalog);
  edit(catalog);
  return catalog;
}

interface FixtureOptions {
  catalog?: SeasonCatalog;
  /** Where the clock starts; the default is inside season s1. */
  now?: string;
  databaseUrl?: string;
}
async function setup(options: FixtureOptions = {}) {
  let date = new Date(options.now ?? "2026-10-31T12:00:00Z");
  const services = await startServices({ clock: () => date, seasonCatalog: options.catalog }, options.databaseUrl);
  const first = (await services.accounts.register({ username: "season_a", password: "test-only-password-a" })).profile
    .id;
  const second = (await services.accounts.register({ username: "season_b", password: "test-only-password-b" })).profile
    .id;
  await services.collection.init(first);
  await services.collection.init(second);
  const rewards = new MatchRewardService(
    services.database,
    services.rankings,
    services.collection,
    undefined,
    services.seasons,
  );
  const state = {
    phase: "finished",
    mode: "race",
    courseId: "sky-sprint",
    winnerIds: ["p"],
    players: [
      { id: "p", totalScore: 10 },
      { id: "q", totalScore: 5 },
    ],
  } as unknown as MatchSnapshot;
  return {
    services,
    first,
    second,
    rewards,
    state,
    seasons: services.seasons,
    gacha: services.collection,
    accounts: new Map([
      ["p", first],
      ["q", second],
    ]),
    clock: (value: string) => {
      date = new Date(value);
    },
    /** Gives pass XP without a match, once per `key`. */
    giveXp: (userId: string, xp: number, key = "test:xp") => services.seasons.grantXp(userId, key, xp),
    ledger: async (userId: string, source: string) =>
      (
        await services.database.query<{ amount: number }>(
          "SELECT amount FROM credit_ledger WHERE user_id=? AND source=?",
          [userId, source],
        )
      ).map(row => Number(row.amount)),
  };
}

describe("seasons", () => {
  it("earns XP from eligible authority receipts, capped daily, without replays across days or seasons", async () => {
    const fixture = await setup();
    await fixture.rewards.complete("one", fixture.state, fixture.accounts);
    await fixture.rewards.complete("one", fixture.state, fixture.accounts);
    assert.equal((await fixture.seasons.state(fixture.first)).xp, 150);
    assert.equal((await fixture.seasons.state(fixture.second)).xp, 100);
    for (let i = 0; i < 15; i++) await fixture.rewards.complete("cap-" + i, fixture.state, fixture.accounts);
    assert.equal((await fixture.seasons.state(fixture.first)).xp, 1500);
    assert.equal((await fixture.seasons.state(fixture.first)).dailyMatches, 10);
    assert.equal((await fixture.seasons.state(fixture.first)).level, 8);
    await fixture.rewards.complete("practice", { ...fixture.state, mode: "arcade" }, fixture.accounts);
    assert.equal((await fixture.seasons.state(fixture.first)).xp, 1500);
    fixture.clock("2026-11-01T00:00:00Z");
    assert.equal((await fixture.seasons.state(fixture.first)).dailyMatches, 0);
    await fixture.rewards.complete("next-day", fixture.state, fixture.accounts);
    assert.equal((await fixture.seasons.state(fixture.first)).xp, 1650);

    fixture.clock("2026-12-01T00:00:00Z");
    await fixture.rewards.complete("one", fixture.state, fixture.accounts);
    const frost = await fixture.seasons.state(fixture.first);
    assert.equal(frost.id, "s2");
    assert.equal(frost.xp, 0);
    await fixture.rewards.complete("next-season", fixture.state, fixture.accounts);
    assert.equal((await fixture.seasons.state(fixture.first)).xp, 150);
    assert.equal((await fixture.seasons.state(fixture.first)).dailyMatches, 1);
    assert.equal((await fixture.seasons.state(fixture.first, "s1")).xp, 1650);
    assert.equal((await fixture.seasons.state(fixture.first, "s1")).active, false);
  });

  it("counts only signed-in humans toward the frozen minimum and keeps bots out of it", async () => {
    const catalog = catalogWith(file => {
      for (const season of file.seasons) season.minimumParticipants = 2;
    });
    const fixture = await setup({ catalog });
    const solo = { ...fixture.state, players: [fixture.state.players[0]] };
    await fixture.rewards.complete("solo", solo, fixture.accounts);
    const withBot = { ...fixture.state, players: [fixture.state.players[0], { id: "q", bot: true, totalScore: 1 }] };
    await fixture.rewards.complete("bot", withBot as unknown as MatchSnapshot, fixture.accounts);
    assert.equal((await fixture.seasons.state(fixture.first)).xp, 0);
    await fixture.rewards.complete("pair", fixture.state, fixture.accounts);
    assert.equal((await fixture.seasons.state(fixture.first)).xp, 150);
    const open = await setup();
    await open.rewards.complete("solo", { ...open.state, players: [open.state.players[0]] }, open.accounts);
    assert.equal((await open.seasons.state(open.first)).xp, 150);
  });

  it("pays each track's tiers atomically and once, honours the claim grace and uses the server clock", async () => {
    const fixture = await setup();
    await fixture.rewards.complete("one", fixture.state, fixture.accounts);
    await fixture.rewards.complete("two", fixture.state, fixture.accounts);
    const before = await fixture.gacha.state(fixture.first);
    await fixture.seasons.claim(fixture.first, "s1", "tier-01", "free");
    await fixture.seasons.claim(fixture.first, "s1", "tier-01");
    assert.equal((await fixture.gacha.state(fixture.first)).credits, before.credits + 50);
    assert.equal((await fixture.gacha.state(fixture.first)).shards, before.shards);
    await assert.rejects(fixture.seasons.claim(fixture.first, "s1", "tier-02", "free"), /unavailable/);
    await assert.rejects(fixture.seasons.claim(fixture.first, "s1", "tier-01", "premium"), /unavailable/);
    await assert.rejects(fixture.seasons.claim(fixture.first, "s1", "tier-01", "gold"), /Unknown reward track/);
    await assert.rejects(fixture.seasons.claim(fixture.first, "s1", "tier-99", "free"), /Unknown season reward/);

    await fixture.giveXp(fixture.first, 9000);
    const grant = fixture.gacha.reward.bind(fixture.gacha);
    fixture.gacha.reward = async (...args) => {
      await grant(...args);
      throw new Error("storage failure");
    };
    const wallet = await fixture.gacha.state(fixture.first);
    await assert.rejects(fixture.seasons.claim(fixture.first, "s1", "tier-10", "free"), /storage failure/);
    assert.deepEqual(await fixture.gacha.state(fixture.first), wallet);
    assert.equal((await fixture.seasons.state(fixture.first)).tiers[9].free.claimed, false);
    fixture.gacha.reward = grant;

    fixture.clock("2026-12-02T00:00:00Z");
    assert.equal((await fixture.seasons.state(fixture.first)).id, "s2");
    const claimed = await fixture.seasons.claim(fixture.first, "s1", "tier-10", "free");
    assert.equal(claimed.tiers[9].free.claimed, true);
    assert.equal(claimed.claimOpen, true);
    assert.equal(claimed.active, false);
    assert.ok((await fixture.gacha.state(fixture.first)).owned.includes("astro"));
    fixture.clock("2026-12-08T00:00:00Z");
    await assert.rejects(fixture.seasons.claim(fixture.first, "s1", "tier-02", "free"), /unavailable/);
    assert.equal((await fixture.seasons.state(fixture.first, "s1")).claimOpen, false);
    await assert.rejects(fixture.seasons.state(fixture.first, "Not A Season"), /Invalid season/);
    await assert.rejects(fixture.seasons.state(fixture.first, "s9"), /Season not found/);
  });

  it("picks the running season, else the one still claimable, else the next, else none", async () => {
    const catalog = catalogWith(file => {
      file.seasons[1].startsAt = "2026-12-20T00:00:00.000Z";
      file.seasons[1].endsAt = "2027-02-01T00:00:00.000Z";
    });
    const fixture = await setup({ catalog, now: "2026-09-15T00:00:00Z" });
    const state = (id?: string) => fixture.seasons.state(fixture.first, id);
    const upcoming = await state();
    assert.equal(upcoming.id, "s1");
    assert.deepEqual([upcoming.upcoming, upcoming.active, upcoming.claimOpen], [true, false, false]);
    assert.deepEqual(upcoming.next, { id: "s2", title: "Frost Season", startsAt: "2026-12-20T00:00:00.000Z" });
    fixture.clock("2026-10-01T00:00:00Z");
    const running = await state();
    assert.deepEqual([running.id, running.upcoming, running.active, running.claimOpen], ["s1", false, true, true]);
    assert.equal(running.claimUntil, "2026-12-08T00:00:00.000Z");
    assert.equal(running.serverTime, "2026-10-01T00:00:00.000Z");
    assert.equal(running.tiers.length, 30);
    assert.equal(running.premium.currency, "credits");
    fixture.clock("2026-12-05T00:00:00Z");
    const grace = await state();
    assert.deepEqual([grace.id, grace.active, grace.claimOpen], ["s1", false, true]);
    fixture.clock("2026-12-10T00:00:00Z");
    assert.equal((await state()).id, "s2");
    assert.equal((await state("s1")).id, "s1");
    fixture.clock("2027-02-05T00:00:00Z");
    const last = await state();
    assert.deepEqual([last.id, last.claimOpen, last.next], ["s2", true, null]);
    fixture.clock("2027-02-09T00:00:00Z");
    await assert.rejects(state(), { status: 404, message: "No season scheduled." });
    assert.equal((await state("s2")).claimOpen, false);
  });

  it("rolls back rankings, wallet and receipts together when the season write fails", async () => {
    const fixture = await setup();
    fixture.seasons.record = () => {
      throw new Error("season write failure");
    };
    await assert.rejects(fixture.rewards.complete("rollback", fixture.state, fixture.accounts), /season write failure/);
    assert.equal((await fixture.services.accounts.profile(fixture.first)).matches, 0);
    assert.equal((await fixture.gacha.state(fixture.first)).credits, 300);
    assert.equal(Number((await fixture.services.database.query("SELECT COUNT(*) AS n FROM match_receipts"))[0].n), 0);
  });

  it("freezes a running season, refuses a changed policy at startup and allows editing the next season", async () => {
    const url = await testDatabaseUrl();
    const fixture = await setup({ databaseUrl: url });
    await fixture.rewards.complete("one", fixture.state, fixture.accounts);
    await fixture.rewards.complete("two", fixture.state, fixture.accounts);
    await fixture.seasons.claim(fixture.first, "s1", "tier-01", "free");
    await fixture.services.stop();
    const clock = () => new Date("2026-10-31T22:00:00Z");
    const restarted = await startServices({ clock }, url);
    assert.equal((await restarted.seasons.state(fixture.first)).xp, 300);
    assert.equal((await restarted.seasons.state(fixture.first)).tiers[0].free.claimed, true);
    assert.equal((await restarted.seasons.state(fixture.first)).tiers[0].premium.claimed, false);

    const changed = catalogWith(file => {
      file.seasons[0].matchXp = 999;
      file.seasons[0].title = "Changed";
    });
    await assert.rejects(
      startServices({ clock, seasonCatalog: changed }, url),
      /Season s1 is running with a different policy; edit the next season, or wait until s1 ends/,
    );
    const nextSeason = catalogWith(file => {
      file.seasons[1].matchXp = 80;
      file.seasons[1].title = "Frosty";
    });
    const edited = await startServices({ clock, seasonCatalog: nextSeason }, url);
    assert.equal((await edited.seasons.state(fixture.first, "s2")).title, "Frosty");
    const reordered = structuredClone(defaultCatalog);
    reordered.seasons[0] = Object.fromEntries(
      Object.entries(reordered.seasons[0]).reverse(),
    ) as unknown as SeasonPolicy;
    await startServices({ clock, seasonCatalog: reordered }, url);
    const invalid = structuredClone(defaultCatalog);
    invalid.seasons[0].tiers[1].xp = 1;
    await assert.rejects(startServices({ clock, seasonCatalog: invalid }, url), /Invalid season catalog.*tier-02 xp/);

    // After the season ends, its frozen policy governs it, whatever the catalog says now.
    const later = () => new Date("2026-12-03T00:00:00Z");
    const afterwards = await startServices({ clock: later, seasonCatalog: changed }, url);
    assert.equal((await afterwards.seasons.state(fixture.first, "s1")).title, "Splash Season");
    assert.equal((await afterwards.seasons.state(fixture.first)).id, "s2");
  });

  it("starts without a running season and ignores the monthly rows older builds left behind", async () => {
    const url = await testDatabaseUrl();
    const legacy = await startServices({ clock: () => new Date("2027-03-01T00:00:00Z") }, url);
    await legacy.database.query("INSERT INTO season_definitions VALUES(?,?)", [
      "2026-10",
      JSON.stringify({
        version: 1,
        title: "Old League",
        claimGraceDays: 7,
        tiers: [{ id: "tier-01", xp: 1, credits: 1, shards: 0, characterId: "ghost" }],
      }),
    ]);
    const clock = () => new Date("2026-10-31T12:00:00Z");
    const services = await startServices({ clock }, url);
    assert.equal((await services.seasons.state(await registerId(services))).id, "s1");
    await assert.rejects(services.seasons.state(await registerId(services, "legacy_two"), "2026-10"), /not found/);
    await services.contentGuard.validateInventory(content.characterCatalog);
  });

  it("requires sign-in over HTTP and never accepts client XP, results, currency or premium flags", async () => {
    const server = await startServer({}, { clock: () => new Date("2026-10-31T12:00:00Z") });
    const post = (path: string, body: unknown, token = "") =>
      fetch(server.url + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(body),
      });
    try {
      assert.equal((await fetch(server.url + "/api/season/state")).status, 401);
      assert.equal((await post("/api/season/premium", { seasonId: "s1" })).status, 401);
      assert.equal((await post("/api/season/claim-all", { seasonId: "s1" })).status, 401);
      const account = await (
        await post("/api/account/register", { username: "season_api", password: "test-only-password" })
      ).json();
      const state = await (
        await fetch(server.url + "/api/season/state", { headers: { Authorization: "Bearer " + account.token } })
      ).json();
      assert.equal(state.id, "s1");
      assert.equal(state.tiers.length, 30);
      assert.equal(state.xp, 0);
      assert.deepEqual(state.premium, { owned: false, currency: "credits", cost: 1500 });
      assert.deepEqual(state.tiers[0].free, {
        credits: 50,
        shards: 0,
        characterId: "",
        claimed: false,
        claimable: false,
      });
      assert.equal(state.tiers[14].premium.characterId, "neon");
      const claim = (body: unknown) => post("/api/season/claim", body, account.token);
      assert.equal(
        (await claim({ seasonId: "s1", tierId: "tier-01", xp: 999999, credits: 999999, premium: true })).status,
        409,
      );
      assert.equal((await claim({ seasonId: "s1", tierId: "tier-01", track: "premium" })).status, 409);
      assert.equal((await claim({ seasonId: "s1", tierId: "tier-01", track: "platinum" })).status, 400);
      assert.equal((await post("/api/season/state", { xp: 99999 }, account.token)).status, 404);
      assert.equal((await claim({ tierId: "tier-01" })).status, 400);
      assert.equal((await post("/api/season/premium", {}, account.token)).status, 400);
      const broke = await post("/api/season/premium", { seasonId: "s1", owned: true }, account.token);
      assert.equal(broke.status, 409);
      assert.equal((await broke.json()).error, "Not enough Stars.");
      assert.equal((await post("/api/season/premium", { seasonId: "nope" }, account.token)).status, 404);

      await server.container.seasons.grantXp(account.profile.id, "http:xp", 400);
      const claimed = await (await claim({ seasonId: "s1", tierId: "tier-01" })).json();
      assert.equal(claimed.tiers[0].free.claimed, true);
      assert.equal(claimed.tiers[1].free.claimable, true);
      const all = await (await post("/api/season/claim-all", { seasonId: "s1" }, account.token)).json();
      assert.deepEqual(
        all.tiers.slice(0, 3).map((tier: { free: { claimed: boolean } }) => tier.free.claimed),
        [true, true, false],
      );
      assert.equal((await server.container.collection.state(account.profile.id)).credits, 300 + 50 * 2);
      assert.equal((await post("/api/season/claim-all", {}, account.token)).status, 400);
    } finally {
      await server.stop();
    }
  });

  it("converts duplicate cosmetics to shards and rolls back every reward when a later write fails", async () => {
    const fixture = await setup();
    await fixture.giveXp(fixture.first, 9000);
    await fixture.services.database.query("INSERT INTO characters VALUES(?,?)", [fixture.first, "astro"]);
    const before = await fixture.gacha.state(fixture.first);
    await fixture.seasons.claim(fixture.first, "s1", "tier-10", "free");
    assert.equal(
      (await fixture.gacha.state(fixture.first)).shards,
      before.shards +
        5 +
        content.characterCatalog.characters.find(character => character.id === "astro").duplicateShards,
    );
    const wallet = await fixture.gacha.state(fixture.first);
    await fixture.services.database.query(
      `CREATE TRIGGER fail_season_shards BEFORE UPDATE ON wallets FOR EACH ROW
       BEGIN
         IF NEW.shards <> OLD.shards THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='shards failure'; END IF;
       END`,
    );
    await assert.rejects(fixture.seasons.claim(fixture.first, "s1", "tier-20", "free"), /shards failure/);
    assert.deepEqual(await fixture.gacha.state(fixture.first), wallet);
    assert.equal((await fixture.seasons.state(fixture.first)).tiers[19].free.claimed, false);
  });

  it("keeps cosmetics promised by either track in content deployments until the claims close", async () => {
    const fixture = await setup();
    const without = (characterId: string) => {
      const changed = structuredClone(content.characterCatalog);
      changed.characters = changed.characters.filter(character => character.id !== characterId);
      return changed;
    };
    // Free track of the running season, premium track of the running season, premium track of the upcoming one.
    for (const characterId of ["astro", "neon", "nova"]) {
      await assert.rejects(
        fixture.services.contentGuard.validateInventory(without(characterId)),
        new RegExp("claimable season character: " + characterId),
      );
    }
    await fixture.services.contentGuard.validateInventory(without("moon"));
    fixture.clock("2027-02-07T23:00:00Z");
    await assert.rejects(fixture.services.contentGuard.validateInventory(without("nova")), /claimable/);
    fixture.clock("2027-02-08T00:00:00Z");
    await fixture.services.contentGuard.validateInventory(without("nova"));
  });
});

/** Registers an account and returns its id. */
async function registerId(services: Awaited<ReturnType<typeof startServices>>, username = "legacy_one") {
  return (await services.accounts.register({ username, password: "test-only-password-x" })).profile.id;
}

describe("battle pass premium track", () => {
  it("charges Stars once through the ledger, refuses short balances and unlocks premium rewards", async () => {
    const fixture = await setup();
    await fixture.giveXp(fixture.first, 9000);
    const state = await fixture.seasons.state(fixture.first);
    assert.equal(state.premium.owned, false);
    assert.equal(state.tiers[0].free.claimable, true);
    assert.equal(state.tiers[0].premium.claimable, false);
    await assert.rejects(fixture.seasons.claim(fixture.first, "s1", "tier-01", "premium"), /unavailable/);
    await assert.rejects(fixture.seasons.buyPremium(fixture.first, "s1"), {
      status: 409,
      message: "Not enough Stars.",
    });
    assert.equal((await fixture.gacha.state(fixture.first)).credits, 300);
    assert.deepEqual(await fixture.ledger(fixture.first, "pass:s1"), []);

    await fixture.gacha.reward(fixture.first, "gift", 2000);
    const bought = await fixture.seasons.buyPremium(fixture.first, "s1");
    assert.equal(bought.premium.owned, true);
    assert.equal((await fixture.gacha.state(fixture.first)).credits, 800);
    assert.deepEqual(await fixture.ledger(fixture.first, "pass:s1"), [-1500]);
    await fixture.seasons.buyPremium(fixture.first, "s1");
    assert.equal((await fixture.gacha.state(fixture.first)).credits, 800);
    assert.equal(
      Number(
        (
          await fixture.services.database.query("SELECT COUNT(*) AS n FROM season_premium WHERE user_id=?", [
            fixture.first,
          ])
        )[0].n,
      ),
      1,
    );
    assert.equal((await fixture.seasons.state(fixture.second)).premium.owned, false);

    const owned = await fixture.seasons.state(fixture.first);
    assert.equal(owned.tiers[0].premium.claimable, true);
    const before = await fixture.gacha.state(fixture.first);
    await fixture.seasons.claim(fixture.first, "s1", "tier-01", "premium");
    await fixture.seasons.claim(fixture.first, "s1", "tier-01", "premium");
    const after = await fixture.gacha.state(fixture.first);
    assert.equal(after.credits, before.credits + 100);
    assert.equal(after.shards, before.shards + 10);
    const claimed = await fixture.seasons.state(fixture.first);
    assert.deepEqual([claimed.tiers[0].premium.claimed, claimed.tiers[0].free.claimed], [true, false]);
    await fixture.seasons.claim(fixture.first, "s1", "tier-15", "premium");
    assert.ok((await fixture.gacha.state(fixture.first)).owned.includes("neon"));
  });

  it("can be sold for gems, for free, in claim grace, and not before it starts or after claims close", async () => {
    const gems = catalogWith(file => {
      file.seasons[0].premium = { currency: "shards", cost: 40 };
    });
    const fixture = await setup({ catalog: gems });
    await assert.rejects(fixture.seasons.buyPremium(fixture.first, "s1"), { status: 409, message: "Not enough gems." });
    await fixture.services.database.query("UPDATE wallets SET shards=50 WHERE user_id=?", [fixture.first]);
    await fixture.seasons.buyPremium(fixture.first, "s1");
    await fixture.seasons.buyPremium(fixture.first, "s1");
    assert.equal((await fixture.gacha.state(fixture.first)).shards, 10);
    assert.equal((await fixture.gacha.state(fixture.first)).credits, 300);
    await assert.rejects(fixture.seasons.buyPremium(fixture.first, "s2"), { status: 409 });
    fixture.clock("2026-12-02T00:00:00Z");
    await fixture.services.database.query("UPDATE wallets SET shards=50 WHERE user_id=?", [fixture.second]);
    assert.equal((await fixture.seasons.buyPremium(fixture.second, "s1")).premium.owned, true);
    assert.equal((await fixture.gacha.state(fixture.second)).shards, 10);
    fixture.clock("2026-12-08T00:00:00Z");
    const late = await registerId(fixture.services, "season_late");
    await assert.rejects(fixture.seasons.buyPremium(late, "s1"), { status: 409 });

    const free = catalogWith(file => {
      file.seasons[0].premium.cost = 0;
    });
    const gift = await setup({ catalog: free });
    await gift.giveXp(gift.first, 200);
    const state = await gift.seasons.state(gift.first);
    assert.equal(state.premium.owned, true);
    assert.equal(state.tiers[0].premium.claimable, true);
    await gift.seasons.claim(gift.first, "s1", "tier-01", "premium");
    assert.equal((await gift.gacha.state(gift.first)).credits, 400);
    await gift.seasons.buyPremium(gift.first, "s1");
    assert.equal((await gift.gacha.state(gift.first)).credits, 400);
    assert.deepEqual(await gift.ledger(gift.first, "pass:s1"), []);
  });

  it("never offers an empty reward and claims everything claimable on both tracks in one transaction", async () => {
    const sparse = catalogWith(file => {
      file.seasons[0].premium.cost = 0;
      file.seasons[0].tiers[0].premium = { credits: 0, shards: 0, characterId: "" };
    });
    const fixture = await setup({ catalog: sparse });
    await fixture.giveXp(fixture.first, 9000);
    const empty = (await fixture.seasons.state(fixture.first)).tiers[0].premium;
    assert.deepEqual([empty.claimable, empty.claimed], [false, false]);
    await assert.rejects(fixture.seasons.claim(fixture.first, "s1", "tier-01", "premium"), /unavailable/);

    const failing = fixture.gacha.reward.bind(fixture.gacha);
    fixture.gacha.reward = async (id, source, amount) => {
      await failing(id, source, amount);
      if (source.includes("tier-12")) throw new Error("storage failure");
    };
    const wallet = await fixture.gacha.state(fixture.first);
    await assert.rejects(fixture.seasons.claimAll(fixture.first, "s1"), /storage failure/);
    assert.deepEqual(await fixture.gacha.state(fixture.first), wallet);
    const untouched = await fixture.seasons.state(fixture.first);
    assert.equal(untouched.tiers.filter(tier => tier.free.claimed || tier.premium.claimed).length, 0);
    fixture.gacha.reward = failing;

    const tiers = sparse.seasons[0].tiers;
    const sum = (pick: (tier: (typeof tiers)[number]) => number) =>
      tiers.reduce((total, tier) => total + pick(tier), 0);
    const credits = sum(tier => tier.free.credits + tier.premium.credits);
    const shards = sum(tier => tier.free.shards + tier.premium.shards);
    const result = await fixture.seasons.claimAll(fixture.first, "s1");
    assert.equal(
      result.tiers.every(tier => tier.free.claimed && (tier.premium.claimed || tier.id === "tier-01")),
      true,
    );
    const paid = await fixture.gacha.state(fixture.first);
    assert.equal(paid.credits, wallet.credits + credits);
    assert.equal(paid.shards, wallet.shards + shards);
    for (const characterId of ["astro", "neon", "crown"]) assert.ok(paid.owned.includes(characterId));
    await fixture.seasons.claimAll(fixture.first, "s1");
    assert.deepEqual(await fixture.gacha.state(fixture.first), paid);

    const partial = await setup();
    await partial.giveXp(partial.first, 400);
    const locked = await partial.seasons.claimAll(partial.first, "s1");
    assert.deepEqual(locked.tiers.map(tier => tier.free.claimed).slice(0, 4), [true, true, false, false]);
    assert.equal(
      locked.tiers.some(tier => tier.premium.claimed),
      false,
    );
  });
});

describe("battle pass XP grants", () => {
  it("adds XP once per receipt key, with no daily cap and never past the last tier", async () => {
    const fixture = await setup();
    assert.equal(await fixture.giveXp(fixture.first, 500, "goal:2026-10-31:daily-win"), 500);
    assert.equal(await fixture.giveXp(fixture.first, 500, "goal:2026-10-31:daily-win"), 0);
    assert.equal(await fixture.giveXp(fixture.second, 500, "goal:2026-10-31:daily-win"), 500);
    assert.equal((await fixture.seasons.state(fixture.first)).xp, 500);
    assert.equal((await fixture.seasons.state(fixture.first)).level, 3);
    for (let i = 0; i < 20; i++) await fixture.giveXp(fixture.first, 300, "bulk-" + i);
    assert.equal((await fixture.seasons.state(fixture.first)).xp, 6500);
    assert.equal((await fixture.seasons.state(fixture.first)).dailyMatches, 0);
    assert.equal(await fixture.giveXp(fixture.first, 100000, "huge"), 2500);
    assert.equal(await fixture.giveXp(fixture.first, 100, "after-cap"), 0);
    const maxed = await fixture.seasons.state(fixture.first);
    assert.deepEqual([maxed.xp, maxed.level], [9000, 30]);
  });

  it("ignores amounts that are not positive and does nothing when no season is running", async () => {
    const fixture = await setup();
    for (const amount of [0, -5, 1.5, Number.NaN]) assert.equal(await fixture.giveXp(fixture.first, amount), 0);
    await assert.rejects(fixture.giveXp(fixture.first, 10, ""), /receipt key/);
    fixture.clock("2027-03-01T00:00:00Z");
    assert.equal(await fixture.giveXp(fixture.first, 500, "late"), 0);
    fixture.clock("2026-11-02T00:00:00Z");
    assert.equal(await fixture.giveXp(fixture.first, 500, "late"), 500);
    assert.equal(Number((await fixture.services.database.query("SELECT COUNT(*) AS n FROM season_receipts"))[0].n), 1);
  });

  it("joins the caller's transaction, so a failed settlement grants nothing", async () => {
    const fixture = await setup();
    await assert.rejects(
      fixture.services.database.transaction(async () => {
        assert.equal(await fixture.giveXp(fixture.first, 700, "inside"), 700);
        throw new Error("settlement failed");
      }),
      /settlement failed/,
    );
    assert.equal((await fixture.seasons.state(fixture.first)).xp, 0);
    assert.equal(await fixture.giveXp(fixture.first, 700, "inside"), 700);
  });
});

describe("season catalog", () => {
  const invalid = (edit: (catalog: SeasonCatalog) => void, pattern: RegExp) => {
    const catalog = catalogWith(edit);
    assert.throws(() => validateSeasonCatalog(catalog, content.characterCatalog), pattern);
  };

  it("accepts the shipped catalog, gaps between seasons and touching seasons", () => {
    validateSeasonCatalog(defaultCatalog, content.characterCatalog);
    assert.equal(defaultCatalog.seasons.length, 2);
    assert.deepEqual(
      defaultCatalog.seasons.map(season => season.tiers.length),
      [30, 30],
    );
    validateSeasonCatalog(
      catalogWith(file => {
        file.seasons[1].startsAt = "2026-12-15T00:00:00.000Z";
      }),
      content.characterCatalog,
    );
  });

  it("rejects overlapping, unsorted, duplicate and badly scheduled seasons", () => {
    invalid(file => {
      file.seasons[1].startsAt = "2026-11-30T00:00:00.000Z";
    }, /season s2 starts before the previous season ends/);
    invalid(file => file.seasons.reverse(), /starts before the previous season ends/);
    invalid(file => {
      file.seasons[1].id = "s1";
    }, /season s1 is listed twice/);
    invalid(file => {
      file.seasons[0].id = "Splash Season";
    }, /season id/);
    invalid(file => {
      file.seasons[0].endsAt = "2026-10-01T12:00:00.000Z";
    }, /length/);
    invalid(file => {
      file.seasons[0].endsAt = "2027-10-03T00:00:00.000Z";
    }, /length/);
    invalid(file => {
      file.seasons[0].startsAt = "2026-10-01";
    }, /startsAt/);
    invalid(file => {
      file.seasons[0].endsAt = "soon";
    }, /endsAt/);
    invalid(file => {
      file.seasons = [];
    }, /seasons/);
    invalid(file => {
      (file as unknown as { version: number }).version = 1;
    }, /version/);
  });

  it("rejects out-of-range policy numbers, a bad premium and broken tiers", () => {
    invalid(file => {
      file.seasons[0].minimumParticipants = 0;
    }, /minimumParticipants/);
    invalid(file => {
      file.seasons[0].minimumParticipants = 33;
    }, /minimumParticipants/);
    invalid(file => {
      file.seasons[0].matchXp = 0;
    }, /matchXp/);
    invalid(file => {
      file.seasons[0].claimGraceDays = 32;
    }, /claimGraceDays/);
    invalid(file => {
      file.seasons[0].dailyMatchCap = 101;
    }, /dailyMatchCap/);
    invalid(file => {
      (file.seasons[0].premium as { currency: string }).currency = "dollars";
    }, /premium.currency/);
    invalid(file => {
      file.seasons[0].premium.cost = 100001;
    }, /premium.cost/);
    invalid(file => {
      file.seasons[0].tiers = [];
    }, /tiers/);
    invalid(file => {
      file.seasons[0].tiers = Array.from({ length: 101 }, (_, index) => ({
        ...file.seasons[0].tiers[0],
        id: "t-" + index,
        xp: index + 1,
      }));
    }, /tiers/);
    invalid(file => {
      file.seasons[0].tiers[2].xp = file.seasons[0].tiers[1].xp;
    }, /tier-03 xp/);
    invalid(file => {
      file.seasons[0].tiers[1].id = "tier-01";
    }, /tier-01 is listed twice/);
    invalid(file => {
      file.seasons[0].tiers[0].free.credits = 10001;
    }, /free.credits/);
    invalid(file => {
      file.seasons[0].tiers[0].premium.shards = 1001;
    }, /premium.shards/);
    invalid(file => {
      file.seasons[0].tiers[0].premium.characterId = "ghost";
    }, /premium.characterId/);
    invalid(file => {
      (file.seasons[0].tiers[0].free as { characterId: unknown }).characterId = null;
    }, /free.characterId/);
  });
});
