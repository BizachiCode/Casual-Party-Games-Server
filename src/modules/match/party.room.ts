import { randomInt } from "node:crypto";
import { Room, ServerError, type Client } from "colyseus";
import type { RedisCoordination } from "../../infrastructure/redis/coordination.js";
import type { AccountService, Profile } from "../account/account.service.js";
import type { CollectionService } from "../collection/collection.service.js";
import type { EventGate } from "../events/events.service.js";
import type { MatchmakingService, MatchRequest } from "../matchmaking/matchmaking.service.js";
import type { ChatLog } from "../moderation/chat-log.js";
import { muteNotice, type ModerationService } from "../moderation/moderation.service.js";
import type { Ticket } from "../matchmaking/matchmaking.types.js";
import type { PartyConfig } from "../content/content.types.js";
import type { OperationsService } from "../operations/operations.service.js";
import type { PresenceService } from "../presence/presence.service.js";
import type { SocialService } from "../social/social.service.js";
import type { MatchRegistry } from "./match-registry.js";
import type { MatchRewardService } from "./match-rewards.service.js";
import { PartySimulation, type PlayerInput } from "./simulation/party-simulation.js";
import { partyTeam } from "./team-placement.js";
import { cleanText } from "../../shared/text.js";
import { MatchWire, updateWire } from "./wire/match-wire.js";

/** What a seat carries after onAuth: the account (with its token, re-checked every second) or an empty guest id. */
export type SeatAuth =
  (Profile & { token: string }) | { id: ""; token?: undefined; displayName?: undefined; color?: undefined };
type Seat = Client & { auth?: SeatAuth };

/** A match room as the GM console lists it. */
export interface MatchRoomSummary {
  roomId: string;
  kind: "public" | "private";
  queue: string;
  eventId: string;
  mode: string;
  playlist: string;
  phase: string;
  round: number;
  /** Seconds left in the lobby or round timer. */
  remaining: number;
  locked: boolean;
  humans: number;
  bots: number;
  maxClients: number;
  hostName: string;
  /** Milliseconds since the epoch. */
  openedAt: number;
}

/** One runner of a match as the GM console shows it. */
export interface LivePlayer {
  sessionId: string;
  name: string;
  /** Empty for a player without an account and for bots. */
  accountId: string;
  bot: boolean;
  /** False for a seat held for reconnection. */
  connected: boolean;
  ready: boolean;
  status: string;
  team: number;
  score: number;
  totalScore: number;
  finishTime: number;
  characterId: string;
  host: boolean;
}
interface Suspended {
  client: Seat;
  reservation: ReturnType<Room["allowReconnection"]>;
}

/** Close codes that mean the connection was lost rather than closed on purpose; only these keep the seat. */
const TRANSPORT_LOSS = [1001, 1005, 1006, 4010];
/** The room closes this way once a finished match has been stored and shown: the client goes back to the menu. */
export const MATCH_OVER = 4005;

export interface MatchServices {
  config: PartyConfig;
  accounts: AccountService;
  social: SocialService;
  presence: PresenceService;
  collection: CollectionService;
  rewards: MatchRewardService;
  operations: OperationsService;
  registry: MatchRegistry;
  matchmaking: MatchmakingService;
  /** Timed events; without it, rooms for an event are refused. */
  events?: EventGate;
  redis?: RedisCoordination;
  /** Chat mutes; without it nobody is muted. */
  moderation?: ModerationService;
  /** Where delivered chat is recorded for the GM console and reports. */
  chatLog?: ChatLog;
}

export interface PartyRoomOptions {
  /** Matchmaking queue of a public match; the room takes its size and lobby rules from it. */
  queue?: string;
  protocol?: number;
  revision?: string;
  sessionToken?: string;
  name?: string;
  color?: number;
  matchSize?: number;
  mode?: string;
  playlist?: string;
  courseId?: string;
  /** A timed event (public rooms only): the room then plays the event's playlist or course and counts toward it. */
  eventId?: string;
}

