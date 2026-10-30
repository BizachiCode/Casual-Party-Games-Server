import { Router } from "express";
import { requirePlayer } from "../account/account.middleware.js";
import type { AccountService } from "../account/account.service.js";
import type { ProgressionService } from "./progression.service.js";

/** /api/progression: state, claim. */
export function progressionRoutes(progression: ProgressionService, accounts: AccountService): Router {
  const router = Router();
  const signedIn = requirePlayer(accounts, "Sign in for online missions and achievements.");
  router.get("/state", signedIn, async (req, res) => {
    res.json(await progression.state(req.player.id));
  });
  router.post("/claim", signedIn, async (req, res) => {
    res.json(await progression.claim(req.player.id, req.body?.goalId));
  });
  return router;
}
