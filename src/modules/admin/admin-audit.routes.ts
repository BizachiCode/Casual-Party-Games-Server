import { Router } from "express";
import { adminRoute, pageOf, queryText } from "./admin-http.js";
import type { AdminAudit } from "./admin-audit.service.js";

/**
 * GET /api/admin/audit?action=&target=&operator=&page=&pageSize= (newest first) and GET /api/admin/audit/filters
 * (the actions and operators on record).
 */
export function adminAuditRoutes(audit: AdminAudit): Router {
  const router = Router();
  router.get(
    "/audit",
    adminRoute(async req =>
      audit.list({
        action: queryText(req.query.action, 64) || undefined,
        targetId: queryText(req.query.target, 64) || undefined,
        operator: queryText(req.query.operator, 64) || undefined,
        ...pageOf(req.query),
      }),
    ),
  );
  router.get(
    "/audit/filters",
    adminRoute(() => audit.filters()),
  );
  return router;
}
