// The messages of the squad room (a party gathered in the menu). Its Unity twin is Core/Community/SquadClient.cs.

/** One player of the party as every member sees it. */
export interface SquadMemberState {
  sessionId: string;
  accountId: string;
  name: string;
  /** The character the account has equipped. */
  characterId: string;
  level: number;
  ready: boolean;
}

/**
 * What the leader's PLAY orders every member to search for: the queue, the playlist or course, an optional event, and
 * the party id and size the matchmaking queue keeps the members together with.
 */
export interface SearchOrder {
  /** `<squad room id>:<counter>`: unique for each search the party starts. */
  partyId: string;
  size: number;
  queue: string;
  mode: string;
  playlist: string;
  courseId: string;
  eventId: string;
}

/** Sent to every member as the "state" message after each change. `leaderId` is the leader's session id. */
export interface SquadState {
  id: string;
  leaderId: string;
  status: "idle" | "searching";
  members: SquadMemberState[];
  search: SearchOrder | null;
}

/** What the matchmaking rooms ask of the parties: the order a member's search must follow. */
export interface SquadDirectory {
  /** The order of the party's running search, if the account is one of its members. */
  searchOrder(partyId: string, accountId: string): SearchOrder | undefined;
}
