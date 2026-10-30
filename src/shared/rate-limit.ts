import type { RequestHandler } from "express";

/**
 * Per-process REST admission: at most `limit` requests per address per minute. Gameplay sockets keep Colyseus' own
 * message limits. Memory is bounded: expired windows are swept and at most 4096 addresses are tracked.
 */
export function apiRateLimit(limit = 240, clock: () => number = () => Date.now()): RequestHandler {
  if (!Number.isInteger(limit) || limit < 30 || limit > 10000)
    throw new Error("API limit must be 30..10000 per minute.");
  const windows = new Map<string, { until: number; count: number }>();
  let calls = 0;
  return (req, res, next) => {
    const now = clock();
    const key = req.ip || req.socket.remoteAddress;
    if (++calls % 64 === 0) for (const [id, entry] of windows) if (entry.until <= now) windows.delete(id);
    let entry = windows.get(key);
    if (!entry || entry.until <= now) {
      if (!entry && windows.size >= 4096) {
        res.status(429).json({ error: "Service busy. Retry shortly." });
        return;
      }
      entry = { until: now + 60000, count: 0 };
      windows.set(key, entry);
    }
    if (++entry.count > limit) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil((entry.until - now) / 1000)));
      res.status(429).json({ error: "Too many requests. Retry shortly." });
      return;
    }
    next();
  };
}

/** A small fixed-window limiter for one sensitive route group (sign-in and registration). */
export function attemptLimit(maximum: number, message: string): RequestHandler {
  const windows = new Map<string, { until: number; count: number }>();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress;
    const now = Date.now();
    for (const [id, entry] of windows) if (now > entry.until) windows.delete(id);
    const entry = windows.get(key) ?? { count: 0, until: now + 60000 };
    windows.set(key, entry);
    if (++entry.count > maximum) {
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}
