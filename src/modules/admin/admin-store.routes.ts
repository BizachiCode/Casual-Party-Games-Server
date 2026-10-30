import { Router } from "express";
import type { AccountService } from "../account/account.service.js";
import type { StoreService } from "../store/store.service.js";
import { adminRoute, pageOf, queryText } from "./admin-http.js";

/**
 * GET /api/admin/purchases?player=&page=&pageSize= (delivered Stars packs, newest first, demo purchases included and
 * marked by their environment) and GET /api/admin/purchases/revenue (US dollars and purchases of the last 14 UTC days,
 * demo purchases left out).
 */
export function adminStoreRoutes(store: StoreService, accounts: AccountService): Router {
  const router = Router();
  router.get(
    "/purchases",
    adminRoute(async req => {
      const { total, entries } = await store.purchases({
        userId: queryText(req.query.player, 64) || undefined,
        ...pageOf(req.query),
      });
      const names = new Map<string, string>();
      for (const userId of new Set(entries.map(entry => entry.userId))) {
        const profile = await accounts.profile(userId);
        names.set(userId, profile ? profile.displayName || profile.username : "");
      }
      return {
        demo: store.demo,
        total,
        entries: entries.map(entry => ({ ...entry, playerName: names.get(entry.userId) ?? "" })),
      };
    }),
  );
  router.get(
    "/purchases/revenue",
    adminRoute(() => store.revenue(14)),
  );
  return router;
}
