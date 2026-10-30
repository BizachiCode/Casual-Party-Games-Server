import { randomBytes } from "node:crypto";
import { Router } from "express";
import type { AdminGuard } from "../../shared/admin-guard.js";
import { gmPanelCsp, renderGmPanelPage } from "./gm-panel.page.js";

/**
 * GET /gm: the GM console, one self-contained page. It holds no secret (the operator types the admin key, which the
 * page sends to /api/admin), so it only needs the address allowlist; it answers 404 while no admin key is set.
 */
export function gmPanelRoutes(guard: AdminGuard): Router {
  const router = Router();
  router.get(["/gm", "/gm/"], guard.allowlist, (_req, res) => {
    const nonce = randomBytes(16).toString("base64");
    res.setHeader("Content-Security-Policy", gmPanelCsp(nonce));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.type("html").send(renderGmPanelPage(nonce));
  });
  return router;
}
