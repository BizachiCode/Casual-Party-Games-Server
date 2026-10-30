import "reflect-metadata";
import { defineRoom, defineServer, type Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import type { ServerSettings } from "../config/env.js";
import { createPartyRoom } from "../modules/match/party.room.js";
import { createMatchmakingRoom } from "../modules/matchmaking/matchmaking.room.js";
import { createSquadRoom } from "../modules/squad/squad.room.js";
import { PartyContainer, type ContainerOptions } from "./container.js";
import { configureHttp } from "./http.js";

export interface PartyServer {
  server: Server;
  container: PartyContainer;
}

/**
 * The Colyseus server for these settings: the `matchmaking` queues, the `party` (public) and `party_private` match
 * rooms, the HTTP API and the lifecycle hooks. Nothing connects until it listens.
 */
export function createPartyServer(
  settings: ServerSettings,
  options: ContainerOptions & { handleSignals?: boolean } = {},
): PartyServer {
  const container = new PartyContainer(settings, options);
  const PartyRoom = createPartyRoom(container.matchServices());
  const MatchmakingRoom = createMatchmakingRoom(container.matchmakingServices());
  const SquadRoom = createSquadRoom(container.squadServices());
  const origins = settings.allowedOrigins;
  const server = defineServer({
    greet: false,
    // On SIGTERM/SIGINT Colyseus shuts down gracefully: onBeforeShutdown drains, then rooms close, then onShutdown.
    gracefullyShutdown: options.handleSignals ?? true,
    transport: new WebSocketTransport({
      maxPayload: 4096,
      verifyClient: ({ origin }: { origin?: string }) => !origins.length || !origin || origins.includes(origin),
    }),
    rooms: {
      // Players search through "matchmaking" (one room per queue), which creates and fills "party" rooms.
      matchmaking: defineRoom(MatchmakingRoom).filterBy(["queue"]),
      party: defineRoom(PartyRoom).filterBy(["queue", "mode", "playlist", "courseId", "eventId"]),
      party_private: defineRoom(PartyRoom),
      // A party gathered in the menu, joined through an invitation; the leader's PLAY sends it into "matchmaking".
      squad: defineRoom(SquadRoom),
    },
    express: app => configureHttp(app, container),
    beforeListen: () => container.start(),
  });
  server.onBeforeShutdown(() => container.operations.drain(settings.drainSeconds));
  server.onShutdown(() => container.stop());
  return { server, container };
}
