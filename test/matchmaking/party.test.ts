import assert from "node:assert/strict";
import { PARTY_GATHER_MS, MatchmakingQueue } from "../../src/modules/matchmaking/matchmaking.queue.js";
import type { QueueDefinition, Ticket } from "../../src/modules/matchmaking/matchmaking.types.js";

function queueDefinition(overrides: Partial<QueueDefinition> = {}): QueueDefinition {
  return {
    id: "test",
    mode: "race",
    players: { min: 2, max: 4 },
    search: { seconds: 10, startShort: true },
    bots: { fill: true, max: -1 },
    lobby: { seconds: 5, readyCheck: true, startWhenFull: true },
    backfill: { enabled: true, minLobbySeconds: 2 },
    rules: {},
    ...overrides,
  };
}

let next = 0;
function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t" + next++,
    accountId: "",
    partition: "test:classic:sky-sprint",
    playlist: "classic",
    courseId: "sky-sprint",
    skill: 1,
    region: "",
    enqueuedAt: 0,
    ...overrides,
  };
}

/** The tickets of a party of `size`, of which `present` have arrived. */
function party(id: string, size: number, present = size, overrides: Partial<Ticket> = {}): Ticket[] {
  return Array.from({ length: present }, () => ticket({ party: id, partySize: size, ...overrides }));
}

const ids = (tickets: Ticket[]) => tickets.map(entry => entry.id).sort();

