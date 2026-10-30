import { Router } from "express";
import { z } from "zod";
import { cleanText } from "../../shared/text.js";
import type { AdminLiveService } from "./admin-live.service.js";
import { actorOf, adminRoute, queryText } from "./admin-http.js";

const message = z
  .string({ error: "A message is required." })
  .transform(value => cleanText(value).trim())
  .pipe(z.string().min(1, "A message is required.").max(180, "The message has at most 180 characters."));
const optionalMessage = z
  .string({ error: "The message must be text." })
  .max(180, "The message has at most 180 characters.")
  .optional()
  .transform(value => cleanText(value ?? "").trim() || undefined);

const noticeBody = z.object({ message });
const kickBody = z.object({
  sessionId: z.string({ error: "Choose a player." }).min(1, "Choose a player.").max(64),
  message: optionalMessage,
});
const closeBody = z.object({ message: optionalMessage });
const maintenanceBody = z.object({
  enabled: z.boolean({ error: "Say whether maintenance is on or off." }),
  message: optionalMessage,
});

/**
 * /api/admin/live: GET status | rooms | rooms/:roomId | chat, and POST rooms/:roomId/notice | kick | close, broadcast,
 * maintenance and drain.
 */
export function adminLiveRoutes(live: AdminLiveService): Router {
  const router = Router();
  const roomOf = (id: unknown) => String(id).slice(0, 191);

  router.get(
    "/live/status",
    adminRoute(() => live.status()),
  );
  router.get(
    "/live/rooms",
    adminRoute(async () => live.rooms()),
  );
  router.get(
    "/live/rooms/:roomId",
    adminRoute(async req => live.room(roomOf(req.params.roomId))),
  );
  router.post(
    "/live/rooms/:roomId/notice",
    adminRoute(async req => {
      const body = noticeBody.parse(req.body ?? {});
      const { recipients } = await live.notice(actorOf(req), roomOf(req.params.roomId), body.message);
      return { ok: true, recipients };
    }),
  );
  router.post(
    "/live/rooms/:roomId/kick",
    adminRoute(async req => {
      const body = kickBody.parse(req.body ?? {});
      await live.kick(actorOf(req), roomOf(req.params.roomId), body.sessionId, body.message);
      return { ok: true };
    }),
  );
  router.post(
    "/live/rooms/:roomId/close",
    adminRoute(async req => {
      const body = closeBody.parse(req.body ?? {});
      await live.close(actorOf(req), roomOf(req.params.roomId), body.message);
      return { ok: true };
    }),
  );
  router.post(
    "/live/broadcast",
    adminRoute(async req => {
      const body = noticeBody.parse(req.body ?? {});
      return { ok: true, ...(await live.broadcast(actorOf(req), body.message)) };
    }),
  );
  router.post(
    "/live/maintenance",
    adminRoute(async req => {
      const body = maintenanceBody.parse(req.body ?? {});
      return { ok: true, status: await live.maintenance(actorOf(req), body.enabled, body.message ?? "") };
    }),
  );
  router.post(
    "/live/drain",
    adminRoute(async req => {
      const body = closeBody.parse(req.body ?? {});
      return { ok: true, status: await live.drain(actorOf(req), body.message) };
    }),
  );
  router.get(
    "/live/chat",
    adminRoute(async req => {
      const limit = Number(req.query.limit);
      return {
        lines: live.chat({
          roomId: queryText(req.query.roomId, 191) || undefined,
          accountId: queryText(req.query.account, 64) || undefined,
          contains: queryText(req.query.q, 120) || undefined,
          limit: Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 500) : 100,
        }),
      };
    }),
  );
  return router;
}
