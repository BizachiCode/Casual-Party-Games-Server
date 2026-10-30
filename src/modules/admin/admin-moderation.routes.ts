import { Router, type Request } from "express";
import { z } from "zod";
import { ApiError } from "../../shared/errors.js";
import { cleanText } from "../../shared/text.js";
import type { AccountService } from "../account/account.service.js";
import type { MatchRegistry } from "../match/match-registry.js";
import { muteNotice, type ModerationService, type Restriction } from "../moderation/moderation.service.js";
import type { PresenceService } from "../presence/presence.service.js";
import type { SquadRegistry } from "../squad/squad-registry.js";
import type { AdminAudit } from "./admin-audit.service.js";
import { actorOf, adminRoute, pageOf, queryText } from "./admin-http.js";

export interface AdminModerationDependencies {
  moderation: ModerationService;
  accounts: AccountService;
  matches: MatchRegistry;
  squads: SquadRegistry;
  presence: PresenceService;
  audit: AdminAudit;
}

const KICK_MESSAGE = "Removed by a moderator.";
const BAN_MESSAGE = "Your account was suspended.";
const WARNING_MESSAGE = "A moderator reviewed a report about you. Please follow the rules.";
const REPORT_STATUSES = ["open", "resolved", "dismissed", "all"];

const text = (label: string, max: number) =>
  z.string({ error: `${label} must be text.` }).max(max, `${label} has at most ${max} characters.`);
const banMinutes = z
  .number({ error: "Minutes must be a whole number from 1 to 5256000, or empty for a permanent ban." })
  .int("Minutes must be a whole number.")
  .min(0, "Minutes cannot be negative.")
  .max(5256000, "A ban lasts 5256000 minutes at most.")
  .nullish();
const muteMinutes = z
  .number({ error: "Choose how many minutes to mute." })
  .int("Minutes must be a whole number.")
  .min(1, "A mute lasts 1 minute at least.")
  .max(525600, "A mute lasts 525600 minutes at most.");

const kickBody = z.object({ message: text("The message", 180).optional() });
const banBody = z.object({ reason: text("The reason", 280).default(""), minutes: banMinutes });
const muteBody = z.object({ reason: text("The reason", 280).default(""), minutes: muteMinutes });
const resolveBody = z
  .object({
    action: z.enum(["none", "warn", "mute", "kick", "ban"], { error: "Unknown action." }),
    minutes: z.number().int().nullish(),
    note: text("The note", 280).default(""),
    allForTarget: z.boolean().optional(),
  })
  .superRefine((body, context) => {
    const bounds = banMinutes.safeParse(body.minutes);
    if (body.action === "mute" && !muteMinutes.safeParse(body.minutes).success)
      context.addIssue({ code: "custom", message: "Choose how many minutes to mute (1 to 525600)." });
    else if (body.action === "ban" && !bounds.success)
      context.addIssue({ code: "custom", message: "Minutes must be 1 to 5256000, or empty for a permanent ban." });
  });
const dismissBody = z.object({ note: text("The note", 280).default("") });

/** The text of a notice to a player: what the moderator typed, cleaned, or the default. */
const noticeText = (message: string | undefined, fallback: string) => cleanText(message ?? "").trim() || fallback;

