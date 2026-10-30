import type { PartyConfig } from "../content/content.types.js";
import { matchRules, usesCourse, type MatchOptions } from "../match/simulation/course-rules.js";
import {
  DEFAULT_PARTY_MEMBERS,
  type BotPolicy,
  type LobbyPolicy,
  type MatchmakingCatalog,
  type QueueDefinition,
} from "./matchmaking.types.js";

/** Where a match is played: the queue plus the playlist or course, in canonical form. */
export interface MatchTarget {
  partition: string;
  playlist: string;
  courseId: string;
}

/** Everything a match room needs to start: its size and the simulation options, rules included. */
export interface MatchPlan {
  /** The queue the match belongs to; empty for private rooms. */
  queue: string;
  /** The timed event the match is played for; empty for ordinary matches and private rooms. */
  eventId: string;
  partition: string;
  matchSize: number;
  options: MatchOptions;
}

/** What a client may ask for when it creates a room or searches. Only ids; the rules come from the catalog. */
export interface MatchRequest {
  queue?: string;
  mode?: string;
  playlist?: string;
  courseId?: string;
  matchSize?: number;
  /**
   * A timed event. Only the code that checked the event (events.resolve) may pass it on: the plan trusts it and keeps
   * event players apart from everyone else.
   */
  eventId?: string;
}

function lobbyOptions(lobby: LobbyPolicy, bots: BotPolicy, minPlayers: number): MatchOptions {
  return {
    minPlayers,
    fillBots: bots.fill,
    maxBots: bots.max,
    readyCheck: lobby.readyCheck,
    lobbySeconds: lobby.seconds,
    startWhenFull: lobby.startWhenFull,
    hostStart: lobby.hostStart ?? false,
  };
}

/**
 * The developer's matchmaking rules (party-matchmaking.json) and the accounts currently searching. Match rooms ask it
 * for their plan, so a room never takes its size or lobby rules from the client.
 */
export class MatchmakingService {
  private readonly searching = new Set<string>();

  constructor(
    readonly catalog: MatchmakingCatalog,
    private readonly config: PartyConfig,
  ) {}

  /** Most players in one party (the catalog's "parties" section). */
  get maxPartyMembers(): number {
    return this.catalog.parties?.maxMembers ?? DEFAULT_PARTY_MEMBERS;
  }

  /** Whether rooms created by players show in the room list (the catalog's privateRooms.listed, on when absent). */
  get listsCreatedRooms(): boolean {
    return this.catalog.privateRooms.listed ?? true;
  }

  /** The queue with this id, else the first queue of the mode. */
  queue(id?: unknown, mode?: unknown): QueueDefinition | undefined {
    return this.catalog.queues.find(queue => queue.id === id) ?? this.catalog.queues.find(queue => queue.mode === mode);
  }

  /**
   * The canonical playlist and course for a mode, so equal choices always share a partition. The matches of an event
   * get a partition of their own, so event players only meet each other.
   */
  target(
    queue: QueueDefinition | undefined,
    mode: string,
    playlist?: unknown,
    courseId?: unknown,
    eventId = "",
  ): MatchTarget {
    const playlistId = this.config.playlists.some(candidate => candidate.id === playlist)
      ? (playlist as string)
      : this.config.playlists[0].id;
    const rules = matchRules(this.config, {
      mode,
      playlist: playlistId,
      courseId: typeof courseId === "string" ? courseId : "",
    });
    // A course the player chose stays; otherwise the room draws one, so the partition does not name it.
    const drawn = usesCourse(mode) ? this.config.courses[rules.indices[0]].id : "";
    const course = drawn === courseId ? drawn : "";
    const chosenPlaylist = usesCourse(mode) ? this.config.playlists[0].id : playlistId;
    return {
      partition: [queue?.id ?? "private", chosenPlaylist, course].join(":") + (eventId ? ":event:" + eventId : ""),
      playlist: chosenPlaylist,
      courseId: course,
    };
  }

  /** A public match: the queue's size and lobby rules. Without a known queue, the first queue of the mode. */
  publicPlan(request: MatchRequest): MatchPlan {
    const queue = this.queue(request.queue, request.mode) ?? this.catalog.queues[0];
    const eventId = typeof request.eventId === "string" ? request.eventId : "";
    const target = this.target(queue, queue.mode, request.playlist, request.courseId, eventId);
    return {
      queue: queue.id,
      eventId,
      partition: target.partition,
      matchSize: queue.players.max,
      // Matchmaking already gathered the players, so a matched lobby starts on its own rules with whoever is in.
      options: {
        mode: queue.mode,
        playlist: target.playlist,
        courseId: target.courseId,
        ...lobbyOptions(queue.lobby, queue.bots, 1),
      },
    };
  }

  /** A private room: the mode and size the host chose, within the private room rules. */
  privatePlan(request: MatchRequest): MatchPlan {
    const policy = this.catalog.privateRooms;
    const mode = this.config.modes.some(candidate => candidate.id === request.mode)
      ? (request.mode as string)
      : this.config.modes[0].id;
    const target = this.target(undefined, mode, request.playlist, request.courseId);
    const size = Number.isInteger(request.matchSize) ? request.matchSize : policy.players.max;
    return {
      queue: "",
      eventId: "",
      partition: target.partition,
      matchSize: Math.max(1, Math.min(policy.players.max, size)),
      options: {
        mode,
        playlist: target.playlist,
        courseId: target.courseId,
        ...lobbyOptions(policy.lobby, policy.bots, policy.players.min),
      },
    };
  }

  /** Marks the account as searching; false when it already is (one search per account). */
  beginSearch(accountId: string): boolean {
    if (!accountId) return true;
    if (this.searching.has(accountId)) return false;
    this.searching.add(accountId);
    return true;
  }

  endSearch(accountId: string): void {
    this.searching.delete(accountId);
  }

  /** How many accounts are searching now. */
  get searchingCount(): number {
    return this.searching.size;
  }

  isSearching(accountId: string): boolean {
    return this.searching.has(accountId);
  }
}
