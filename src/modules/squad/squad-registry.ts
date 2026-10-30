import type { SquadRoom } from "./squad.room.js";
import type { SearchOrder, SquadDirectory } from "./squad.types.js";

/**
 * The live squad rooms of this process. Invitations, the one-party-per-account rule, logout and the matchmaking queues
 * (which check a party's search order here) read it.
 */
export class SquadRegistry implements SquadDirectory {
  private readonly rooms = new Map<string, SquadRoom>();

  add(room: SquadRoom): void {
    this.rooms.set(room.roomId, room);
  }
  remove(roomId: string): void {
    this.rooms.delete(roomId);
  }
  get(roomId: unknown): SquadRoom | undefined {
    return typeof roomId === "string" ? this.rooms.get(roomId) : undefined;
  }
  all(): SquadRoom[] {
    return [...this.rooms.values()];
  }

  /** Whether the account sits in any party (a seat on hold is not kept: leaving a party is final). */
  hasAccount(accountId: string, exceptSessionId = ""): boolean {
    return this.all().some(room => room.hasAccount(accountId, exceptSessionId));
  }

  /** Removes the account from its party (logout, expired session). */
  revokeAccount(accountId: string): void {
    for (const room of this.all()) room.revokeAccount(accountId);
  }

  /** A moderator removes the account from its party, telling it why; returns the seats removed. */
  removeAccount(accountId: string, message: string): number {
    return this.all().filter(room => room.removeAccount(accountId, message)).length;
  }

  searchOrder(partyId: string, accountId: string): SearchOrder | undefined {
    // A party id is `<room id>:<counter>`, so the room is found without scanning.
    return this.get(partyId.split(":")[0])?.orderFor(partyId, accountId);
  }
}
