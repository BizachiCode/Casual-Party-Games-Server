import { buildRules, type MatchmakingRule } from "./matchmaking.rules.js";
import type { QueueDefinition, Ticket } from "./matchmaking.types.js";

/** A lobby of this queue that still takes players, as the backfill sees it. */
export interface OpenLobby {
  roomId: string;
  partition: string;
  /** Seats still free. */
  free: number;
  /** The tickets already placed in it. */
  members: Ticket[];
}

/** Tickets sent to one match: an existing lobby (backfill) or, without a room id, a new one. */
export interface Placement {
  partition: string;
  tickets: Ticket[];
  roomId?: string;
}

/** What a waiting player is told after each pass. */
export interface SearchStatus {
  /** Players in the group forming around this ticket, the ticket included. */
  found: number;
  min: number;
  max: number;
  /** Seconds this ticket has waited. */
  waited: number;
  /** The queue's search time. */
  search: number;
}

/** A party whose members have not all arrived is dropped after the oldest of them has waited this long. */
export const PARTY_GATHER_MS = 20000;

/** The party id of a ticket that searches with other players; "" for a solo search. */
const partyOf = (ticket: Ticket): string => ((ticket.partySize ?? 0) > 1 && ticket.party) || "";

const oldest = (tickets: Ticket[]) => Math.min(...tickets.map(ticket => ticket.enqueuedAt));

/**
 * The waiting players of one queue. Each pass first offers tickets to open lobbies (backfill), then forms groups of
 * tickets the rules let play together, oldest first. A group becomes a match when it is full, when it reaches the
 * minimum, or when its oldest ticket has searched long enough and the queue starts short.
 *
 * The tickets of one party are a unit: a unit waits until all its members are here, counts as its size against the
 * group and lobby limits, is never split between matches, and the rules are checked between its members and everyone
 * else (its own members always suit each other). Pure: the room feeds it the clock and the open lobbies, and acts on
 * the placements it returns.
 */
export class MatchmakingQueue {
  readonly rules: MatchmakingRule[];
  private readonly tickets = new Map<string, Ticket>();
  private readonly groupSizes = new Map<string, number>();

  constructor(readonly definition: QueueDefinition) {
    this.rules = buildRules(definition.rules);
  }

  get size(): number {
    return this.tickets.size;
  }

  /** Why the ticket may not search this queue, or "" when it may. */
  admit(ticket: Ticket): string {
    if (partyOf(ticket) && ticket.partySize > this.definition.players.max)
      return "Your party is larger than this queue allows.";
    for (const rule of this.rules) {
      const reason = rule.admit?.(ticket);
      if (reason) return reason;
    }
    return "";
  }

  add(ticket: Ticket): void {
    this.tickets.set(ticket.id, ticket);
  }

  remove(id: string): void {
    this.tickets.delete(id);
    this.groupSizes.delete(id);
  }

  /** Takes every ticket of the party out of the queue and returns them. */
  removeParty(party: string): Ticket[] {
    const removed = [...this.tickets.values()].filter(ticket => party && partyOf(ticket) === party);
    for (const ticket of removed) this.remove(ticket.id);
    return removed;
  }

  has(id: string): boolean {
    return this.tickets.has(id);
  }

  status(id: string, now: number): SearchStatus | undefined {
    const ticket = this.tickets.get(id);
    if (!ticket) return undefined;
    const { players, search } = this.definition;
    return {
      found: this.groupSizes.get(id) ?? 1,
      min: players.min,
      max: players.max,
      waited: Math.max(0, (now - ticket.enqueuedAt) / 1000),
      search: search.seconds,
    };
  }

  /**
   * The units that may be placed, oldest first: every solo ticket, and every party that has all its members here.
   * Parties still waiting for members are returned separately.
   */
  private units(): { ready: Ticket[][]; gathering: Ticket[][] } {
    const ready: Ticket[][] = [];
    const gathering: Ticket[][] = [];
    const parties = new Map<string, Ticket[]>();
    for (const ticket of this.tickets.values()) {
      const party = partyOf(ticket);
      if (!party) ready.push([ticket]);
      else parties.set(party, [...(parties.get(party) ?? []), ticket]);
    }
    for (const members of parties.values()) (members.length >= members[0].partySize ? ready : gathering).push(members);
    return { ready: ready.sort((first, second) => oldest(first) - oldest(second)), gathering };
  }

  /**
   * Takes out the parties whose members did not all arrive in time and returns their tickets, so the room can tell
   * the players who did. Call it after cycle(), which places the parties that are complete.
   */
  expireParties(now: number): Ticket[] {
    const expired: Ticket[] = [];
    for (const unit of this.units().gathering) {
      if (now - oldest(unit) > PARTY_GATHER_MS) expired.push(...unit);
    }
    for (const ticket of expired) this.remove(ticket.id);
    return expired;
  }

  /** One matching pass. The placed tickets leave the queue; a failed placement may add them back. */
  cycle(now: number, lobbies: OpenLobby[] = []): Placement[] {
    const placements: Placement[] = [];
    const { ready, gathering } = this.units();
    let waiting = ready;
    if (this.definition.backfill.enabled) {
      const open = lobbies.map(lobby => ({ ...lobby, members: [...lobby.members] }));
      waiting = waiting.filter(unit => {
        const lobby = open.find(
          candidate =>
            candidate.partition === unit[0].partition &&
            candidate.free >= unit.length &&
            this.unitFits(unit, candidate.members, now),
        );
        if (!lobby) return true;
        lobby.free -= unit.length;
        lobby.members.push(...unit);
        placements.push({ partition: unit[0].partition, tickets: unit, roomId: lobby.roomId });
        return false;
      });
    }
    const { players, search } = this.definition;
    const groups: Ticket[][] = [];
    for (const unit of waiting) {
      // A party larger than the queue's seats can never be placed (admit() turns it away).
      if (unit.length > players.max) continue;
      const group = groups.find(
        candidate =>
          candidate[0].partition === unit[0].partition &&
          candidate.length + unit.length <= players.max &&
          this.unitFits(unit, candidate, now),
      );
      if (group) group.push(...unit);
      else groups.push([...unit]);
    }
    this.groupSizes.clear();
    for (const group of groups) {
      const searchedLongEnough = search.startShort && now - oldest(group) >= search.seconds * 1000;
      if (group.length >= players.min || searchedLongEnough)
        placements.push({ partition: group[0].partition, tickets: group });
      else for (const ticket of group) this.groupSizes.set(ticket.id, group.length);
    }
    // A party still gathering shows how many of its members are here.
    for (const unit of gathering) for (const ticket of unit) this.groupSizes.set(ticket.id, unit.length);
    for (const placement of placements) for (const ticket of placement.tickets) this.tickets.delete(ticket.id);
    return placements;
  }

  /** Whether every rule lets the ticket play with each of these tickets. */
  private fits(ticket: Ticket, members: Ticket[], now: number): boolean {
    return members.every(member => this.rules.every(rule => !rule.compatible || rule.compatible(ticket, member, now)));
  }

  /** Whether every member of the unit may play with each of these tickets (the unit's own members always may). */
  private unitFits(unit: Ticket[], members: Ticket[], now: number): boolean {
    return unit.every(ticket => this.fits(ticket, members, now));
  }
}
