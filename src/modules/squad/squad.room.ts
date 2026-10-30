import { Room, ServerError, type Client } from "colyseus";
import type { AccountService, Profile } from "../account/account.service.js";
import type { CollectionService } from "../collection/collection.service.js";
import type { PartyConfig } from "../content/content.types.js";
import type { EventGate } from "../events/events.service.js";
import type { MatchRegistry } from "../match/match-registry.js";
import type { MatchmakingService } from "../matchmaking/matchmaking.service.js";
import type { OperationsService } from "../operations/operations.service.js";
import type { PresenceService } from "../presence/presence.service.js";
import type { SocialService } from "../social/social.service.js";
import { cleanText } from "../../shared/text.js";
import type { SquadRegistry } from "./squad-registry.js";
import type { SearchOrder, SquadMemberState, SquadState } from "./squad.types.js";

export interface SquadServices {
  config: PartyConfig;
  accounts: AccountService;
  social: SocialService;
  presence: PresenceService;
  collection: CollectionService;
  operations: OperationsService;
  matches: MatchRegistry;
  squads: SquadRegistry;
  matchmaking: MatchmakingService;
  /** Timed events; without it, a party cannot search for an event. */
  events?: EventGate;
  /** A search that has not ended by itself after this long is abandoned. */
  searchSeconds: number;
}

export interface SquadOptions {
  protocol?: number;
  revision?: string;
  sessionToken?: string;
  name?: string;
}

/** A party as the GM console lists it. */
export interface SquadSummary {
  roomId: string;
  status: "idle" | "searching";
  size: number;
  maxMembers: number;
  leaderName: string;
  members: { accountId: string; name: string }[];
}

/** What a seat carries after onAuth: the account and its token, which is re-checked every few seconds. */
type SquadAuth = Profile & { token: string };
type Seat = Client & { auth?: SquadAuth };
interface Member extends SquadMemberState {
  client: Seat;
}

/** Sessions of the members are checked this often. */
const AUTH_CHECK_MILLISECONDS = 5000;

/**
 * A party gathered in the menu: up to the catalog's party size (four by default) signed-in players. The leader (the
 * creator, then the oldest member) presses PLAY and the room orders every member to search the same queue under one
 * party id, which the matchmaking queue keeps together. The state travels as plain JSON messages:
 *
 * To the client: state (SquadState, after every change), search (SearchOrder), cancelled, notice (text).
 * From the client: ready (boolean), refresh, kick (session id), play ({ queue, mode, playlist, courseId, eventId }),
 * cancel, searchDone.
 */
export class SquadRoom extends Room {
  /** Provided by createSquadRoom(). */
  protected services: SquadServices;
  private readonly members = new Map<string, Member>();
  private readonly kickedAccounts = new Set<string>();
  private leaderSession = "";
  private order: SearchOrder | null = null;
  private searches = 0;
  private searchTimer?: NodeJS.Timeout;
  private authTimer?: NodeJS.Timeout;
  private readonly resends = new Set<NodeJS.Timeout>();
  private checking = false;

  onCreate(): void {
    const { operations, squads } = this.services;
    operations.requireAdmission();
    this.maxClients = this.services.matchmaking.maxPartyMembers;
    this.maxMessagesPerSecond = 20;
    // A party is joined through an invitation, never found by the matchmaker.
    this.setPrivate(true);
    squads.add(this);
    this.registerMessages();
    this.authTimer = setInterval(() => void this.checkSessions(), AUTH_CHECK_MILLISECONDS);
  }

  private registerMessages(): void {
    this.onMessage("ready", (client, value: unknown) => {
      const member = this.members.get(client.sessionId);
      if (!member || typeof value !== "boolean") return;
      member.ready = value;
      this.publish();
    });
    this.onMessage("refresh", (client: Seat) => void this.refresh(client.sessionId));
    this.onMessage("kick", (client, sessionId: unknown) => {
      const target = typeof sessionId === "string" ? this.members.get(sessionId) : undefined;
      if (client.sessionId !== this.leaderSession || this.order || !target || target.sessionId === client.sessionId)
        return;
      this.kickedAccounts.add(target.accountId);
      target.client.leave(4003);
    });
    this.onMessage("play", (client, payload: unknown) => void this.play(client, payload));
    this.onMessage("cancel", client => {
      if (this.order && this.members.has(client.sessionId)) this.endSearch(true);
    });
    this.onMessage("searchDone", client => {
      if (this.order && client.sessionId === this.leaderSession) this.endSearch(false);
    });
    this.onMessage("*", () => {}); // Unknown commands confer no authority.
  }