/**
 * One match: a lobby that fills with players (and bots), then rounds of courses until a winner. The PartySimulation is
 * the authority; this room only admits players, relays their input and publishes the state every tick.
 *
 * Messages from the client: input, ready, setReady, emote, team, kick and start (host, lobby only), chat, sync.
 * Messages to the client: notice, chat, presence (reconnecting players), reconnectWindow, identity.
 *
 * A lost connection holds the seat for `room.reconnectSeconds` while the runner can still play: never once it is
 * eliminated or the match is over, and a held seat ends as soon as that happens. Colyseus disposes of the room once no
 * player is connected and no seat is held, bots or not; a finished match closes `room.closeAfterFinishSeconds` after
 * its results are stored (close code MATCH_OVER).
 */
export class PartyRoom extends Room<{ state: MatchWire }> {
  /** Provided by createPartyRoom(). */
  protected services: MatchServices;
  simulation: PartySimulation;
  privateRoom = false;
  /** Matchmaking queue and partition of a public match, and the tickets placed in it (for backfill). */
  queue = "";
  partition = "";
  /** The timed event this public match counts toward; empty for ordinary matches. */
  eventId = "";
  readonly members: Ticket[] = [];
  /** When the room was created (milliseconds since the epoch). */
  openedAt = 0;
  /** Players whose connection dropped, holding their seat until they reconnect or the window ends. */
  readonly suspended = new Map<string, Suspended>();
  private readonly chatTicks = new Map<string, number>();
  /** session id -> account id of every signed-in player; the results are paid to these accounts. */
  readonly accounts = new Map<string, string>();
  /** True once the finished match has been settled (rankings, Stars, goals, season). */
  recorded = false;
  private readonly kickedAccounts = new Set<string>();
  private recording = false;
  private closing = false;
  private authChecking = false;
  private rewardWrite?: Promise<void>;
  private authWrite?: Promise<void>;

  onCreate(options: PartyRoomOptions): void {
    const { config, operations, registry, matchmaking } = this.services;
    operations.requireAdmission();
    this.openedAt = Date.now();
    this.privateRoom = this.roomName === "party_private";
    this.setPrivate(this.privateRoom);
    this.maxMessagesPerSecond = 65;
    // Size and lobby rules come from the developer's matchmaking catalog, never from the client.
    const plan = this.privateRoom ? matchmaking.privatePlan(options) : matchmaking.publicPlan(this.request(options));
    this.queue = plan.queue;
    this.eventId = plan.eventId;
    this.partition = plan.partition;
    this.simulation = new PartySimulation(config, plan.matchSize, { ...plan.options, seed: randomInt(1, 2147483647) });
    this.maxClients = this.simulation.matchSize;
    this.setState(new MatchWire());
    // Publish every tick: clients interpolate between patches, so the patch rate sets the visual fidelity.
    this.setPatchRate(1000 / config.tickRate);
    updateWire(this.state, this.simulation.snapshot());
    registry.add(this);
    this.registerMessages();
    // A fixed step with catch-up: a late timer (Windows timers tick every ~15.6 ms) never slows the match down.
    this.setFixedTimestep(() => this.tickOnce(), config.tickRate);
  }

  /**
   * What a public room is built from. An event room is played on the event's queue, playlist and course, whatever the
   * creator asked for, and only while the event runs; private rooms ignore event ids.
   */
  private request(options: PartyRoomOptions): MatchRequest {
    const { events } = this.services;
    if (options.eventId === undefined || options.eventId === "") return { ...options, eventId: undefined };
    if (!events) throw new ServerError(404, "Unknown event.");
    const play = events.resolve(options.eventId, options.queue);
    return { ...options, queue: play.queue, playlist: play.playlist, courseId: play.courseId, eventId: play.eventId };
  }

