import express, { type Application, type ErrorRequestHandler, type RequestHandler } from "express";
import { monitor, playground } from "colyseus";
import { accountRoutes } from "../modules/account/account.routes.js";
import { adminRoutes } from "../modules/admin/admin.routes.js";
import { gmPanelRoutes } from "../modules/admin/gm-panel.routes.js";
import { collectionRoutes } from "../modules/collection/collection.routes.js";
import { contentRoutes } from "../modules/content/content.routes.js";
import { eventRoutes } from "../modules/events/events.routes.js";
import { operationsRoutes } from "../modules/operations/operations.routes.js";
import { reportRoutes } from "../modules/moderation/reports.routes.js";
import { progressionRoutes } from "../modules/progression/progression.routes.js";
import { rankingRoutes } from "../modules/ranking/ranking.routes.js";
import { seasonRoutes } from "../modules/season/season.routes.js";
import { socialRoutes } from "../modules/social/social.routes.js";
import { storeRoutes } from "../modules/store/store.routes.js";
import { ApiError } from "../shared/errors.js";
import { apiRateLimit } from "../shared/rate-limit.js";
import type { PartyContainer } from "./container.js";

/** Browser origins: an empty allowlist accepts any origin (native builds send none; local development). */
function cors(origins: string[]): RequestHandler {
  return (req, res, next) => {
    if (origins.length && req.headers.origin && !origins.includes(req.headers.origin)) {
      res.sendStatus(403);
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

/** With Redis, the request window is shared by every server process. */
function sharedRateLimit(container: PartyContainer): RequestHandler {
  return async (req, res, next) => {
    try {
      if (
        container.redis &&
        !(await container.redis.admit(req.ip || req.socket.remoteAddress, container.settings.apiRequestsPerMinute))
      ) {
        res.status(429).json({ error: "Too many requests." });
        return;
      }
      next();
    } catch {
      res.status(503).json({ error: "Service temporarily unavailable." });
    }
  };
}

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

/** Expected errors keep their status and message; anything else becomes a generic 500. */
const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = error.status || 500;
  // An ApiError with a code keeps its message at any status: the client branches on the code.
  const code = error instanceof ApiError ? error.code : undefined;
  res
    .status(status)
    .json({ error: status < 500 || code ? error.message : "Server operation failed.", ...(code ? { code } : {}) });
};

/** Every HTTP route. Colyseus answers its own matchmaking routes (/matchmake) before these. */
export function configureHttp(app: Application, container: PartyContainer): void {
  const { settings } = container;
  app.disable("x-powered-by");
  if (settings.trustProxyHops) app.set("trust proxy", settings.trustProxyHops);
  app.use(cors(settings.allowedOrigins));
  app.use("/api", sharedRateLimit(container));
  app.use("/api", noStore, apiRateLimit(settings.apiRequestsPerMinute));
  // The content upload takes up to 4 MB, so it comes before the 16 KB JSON limit of every other route.
  app.use(
    "/api/admin",
    contentRoutes({
      admin: container.adminGuard,
      stagePath: settings.contentStagePath,
      guard: container.contentGuard,
      active: container.content.config,
      gameConfig: container.gameConfig,
      // PM2 (pm_id) starts the process again after it exits, so an uploaded export restarts it gracefully.
      restart: process.env.pm_id !== undefined ? () => process.kill(process.pid, "SIGTERM") : undefined,
    }),
  );
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, protocol: container.content.config.protocol, revision: container.content.config.revision });
  });
  app.use(operationsRoutes(container.operations, container.adminGuard));
  app.use(gmPanelRoutes(container.adminGuard));
  app.use(
    "/api/admin",
    adminRoutes({
      guard: container.adminGuard,
      audit: container.audit,
      players: container.adminPlayers,
      insights: container.adminInsights,
      live: container.adminLive,
      store: container.store,
      moderation: container.moderation,
      accounts: container.accounts,
      matches: container.matches,
      squads: container.squads,
      presence: container.presence,
    }),
  );
  app.use(
    "/api/account",
    accountRoutes(
      container.accounts,
      container.matches,
      container.squads,
      container.profiles,
      container.accountDeletion,
    ),
  );
  app.use("/api/season", seasonRoutes(container.seasons, container.accounts));
  app.use("/api/events", eventRoutes(container.events, container.accounts));
  app.use("/api/progression", progressionRoutes(container.progression, container.accounts));
  app.use("/api/gacha", collectionRoutes(container.collection, container.accounts));
  app.use("/api/store", storeRoutes(container.store, container.accounts));
  app.use("/api", rankingRoutes(container.rankings, container.accounts));
  app.use(
    "/api",
    socialRoutes(container.social, container.accounts, container.matches, container.squads, container.matchmaking),
  );
  app.use("/api", reportRoutes(container.moderation, container.accounts, container.matches, container.chatLog));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Unknown API endpoint." });
  });
  app.use(errorHandler);

  // Colyseus developer tools; never exposed in production.
  if (process.env.NODE_ENV !== "production") {
    app.use("/monitor", monitor());
    app.use("/", playground());
  }
}