  async onAuth(_client: Client, options: SquadOptions): Promise<SquadAuth> {
    const { config, operations, accounts, social, squads } = this.services;
    operations.requireAdmission();
    if (options.protocol !== config.protocol || options.revision !== config.revision)
      throw new ServerError(400, "Client/course version mismatch. Update the client and server together.");
    if (!options.sessionToken) throw new ServerError(401, "Sign in to join a party.");
    const profile = await accounts.authenticate(options.sessionToken);
    if (!profile) throw new ServerError(401, "Session expired. Sign in again.");
    if (this.kickedAccounts.has(profile.id)) throw new ServerError(403, "Removed from this party.");
    if (squads.hasAccount(profile.id)) throw new ServerError(409, "Already in a party.");
    if (this.order) throw new ServerError(409, "The party is searching for a match.");
    for (const member of this.members.values()) {
      if (await social.blocked(profile.id, member.accountId)) throw new ServerError(403, "Party unavailable.");
    }
    return { ...profile, token: options.sessionToken };
  }

  async onJoin(client: Seat, options: SquadOptions): Promise<void> {
    const { squads, collection, presence } = this.services;
    const profile = client.auth;
    if (squads.hasAccount(profile.id, client.sessionId)) throw new ServerError(409, "Already in a party.");
    const characterId = (await collection.state(profile.id)).equipped;
    this.members.set(client.sessionId, {
      client,
      sessionId: client.sessionId,
      accountId: profile.id,
      name: cleanText(profile.displayName || options.name || "").slice(0, 20) || "Runner",
      characterId,
      level: profile.level,
      ready: false,
    });
    if (!this.leaderSession) this.leaderSession = client.sessionId;
    presence.setParty(profile.id, this.roomId);
    this.publish();
    // A client registers its message handlers once the join has completed, so it may have missed the state above.
    const resend: NodeJS.Timeout = setTimeout(() => {
      this.resends.delete(resend);
      if (this.members.get(client.sessionId)?.client === client) client.send("state", this.snapshot());
    }, 250);
    this.resends.add(resend);
  }

  onLeave(client: Seat): void {
    const member = this.members.get(client.sessionId);
    if (!member) return;
    this.members.delete(client.sessionId);
    this.services.presence.setParty(member.accountId, "");
    // The oldest member leads on.
    if (this.leaderSession === client.sessionId) this.leaderSession = this.members.keys().next().value ?? "";
    // A search belongs to the party it started with.
    if (this.order) this.endSearch(true);
    else this.publish();
  }

  onDispose(): void {
    clearInterval(this.authTimer);
    clearTimeout(this.searchTimer);
    for (const resend of this.resends) clearTimeout(resend);
    this.services.squads.remove(this.roomId);
  }

  hasAccount(accountId: string, exceptSessionId = ""): boolean {
    return [...this.members.values()].some(
      member => member.sessionId !== exceptSessionId && member.accountId === accountId,
    );
  }

  revokeAccount(accountId: string): void {
    for (const member of this.members.values()) if (member.accountId === accountId) member.client.leave(4001);
  }

  /** A moderator removes the account from the party and bars it from coming back; false when it is not a member. */
  removeAccount(accountId: string, message: string): boolean {
    const member = [...this.members.values()].find(candidate => candidate.accountId === accountId);
    if (!member) return false;
    this.kickedAccounts.add(accountId);
    member.client.send("notice", message);
    member.client.leave(4003);
    return true;
  }

  /** The account in the seat with this session id, or "". */
  accountOf(sessionId: string): string {
    return this.members.get(sessionId)?.accountId ?? "";
  }

  /** Like removeAccount, for the seat with this session id. */
  removeSession(sessionId: string, message: string): boolean {
    const member = this.members.get(sessionId);
    return !!member && this.removeAccount(member.accountId, message);
  }

  /** Sends every member a `notice`; returns how many it reached. */
  notify(message: string): number {
    this.broadcast("notice", message);
    return this.clients.length;
  }

  summary(): SquadSummary {
    return {
      roomId: this.roomId,
      status: this.order ? "searching" : "idle",
      size: this.members.size,
      maxMembers: this.maxMembers,
      leaderName: this.members.get(this.leaderSession)?.name || "",
      members: [...this.members.values()].map(member => ({ accountId: member.accountId, name: member.name })),
    };
  }

  /** Most members the party takes: the matchmaking catalog's party size. */
  get maxMembers(): number {
    return this.maxClients;
  }

  /** Members in the party (a player who is joining counts once seated). */
  get size(): number {
    return this.members.size;
  }

  get searching(): boolean {
    return this.order !== null;
  }

