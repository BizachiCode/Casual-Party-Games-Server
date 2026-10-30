import { Router, type Request } from "express";
import { z } from "zod";
import { actorOf, adminRoute, pageOf, queryText, requestIdSchema } from "./admin-http.js";
import type { AdminPlayersService } from "./admin-players.service.js";

const FILTERS = ["all", "registered", "guest", "banned", "muted", "online", "new"] as const;
const SORTS = ["lastSeen", "createdAt", "xp", "wins", "matches", "stars", "name"] as const;

const noteSchema = z.string({ error: "The note must be text." }).max(140, "The note has at most 140 characters.");
const wholeNumber = (label: string) =>
  z.number({ error: `The ${label} must be a number.` }).int(`The ${label} must be whole.`);
const characterBody = z.object({ characterId: z.string({ error: "A character id is required." }).min(1).max(191) });

const renameBody = z.object({
  displayName: z.string({ error: "A name is required." }).max(120, "That name is too long."),
});
const adjustBody = z.object({
  delta: wholeNumber("amount")
    .refine(delta => delta !== 0, "The amount cannot be zero.")
    .refine(delta => Math.abs(delta) <= 1_000_000_000, "The amount is at most 1,000,000,000."),
  requestId: requestIdSchema,
  note: noteSchema.optional(),
});
const xpBody = z.object({
  xp: wholeNumber("XP").min(0, "XP cannot be negative.").max(100_000_000, "XP is at most 100,000,000."),
});
const passXpBody = z.object({
  xp: wholeNumber("XP").min(1, "Give at least 1 XP.").max(1_000_000, "Give at most 1,000,000 XP at once."),
  requestId: requestIdSchema,
});
const premiumBody = z.object({
  seasonId: z.string({ error: "A season id is required." }).regex(/^[a-z0-9-]{1,64}$/, "Invalid season."),
  owned: z.boolean({ error: "Say whether the player owns the premium track." }),
});
const resetBody = z.object({ scope: z.enum(["boards", "times", "all"], { error: "Choose boards, times or all." }) });
const reward = (label: string) =>
  wholeNumber(label).min(1, `The ${label} must be positive.`).max(1_000_000, `The ${label} is at most 1,000,000.`);
const grantBody = z
  .object({
    targets: z
      .array(z.string().trim().min(1, "A target cannot be empty.").max(64, "A target has at most 64 characters."), {
        error: "Targets are required.",
      })
      .min(1, "Name at least one target.")
      .max(100, "At most 100 targets at once."),
    stars: reward("Stars").optional(),
    shards: reward("shards").optional(),
    characterId: z.string().min(1).max(191).optional(),
    passXp: reward("pass XP").optional(),
    note: noteSchema.optional(),
    requestId: requestIdSchema,
  })
  .refine(
    body => body.stars || body.shards || body.characterId || body.passXp,
    "Choose at least one reward: Stars, shards, a character or pass XP.",
  );

/** /api/admin/players and /api/admin/grants. */
export function adminPlayersRoutes(players: AdminPlayersService): Router {
  const router = Router();
  const body = (req: { body?: unknown }) => req.body ?? {};
  /** The account id of the path (an id is at most 64 characters, so anything longer finds nobody). */
  const idOf = (req: Request) => queryText(req.params.id, 65);

  router.get(
    "/players/search",
    adminRoute(async req => {
      const limit = Number(req.query.limit);
      return players.search(queryText(req.query.q, 64), Number.isInteger(limit) ? Math.min(20, Math.max(1, limit)) : 8);
    }),
  );
  router.get(
    "/players",
    adminRoute(async req => {
      const query = z
        .object({
          filter: z.enum(FILTERS, { error: "Unknown filter." }).default("all"),
          sort: z.enum(SORTS, { error: "Unknown sort column." }).default("lastSeen"),
          dir: z.enum(["asc", "desc"], { error: "The direction is asc or desc." }).default("desc"),
        })
        .parse({
          filter: queryText(req.query.filter) || undefined,
          sort: queryText(req.query.sort) || undefined,
          dir: queryText(req.query.dir) || undefined,
        });
      return players.list({
        q: queryText(req.query.q, 64),
        filter: query.filter,
        sort: query.sort,
        descending: query.dir === "desc",
        ...pageOf(req.query),
      });
    }),
  );
  router.get(
    "/players/:id",
    adminRoute(req => players.detail(idOf(req))),
  );

  router.post(
    "/players/:id/rename",
    adminRoute(async req => {
      const { displayName } = renameBody.parse(body(req));
      return players.rename(actorOf(req), idOf(req), displayName);
    }),
  );
  router.post(
    "/players/:id/stars",
    adminRoute(async req => players.adjustStars(actorOf(req), idOf(req), adjustBody.parse(body(req)))),
  );
  router.post(
    "/players/:id/shards",
    adminRoute(async req => players.adjustShards(actorOf(req), idOf(req), adjustBody.parse(body(req)))),
  );
  router.post(
    "/players/:id/xp",
    adminRoute(async req => players.setXp(actorOf(req), idOf(req), xpBody.parse(body(req)).xp)),
  );
  router.post(
    "/players/:id/characters/grant",
    adminRoute(async req =>
      players.grantCharacter(actorOf(req), idOf(req), characterBody.parse(body(req)).characterId),
    ),
  );
  router.post(
    "/players/:id/characters/revoke",
    adminRoute(async req =>
      players.revokeCharacter(actorOf(req), idOf(req), characterBody.parse(body(req)).characterId),
    ),
  );
  router.post(
    "/players/:id/equip",
    adminRoute(async req => players.equip(actorOf(req), idOf(req), characterBody.parse(body(req)).characterId)),
  );
  router.post(
    "/players/:id/pass-xp",
    adminRoute(async req => players.grantPassXp(actorOf(req), idOf(req), passXpBody.parse(body(req)))),
  );
  router.post(
    "/players/:id/premium",
    adminRoute(async req => {
      const { seasonId, owned } = premiumBody.parse(body(req));
      return players.setPremium(actorOf(req), idOf(req), seasonId, owned);
    }),
  );
  router.post(
    "/players/:id/rankings/reset",
    adminRoute(async req => players.resetRankings(actorOf(req), idOf(req), resetBody.parse(body(req)).scope)),
  );
  router.post(
    "/grants",
    adminRoute(async req => players.grant(actorOf(req), grantBody.parse(body(req)))),
  );
  return router;
}
