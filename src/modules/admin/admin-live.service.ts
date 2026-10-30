import { ApiError } from "../../shared/errors.js";
import type { LivePlayer, MatchRoomSummary } from "../match/party.room.js";
import type { MatchRegistry } from "../match/match-registry.js";
import type { MatchmakingService } from "../matchmaking/matchmaking.service.js";
import type { ChatFilter, ChatLine, ChatLog } from "../moderation/chat-log.js";
import type { ModerationService } from "../moderation/moderation.service.js";
import type { OperationsService } from "../operations/operations.service.js";
import type { SquadRegistry } from "../squad/squad-registry.js";
import type { SquadSummary } from "../squad/squad.room.js";
import type { AdminAudit, AuditActor } from "./admin-audit.service.js";

export type { LivePlayer, MatchRoomSummary, SquadSummary };

export interface AdminLiveDependencies {
  operations: OperationsService;
  matches: MatchRegistry;
  squads: SquadRegistry;
  matchmaking: MatchmakingService;
  chatLog: ChatLog;
  moderation: ModerationService;
  audit: AdminAudit;
}

export interface LiveStatus {
  status: ReturnType<OperationsService["metrics"]>;
  openReports: number;
}
export interface LiveRooms {
  matches: MatchRoomSummary[];
  squads: SquadSummary[];
  totals: { matches: number; humans: number; bots: number; squads: number; partyMembers: number };
}
export type LiveRoomDetail =
  | { kind: "match"; room: MatchRoomSummary; players: LivePlayer[]; chat: ChatLine[] }
  | { kind: "squad"; room: SquadSummary };

const CLOSE_MESSAGE = "This match was closed by a moderator.";
const KICK_MESSAGE = "Removed by a moderator.";

/** Live rooms, notices, room kicks and closes, broadcasts, maintenance and the chat of this process. */
export class AdminLiveService {
  constructor(private readonly deps: AdminLiveDependencies) {}

  async status(): Promise<LiveStatus> {
    return { status: this.deps.operations.metrics(), openReports: await this.deps.moderation.openReports() };
  }

  rooms(): LiveRooms {
    const matches = this.deps.matches.all().map(room => room.summary());
    const squads = this.deps.squads.all().map(room => room.summary());
    return {
      matches,
      squads,
      totals: {
        matches: matches.length,
        humans: matches.reduce((sum, room) => sum + room.humans, 0),
        bots: matches.reduce((sum, room) => sum + room.bots, 0),
        squads: squads.length,
        partyMembers: squads.reduce((sum, room) => sum + room.size, 0),
      },
    };
  }

  room(roomId: string): LiveRoomDetail {
    const match = this.deps.matches.get(roomId);
    if (match) {
      return {
        kind: "match",
        room: match.summary(),
        players: match.detail(),
        chat: this.deps.chatLog.recent({ roomId, limit: 50 }),
      };
    }
    const squad = this.deps.squads.get(roomId);
    if (squad) return { kind: "squad", room: squad.summary() };
    throw new ApiError(404, "Room not found.");
  }

  /** Sends a notice to everyone in the match or party. */
  async notice(actor: AuditActor, roomId: string, message: string): Promise<{ recipients: number }> {
    const room = this.deps.matches.get(roomId) ?? this.deps.squads.get(roomId);
    if (!room) throw new ApiError(404, "Room not found.");
    const recipients = room.notify(message);
    await this.deps.audit.record(actor, "room.notice", null, { roomId, message, recipients });
    return { recipients };
  }

  /** Removes one seat of a match or party (it cannot come back to that room). */
  async kick(actor: AuditActor, roomId: string, sessionId: string, message = KICK_MESSAGE): Promise<void> {
    const match = this.deps.matches.get(roomId);
    const squad = match ? undefined : this.deps.squads.get(roomId);
    if (!match && !squad) throw new ApiError(404, "Room not found.");
    const accountId = (match ? match.accounts.get(sessionId) : squad.accountOf(sessionId)) ?? "";
    const removed = match ? match.removeSession(sessionId, message) : squad.removeSession(sessionId, message);
    if (!removed) throw new ApiError(404, "That player is not in the room.");
    await this.deps.audit.record(actor, "room.kick", accountId || null, { roomId, sessionId, message });
  }

  /** Ends a match: everyone is told why and disconnected. */
  async close(actor: AuditActor, roomId: string, message = CLOSE_MESSAGE): Promise<void> {
    const room = this.deps.matches.get(roomId);
    if (!room) throw new ApiError(404, "Match not found.");
    const players = room.humanCount;
    await this.deps.audit.record(actor, "room.close", null, { roomId, message, players });
    await room.closeByModerator(message);
  }

  /** A notice to every match and party of this process. */
  async broadcast(actor: AuditActor, message: string): Promise<{ rooms: number; recipients: number }> {
    const rooms = [...this.deps.matches.all(), ...this.deps.squads.all()];
    const recipients = rooms.reduce((sum, room) => sum + room.notify(message), 0);
    await this.deps.audit.record(actor, "broadcast", null, { message, rooms: rooms.length, recipients });
    return { rooms: rooms.length, recipients };
  }

  async maintenance(actor: AuditActor, enabled: boolean, message: string) {
    this.deps.operations.setMaintenance(enabled, message);
    await this.deps.audit.record(actor, "service.maintenance", null, { enabled, message });
    return this.deps.operations.status();
  }

  async drain(actor: AuditActor, message?: string) {
    this.deps.operations.beginDrain(message);
    await this.deps.audit.record(actor, "service.drain", null, { message: message ?? null });
    return this.deps.operations.status();
  }

  chat(filter: ChatFilter): ChatLine[] {
    return this.deps.chatLog.recent(filter);
  }
}
