import { matchMaker, Room, ServerError, type Client } from "colyseus";
import type { AccountService, Profile } from "../account/account.service.js";
import type { PartyConfig } from "../content/content.types.js";
import type { MatchRegistry } from "../match/match-registry.js";
import type { SeatAuth } from "../match/party.room.js";
import type { EventAdmission, EventGate } from "../events/events.service.js";
import type { OperationsService } from "../operations/operations.service.js";
import type { SearchOrder, SquadDirectory } from "../squad/squad.types.js";
import { cleanText } from "../../shared/text.js";
import { MatchmakingQueue, type Placement } from "./matchmaking.queue.js";
import { skillOf } from "./matchmaking.rules.js";
import type { MatchmakingService } from "./matchmaking.service.js";
import type { Ticket } from "./matchmaking.types.js";

export interface MatchmakingServices {
  config: PartyConfig;
  accounts: AccountService;
  operations: OperationsService;
  registry: MatchRegistry;
  matchmaking: MatchmakingService;
  /** Timed events; without it, searches for an event are refused. */
  events?: EventGate;
  /** The parties of this process; without it, searches with a party are refused. */
  squads?: SquadDirectory;
}

export interface SearchOptions {
  protocol?: number;
  revision?: string;
  sessionToken?: string;
  queue?: string;
  mode?: string;
  playlist?: string;
  courseId?: string;
  /** Search for this timed event instead of the queue's usual match. */
  eventId?: string;
  /**
   * The party id from the squad's search order ("" or absent for a solo search). The room follows the order, not the
   * other options: the party's queue, playlist, course and event, and its size.
   */
  party?: string;
  partySize?: number;
  region?: string;
  name?: string;
  color?: number;
}

/** What a searching player carries: the seat the match will receive and the ticket waiting for it. */
interface Search {
  seat: SeatAuth;
  ticket: Omit<Ticket, "id" | "enqueuedAt">;
  join: { name?: string; color?: number };
}
type Searcher = Client & { auth?: Search };

/** How often the queue looks for matches. */
const PASS_MILLISECONDS = 500;

/**
 * One matchmaking queue (one room per queue id, created on demand). Players join it to search; every pass the queue
 * backfills open lobbies and forms new matches, then each placed player receives a seat reservation ("seat") and
 * leaves to join the match. Waiting players get "status" updates: players found, minimum, seats and seconds waited.
 */
export class MatchmakingRoom extends Room {
  /** Provided by createMatchmakingRoom(). */
  protected services: MatchmakingServices;
  queue: MatchmakingQueue;
  private passing = false;

  onCreate(options: SearchOptions): void {
    const { operations, matchmaking } = this.services;
    operations.requireAdmission();
    const definition = matchmaking.queue(options.queue, options.mode);
    if (!definition) throw new ServerError(400, "Unknown matchmaking queue.");
    this.queue = new MatchmakingQueue(definition);
    this.maxClients = 1000;
    this.setTimestep(() => void this.pass(), PASS_MILLISECONDS);
  }

  async onAuth(_client: Client, options: SearchOptions): Promise<Search> {
    const { config, operations, accounts, registry, matchmaking, events, squads } = this.services;
    operations.requireAdmission();
    if (options.protocol !== config.protocol || options.revision !== config.revision)
      throw new ServerError(400, "Client/course version mismatch. Update the client and server together.");
    let seat: SeatAuth = { id: "" };
    let profile: Profile | undefined;
    if (options.sessionToken) {
      profile = await accounts.authenticate(options.sessionToken);
      if (!profile) throw new ServerError(401, "Session expired. Sign in again.");
      if (registry.hasAccount(profile.id)) throw new ServerError(409, "Account already in a match.");
      if (matchmaking.isSearching(profile.id)) throw new ServerError(409, "Account already searching for a match.");
      seat = { ...profile, token: options.sessionToken };
    }
    const definition = this.queue.definition;
    // A party searches the order its squad gave, the same for every member: the squad checked it, the client does not
    // choose it. Each member must still qualify for the event on their own.
    let order: SearchOrder | undefined;
    if (typeof options.party === "string" && options.party !== "") {
      if (!profile) throw new ServerError(401, "Sign in to search with a party.");
      order = squads?.searchOrder(options.party, profile.id);
      if (!order) throw new ServerError(409, "Your party is not searching.");
      if (order.queue !== definition.id) throw new ServerError(400, "The party searches another queue.");
    }
    // An event is played on its own playlist or course, never the client's, and only by players who qualify.
    let play: EventAdmission | undefined;
    const eventId = order ? order.eventId : options.eventId;
    if (eventId !== undefined && eventId !== "") {
      if (!events) throw new ServerError(404, "Unknown event.");
      play = events.admit(eventId, definition.id, profile?.level ?? 1);
    }
    const target = matchmaking.target(
      definition,
      definition.mode,
      play ? play.playlist : (order ?? options).playlist,
      play ? play.courseId : (order ?? options).courseId,
      play?.eventId,
    );
    const ticket = {
      accountId: seat.id,
      partition: target.partition,
      playlist: target.playlist,
      courseId: target.courseId,
      eventId: play?.eventId,
      party: order?.partyId ?? "",
      partySize: order?.size ?? 0,
      skill: skillOf(definition.rules, profile),
      region: typeof options.region === "string" ? cleanText(options.region).slice(0, 16) : "",
    };
    const refusal = this.queue.admit({ ...ticket, id: "", enqueuedAt: 0 });
    if (refusal) throw new ServerError(403, refusal);
    return { seat, ticket, join: { name: options.name, color: options.color } };
  }

