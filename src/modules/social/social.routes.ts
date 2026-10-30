import { Router } from "express";
import { ApiError, ensure } from "../../shared/errors.js";
import { requirePlayer } from "../account/account.middleware.js";
import type { AccountService } from "../account/account.service.js";
import type { MatchRegistry } from "../match/match-registry.js";
import type { MatchmakingService } from "../matchmaking/matchmaking.service.js";
import type { SquadRegistry } from "../squad/squad-registry.js";
import type { SocialService } from "./social.service.js";

/**
 * GET /api/rooms (open lobbies: public ones and, unless the matchmaking catalog turns it off, the rooms players
 * created), GET /api/social, and POST /api/social/request | accept | decline | remove | block |
 * unblock | color | invite | invite/respond. Every social action answers with the updated friends state, except
 * invite/respond, which answers `{ roomId, kind }`: the room to join and whether it is a "match" lobby or a "squad"
 * (a party). An invitation points at a private lobby the sender sits in, or at the sender's party.
 */
export function socialRoutes(
  social: SocialService,
  accounts: AccountService,
  matches: MatchRegistry,
  squads: SquadRegistry,
  matchmaking: MatchmakingService,
): Router {
  const router = Router();
  const signedIn = requirePlayer(accounts, "Sign in to use friends and invitations.");
  const userId = (body: { userId?: unknown }) => {
    ensure(typeof body.userId === "string", 400, "Player id required.");
    return body.userId as string;
  };

  router.get("/rooms", (_req, res) => {
    res.json({ rooms: matches.publicLobbies(matchmaking.listsCreatedRooms) });
  });
  router.get("/social", signedIn, async (req, res) => {
    res.json(await social.state(req.player.id));
  });

  router.post("/social/request", signedIn, async (req, res) => {
    await social.request(req.player.id, req.body?.username);
    res.json(await social.state(req.player.id));
  });
  router.post("/social/color", signedIn, async (req, res) => {
    await accounts.setColor(req.player.id, req.body?.color);
    res.json(await social.state(req.player.id));
  });
  for (const action of ["accept", "decline", "remove", "block", "unblock"] as const) {
    router.post("/social/" + action, signedIn, async (req, res) => {
      const id = req.player.id;
      const other = userId(req.body || {});
      if (action === "accept" || action === "decline") await social.respond(id, other, action === "accept");
      else await social[action](id, other);
      res.json(await social.state(id));
    });
  }

  router.post("/social/invite", signedIn, async (req, res) => {
    const body = req.body || {};
    const squad = squads.get(body.roomId);
    if (squad) {
      if (!squad.hasAccount(req.player.id)) throw new ApiError(403, "Join a party before inviting friends to it.");
      await social.invite(req.player.id, userId(body), squad.roomId);
      res.json(await social.state(req.player.id));
      return;
    }
    const room = matches.get(body.roomId);
    if (!room || room.simulation.phase !== "lobby" || !room.clients.some(seat => seat.auth?.id === req.player.id))
      throw new ApiError(403, "Join an open lobby before inviting friends.");
    await social.invite(req.player.id, userId(body), room.roomId);
    res.json(await social.state(req.player.id));
  });
  router.post("/social/invite/respond", signedIn, async (req, res) => {
    const body = req.body || {};
    ensure(typeof body.accept === "boolean", 400, "Accept must be boolean.");
    ensure(typeof body.inviteId === "string", 400, "Invite id required.");
    const { roomId } = await social.consumeInvite(req.player.id, body.inviteId);
    const squad = squads.get(roomId);
    if (squad) {
      if (body.accept && (squad.searching || squad.size >= squad.maxMembers))
        throw new ApiError(409, "Party no longer available.");
      res.json({ roomId: body.accept ? roomId : "", kind: "squad" });
      return;
    }
    const room = matches.get(roomId);
    if (body.accept && (!room || room.simulation.phase !== "lobby" || room.humanCount >= room.maxClients))
      throw new ApiError(409, "Lobby no longer available.");
    res.json({ roomId: body.accept ? roomId : "", kind: "match" });
  });
  return router;
}