  private registerMessages(): void {
    const { config } = this.services;
    this.onMessage("input", (client, input: PlayerInput) => this.simulation.input(client.sessionId, input));
    this.onMessage("ready", client => this.simulation.ready(client.sessionId));
    this.onMessage("setReady", (client, value: unknown) => {
      if (typeof value === "boolean") this.simulation.ready(client.sessionId, value);
    });
    this.onMessage("emote", (client, value: unknown) => this.simulation.emote(client.sessionId, value));
    this.onMessage("team", (client, value: number) => {
      if (!this.simulation.selectTeam(client.sessionId, value)) client.send("notice", "Team unavailable or full.");
    });
    this.onMessage("kick", (client: Seat, id: unknown) => {
      if (this.simulation.phase !== "lobby" || this.simulation.hostId !== client.sessionId || id === client.sessionId)
        return;
      const pending = this.suspended.get(id as string);
      const target: Seat = this.clients.find(seat => seat.sessionId === id) || pending?.client;
      if (target?.auth?.id) this.kickedAccounts.add(target.auth.id);
      if (pending) pending.reservation.reject(new Error("Removed from lobby."));
      else target?.leave(4003);
    });
    // The host of a created room starts it early, with bots in the empty seats or not (the simulation checks it).
    this.onMessage("start", (client, fillBots: unknown) => {
      this.simulation.hostStart(client.sessionId, fillBots === true);
    });
    this.onMessage("chat", async (client: Seat, text: unknown) => {
      if (
        typeof text !== "string" ||
        this.simulation.tick - (this.chatTicks.get(client.sessionId) ?? -100) < config.tickRate
      )
        return;
      const line = cleanText(text).trim().slice(0, 140);
      if (!line) return;
      this.chatTicks.set(client.sessionId, this.simulation.tick);
      const sender = this.simulation.players.find(runner => runner.id === client.sessionId);
      if (!sender) return;
      const mute = client.auth?.id ? await this.services.moderation?.activeMute(client.auth.id) : null;
      if (mute) {
        client.send("notice", muteNotice(mute));
        return;
      }
      this.services.chatLog?.add({
        at: Date.now(),
        roomId: this.roomId,
        sessionId: client.sessionId,
        accountId: client.auth?.id ?? "",
        name: sender.name,
        text: line,
      });
      const json = JSON.stringify({ senderId: client.sessionId, senderName: sender.name, text: line });
      for (const recipient of this.clients as Seat[]) {
        if (
          !client.auth?.id ||
          !recipient.auth?.id ||
          !(await this.services.social.blocked(client.auth.id, recipient.auth.id))
        )
          recipient.send("chat", json);
      }
    });
    // A (re)connected client asks for its identity, the seats on hold and a full state.
    this.onMessage("sync", client => {
      client.send("reconnectWindow", this.services.config.room.reconnectSeconds);
      client.send("presence", [...this.suspended.keys()]);
      client.send("identity", client.sessionId);
      updateWire(this.state, this.simulation.snapshot());
      (this as unknown as { sendFullState(client: Client): void }).sendFullState(client);
    });
    this.onMessage("*", () => {}); // Unknown commands confer no authority.
  }

  private tickOnce(): void {
    const { config } = this.services;
    const wasLobby = this.simulation.phase === "lobby";
    this.simulation.step();
    if (wasLobby && this.simulation.phase !== "lobby") this.lock();
    this.releaseLostSeats();
    // Once per second, signed-in players must still hold a valid session and their account seat.
    if (this.simulation.tick % config.tickRate === 0 && !this.authChecking) {
      this.authChecking = true;
      this.authWrite = this.checkAccounts()
        .catch(() => {})
        .finally(() => {
          this.authChecking = false;
        });
    }
    if (this.simulation.phase === "finished" && !this.recorded && !this.recording) {
      this.recording = true;
      this.rewardWrite = this.services.rewards
        .complete(this.roomId, this.simulation.snapshot(), new Map(this.accounts), this.eventId)
        .then(() => {
          this.recorded = true;
        })
        .catch(() => {
          this.services.operations.setMaintenance(true, "Results storage unavailable.");
        })
        .finally(() => {
          this.recording = false;
        });
    }
    if (this.recorded && !this.closing) {
      this.closing = true;
      this.clock.setTimeout(() => {
        this.disconnect(MATCH_OVER).catch(() => {});
      }, config.room.closeAfterFinishSeconds * 1000);
    }
    updateWire(this.state, this.simulation.snapshot());
  }

