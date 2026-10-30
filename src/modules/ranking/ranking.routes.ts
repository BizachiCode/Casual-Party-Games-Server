import { Router } from "express";
import { optionalPlayer } from "../account/account.middleware.js";
import type { AccountService } from "../account/account.service.js";
import type { RankingService } from "./ranking.service.js";

/** GET /api/rankings?board=&mode=&courseId=&offset= and GET /api/leaderboard/:courseId (time trial). */
export function rankingRoutes(rankings: RankingService, accounts: AccountService): Router {
  const router = Router();
  router.get("/rankings", optionalPlayer(accounts), async (req, res) => {
    res.json(await rankings.board(req.query, req.player?.id));
  });
  router.get("/leaderboard/:courseId", async (req, res) => {
    res.json(await rankings.board({ board: "timeTrial", courseId: req.params.courseId }));
  });
  return router;
}
