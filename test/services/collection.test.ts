import assert from "node:assert/strict";
import type { PartyContainer } from "../../src/app/container.js";
import { MatchRewardService } from "../../src/modules/match/match-rewards.service.js";
import type { MatchSnapshot } from "../../src/modules/match/simulation/party-simulation.js";
import { startServer, startServices, testDatabaseUrl } from "../support/server.js";

async function collector(services: PartyContainer, username = "collector") {
  services.collection.random = () => 0;
  return (await services.accounts.register({ username, password: "test-only-password" })).profile.id;
}
/** The fields of a finished match that settlement reads. */
const finished = (mode: string, players: { id: string; totalScore: number }[], winners: string[]) =>
  ({ phase: "finished", mode, courseId: "sky-sprint", winnerIds: winners, players }) as unknown as MatchSnapshot;

describe("collection", () => {
  it("keeps the wallet, inventory, pity and draw receipts across a restart", async () => {
    const url = await testDatabaseUrl();
    let services = await startServices({}, url);
    const id = await collector(services, "persistent");
    const request = { bannerId: "standard", count: 1, requestId: "persist-0001" };
    const receipt = await services.collection.pull(id, request);
    await services.stop();
    services = await startServices({}, url);
    assert.equal((await services.collection.state(id)).credits, 200);
    assert.equal((await services.collection.state(id)).pityEpic, 1);
    assert.deepEqual(await services.collection.pull(id, request), receipt);
    assert.equal((await services.collection.state(id)).credits, 200);
  });

  it("validates draws, converts duplicates, replays receipts and refuses locked characters", async () => {
    const services = await startServices();
    const id = await collector(services);
    const service = services.collection;
    assert.equal((await service.state(id)).credits, 300);
    assert.deepEqual((await service.state(id)).owned, ["rookie"]);
    const data = { bannerId: "standard", count: 1, requestId: "single-0001" };
    const draw = await service.pull(id, data);
    assert.equal(draw.spent, 100);
    assert.equal(draw.items[0].duplicate, true);
    assert.equal(draw.state.shards, 5);
    assert.deepEqual(await service.pull(id, data), draw);
    assert.equal((await service.state(id)).credits, 200);
    await assert.rejects(service.pull(id, { ...data, count: 10 }), /different parameters/);
    for (const bad of [
      { ...data, count: -1 },
      { ...data, count: 1.1 },
      { ...data, requestId: "" },
      { ...data, bannerId: "free" },
    ]) {
      await assert.rejects(service.pull(id, bad), /Invalid/);
    }
    await assert.rejects(service.pull(id, { ...data, requestId: "ten-0000001", count: 10 }), /Not enough/);
    assert.equal((await service.state(id)).credits, 200);
    await assert.rejects(service.equip(id, "nova"), /Unlock/);
  });

  it("guarantees epic and legendary pity, discounts ten draws and keeps ownership unique", async () => {
    const services = await startServices();
    const id = await collector(services);
    const service = services.collection;
    await service.state(id);
    await services.database.query("UPDATE wallets SET credits=10000 WHERE user_id=?", [id]);
    let result;
    for (let i = 0; i < 5; i++) {
      result = await service.pull(id, { bannerId: "standard", count: 10, requestId: "ten-draw-" + i });
      assert.ok(result.items.some(item => ["epic", "legendary"].includes(item.rarity)));
    }
    assert.equal(result.items[9].rarity, "legendary");
    const state = await service.state(id);
    assert.equal(state.pityLegendary, 0);
    assert.equal(state.pityEpic, 0);
    assert.equal(state.credits, 5500);
    assert.equal(new Set(state.owned).size, state.owned.length);
    assert.equal((await service.equip(id, "crown")).equipped, "crown");
  });

  it("rolls back a failed draw entirely, and validates crafting and daily claims", async () => {
    const services = await startServices();
    const id = await collector(services);
    const service = services.collection;
    await service.state(id);
    await services.database.query("UPDATE wallets SET credits=10000,pity_epic=9,shards=500 WHERE user_id=?", [id]);
    let calls = 0;
    service.random = () => {
      if (++calls === 6) throw new Error("entropy failure");
      return 0;
    };
    const before = await service.state(id);
    await assert.rejects(service.pull(id, { bannerId: "standard", count: 10, requestId: "rollback-0001" }), /entropy/);
    assert.deepEqual(await service.state(id), before);
    assert.equal(Number((await services.database.query("SELECT COUNT(*) AS n FROM gacha_receipts"))[0].n), 0);
    assert.ok((await service.craft(id, "neon")).owned.includes("neon"));
    assert.equal((await service.state(id)).shards, 0);
    await assert.rejects(service.craft(id, "nova"), /Not enough/);
    await assert.rejects(service.craft(id, "neon"), /already owned/);
    let day = new Date("2026-01-01T12:00:00Z");
    service.clock = () => day;
    const credits = (await service.daily(id)).credits;
    await assert.rejects(service.daily(id), /already claimed/);
    day = new Date("2026-01-02T00:00:00Z");
    assert.equal((await service.daily(id)).credits, credits + 100);
  });

  it("settles match rewards and rankings atomically, never twice", async () => {
    const services = await startServices();
    const id = await collector(services);
    const service = services.collection;
    const second = (await services.accounts.register({ username: "second", password: "test-only-password-b" })).profile
      .id;
    const rewards = new MatchRewardService(services.database, services.rankings, service);
    const state = finished(
      "tournament",
      [
        { id: "p", totalScore: 10 },
        { id: "q", totalScore: 5 },
      ],
      ["p"],
    );
    const accounts = new Map([
      ["p", id],
      ["q", second],
    ]);
    const original = service.reward.bind(service);
    service.reward = async (user, source, amount) => {
      await original(user, source, amount);
      throw new Error("storage failure");
    };
    await assert.rejects(rewards.complete("reward-test", state, accounts), /storage/);
    assert.equal((await services.accounts.profile(id)).xp, 0);
    assert.equal((await services.rankings.board()).entries.length, 0);
    service.reward = original;
    await rewards.complete("reward-test", state, accounts);
    await rewards.complete("reward-test", state, accounts);
    assert.equal((await services.accounts.profile(id)).xp, 100);
    assert.equal((await service.state(id)).credits, 450);
    assert.equal((await service.state(second)).credits, 350);
  });

  it("settles a match whose player deleted their account meanwhile, paying only the others", async () => {
    const services = await startServices();
    const kept = await collector(services);
    const gone = (await services.accounts.register({ username: "leaving", password: "test-only-password-c" })).profile
      .id;
    const rewards = new MatchRewardService(services.database, services.rankings, services.collection);
    const state = finished(
      "tournament",
      [
        { id: "p", totalScore: 10 },
        { id: "q", totalScore: 5 },
      ],
      ["q"],
    );
    await services.accountDeletion.delete(gone, "DELETE");
    const paid = await rewards.complete(
      "deleted-player",
      state,
      new Map([
        ["p", kept],
        ["q", gone],
      ]),
    );
    assert.deepEqual(
      paid.map(reward => reward.id),
      [kept],
    );
    assert.equal(await services.accounts.profile(gone), null);
  });

  it("never double debits or awards under concurrent draws, daily claims and settlements", async () => {
    const services = await startServices();
    const id = (await services.accounts.register({ username: "concurrent", password: "test-only-password" })).profile
      .id;
    const gacha = services.collection;
    await gacha.state(id);
    const draws = await Promise.all(
      Array.from({ length: 8 }, () =>
        gacha.pull(id, { bannerId: "standard", count: 1, requestId: "concurrent-request" }),
      ),
    );
    assert.deepEqual(
      draws,
      draws.map(() => draws[0]),
    );
    assert.equal((await gacha.state(id)).credits, 200);
    const claims = await Promise.allSettled([gacha.daily(id), gacha.daily(id)]);
    assert.equal(claims.filter(claim => claim.status === "fulfilled").length, 1);
    assert.equal((await gacha.state(id)).credits, 300);
    const rewards = new MatchRewardService(services.database, services.rankings, gacha);
    const state = finished("race", [{ id: "p", totalScore: 1 }], ["p"]);
    await Promise.all([
      rewards.complete("same-match", state, new Map([["p", id]])),
      rewards.complete("same-match", state, new Map([["p", id]])),
    ]);
    assert.equal((await services.accounts.profile(id)).matches, 1);
    assert.equal((await gacha.state(id)).credits, 450);
    await assert.rejects(services.database.query("UPDATE wallets SET credits=-1 WHERE user_id=?", [id]));
  });

  it("ignores client currency and randomness over the API, requires sign-in and exposes no credit mint", async () => {
    const server = await startServer();
    server.container.collection.random = () => 0;
    const post = (path: string, body: unknown, token = "") =>
      fetch(server.url + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(body),
      });
    try {
      assert.equal((await fetch(server.url + "/api/gacha/state")).status, 401);
      assert.equal((await fetch(server.url + "/api/gacha/catalog")).status, 200);
      const session = await (
        await post("/api/account/register", { username: "api_collector", password: "test-only-password" })
      ).json();
      const result = await (
        await post(
          "/api/gacha/pull",
          { bannerId: "standard", count: 1, requestId: "api-test-001", credits: 999999, seed: 0, rarity: "legendary" },
          session.token,
        )
      ).json();
      assert.equal(result.state.credits, 200);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].rarity, "common");
      assert.equal((await post("/api/gacha/reward", { amount: 99999 }, session.token)).status, 404);
      assert.equal((await post("/api/gacha/equip", { characterId: "not-a-character" }, session.token)).status, 403);
    } finally {
      await server.stop();
    }
  });
});