  /** The order of the running search with this party id, for a member of the party. */
  orderFor(partyId: string, accountId: string): SearchOrder | undefined {
    return this.order?.partyId === partyId && this.hasAccount(accountId) ? this.order : undefined;
  }

  private snapshot(): SquadState {
    return {
      id: this.roomId,
      leaderId: this.leaderSession,
      status: this.order ? "searching" : "idle",
      members: [...this.members.values()].map(({ client: _client, ...member }) => member),
      search: this.order,
    };
  }

  private publish(): void {
    this.broadcast("state", this.snapshot());
  }

  /** Re-reads a member's equipped character, level and name. */
  private async refresh(sessionId: string): Promise<void> {
    const { collection, accounts } = this.services;
    const member = this.members.get(sessionId);
    if (!member) return;
    const profile = await accounts.profile(member.accountId);
    const characterId = (await collection.state(member.accountId)).equipped;
    // The member may have left while the data was read.
    if (!profile || this.members.get(sessionId) !== member) return;
    member.characterId = characterId;
    member.level = profile.level;
    member.name = cleanText(profile.displayName).slice(0, 20) || member.name;
    this.publish();
  }

  /** The leader's PLAY: checks everything a public search would, then orders every member to search. */
  private async play(client: Client, payload: unknown): Promise<void> {
    if (client.sessionId !== this.leaderSession || this.order) return;
    let order: SearchOrder;
    try {
      order = await this.buildOrder(payload);
    } catch (error) {
      client.send("notice", error instanceof ServerError ? error.message : "The party cannot search right now.");
      return;
    }
    // The checks took a moment: a second PLAY, a new leader or a changed party make this order stale.
    if (this.order || client.sessionId !== this.leaderSession || order.size !== this.members.size) return;
    this.order = order;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.order && this.endSearch(true), this.services.searchSeconds * 1000);
    this.publish();
    this.broadcast("search", this.order);
  }

  private async buildOrder(payload: unknown): Promise<SearchOrder> {
    const { matchmaking, events, matches, accounts } = this.services;
    const request = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 64) : "");
    // A party searches a public queue like any player; there is no private match for it to order.
    const queue = matchmaking.queue(text(request.queue), text(request.mode));
    if (!queue) throw new ServerError(400, "Unknown matchmaking queue.");
    const size = this.members.size;
    if (size > queue.players.max) throw new ServerError(409, "This queue has fewer seats than the party has players.");
    for (const member of this.members.values()) {
      if (matches.hasAccount(member.accountId) || matchmaking.isSearching(member.accountId))
        throw new ServerError(409, member.name + " is already in a match or searching.");
      // Levels change with every match; the event's minimum is checked against the current one.
      const profile = await accounts.profile(member.accountId);
      if (profile) member.level = profile.level;
    }
    const eventId = text(request.eventId);
    let playlist: unknown = request.playlist;
    let courseId: unknown = request.courseId;
    if (eventId) {
      if (!events) throw new ServerError(404, "Unknown event.");
      // Every member must qualify, not only the leader.
      let admission = events.resolve(eventId, queue.id);
      for (const member of this.members.values()) admission = events.admit(eventId, queue.id, member.level);
      ({ playlist, courseId } = admission);
    }
    const target = matchmaking.target(queue, queue.mode, playlist, courseId, eventId);
    return {
      partyId: this.roomId + ":" + ++this.searches,
      size,
      queue: queue.id,
      mode: queue.mode,
      playlist: target.playlist,
      courseId: target.courseId,
      eventId,
    };
  }

  /** Ends the running search. A cancelled one tells every member to stop searching. */
  private endSearch(cancelled: boolean): void {
    clearTimeout(this.searchTimer);
    this.order = null;
    this.publish();
    if (cancelled) this.broadcast("cancelled");
  }

  /** Once every few seconds, members must still hold a valid session. */
  private async checkSessions(): Promise<void> {
    if (this.checking || !this.members.size) return;
    this.checking = true;
    try {
      const members = [...this.members.values()];
      const sessions = await this.services.accounts.authenticateBatch(members.map(member => member.client.auth?.token));
      for (const member of members) {
        if (sessions.get(member.client.auth?.token) !== member.accountId) member.client.leave(4001);
      }
    } catch {
      // The database is unavailable; the next check tries again.
    } finally {
      this.checking = false;
    }
  }
}

/** The room class registered with the matchmaker, bound to this server's services. */
export function createSquadRoom(services: SquadServices): typeof SquadRoom {
  return class ConfiguredSquadRoom extends SquadRoom {
    protected services = services;
  };
}
