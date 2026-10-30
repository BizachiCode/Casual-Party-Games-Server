import type { OpenLobby } from "../matchmaking/matchmaking.queue.js";
import type { BackfillPolicy } from "../matchmaking/matchmaking.types.js";
import type { PartyRoom } from "./party.room.js";

export interface LobbyListing {
  id: string;
  hostName: string;
  mode: string;
  playlist: string;
  players: number;
  capacity: number;
}

/**
 * The live match rooms of this process. Friends and invitations, the account seat rule (one match per account) and
 * the service metrics read it.
 */
export class MatchRegistry {
  private readonly rooms = new Map<string, PartyRoom>();

  add(room: PartyRoom): void {
    this.rooms.set(room.roomId, room);
  }
  remove(roomId: string): void {
    this.rooms.delete(roomId);
  }
  get(roomId: unknown): PartyRoom | undefined {
    return typeof roomId === "string" ? this.rooms.get(roomId) : undefined;
  }
  all(): PartyRoom[] {
    return [...this.rooms.values()];
  }

  /**
   * Lobbies that still take players, for the room list: public ones and, with `includeCreated`, the rooms players
   * created (the catalog's privateRooms.listed). Event lobbies are joined through their queue.
   */
  publicLobbies(includeCreated = false): LobbyListing[] {
    return this.all()
      .filter(
        room =>
          room.clients.length > 0 &&
          (includeCreated || !room.privateRoom) &&
          !room.eventId &&
          room.simulation.phase === "lobby" &&
          room.humanCount < room.maxClients,
      )
      .map(room => ({
        id: room.roomId,
        hostName: room.simulation.players.find(runner => runner.id === room.simulation.hostId)?.name || "",
        mode: room.simulation.rules.mode,
        playlist: room.simulation.rules.playlist,
        players: room.humanCount,
        capacity: room.maxClients,
      }));
  }

  /**
   * Lobbies of a matchmaking queue that can still take a searching player: public, unlocked, not full and, when the
   * lobby runs a timer, with enough of it left for the player to arrive.
   */
  openLobbies(queue: string, backfill: BackfillPolicy): OpenLobby[] {
    return this.all()
      .filter(
        room =>
          room.queue === queue &&
          !room.privateRoom &&
          !room.locked &&
          room.simulation.phase === "lobby" &&
          !room.hasReachedMaxClients() &&
          (room.simulation.lobby.lobbySeconds === 0 || room.simulation.remaining >= backfill.minLobbySeconds),
      )
      .map(room => ({
        roomId: room.roomId,
        partition: room.partition,
        free: room.maxClients - room.humanCount,
        members: room.members,
      }))
      .filter(lobby => lobby.free > 0);
  }

  /** Whether the account holds a seat in any room (connected or reserved for reconnection). */
  hasAccount(accountId: string, exceptSessionId = ""): boolean {
    return this.all().some(room => room.hasAccount(accountId, exceptSessionId));
  }

  /** Ends every seat of the account (logout, expired session). */
  revokeAccount(accountId: string): void {
    for (const room of this.all()) room.revokeAccount(accountId);
  }

  /** A moderator removes the account from every match, telling it why; returns the seats removed. */
  removeAccount(accountId: string, message: string): number {
    return this.all().filter(room => room.removeAccount(accountId, message)).length;
  }

  /** Sends the account's seats a notice; returns how many it reached. */
  noticeAccount(accountId: string, message: string): number {
    return this.all().reduce((sum, room) => sum + room.notifyAccount(accountId, message), 0);
  }
}
