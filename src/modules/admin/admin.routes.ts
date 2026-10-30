import { Router } from "express";
import type { AdminGuard } from "../../shared/admin-guard.js";
import { adminAuditRoutes } from "./admin-audit.routes.js";
import type { AdminAudit } from "./admin-audit.service.js";
import { adminInsightsRoutes } from "./admin-insights.routes.js";
import type { AdminInsightsService } from "./admin-insights.service.js";
import { adminLiveRoutes } from "./admin-live.routes.js";
import type { AdminLiveService } from "./admin-live.service.js";
import { adminModerationRoutes, type AdminModerationDependencies } from "./admin-moderation.routes.js";
import { adminPlayersRoutes } from "./admin-players.routes.js";
import { adminStoreRoutes } from "./admin-store.routes.js";
import type { AdminPlayersService } from "./admin-players.service.js";
import type { StoreService } from "../store/store.service.js";

export interface AdminRouteServices extends AdminModerationDependencies {
  guard: AdminGuard;
  audit: AdminAudit;
  players: AdminPlayersService;
  insights: AdminInsightsService;
  live: AdminLiveService;
  store: StoreService;
}

/**
 * The GM API under /api/admin: every route needs the admin key (see shared/admin-guard.ts), answers JSON and writes
 * what it changes to the audit log. The GM console (/gm) is its only intended client.
 */
export function adminRoutes(services: AdminRouteServices): Router {
  const router = Router();
  router.use(services.guard.requireKey());
  router.use(adminInsightsRoutes(services.insights));
  router.use(adminPlayersRoutes(services.players));
  router.use(adminModerationRoutes(services));
  router.use(adminLiveRoutes(services.live));
  router.use(adminStoreRoutes(services.store, services.accounts));
  router.use(adminAuditRoutes(services.audit));
  router.use((_req, res) => {
    res.status(404).json({ error: "Unknown admin endpoint." });
  });
  return router;
}
