import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../../shared/errors.js";
import { cleanText } from "../../shared/text.js";
import { requirePlayer } from "../account/account.middleware.js";
import type { AccountService } from "../account/account.service.js";
import type { MatchRegistry } from "../match/match-registry.js";
import type { ChatLog } from "./chat-log.js";
import { REPORT_REASONS, type ModerationService } from "./moderation.service.js";

const reportBody = z.object({
  reason: z.enum(REPORT_REASONS, { error: "Choose cheating, abuse, name or other." }),
  details: z.string({ error: "Details must be text." }).max(280, "Details have at most 280 characters.").optional(),
  userId: z.string().max(64).optional(),
  roomId: z.string().max(191).optional(),
  sessionId: z.string().max(64).optional(),
});

/**
 * POST /api/reports: a signed-in player reports another player, either by the match seat they share
 * (`{ reason, roomId, sessionId }`) or by account id (`{ reason, userId }`), with optional `details`. The latest chat
 * of the reported player is kept as evidence. Answers 201 `{ ok, reportId }`, or 200 with `duplicate` when the same
 * player reported the same target in the last day and nobody has handled it yet.
 */
export function reportRoutes(
  moderation: ModerationService,
  accounts: AccountService,
  matches: MatchRegistry,
  chatLog: ChatLog,
): Router {
  const router = Router();
  const signedIn = requirePlayer(accounts, "Sign in to report players.");

  router.post("/reports", signedIn, async (req, res) => {
    const parsed = reportBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiError(400, parsed.error.issues.map(issue => issue.message).join(" "));
    const body = parsed.data;
    const reporterId = req.player.id;
    // The Unity client writes "" for every field it leaves out, so an empty string is an absent one.
    const roomId = body.roomId || "";
    let targetId = body.userId || "";
    if (roomId && body.sessionId) {
      const room = matches.get(roomId);
      if (!room?.hasAccount(reporterId)) throw new ApiError(403, "You can only report players of your own match.");
      targetId = room.accounts.get(body.sessionId) ?? "";
      if (!targetId) throw new ApiError(404, "Player unavailable.");
    } else if (!targetId) {
      throw new ApiError(400, "Choose a player to report.");
    }
    const evidence = chatLog.recent({ roomId: roomId || undefined, accountId: targetId, limit: 20 });
    const { reportId, duplicate } = await moderation.fileReport({
      reporterId,
      targetId,
      reason: body.reason,
      details: cleanText(body.details || "").trim(),
      roomId,
      evidence,
    });
    res.status(duplicate ? 200 : 201).json(duplicate ? { ok: true, reportId, duplicate } : { ok: true, reportId });
  });
  return router;
}
