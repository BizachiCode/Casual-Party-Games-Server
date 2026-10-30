import { Router } from "express";
import type { AdminGuard } from "../../shared/admin-guard.js";
import type { OperationsService } from "./operations.service.js";

/**
 * GET /ready (load balancer readiness), GET /api/service/status (shown by clients), and the admin
 * GET|POST /api/admin/service ({ action: "drain" } or { action: "maintenance", enabled, message }).
 */
export function operationsRoutes(operations: OperationsService, guard: AdminGuard): Router {
  const router = Router();
  router.get("/ready", (_req, res) => {
    const ready = operations.ready();
    res.status(ready ? 200 : 503).json({ ready });
  });
  router.get("/api/service/status", (_req, res) => {
    res.json(operations.status());
  });
  const admin = guard.requireKey();
  router.get("/api/admin/service", admin, (_req, res) => {
    res.json(operations.metrics());
  });
  router.post("/api/admin/service", admin, (req, res) => {
    try {
      if (req.body?.action === "drain") operations.beginDrain();
      else if (req.body?.action === "maintenance") operations.setMaintenance(req.body.enabled, req.body.message ?? "");
      else {
        res.status(400).json({ error: "Unknown service operation." });
        return;
      }
      res.json(operations.metrics());
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  return router;
}
