import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../../shared/errors.js";
import { attemptLimit } from "../../shared/rate-limit.js";
import type { MatchRegistry } from "../match/match-registry.js";
import type { SquadRegistry } from "../squad/squad-registry.js";
import { bearerToken, requirePlayer } from "./account.middleware.js";
import type { AccountDeletionService } from "./account-deletion.service.js";
import type { AccountService } from "./account.service.js";
import { NameCooldownError, type ProfileService } from "./profile.service.js";

const nameBody = z.object({ displayName: z.string({ error: "Send a name." }) });
// The client writes "" for a field it leaves out, which for the avatar means "show the equipped character".
const avatarBody = z.object({ avatar: z.string({ error: "Send a character id." }).max(64).default("") });
const deleteBody = z.object({ confirm: z.string().default("") });

function parse<Shape extends z.ZodType>(schema: Shape, body: unknown): z.output<Shape> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new ApiError(400, result.error.issues.map(issue => issue.message).join(" "));
  return result.data;
}

/**
 * /api/account: register, login, guest (device sign-in), upgrade (a guest picks a username and password) and logout.
 * Logging out also ends the account's seat in any match and party. With the profile services it also serves
 * GET profile, POST name (3 to 20 characters, blocklist, cooldown: 400 NAME_INVALID | NAME_NOT_ALLOWED, 429
 * NAME_COOLDOWN with `retryAt`), POST avatar (400 AVATAR_NOT_OWNED) and POST delete (`{ confirm: "DELETE" }` removes
 * the account).
 */
export function accountRoutes(
  accounts: AccountService,
  matches: MatchRegistry,
  squads?: SquadRegistry,
  profiles?: ProfileService,
  deletion?: AccountDeletionService,
): Router {
  const router = Router();
  const limited = attemptLimit(20, "Too many authentication attempts. Retry in one minute.");
  router.post("/register", limited, async (req, res) => {
    res.status(201).json(await accounts.register(req.body || {}));
  });
  router.post("/login", limited, async (req, res) => {
    res.json(await accounts.login(req.body || {}));
  });
  router.post("/guest", limited, async (req, res) => {
    res.json(await accounts.guest(req.body || {}));
  });
  const signedIn = requirePlayer(accounts, "Sign in to use friends and invitations.");
  router.post("/upgrade", limited, signedIn, async (req, res) => {
    res.json({ token: bearerToken(req), profile: await accounts.upgrade(req.player.id, req.body || {}) });
  });
  router.post("/logout", signedIn, async (req, res) => {
    await accounts.logout(bearerToken(req));
    matches.revokeAccount(req.player.id);
    squads?.revokeAccount(req.player.id);
    res.json({ ok: true });
  });
  const manager = requirePlayer(accounts, "Sign in to manage your profile.");
  if (profiles) {
    router.get("/profile", manager, async (req, res) => {
      res.json(await profiles.view(req.player.id));
    });
    router.post("/name", manager, async (req, res) => {
      const { displayName } = parse(nameBody, req.body);
      try {
        res.json(await profiles.setName(req.player.id, displayName));
      } catch (error) {
        if (!(error instanceof NameCooldownError)) throw error;
        res.status(429).json({ error: error.message, code: error.code, retryAt: error.retryAt });
      }
    });
    router.post("/avatar", manager, async (req, res) => {
      res.json(await profiles.setAvatar(req.player.id, parse(avatarBody, req.body).avatar.trim()));
    });
  }
  if (deletion) {
    router.post("/delete", manager, async (req, res) => {
      await deletion.delete(req.player.id, parse(deleteBody, req.body).confirm);
      res.json({ ok: true });
    });
  }
  return router;
}
