import { Router } from "express";
import { adminRoute } from "./admin-http.js";
import type { AdminInsightsService } from "./admin-insights.service.js";

/** GET /api/admin/overview, /api/admin/catalog and /api/admin/rankings?board=&mode=&courseId=&offset=. */
export function adminInsightsRoutes(insights: AdminInsightsService): Router {
  const router = Router();
  router.get(
    "/overview",
    adminRoute(() => insights.overview()),
  );
  router.get(
    "/catalog",
    adminRoute(() => insights.catalog()),
  );
  router.get(
    "/rankings",
    adminRoute(async req => insights.rankings(req.query)),
  );
  return router;
}
