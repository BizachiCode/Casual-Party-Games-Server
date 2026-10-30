import assert from "node:assert/strict";
import type { MatchSnapshot } from "../../src/modules/match/simulation/party-simulation.js";
import { RankingRepository } from "../../src/modules/ranking/ranking.repository.js";
import { RankingService } from "../../src/modules/ranking/ranking.service.js";
import { config, startServer, startServices } from "../support/server.js";

describe("rankings", () => {
  it("isolates modes, seasons, friends, solo practice and best times; receipts are idempotent", async () => {
    const services = await startServices();
    let now = new Date("2026-01-05T00:00:00Z");
    const rankings = new RankingService(services.database, new RankingRepository(services.database), config, () => now);
    const alice = (await services.accounts.register({ username: "alice", password: "test-password-a" })).profile.id;
    const bravo = (await services.accounts.register({ username: "bravo", password: "test-password-b" })).profile.id;
    const charlie = (await services.accounts.register({ username: "charlie", password: "test-password-c" })).profile.id;
    const accounts = new Map([
      ["p1", alice],
      ["p2", bravo],
    ]);
    const state = {
      phase: "finished",
      mode: "tournament",
      courseId: "sky-sprint",
      winnerIds: ["p1"],
      players: [
        { id: "p1", totalScore: 25, finishTime: 20 },
        { id: "p2", totalScore: 12, finishTime: -1 },
      ],
    } as unknown as MatchSnapshot;

    await rankings.recordMatch("match-1", state, accounts);
    await rankings.recordMatch("match-1", state, accounts);
    assert.equal((await services.accounts.profile(alice)).matches, 1);
    assert.equal((await rankings.board()).entries[0].wins, 1);
    assert.equal((await rankings.board({ board: "points" })).entries[0].points, 25);
    assert.equal((await rankings.board({ board: "mode", mode: "squads" })).entries.length, 0);
    now = new Date("2026-02-01T00:00:00Z");
    assert.equal((await rankings.board({ board: "season" })).entries.length, 0);
    await rankings.recordMatch("match-2", { ...state, mode: "squads", winnerIds: ["p2"] }, accounts);
    assert.equal((await rankings.board({ board: "mode", mode: "squads" })).entries[0].id, bravo);
    assert.equal((await rankings.board({ board: "friends" }, charlie)).entries.length, 0);
    await services.social.request(alice, "bravo");
    await services.social.respond(bravo, alice, true);
    assert.equal((await rankings.board({ board: "friends" }, alice)).entries.length, 2);
    await assert.rejects(rankings.board({ board: "friends" }), /Sign in/);
    assert.ok((await rankings.board({ board: "level" })).entries[0].score >= 25);
    const trial = { ...state, mode: "timeTrial", players: [state.players[0]] } as MatchSnapshot;
    await rankings.recordMatch("trial-1", trial, accounts);
    await rankings.recordMatch("trial-2", { ...trial, players: [{ ...trial.players[0], finishTime: 25 }] }, accounts);
    assert.equal((await rankings.board({ board: "timeTrial", courseId: "sky-sprint" })).entries[0].seconds, 20);
    await rankings.recordMatch("solo", { ...state, players: [state.players[0]] }, accounts);
    assert.equal((await rankings.board()).entries.find(player => player.id === alice).wins, 1);
    await assert.rejects(
      async () => rankings.recordMatch("forged", { ...state, phase: "running" }, accounts),
      /finished/,
    );
  });

  it("serves read-only boards and rejects client-written results and unknown filters", async () => {
    const server = await startServer();
    try {
      for (const board of ["wins", "points", "season", "mode", "level"]) {
        const response = await fetch(server.url + "/api/rankings?board=" + board);
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).entries, []);
      }
      assert.equal((await fetch(server.url + "/api/rankings?board=friends")).status, 401);
      assert.equal((await fetch(server.url + "/api/rankings?board=made-up")).status, 400);
      assert.equal((await fetch(server.url + "/api/rankings?board=timeTrial&courseId=tile-tumble")).status, 400);
      assert.equal(
        (
          await fetch(server.url + "/api/rankings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wins: 999 }),
          })
        ).status,
        404,
      );
    } finally {
      await server.stop();
    }
  });
});
