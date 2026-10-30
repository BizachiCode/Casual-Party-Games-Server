import { Router } from "express";
import { requirePlayer } from "../account/account.middleware.js";
import type { AccountService } from "../account/account.service.js";
import type { SeasonService } from "./season.service.js";

/** /api/season: state (?season=<id>), premium (buy the premium track), claim, claim-all. */
export function seasonRoutes(seasons: SeasonService, accounts: AccountService): Router {
  const router = Router();
  const signedIn = requirePlayer(accounts, "Sign in for season progression.");
  router.get("/state", signedIn, async (req, res) => {
    res.json(await seasons.state(req.player.id, req.query.season));
  });
  router.post("/premium", signedIn, async (req, res) => {
    const { seasonId } = req.body || {};
    if (typeof seasonId !== "string") {
      res.status(400).json({ error: "Season id required." });
      return;
    }
    res.json(await seasons.buyPremium(req.player.id, seasonId));
  });
  router.post("/claim", signedIn, async (req, res) => {
    const { seasonId, tierId, track } = req.body || {};
    if (typeof seasonId !== "string" || typeof tierId !== "string") {
      res.status(400).json({ error: "Season and reward id required." });
      return;
    }
    // Clients from before the premium track send no track: that is the free one.
    res.json(await seasons.claim(req.player.id, seasonId, tierId, track ?? "free"));
  });
  router.post("/claim-all", signedIn, async (req, res) => {
    const { seasonId } = req.body || {};
    if (typeof seasonId !== "string") {
      res.status(400).json({ error: "Season id required." });
      return;
    }
    res.json(await seasons.claimAll(req.player.id, seasonId));
  });
  return router;
}
