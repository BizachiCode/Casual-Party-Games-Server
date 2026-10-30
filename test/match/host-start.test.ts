import assert from "node:assert/strict";
import { PartySimulation } from "../../src/modules/match/simulation/party-simulation.js";
import { config } from "../support/server.js";

/** A created room's lobby: no ready check, starts when full, the host may start it, no bots on their own. */
const createdRoom = { readyCheck: false, startWhenFull: true, hostStart: true, fillBots: false, maxBots: 5 };
const steps = (simulation: PartySimulation, seconds: number) => {
  for (let tick = 0; tick < seconds * config.tickRate; tick++) simulation.step();
};

describe("host start", () => {
  it("lets only the host start a created room, now, with bots in the empty seats up to the limit", () => {
    const simulation = new PartySimulation(config, 8, createdRoom);
    simulation.addPlayer("host", "Host");
    simulation.addPlayer("friend", "Friend");
    steps(simulation, 30);
    assert.equal(simulation.phase, "lobby", "a created room waits for the host");
    assert.equal(simulation.players.filter(runner => runner.bot).length, 0, "and takes no bots on its own");
    simulation.ready("friend");
    simulation.ready("host");
    steps(simulation, 1);
    assert.equal(simulation.phase, "lobby", "being ready starts nothing without the ready check");

    assert.equal(simulation.hostStart("friend", true), false, "only the host starts the room");
    assert.equal(simulation.phase, "lobby");
    assert.equal(simulation.hostStart("host", true), true);
    assert.equal(simulation.phase, "countdown");
    assert.equal(simulation.players.length, 7, "two humans and the five bots allowed");
    assert.equal(simulation.hostStart("host", true), false, "a started match cannot start again");
  });

  it("starts a created room with only the humans in when the host does not want bots", () => {
    const simulation = new PartySimulation(config, 8, createdRoom);
    simulation.addPlayer("host", "Host");
    assert.equal(simulation.hostStart("host", false), true);
    assert.equal(simulation.phase, "countdown");
    assert.deepEqual(
      simulation.players.map(runner => runner.id),
      ["host"],
    );
  });

  it("never starts a matchmaking lobby on demand: ready and host start wait for the room to fill", () => {
    const simulation = new PartySimulation(config, 6, { readyCheck: false, lobbySeconds: 10, fillBots: true });
    simulation.addPlayer("player", "Player");
    simulation.ready("player");
    assert.equal(simulation.hostStart("player", true), false, "matchmaking lobbies have no host start");
    steps(simulation, 1);
    assert.equal(simulation.phase, "lobby", "ready alone starts nothing");
    steps(simulation, config.bots.joinDelay + 5 * config.bots.joinIntervalMax + 0.2);
    assert.equal(simulation.players.length, 6, "bots took the empty seats meanwhile");
    steps(simulation, 10);
    assert.notEqual(simulation.phase, "lobby", "the lobby timer starts the match");
  });
});
