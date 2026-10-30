// Shape of game_config/party-matchmaking.json, the rules the developer sets for finding matches. The C# twin used
// offline is Assets/CasualPartyMultiplayer/Core/Backend/MatchmakingCatalog.cs.

export interface PlayerLimits {
  /** Humans that form a match at once, without waiting for the search timer. */
  min: number;
  /** Seats in the match, humans and bots. */
  max: number;
}

export interface SearchPolicy {
  /** How long the oldest player of a forming group waits before the group may start below the minimum. */
  seconds: number;
  /** Once the search time is up, start with whoever was found (bots fill the rest) instead of waiting on. */
  startShort: boolean;
}

export interface BotPolicy {
  /** Fill the empty seats with bots when the match starts. */
  fill: boolean;
  /** Most bots in one match; -1 means no limit. */
  max: number;
}

export interface LobbyPolicy {
  /** Seconds the lobby runs before the match starts on its own; 0 leaves the start to the other two rules. */
  seconds: number;
  /** Start as soon as every human in the lobby is ready. */
  readyCheck: boolean;
  /** Start as soon as every seat holds a human. */
  startWhenFull: boolean;
  /** The host may start early with a Start button, with the empty seats taken by bots or not (created rooms). */
  hostStart?: boolean;
}

export interface BackfillPolicy {
  /** Searching players may join lobbies of this queue that are still filling. */
  enabled: boolean;
  /** A lobby with a timer only takes players while at least this many seconds remain. */
  minLobbySeconds: number;
}

export interface SkillRuleSettings {
  /** false switches the rule off; absent means on, so hand-written catalogs keep working. */
  enabled?: boolean;
  /** What skill is measured by: the account level or its total wins. Guests count as level 1 with 0 wins. */
  metric: "level" | "wins";
  /** Largest skill gap allowed at once. */
  range: number;
  /** How much the allowed gap grows per second of waiting. */
  widenPerSecond: number;
  /** The gap never grows beyond this. */
  maxRange: number;
}

export interface RegionRuleSettings {
  /** false switches the rule off; absent means on, so hand-written catalogs keep working. */
  enabled?: boolean;
  /** Players of different regions may meet after this many seconds of waiting; -1 keeps regions apart. */
  relaxSeconds: number;
}

export interface AccountRuleSettings {
  /** false switches the rule off; absent means on, so hand-written catalogs keep working. */
  enabled?: boolean;
  /** Only signed-in players may search this queue. */
  required: boolean;
}

/** Optional rules of a queue. Each one present in the catalog is built by matchmaking.rules.ts. */
export interface RuleSettings {
  skill?: SkillRuleSettings;
  region?: RegionRuleSettings;
  account?: AccountRuleSettings;
}

export interface QueueDefinition {
  id: string;
  /** Game mode played by the matches of this queue. */
  mode: string;
  players: PlayerLimits;
  search: SearchPolicy;
  bots: BotPolicy;
  lobby: LobbyPolicy;
  backfill: BackfillPolicy;
  rules: RuleSettings;
}

export interface PrivateRoomPolicy {
  /**
   * Rooms created by players show in the room list (GET /api/rooms) while their lobby is open and has a free seat, so
   * other players can join them from there. false keeps them join-by-code only. Absent means true.
   */
  listed?: boolean;
  players: PlayerLimits;
  bots: BotPolicy;
  lobby: LobbyPolicy;
}

/** Parties (squads gathered in the menu before they search together). */
export interface PartyPolicy {
  /** Most players in one party, 1 to 16; 1 means nobody can be invited. */
  maxMembers: number;
}

/** Party size when the catalog has no "parties" section. */
export const DEFAULT_PARTY_MEMBERS = 4;

export interface MatchmakingCatalog {
  version: 1;
  queues: QueueDefinition[];
  privateRooms: PrivateRoomPolicy;
  /** Optional; validateMatchmakingCatalog fills in { maxMembers: 4 } when it is absent. */
  parties?: PartyPolicy;
}

/** One player waiting in a queue. */
export interface Ticket {
  /** Session id in the queue room; the match seat is reserved under the same id. */
  id: string;
  /** Empty for guests. */
  accountId: string;
  /** The queue plus the playlist or course the match is played on; only tickets of one partition meet. */
  partition: string;
  playlist: string;
  courseId: string;
  /** Set when the player searches for a timed event; the partition already keeps event players together. */
  eventId?: string;
  /**
   * The party this player searches with ("" or absent for a solo search) and how many players it has. The tickets of
   * one party are a unit for the queue: placed together, and only once all of them have arrived.
   */
  party?: string;
  partySize?: number;
  skill: number;
  region: string;
  /** Milliseconds, on the clock the queue is driven with. */
  enqueuedAt: number;
}
