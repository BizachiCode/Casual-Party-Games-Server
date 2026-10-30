import assert from "node:assert/strict";
import { partyTeam, type LobbySeat } from "../../src/modules/match/team-placement.js";
import { PartySimulation } from "../../src/modules/match/simulation/party-simulation.js";
import { config } from "../support/server.js";

/** A lobby seat of a party member (or of a bot or solo player with an empty party). */
const seat = (team: number, party = "", partySize = 0): LobbySeat => ({ team, party, partySize });

describe("party team placement", () => {
  it("leaves solo players, bots and modes without teams alone", () => {
    assert.equal(partyTeam(2, 4, [], "", 0), 0, "no party");
    assert.equal(partyTeam(1, 4, [seat(0, "a", 2)], "a", 2), 0, "a mode without teams");
    assert.equal(partyTeam(2, 4, [seat(1), seat(0)], "", 0), 0, "solo players are seated by the match");
  });

  it("seats the first member on the lowest team with room for the party", () => {
    assert.equal(partyTeam(2, 4, [], "a", 2), 1, "an empty lobby");
    assert.equal(partyTeam(2, 4, [seat(1, "other", 2), seat(1, "other", 2)], "a", 2), 2, "team 1 is full");
    assert.equal(partyTeam(2, 4, [seat(1)], "a", 2), 2, "team 1 has one place, the duo needs two");
    assert.equal(partyTeam(2, 4, [seat(1), seat(2)], "a", 2), 3);
  });

  it("puts the next member on the team of a member already there", () => {
    assert.equal(partyTeam(2, 4, [seat(3, "a", 2)], "a", 2), 3);
    assert.equal(partyTeam(4, 4, [seat(2, "a", 3), seat(2, "a", 3)], "a", 3), 2);
    // Other players around it change nothing.
    assert.equal(partyTeam(2, 4, [seat(1), seat(2, "a", 2), seat(3, "b", 2), seat(1)], "a", 2), 2);
  });

  it("keeps the places a party that is still arriving needs", () => {
    // Squads (four to a team): a party of three has one member in, so team 1 keeps two places for the rest of it and
    // has one left, which is not enough for a duo.
    assert.equal(partyTeam(4, 4, [seat(1, "trio", 3)], "duo", 2), 2);
    assert.equal(partyTeam(4, 4, [seat(1, "trio", 3)], "single", 1), 1, "but one player fits");
    assert.equal(partyTeam(4, 4, [seat(1, "trio", 3), seat(1)], "single", 1), 2, "a solo player took the last place");
    assert.equal(
      partyTeam(4, 4, [seat(1, "trio", 3), seat(1, "trio", 3)], "duo", 2),
      2,
      "team 1 keeps one for the trio",
    );
    // Two duos arriving member by member never share a team.
    assert.equal(partyTeam(2, 4, [seat(1, "first", 2)], "second", 2), 2);
    assert.equal(partyTeam(2, 4, [seat(1, "first", 2), seat(2, "second", 2)], "first", 2), 1);
  });

  it("fills one team and continues on the next when the party is larger than a team", () => {
    const seats: LobbySeat[] = [];
    const teams: number[] = [];
    for (let member = 0; member < 4; member++) {
      const team = partyTeam(2, 4, seats, "quad", 4);
      teams.push(team);
      seats.push(seat(team, "quad", 4));
    }
    assert.deepEqual(teams, [1, 1, 2, 2]);
    const trio: number[] = [];
    const lobby: LobbySeat[] = [];
    for (let member = 0; member < 3; member++) {
      const team = partyTeam(2, 4, lobby, "trio", 3);
      trio.push(team);
      lobby.push(seat(team, "trio", 3));
    }
    assert.deepEqual(trio, [1, 1, 2]);
  });

  it("falls back to the roomiest team, and to none when every team is full", () => {
    // Two places left on different teams: a duo cannot sit together, so it takes what is there.
    const fragmented = [seat(1), seat(2), seat(3), seat(3), seat(4), seat(4)];
    assert.equal(partyTeam(2, 4, fragmented, "a", 2), 1);
    const full = [1, 1, 2, 2, 3, 3, 4, 4].map(team => seat(team));
    assert.equal(partyTeam(2, 4, full, "a", 2), 0);
  });

  it("is carried out by the simulation's own team rule, without bypassing it", () => {
    const simulation = new PartySimulation(config, 4, { mode: "duos", playlist: "classic" });
    const parties = new Map([
      ["p1", "first"],
      ["p2", "first"],
      ["p3", "second"],
      ["p4", "second"],
    ]);
    for (const [id, party] of parties) {
      const seats = simulation.players.map(runner => seat(runner.team, parties.get(runner.id), 2));
      simulation.addPlayer(id, id);
      assert.equal(simulation.selectTeam(id, partyTeam(2, 2, seats, party, 2)), true);
    }
    const teamOf = (id: string) => simulation.players.find(runner => runner.id === id).team;
    assert.equal(teamOf("p1"), teamOf("p2"));
    assert.equal(teamOf("p3"), teamOf("p4"));
    assert.notEqual(teamOf("p1"), teamOf("p3"));
    assert.ok(teamOf("p1") > 0 && teamOf("p3") > 0);
  });
});
