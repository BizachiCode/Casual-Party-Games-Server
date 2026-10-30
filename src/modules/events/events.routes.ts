import { Router } from "express";
import { requirePlayer } from "../account/account.middleware.js";
import type { AccountService } from "../account/account.service.js";
import type { EventService } from "./events.service.js";

/** /api/events: the schedule (public), the account's progress (state), claim. */
export function eventRoutes(events: EventService, accounts: AccountService): Router {
  const router = Router();
  const signedIn = requirePlayer(accounts, "Sign in for event missions.");
  router.get("/", (_req, res) => {
    res.json(events.list());
  });
  router.get("/state", signedIn, async (req, res) => {
    res.json(await events.state(req.player.id));
  });
  router.post("/claim", signedIn, async (req, res) => {
    const { eventId, goalId } = req.body || {};
    if (typeof eventId !== "string" || typeof goalId !== "string") {
      res.status(400).json({ error: "Event and goal id required." });
      return;
    }
    res.json(await events.claim(req.player.id, eventId, goalId));
  });
  return router;
}
