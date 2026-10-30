import express, { Router } from "express";
import type { AdminGuard } from "../../shared/admin-guard.js";
import { atomicWrite, verifyBundle } from "./content-bundle.js";
import type { ContentGuard } from "./content.guard.js";
import type { PartyConfig } from "./content.types.js";
import type { GameConfigService } from "./game-config.service.js";

/**
 * POST /api/admin/content: the Unity exporter uploads a bundle, which is verified and staged for the next restart
 * (running matches never change content). Disabled unless PARTY_ADMIN_KEY and PARTY_CONTENT_STAGE are both set.
 *
 * POST /api/admin/game-config: Unity's "Export to Server" uploads every exported file ({ files: { name: json } }); they
 * are checked together and written to game_config. Under PM2 the server then restarts to load them: running matches
 * may finish first (PARTY_DRAIN_SECONDS). Elsewhere the answer says a restart is needed.
 */
export function contentRoutes(options: {
  admin: AdminGuard;
  stagePath?: string;
  guard: ContentGuard;
  active: PartyConfig;
  gameConfig: GameConfigService;
  /** Restarts the process to load new files; absent when nothing would start it again (no PM2). */
  restart?: () => void;
}): Router {
  const router = Router();
  router.post("/game-config", options.admin.requireKey(true), express.json({ limit: "8mb" }), async (req, res) => {
    try {
      const applied = await options.gameConfig.apply(req.body);
      res.json({ ...applied, activeRevision: options.active.revision, restarting: !!options.restart });
      if (options.restart) setTimeout(options.restart, 500);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400;
      res.status(status).json({ error: (error as Error).message });
    }
  });
  router.post(
    "/content",
    options.admin.requireKey(!!options.stagePath),
    express.json({ limit: "4mb" }),
    async (req, res) => {
      try {
        const { config, characterCatalog, goalCatalog } = verifyBundle(req.body);
        await options.guard.validateInventory(characterCatalog);
        await options.guard.checkIdentities(characterCatalog, goalCatalog);
        atomicWrite(options.stagePath, JSON.stringify(req.body) + "\n");
        res.json({
          staged: true,
          restartRequired: true,
          activeConfigChanged: false,
          activeRevision: options.active.revision,
          stagedRevision: config.revision,
          checksum: req.body.checksum,
        });
      } catch (error) {
        res.status(400).json({ error: (error as Error).message });
      }
    },
  );
  return router;
}
