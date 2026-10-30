import assert from "node:assert/strict";
import { MatchRewardService } from "../../src/modules/match/match-rewards.service.js";
import type { MatchSnapshot } from "../../src/modules/match/simulation/party-simulation.js";
import { ProgressionRepository } from "../../src/modules/progression/progression.repository.js";
import { ProgressionService, weekStart } from "../../src/modules/progression/progression.service.js";
import { content, startServer, startServices } from "../support/server.js";

describe("progression", () => {
  it("derives daily and lifetime goals from authority receipts; claims are idempotent and days reset", async () => {
    const services = await startServices();
    const runnerId = (await services.accounts.register({ username: "runner", password: "test-only-password-a" }))
      .profile.id;
    const teammateId = (await services.accounts.register({ username: "teammate", password: "test-only-password-b" }))
      .profile.id;
    let day = new Date("2026-01-01T12:00:00Z");
    const progression = new ProgressionService(
      services.database,
      new ProgressionRepository(services.database),
      content.goalCatalog,
      services.accounts,
      services.collection,
      () => day,
    );
    const results = new MatchRewardService(services.database, services.rankings, services.collection, progression);
    const accounts = new Map([
      ["p", runnerId],
      ["q", teammateId],
    ]);
    const state = {
      phase: "finished",
      mode: "duos",
      courseId: "sky-sprint",
      winnerIds: ["p"],
      players: [
        { id: "p", totalScore: 10 },
        { id: "q", totalScore: 5 },
      ],
    } as unknown as MatchSnapshot;
    const goal = async (id: string) => (await progression.state(runnerId)).goals.find(candidate => candidate.id === id);

    await assert.rejects(progression.claim(runnerId, "daily-finish"), /not completed/);
    await results.complete("goals-1", state, accounts);
    await results.complete("goals-1", state, accounts);
    assert.equal((await goal("daily-three")).current, 1);
    assert.equal((await goal("daily-team")).claimable, true);
    assert.equal((await goal("first-crown")).claimable, true);
    await progression.claim(runnerId, "daily-finish");
    await progression.claim(runnerId, "daily-finish");
    assert.equal((await services.collection.state(runnerId)).credits, 525);
    assert.equal((await services.accounts.profile(runnerId)).xp, 125);
    day = new Date("2026-01-02T00:00:00Z");
    assert.equal((await goal("daily-finish")).current, 0);
    assert.equal((await goal("daily-finish")).claimed, false);
    assert.equal((await goal("first-finish")).claimable, true);
    await results.complete("practice", { ...state, mode: "arcade" }, accounts);
    assert.equal((await goal("daily-finish")).current, 0);
  });

  it("rolls back the claim receipt, wallet and experience together when the reward fails", async () => {
    const services = await startServices();
    const id = (await services.accounts.register({ username: "rollback", password: "test-only-password" })).profile.id;
    await services.database.query("UPDATE users SET matches=1 WHERE id=?", [id]);
    const before = await services.collection.state(id);
    const original = services.collection.reward.bind(services.collection);
    services.collection.reward = async (...args) => {
      await original(...args);
      throw new Error("storage failure");
    };
    await assert.rejects(services.progression.claim(id, "first-finish"), /storage failure/);
    assert.deepEqual(await services.collection.state(id), before);
    assert.equal((await services.accounts.profile(id)).xp, 0);
    assert.equal(
      (await services.progression.state(id)).goals.find(candidate => candidate.id === "first-finish").claimed,
      false,
    );
  });

  it("finds the Monday of the ISO week in UTC", () => {
    const monday = (iso: string) => weekStart(new Date(iso));
    assert.equal(monday("2026-11-02T00:00:00Z"), "2026-11-02");
    assert.equal(monday("2026-11-08T23:59:59Z"), "2026-11-02");
    assert.equal(monday("2026-11-09T00:00:00Z"), "2026-11-09");
    assert.equal(monday("2027-01-01T12:00:00Z"), "2026-12-28");
    assert.equal(monday("2024-03-03T12:00:00Z"), "2024-02-26");
  });

  it("sums the days of the ISO week into weekly goals, pays them once per week and resets on Monday", async () => {
    let now = new Date("2026-11-02T08:00:00Z");
    const services = await startServices({ clock: () => now });
    const runnerId = (await services.accounts.register({ username: "weekly", password: "test-only-password-a" }))
      .profile.id;
    const teammateId = (await services.accounts.register({ username: "weekmate", password: "test-only-password-b" }))
      .profile.id;
    const accounts = new Map([
      ["p", runnerId],
      ["q", teammateId],
    ]);
    const duos = {
      phase: "finished",
      mode: "duos",
      courseId: "sky-sprint",
      winnerIds: ["p"],
      players: [
        { id: "p", totalScore: 10 },
        { id: "q", totalScore: 5 },
      ],
    } as unknown as MatchSnapshot;
    const play = async (count: number, prefix: string) => {
      for (let i = 0; i < count; i++) await services.rewards.complete(prefix + "-" + i, duos, accounts);
    };
    const { progression } = services;
    const goal = async (id: string) => (await progression.state(runnerId)).goals.find(candidate => candidate.id === id);

    const opening = await progression.state(runnerId);
    assert.equal(opening.day, "2026-11-02");
    assert.equal(opening.week, "2026-11-02");
    assert.equal(opening.dayEndsAt, "2026-11-03T00:00:00.000Z");
    assert.equal(opening.weekEndsAt, "2026-11-09T00:00:00.000Z");
    assert.equal((await goal("weekly-ten")).scope, "weekly");
    assert.equal((await goal("weekly-ten")).passXp, 500);

    await play(4, "monday");
    now = new Date("2026-11-03T20:00:00Z");
    await play(3, "tuesday");
    now = new Date("2026-11-08T23:00:00Z");
    await play(2, "sunday");
    assert.equal((await goal("weekly-ten")).current, 9);
    assert.equal((await goal("weekly-ten")).claimable, false);
    assert.equal((await goal("daily-three")).current, 2);
    await assert.rejects(progression.claim(runnerId, "weekly-ten"), /not completed/);
    await play(1, "sunday-late");
    assert.equal((await goal("weekly-ten")).current, 10);
    assert.equal((await goal("weekly-wins")).current, 10);
    assert.equal((await goal("weekly-teams")).current, 10);
    assert.equal((await goal("daily-five")).current, 3);

    const credits = (await services.collection.state(runnerId)).credits;
    const accountXp = (await services.accounts.profile(runnerId)).xp;
    const passXp = (await services.seasons.state(runnerId)).xp;
    await progression.claim(runnerId, "weekly-ten");
    await progression.claim(runnerId, "weekly-ten");
    assert.equal((await services.collection.state(runnerId)).credits, credits + 400);
    assert.equal((await services.accounts.profile(runnerId)).xp, accountXp + 50);
    assert.equal((await services.seasons.state(runnerId)).xp, passXp + 500);
    assert.equal((await goal("weekly-ten")).claimed, true);
    const periods = await services.database.query<{ period: string }>(
      "SELECT period FROM goal_claims WHERE goal_id='weekly-ten'",
    );
    assert.deepEqual(
      periods.map(row => row.period),
      ["week:2026-11-02"],
    );
    const receipts = await services.database.query(
      "SELECT COUNT(*) AS n FROM season_receipts WHERE match_id='goal:week:2026-11-02:weekly-ten'",
    );
    assert.equal(Number(receipts[0].n), 1);

    now = new Date("2026-11-09T00:00:00Z");
    const nextWeek = await progression.state(runnerId);
    assert.equal(nextWeek.week, "2026-11-09");
    assert.equal(nextWeek.weekEndsAt, "2026-11-16T00:00:00.000Z");
    assert.equal((await goal("weekly-ten")).current, 0);
    assert.equal((await goal("weekly-ten")).claimed, false);
    await play(1, "new-week");
    assert.equal((await goal("weekly-ten")).current, 1);
    assert.equal((await goal("weekly-wins")).claimed, false);
  });

  it("adds battle pass XP when a mission is claimed, once per period, and rolls back with the claim", async () => {
    let now = new Date("2026-11-04T10:00:00Z");
    const services = await startServices({ clock: () => now });
    const id = (await services.accounts.register({ username: "passxp", password: "test-only-password" })).profile.id;
    await services.database.query("UPDATE users SET matches=1 WHERE id=?", [id]);
    await services.seasons.grantXp(id, "test:setup", 1);
    await services.database.query("INSERT INTO daily_progress VALUES(?,?,?,?,?)", [id, "2026-11-04", 3, 3, 3]);
    const passXp = async () => (await services.seasons.state(id)).xp;
    assert.equal(await passXp(), 1);

    const original = services.seasons.grantXp.bind(services.seasons);
    services.seasons.grantXp = async (...args) => {
      await original(...args);
      throw new Error("pass failure");
    };
    const before = await services.collection.state(id);
    await assert.rejects(services.progression.claim(id, "daily-three"), /pass failure/);
    assert.deepEqual(await services.collection.state(id), before);
    assert.equal(await passXp(), 1);
    services.seasons.grantXp = original;

    await services.progression.claim(id, "daily-three");
    assert.equal(await passXp(), 151);
    await services.progression.claim(id, "daily-three");
    assert.equal(await passXp(), 151);
    await services.progression.claim(id, "first-finish"); // Achievements carry no pass XP.
    assert.equal(await passXp(), 151);
    const receipts = await services.database.query(
      "SELECT COUNT(*) AS n FROM season_receipts WHERE match_id='goal:2026-11-04:daily-three'",
    );
    assert.equal(Number(receipts[0].n), 1);
    now = new Date("2026-11-05T10:00:00Z");
    await services.database.query("INSERT INTO daily_progress VALUES(?,?,?,?,?)", [id, "2026-11-05", 3, 0, 0]);
    await services.progression.claim(id, "daily-three");
    assert.equal(await passXp(), 301);
  });

  it("still pays Stars and XP for a mission when no season is running", async () => {
    const now = new Date("2027-03-01T10:00:00Z");
    const services = await startServices({ clock: () => now });
    const id = (await services.accounts.register({ username: "nopass", password: "test-only-password" })).profile.id;
    await services.database.query("INSERT INTO daily_progress VALUES(?,?,?,?,?)", [id, "2027-03-01", 1, 0, 0]);
    const before = (await services.collection.state(id)).credits;
    await services.progression.claim(id, "daily-finish");
    assert.equal((await services.collection.state(id)).credits, before + 75);
    assert.equal(Number((await services.database.query("SELECT COUNT(*) AS n FROM season_receipts"))[0].n), 0);
  });

  it("works without a season service and validates scopes, metrics and pass XP", async () => {
    const day = new Date("2026-11-04T10:00:00Z");
    const services = await startServices({ clock: () => day });
    const goal = (edit: Record<string, unknown>) => ({
      id: "custom",
      title: "Custom",
      scope: "weekly",
      metric: "wins",
      target: 2,
      credits: 10,
      xp: 5,
      passXp: 20,
      ...edit,
    });
    const build = (edit: Record<string, unknown>) =>
      new ProgressionService(
        services.database,
        new ProgressionRepository(services.database),
        { version: 1, goals: [goal(edit)] } as unknown as typeof content.goalCatalog,
        services.accounts,
        services.collection,
      );
    assert.doesNotThrow(() => build({}));
    assert.doesNotThrow(() => build({ passXp: undefined }));
    for (const edit of [
      { metric: "level" },
      { scope: "monthly" },
      { passXp: -1 },
      { passXp: 10001 },
      { passXp: 1.5 },
      { target: 0 },
    ]) {
      assert.throws(() => build(edit), /Invalid mission catalogue/);
    }
    const id = (await services.accounts.register({ username: "nosink", password: "test-only-password" })).profile.id;
    await services.database.query("INSERT INTO daily_progress VALUES(?,?,?,?,?)", [id, "2026-11-04", 1, 0, 0]);
    const standalone = new ProgressionService(
      services.database,
      new ProgressionRepository(services.database),
      content.goalCatalog,
      services.accounts,
      services.collection,
      () => day,
    );
    await standalone.claim(id, "daily-finish");
    assert.equal((await services.seasons.state(id)).xp, 0);
  });

  it("authenticates the API and never trusts submitted counters or reward amounts", async () => {
    const server = await startServer();
    const post = (path: string, body: unknown, token = "") =>
      fetch(server.url + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(body),
      });
    try {
      assert.equal((await fetch(server.url + "/api/progression/state")).status, 401);
      const account = await (
        await post("/api/account/register", { username: "goals_api", password: "test-only-password" })
      ).json();
      const response = await fetch(server.url + "/api/progression/state", {
        headers: { Authorization: "Bearer " + account.token },
      });
      const progression = await response.json();
      assert.equal(progression.goals.length, 16);
      assert.match(progression.week, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Date.parse(progression.dayEndsAt) > Date.now());
      assert.ok(Date.parse(progression.weekEndsAt) >= Date.parse(progression.dayEndsAt));
      assert.deepEqual(
        progression.goals
          .filter((goal: { scope: string }) => goal.scope === "weekly")
          .map((goal: { id: string }) => goal.id),
        ["weekly-ten", "weekly-wins", "weekly-teams"],
      );
      assert.equal(progression.goals.find((goal: { id: string }) => goal.id === "weekly-wins").passXp, 600);
      assert.equal(
        (
          await post(
            "/api/progression/claim",
            { goalId: "daily-finish", current: 9999, credits: 999999 },
            account.token,
          )
        ).status,
        409,
      );
      assert.equal((await post("/api/progression/claim", { goalId: "unknown" }, account.token)).status, 400);
      assert.equal((await post("/api/progression/state", { matches: 999 }, account.token)).status, 404);
      assert.equal((await server.container.collection.state(account.profile.id)).credits, 300);
    } finally {
      await server.stop();
    }
  });
});