  onJoin(client: Searcher): void {
    const accountId = client.auth.seat.id;
    if (!this.services.matchmaking.beginSearch(accountId))
      throw new ServerError(409, "Account already searching for a match.");
    this.queue.add({ ...client.auth.ticket, id: client.sessionId, enqueuedAt: Date.now() });
    this.sendStatus(client, Date.now());
  }

  onLeave(client: Searcher): void {
    // A player who leaves while still waiting breaks the party's search: the rest of the party is called off too.
    const waiting = this.queue.has(client.sessionId);
    this.queue.remove(client.sessionId);
    this.services.matchmaking.endSearch(client.auth?.seat.id);
    const party = client.auth?.ticket.party;
    if (waiting && party) this.dismissParty(this.queue.removeParty(party), "partyCancelled");
  }

  /** Tells the clients of these removed tickets why their search ended, and sends them home. */
  private dismissParty(tickets: Ticket[], message: "partyCancelled" | "partyTimeout"): void {
    for (const ticket of tickets) {
      const client = (this.clients as Searcher[]).find(candidate => candidate.sessionId === ticket.id);
      client?.send(message);
      client?.leave();
    }
  }

  /** One queue pass: place who can be placed, then tell everyone still waiting where their search stands. */
  private async pass(): Promise<void> {
    if (this.passing) return;
    this.passing = true;
    try {
      const now = Date.now();
      const { backfill } = this.queue.definition;
      const lobbies = backfill.enabled ? this.services.registry.openLobbies(this.queue.definition.id, backfill) : [];
      const placements = this.queue.cycle(now, lobbies);
      await Promise.all(placements.map(placement => this.place(placement)));
      // Parties whose members did not all show up give up, and tell the ones who did.
      this.dismissParty(this.queue.expireParties(now), "partyTimeout");
      for (const client of this.clients) this.sendStatus(client as Searcher, now);
    } finally {
      this.passing = false;
    }
  }

  /** Reserves the seats of one placement and sends each player its reservation. Whoever gets no seat searches on. */
  private async place(placement: Placement): Promise<void> {
    const seats = placement.tickets
      .map(ticket => ({ ticket, client: (this.clients as Searcher[]).find(client => client.sessionId === ticket.id) }))
      .filter(seat => seat.client);
    if (!seats.length) return;
    const eventId = seats[0].ticket.eventId ?? "";
    if (eventId && !this.services.events?.isRunning(eventId)) {
      // The event ended while they searched: there is nothing left to wait for.
      for (const { client } of seats) {
        client.send("notice", "This event has ended.");
        client.leave();
      }
      return;
    }
    let reserved: boolean[] = [];
    try {
      const room = placement.roomId
        ? await matchMaker.getRoomById(placement.roomId)
        : await matchMaker.createRoom("party", {
            queue: this.queue.definition.id,
            playlist: seats[0].ticket.playlist,
            courseId: seats[0].ticket.courseId,
            eventId,
          });
      if (!room) throw new Error("The lobby closed.");
      reserved = await matchMaker.reserveMultipleSeatsFor(
        room,
        seats.map(({ client }) => ({ sessionId: client.sessionId, options: client.auth.join, auth: client.auth.seat })),
      );
      this.services.registry
        .get(room.roomId)
        ?.addMembers(seats.filter((_, index) => reserved[index]).map(seat => seat.ticket));
      seats.forEach(({ client }, index) => {
        if (reserved[index]) client.send("seat", matchMaker.buildSeatReservation(room, client.sessionId));
      });
    } catch {
      // The lobby filled or closed meanwhile; the next pass retries.
    } finally {
      // Players without a seat keep their place in the queue.
      seats.forEach(({ ticket }, index) => {
        if (!reserved[index]) this.queue.add(ticket);
      });
    }
  }

  private sendStatus(client: Searcher, now: number): void {
    const status = this.queue.status(client.sessionId, now);
    if (status) client.send("status", status);
  }
}

/** The room class registered with the matchmaker, bound to this server's services. */
export function createMatchmakingRoom(services: MatchmakingServices): typeof MatchmakingRoom {
  return class ConfiguredMatchmakingRoom extends MatchmakingRoom {
    protected services = services;
  };
}
