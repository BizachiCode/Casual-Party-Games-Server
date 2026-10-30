/** One runner already in a lobby, as the team choice sees it. */
export interface LobbySeat {
  /** 0 until the runner is on a team. */
  team: number;
  /** The party of the runner's matchmaking ticket; "" for solo players and bots. */
  party: string;
  /** How many players that party has. */
  partySize: number;
}

/**
 * The team a joining party member takes in a team mode, so the whole party plays together. `seats` is everyone already
 * in the lobby except the joiner.
 *
 * - A team that already holds a member of the same party, if it still has room.
 * - Else the lowest team with room for the members of the party yet to come (at most one team's worth: a party larger
 *   than a team fills one team and continues on the next).
 * - Else the team with the most room, so nobody is left out; 0 when every team is full.
 *
 * Seats the other parties are still waiting for count as taken, so a half-arrived party keeps its places. Solo players
 * and bots never get a team here: the match puts them wherever there is room when it starts. Returns 0 when the mode
 * has no teams or the joiner has no party.
 */
export function partyTeam(
  teamSize: number,
  teamCount: number,
  seats: LobbySeat[],
  party: string,
  partySize: number,
): number {
  if (teamSize <= 1 || !party) return 0;
  const teams = Array.from({ length: teamCount }, (_, index) => index + 1);
  const taken = new Map<number, number>(teams.map(team => [team, 0]));
  for (const seat of seats) if (taken.has(seat.team)) taken.set(seat.team, taken.get(seat.team) + 1);

  // Members the other parties still expect hold places on the teams those parties already sit on.
  const expected = new Map<number, number>(teams.map(team => [team, 0]));
  const others = new Map<string, LobbySeat[]>();
  for (const seat of seats) {
    if (seat.party && seat.party !== party) others.set(seat.party, [...(others.get(seat.party) ?? []), seat]);
  }
  for (const members of others.values()) {
    let missing = Math.max(...members.map(member => member.partySize)) - members.length;
    for (const team of [...new Set(members.map(member => member.team))].sort((left, right) => left - right)) {
      if (!taken.has(team) || missing <= 0) continue;
      const held = Math.max(0, Math.min(missing, teamSize - taken.get(team) - expected.get(team)));
      expected.set(team, expected.get(team) + held);
      missing -= held;
    }
  }
  const room = (team: number) => teamSize - taken.get(team) - expected.get(team);

  const mine = seats.filter(seat => seat.party === party);
  for (const team of [...new Set(mine.map(seat => seat.team))].sort((left, right) => left - right)) {
    if (taken.has(team) && room(team) >= 1) return team;
  }
  const needed = Math.max(1, Math.min(teamSize, partySize - mine.length));
  const roomFor = teams.find(team => room(team) >= needed);
  if (roomFor) return roomFor;
  return teams.reduce((best, team) => (room(team) > (best ? room(best) : 0) ? team : best), 0);
}