  /** Whether the session's runner can still play: in the match, not eliminated, and the match not over. */
  private canResume(sessionId: string): boolean {
    const runner = this.simulation.players.find(player => player.id === sessionId);
    return !!runner && runner.status !== "eliminated" && this.simulation.phase !== "finished";
  }

  /** Ends the held seats whose runners were eliminated, or every one once the match is over. */
  private releaseLostSeats(): void {
    for (const [sessionId, pending] of this.suspended) {
      if (this.canResume(sessionId)) continue;
      this.suspended.delete(sessionId);
      pending.reservation.reject(new Error("The match is over for this player."));
    }
  }

  private async checkAccounts(): Promise<void> {
    const { accounts, redis, presence } = this.services;
    const sessions = await accounts.authenticateBatch(this.seats().map(seat => seat.auth?.token));
    for (const client of this.clients as Seat[]) {
      if (!client.auth?.id) continue;
      if (sessions.get(client.auth.token) !== client.auth.id) {
        client.leave(4001);
        continue;
      }
      if (redis && !(await redis.renew(client.auth.id, this.roomId + ":" + client.sessionId))) {
        client.leave(4001);
        continue;
      }
      presence.touch(client.auth.id, this.roomId);
    }
    for (const pending of this.suspended.values()) {
      if (pending.client.auth?.id && sessions.get(pending.client.auth.token) !== pending.client.auth.id)
        pending.reservation.reject(new Error("Session ended."));
    }
  }

  async onAuth(_client: Client, options: PartyRoomOptions): Promise<SeatAuth> {
    const { config, operations, accounts, registry, social, events } = this.services;
    operations.requireAdmission();
    if (options.protocol !== config.protocol || options.revision !== config.revision)
      throw new ServerError(400, "Client/course version mismatch. Update the client and server together.");
    // Seats from the matchmaking queue skip onAuth; whoever joins an event room directly must ask for the event and
    // qualify for it too.
    if (this.eventId && options.eventId !== this.eventId) throw new ServerError(403, "This is an event match.");
    if (!options.sessionToken) {
      if (this.eventId) events?.admit(this.eventId, this.queue, 1);
      return { id: "" };
    }
    const profile = await accounts.authenticate(options.sessionToken);
    if (!profile) throw new ServerError(401, "Session expired. Sign in again.");
    if (this.eventId) events?.admit(this.eventId, this.queue, profile.level);
    if (this.kickedAccounts.has(profile.id)) throw new ServerError(403, "Removed from this lobby.");
    if (registry.hasAccount(profile.id)) throw new ServerError(409, "Account already in a match.");
    for (const seat of this.seats()) {
      if (seat.auth?.id && (await social.blocked(profile.id, seat.auth.id)))
        throw new ServerError(403, "Lobby unavailable.");
    }
    return { ...profile, token: options.sessionToken };
  }

  async onJoin(client: Seat, options: PartyRoomOptions): Promise<void> {
    const { operations, registry, redis, collection, presence } = this.services;
    operations.requireAdmission();
    const accountId = client.auth?.id;
    if (accountId && registry.hasAccount(accountId, client.sessionId))
      throw new ServerError(409, "Account already in a match.");
    if (accountId && redis && !(await redis.acquire(accountId, this.roomId + ":" + client.sessionId)))
      throw new ServerError(409, "Account already in a match.");
    if (!this.simulation.addPlayer(client.sessionId, client.auth?.displayName || options.name))
      throw new ServerError(409, "Match already started");
    this.seatWithParty(client.sessionId);
    const player = this.simulation.players.find(runner => runner.id === client.sessionId);
    if (accountId) player.characterId = (await collection.state(accountId)).equipped;
    player.color =
      client.auth?.color ?? (Number.isInteger(options.color) ? Math.max(0, Math.min(7, options.color)) : 0);
    if (accountId) {
      this.accounts.set(client.sessionId, accountId);
      presence.touch(accountId, this.roomId);
    }
  }

