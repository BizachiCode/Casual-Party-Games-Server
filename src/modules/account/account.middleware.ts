import type { Request, RequestHandler } from "express";
import type { AccountService, Profile } from "./account.service.js";

declare global {
  namespace Express {
    interface Request {
      player?: Profile;
    }
  }
}

export const bearerToken = (req: Request) => (req.headers.authorization || "").replace(/^Bearer /, "");

/** Rejects the request with 401 and `message` unless it carries a valid session token; sets `req.player`. */
export function requirePlayer(accounts: AccountService, message: string): RequestHandler {
  return async (req, res, next) => {
    req.player = await accounts.authenticate(bearerToken(req));
    if (!req.player) {
      res.status(401).json({ error: message });
      return;
    }
    next();
  };
}

/** Sets `req.player` when the request carries a valid token, without requiring one. */
export function optionalPlayer(accounts: AccountService): RequestHandler {
  return async (req, _res, next) => {
    const token = bearerToken(req);
    req.player = token ? await accounts.authenticate(token) : undefined;
    next();
  };
}