/** Bans, mutes, kicks, session revocation and player reports under /api/admin. */
export function adminModerationRoutes(dependencies: AdminModerationDependencies): Router {
  const { moderation, accounts, matches, squads, presence, audit } = dependencies;
  const router = Router();

  const playerOf = async (req: Request) => {
    const id = String(req.params.id);
    const player = id.length <= 64 ? await accounts.profile(id) : null;
    if (!player) throw new ApiError(404, "Player not found.");
    return player;
  };

  /** Removes the account from every match and party, telling it why. Returns the seats removed. */
  const removeFromRooms = (accountId: string, message: string) =>
    matches.removeAccount(accountId, message) + squads.removeAccount(accountId, message);

  const banPlayer = async (accountId: string, reason: string, minutes: number | null | undefined, operator: string) => {
    const ban = await moderation.ban(accountId, { reason, minutes: minutes || null, operator });
    removeFromRooms(accountId, BAN_MESSAGE);
    await accounts.revokeSessions(accountId);
    await presence.forget(accountId);
    return ban;
  };

  const mutePlayer = async (accountId: string, reason: string, minutes: number, operator: string) => {
    const mute = await moderation.mute(accountId, { reason, minutes, operator });
    matches.noticeAccount(accountId, muteNotice(mute));
    return mute;
  };

  router.post(
    "/players/:id/kick",
    adminRoute(async req => {
      const player = await playerOf(req);
      const message = noticeText(kickBody.parse(req.body ?? {}).message, KICK_MESSAGE);
      const removed = removeFromRooms(player.id, message);
      await audit.record(actorOf(req), "player.kick", player.id, { message, removed });
      return { ok: true, removed };
    }),
  );

  router.post(
    "/players/:id/sessions/revoke",
    adminRoute(async req => {
      const player = await playerOf(req);
      const sessions = await accounts.revokeSessions(player.id);
      matches.revokeAccount(player.id);
      squads.revokeAccount(player.id);
      await presence.forget(player.id);
      await audit.record(actorOf(req), "player.sessions.revoke", player.id, { sessions });
      return { ok: true, sessions };
    }),
  );

  router.post(
    "/players/:id/ban",
    adminRoute(async req => {
      const player = await playerOf(req);
      const actor = actorOf(req);
      const { reason, minutes } = banBody.parse(req.body ?? {});
      const ban: Restriction = await banPlayer(player.id, reason, minutes, actor.operator);
      await audit.record(actor, "player.ban", player.id, {
        reason: ban.reason,
        minutes: minutes || null,
        until: ban.until,
      });
      return { ok: true, ban };
    }),
  );

  router.post(
    "/players/:id/unban",
    adminRoute(async req => {
      const player = await playerOf(req);
      const removed = await moderation.unban(player.id);
      await audit.record(actorOf(req), "player.unban", player.id, { removed });
      return { ok: true, removed };
    }),
  );

  router.post(
    "/players/:id/mute",
    adminRoute(async req => {
      const player = await playerOf(req);
      const actor = actorOf(req);
      const { reason, minutes } = muteBody.parse(req.body ?? {});
      const mute = await mutePlayer(player.id, reason, minutes, actor.operator);
      await audit.record(actor, "player.mute", player.id, { reason: mute.reason, minutes, until: mute.until });
      return { ok: true, mute };
    }),
  );

  router.post(
    "/players/:id/unmute",
    adminRoute(async req => {
      const player = await playerOf(req);
      const removed = await moderation.unmute(player.id);
      await audit.record(actorOf(req), "player.unmute", player.id, { removed });
      return { ok: true, removed };
    }),
  );

  router.get(
    "/moderation/bans",
    adminRoute(req => {
      const { page, pageSize } = pageOf(req.query);
      return moderation.bans(page, pageSize);
    }),
  );
  router.get(
    "/moderation/mutes",
    adminRoute(req => {
      const { page, pageSize } = pageOf(req.query);
      return moderation.mutes(page, pageSize);
    }),
  );

  router.get(
    "/reports",
    adminRoute(req => {
      const status = queryText(req.query.status, 16) || "open";
      if (!REPORT_STATUSES.includes(status)) throw new ApiError(400, "Unknown report status.");
      return moderation.reports({
        status,
        target: queryText(req.query.target, 64),
        reporter: queryText(req.query.reporter, 64),
        ...pageOf(req.query),
      });
    }),
  );
  router.get(
    "/reports/:id",
    adminRoute(async req => ({ report: await moderation.report(String(req.params.id)) })),
  );

  router.post(
    "/reports/:id/resolve",
    adminRoute(async req => {
      const body = resolveBody.parse(req.body ?? {});
      const actor = actorOf(req);
      const reportId = String(req.params.id);
      const note = cleanText(body.note).trim();
      const { targetId, resolved } = await moderation.resolve(reportId, {
        action: body.action,
        note,
        operator: actor.operator,
        allForTarget: body.allForTarget,
      });
      // The report is closed first, so a double click applies the action once.
      const reason = note || "Reported by players.";
      if (body.action === "warn") matches.noticeAccount(targetId, WARNING_MESSAGE);
      else if (body.action === "mute") await mutePlayer(targetId, reason, body.minutes as number, actor.operator);
      else if (body.action === "kick") removeFromRooms(targetId, KICK_MESSAGE);
      else if (body.action === "ban") await banPlayer(targetId, reason, body.minutes, actor.operator);
      await audit.record(actor, "report.resolve", targetId, {
        reportId,
        action: body.action,
        minutes: body.minutes || null,
        count: resolved,
      });
      return { ok: true, resolved };
    }),
  );

  router.post(
    "/reports/:id/dismiss",
    adminRoute(async req => {
      const { note } = dismissBody.parse(req.body ?? {});
      const actor = actorOf(req);
      const reportId = String(req.params.id);
      const { targetId } = await moderation.dismiss(reportId, { note, operator: actor.operator });
      await audit.record(actor, "report.dismiss", targetId, { reportId });
      return { ok: true };
    }),
  );

  return router;
}