describe("matchmaking parties", () => {
  it("places a party as one unit, together with solo players up to the seats", () => {
    const queue = new MatchmakingQueue(queueDefinition({ players: { min: 2, max: 4 } }));
    const duo = party("duo", 2);
    const solos = [ticket({ enqueuedAt: 10 }), ticket({ enqueuedAt: 11 }), ticket({ enqueuedAt: 12 })];
    for (const entry of [...duo, ...solos]) queue.add(entry);
    const placements = queue.cycle(1000);
    assert.equal(placements.length, 1, "four seats: the duo and two solo players; the third waits for a partner");
    assert.deepEqual(ids(placements[0].tickets), ids([...duo, solos[0], solos[1]]));
    assert.equal(queue.size, 1);
  });

  it("never splits a party: a unit that does not fit the group is placed on its own", () => {
    const queue = new MatchmakingQueue(queueDefinition({ players: { min: 4, max: 4 } }));
    const duo = party("duo", 2, 2, { enqueuedAt: 0 });
    const trio = party("trio", 3, 3, { enqueuedAt: 1 });
    for (const entry of [...duo, ...trio]) queue.add(entry);
    assert.deepEqual(queue.cycle(1000), [], "2 + 3 players do not fit four seats, and neither party is cut to fit");
    const placements = queue.cycle(11_000);
    assert.deepEqual(
      placements.map(placement => placement.tickets.length),
      [2, 3],
      "once the search time is up, each party starts short on its own",
    );
    assert.deepEqual(ids(placements[0].tickets), ids(duo));
    assert.deepEqual(ids(placements[1].tickets), ids(trio));
  });

  it("waits until every member of the party is here, and tells the others how many arrived", () => {
    const queue = new MatchmakingQueue(queueDefinition({ players: { min: 1, max: 4 } }));
    const trio = party("trio", 3, 2);
    for (const entry of trio) queue.add(entry);
    assert.deepEqual(queue.cycle(1000), [], "two of three members do not play");
    assert.equal(queue.status(trio[0].id, 1000).found, 2);
    const last = party("trio", 3, 1)[0];
    queue.add(last);
    const placements = queue.cycle(2000);
    assert.equal(placements.length, 1);
    assert.deepEqual(ids(placements[0].tickets), ids([...trio, last]));
  });

  it("does not start a party short before it is complete, even when the search time is up", () => {
    const queue = new MatchmakingQueue(queueDefinition({ players: { min: 4, max: 4 } }));
    const duo = party("duo", 2, 1);
    queue.add(duo[0]);
    assert.deepEqual(queue.cycle(60_000), []);
    queue.add(party("duo", 2, 1)[0]);
    assert.equal(queue.cycle(60_000).length, 1, "complete, and the search time is up, so it starts short");
  });

  it("drops a party whose members do not arrive in time, and lets complete ones through", () => {
    const queue = new MatchmakingQueue(queueDefinition({ players: { min: 4, max: 4 } }));
    const lonely = party("lonely", 3, 2, { enqueuedAt: 0 });
    const complete = party("complete", 2, 2, { enqueuedAt: 0 });
    const solo = ticket({ enqueuedAt: 0 });
    for (const entry of [...lonely, ...complete, solo]) queue.add(entry);
    assert.deepEqual(queue.expireParties(PARTY_GATHER_MS), [], "exactly 20 seconds is not more than 20 seconds");
    const expired = queue.expireParties(PARTY_GATHER_MS + 1);
    assert.deepEqual(ids(expired), ids(lonely));
    assert.equal(queue.has(lonely[0].id), false);
    assert.equal(queue.has(complete[0].id), true, "a complete party is never expired");
    assert.equal(queue.has(solo.id), true);
    assert.deepEqual(queue.expireParties(PARTY_GATHER_MS * 10).length, 0);
  });

  it("takes every ticket of a party out when one of them leaves", () => {
    const queue = new MatchmakingQueue(queueDefinition());
    const duo = party("duo", 2);
    const solo = ticket();
    for (const entry of [...duo, solo]) queue.add(entry);
    queue.remove(duo[0].id);
    assert.deepEqual(ids(queue.removeParty("duo")), ids([duo[1]]));
    assert.equal(queue.size, 1);
    assert.deepEqual(queue.removeParty(""), [], "solo tickets are not a party");
    assert.equal(queue.has(solo.id), true);
  });

  it("backfills a lobby only when it has room for the whole unit", () => {
    const queue = new MatchmakingQueue(queueDefinition({ players: { min: 1, max: 4 } }));
    const duo = party("duo", 2);
    for (const entry of duo) queue.add(entry);
    const members = [ticket(), ticket()];
    const lobby = { roomId: "room", partition: duo[0].partition, free: 1, members };
    const full = queue.cycle(1000, [lobby]);
    assert.equal(full[0].roomId, undefined, "one free seat is not enough for two: a new match is formed");
    assert.equal(queue.size, 0);
    for (const entry of party("duo", 2)) queue.add(entry);
    const roomy = queue.cycle(1000, [{ ...lobby, free: 2 }]);
    assert.equal(roomy.length, 1);
    assert.equal(roomy[0].roomId, "room");
    assert.equal(roomy[0].tickets.length, 2, "both members go to the same lobby");
    // Seats are used up unit by unit within one pass.
    for (const entry of [...party("a", 2), ...party("b", 2)]) queue.add(entry);
    const two = queue.cycle(1000, [{ ...lobby, free: 3 }]);
    assert.deepEqual(
      two.map(placement => [placement.roomId ?? "new", placement.tickets.length]),
      [
        ["room", 2],
        ["new", 2],
      ],
    );
  });

  it("checks the skill rule between a party's members and everyone else, never among its own", () => {
    const strict = { skill: { metric: "level" as const, range: 2, widenPerSecond: 0, maxRange: 2 } };
    const duo = () => [
      ticket({ party: "duo", partySize: 2, skill: 1, enqueuedAt: 0 }),
      ticket({ party: "duo", partySize: 2, skill: 11, enqueuedAt: 0 }),
    ];
    // The duo is ten levels apart inside itself, which is fine.
    const alone = new MatchmakingQueue(queueDefinition({ players: { min: 2, max: 4 }, rules: strict }));
    for (const entry of duo()) alone.add(entry);
    assert.equal(alone.cycle(1000)[0].tickets.length, 2);
    // A solo player close to one member is nine levels from the other, so the unit and the player do not meet.
    const queue = new MatchmakingQueue(queueDefinition({ players: { min: 3, max: 4 }, rules: strict }));
    for (const entry of [...duo(), ticket({ skill: 2, enqueuedAt: 1 })]) queue.add(entry);
    assert.deepEqual(queue.cycle(1000), []);
    // A wider range suits every pair across the two units.
    const wide = new MatchmakingQueue(
      queueDefinition({
        players: { min: 3, max: 4 },
        rules: { skill: { metric: "level", range: 10, widenPerSecond: 0, maxRange: 10 } },
      }),
    );
    for (const entry of [...duo(), ticket({ skill: 6, enqueuedAt: 1 })]) wide.add(entry);
    assert.equal(wide.cycle(1000)[0].tickets.length, 3);
  });

  it("reports the group size by tickets, as for solo players", () => {
    const queue = new MatchmakingQueue(queueDefinition({ players: { min: 4, max: 4 } }));
    const duo = party("duo", 2);
    for (const entry of duo) queue.add(entry);
    queue.add(ticket({ enqueuedAt: 5 }));
    assert.deepEqual(queue.cycle(1000), []);
    assert.equal(queue.status(duo[0].id, 1000).found, 3, "the duo and the solo player");
  });

  it("turns away a party larger than the queue's seats and treats a party of one as a solo player", () => {
    const small = new MatchmakingQueue(queueDefinition({ players: { min: 1, max: 2 } }));
    assert.match(small.admit(ticket({ party: "big", partySize: 3 })), /larger than this queue/);
    assert.equal(small.admit(ticket({ party: "duo", partySize: 2 })), "");
    const queue = new MatchmakingQueue(queueDefinition({ players: { min: 1, max: 4 } }));
    const alone = ticket({ party: "one", partySize: 1 });
    queue.add(alone);
    assert.equal(queue.cycle(1000)[0].tickets[0].id, alone.id);
  });
});