  /**
   * In a team mode, puts a player who searched with a party on their party's team (see partyTeam), so the party plays
   * together. The ticket is the one the matchmaking queue recorded for this session. Solo players, bots and private
   * rooms have none and are left to the match, which seats them when it starts.
   */
  private seatWithParty(sessionId: string): void {
    const { teamSize } = this.simulation.rules;
    const ticket = this.members.find(member => member.id === sessionId);
    if (teamSize <= 1 || !ticket?.party) return;
    const seats = this.simulation.players
      .filter(runner => runner.id !== sessionId)
      .map(runner => {
        const placed = this.members.find(member => member.id === runner.id);
        return { team: runner.team, party: placed?.party ?? "", partySize: placed?.partySize ?? 0 };
      });
    const teamCount = Math.ceil(this.simulation.matchSize / teamSize);
    const team = partyTeam(teamSize, teamCount, seats, ticket.party, Math.max(1, ticket.partySize ?? 1));
    if (team) this.simulation.selectTeam(sessionId, team);
  }

  /** Records tickets the matchmaking queue placed here, so backfill keeps the queue's rules with them. */
  addMembers(tickets: Ticket[]): void {
    this.members.push(...tickets);
  }

  /** Connected players plus seats held for reconnection. */
  get humanCount(): number {
    return new Set([...this.clients.map(seat => seat.sessionId), ...this.suspended.keys()]).size;
  }

  private seats(): Seat[] {
    return [...(this.clients as Seat[]), ...[...this.suspended.values()].map(pending => pending.client)];
  }

  hasAccount(accountId: string, exceptSessionId = ""): boolean {
    return this.seats().some(seat => seat.sessionId !== exceptSessionId && seat.auth?.id === accountId);
  }

  revokeAccount(accountId: string): void {
    for (const client of this.clients as Seat[]) if (client.auth?.id === accountId) client.leave(4001);
    for (const pending of this.suspended.values())
      if (pending.client.auth?.id === accountId) pending.reservation.reject(new Error("Session ended."));
  }

  /** Sends the connected players a `notice`; returns how many it reached. */
  notify(message: string): number {
    this.broadcast("notice", message);
    return this.clients.length;
  }

  /** Sends the account's connected seat a `notice`; returns how many seats it reached. */
  notifyAccount(accountId: string, message: string): number {
    const seats = (this.clients as Seat[]).filter(seat => seat.auth?.id === accountId);
    for (const seat of seats) seat.send("notice", message);
    return seats.length;
  }

  /** A moderator removes the session's seat (or its seat on hold) and bars its account from this room. */
  removeSession(sessionId: string, message: string): boolean {
    const pending = this.suspended.get(sessionId);
    const seat: Seat | undefined =
      (this.clients as Seat[]).find(client => client.sessionId === sessionId) || pending?.client;
    if (!seat) return false;
    if (seat.auth?.id) this.kickedAccounts.add(seat.auth.id);
    if (pending) {
      pending.reservation.reject(new Error("Removed by a moderator."));
    } else {
      seat.send("notice", message);
      seat.leave(4003);
    }
    return true;
  }

  /** A moderator removes the account from this room; false when it holds no seat here. */
  removeAccount(accountId: string, message: string): boolean {
    const sessionIds = this.seats()
      .filter(seat => seat.auth?.id === accountId)
      .map(seat => seat.sessionId);
    for (const sessionId of sessionIds) this.removeSession(sessionId, message);
    return sessionIds.length > 0;
  }

