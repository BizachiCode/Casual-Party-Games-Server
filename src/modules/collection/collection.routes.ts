import { Router } from "express";
import { requirePlayer } from "../account/account.middleware.js";
import type { AccountService } from "../account/account.service.js";
import type { CollectionService } from "./collection.service.js";

/** /api/gacha: catalog, state, pull, daily, equip, craft. */
export function collectionRoutes(collection: CollectionService, accounts: AccountService): Router {
  const router = Router();
  const signedIn = requirePlayer(accounts, "Sign in for the online collection.");
  router.get("/catalog", (_req, res) => {
    res.json(collection.catalog);
  });
  router.get("/state", signedIn, async (req, res) => {
    res.json(await collection.state(req.player.id));
  });
  router.post("/pull", signedIn, async (req, res) => {
    res.json(await collection.pull(req.player.id, req.body || {}));
  });
  router.post("/daily", signedIn, async (req, res) => {
    res.json(await collection.daily(req.player.id));
  });
  router.post("/equip", signedIn, async (req, res) => {
    res.json(await collection.equip(req.player.id, req.body?.characterId));
  });
  router.post("/craft", signedIn, async (req, res) => {
    res.json(await collection.craft(req.player.id, req.body?.characterId));
  });
  return router;
}