  /** A moderator ends the match: everyone is told why, then disconnected. */
  async closeByModerator(message: string): Promise<void> {
    this.broadcast("notice", message);
    await this.disconnect(4003);
  }

  summary(): MatchRoomSummary {
    const { simulation } = this;
    return {
      roomId: this.roomId,
      kind: this.privateRoom ? "private" : "public",
      queue: this.queue,
      eventId: this.eventId,
      mode: simulation.rules.mode,
      playlist: simulation.rules.playlist,
      phase: simulation.phase,
      round: simulation.round,
      remaining: Math.ceil(Math.max(0, simulation.remaining)),
      locked: this.locked,
      humans: this.humanCount,
      bots: simulation.players.filter(runner => runner.bot).length,
      maxClients: this.maxClients,
      hostName: simulation.players.find(runner => runner.id === simulation.hostId)?.name || "",
      openedAt: this.openedAt,
    };
  }

  /** Every runner of the match, bots included. */
  detail(): LivePlayer[] {
    const { simulation } = this;
    return simulation.players.map(runner => ({
      sessionId: runner.id,
      name: runner.name,
      accountId: this.accounts.get(runner.id) || "",
      bot: runner.bot,
      connected: !this.suspended.has(runner.id),
      ready: runner.ready,
      status: runner.status,
      team: runner.team,
      score: runner.score,
      totalScore: runner.totalScore,
      finishTime: runner.finishTime,
      characterId: runner.characterId,
      host: runner.id === simulation.hostId,
    }));
  }

  onDrop(client: Seat, code: number): void {
    // Kicks, logout and an explicit leave are final; only a lost connection reserves the seat, and only while its
    // runner can still play.
    if (!TRANSPORT_LOSS.includes(code) || !this.canResume(client.sessionId)) return;
    this.simulation.releaseInput(client.sessionId);
    this.simulation.ready(client.sessionId, false);
    const reservation = this.allowReconnection(client, this.services.config.room.reconnectSeconds);
    this.suspended.set(client.sessionId, { client, reservation });
    reservation.catch(() => {}); // Colyseus calls onLeave after expiry or rejection.
    this.broadcast("presence", [...this.suspended.keys()]);
  }

  async onReconnect(client: Seat): Promise<void> {
    const { accounts, presence } = this.services;
    const pending = this.suspended.get(client.sessionId);
    if (!pending || !this.canResume(client.sessionId)) throw new ServerError(403, "Seat no longer available.");
    if (
      client.auth?.id &&
      (!(await accounts.authenticate(client.auth.token)) || this.kickedAccounts.has(client.auth.id))
    )
      throw new ServerError(401, "Session ended. Sign in again.");
    this.suspended.delete(client.sessionId);
    this.simulation.releaseInput(client.sessionId);
    if (client.auth?.id) presence.touch(client.auth.id, this.roomId);
    this.broadcast("presence", [...this.suspended.keys()]);
  }

  async onLeave(client: Seat): Promise<void> {
    const { redis, accounts, presence } = this.services;
    if (client.auth?.id && redis)
      await redis.release(client.auth.id, this.roomId + ":" + client.sessionId).catch(() => {});
    this.suspended.delete(client.sessionId);
    this.broadcast("presence", [...this.suspended.keys()]);
    this.simulation.removePlayer(client.sessionId);
    this.chatTicks.delete(client.sessionId);
    this.accounts.delete(client.sessionId);
    if (client.auth?.id && (await accounts.authenticate(client.auth.token))) presence.touch(client.auth.id, "");
  }

  async onDispose(): Promise<void> {
    await Promise.allSettled([this.rewardWrite, this.authWrite].filter(Boolean));
    this.services.registry.remove(this.roomId);
  }
}

/** The room class registered with the matchmaker, bound to this server's services. */
export function createPartyRoom(services: MatchServices): typeof PartyRoom {
  return class ConfiguredPartyRoom extends PartyRoom {
    protected services = services;
  };
}
