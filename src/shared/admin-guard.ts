import { createHash, timingSafeEqual } from "node:crypto";
import net from "node:net";
import type { Request, RequestHandler } from "express";

// The gate in front of everything administrative (the /api/admin routes and the GM console page): an optional address
// allowlist, then a lockout for addresses that keep sending wrong keys, then the key itself. A locked address gets 429
// even with the right key, so a guessing attempt never learns whether a guess was right once the lockout started.

const digest = (value: string) => createHash("sha256").update(value).digest();
/** Upper bound of the failure table, so a flood of rotating addresses cannot grow it without limit. */
const MAX_TRACKED_ADDRESSES = 10_000;

export interface AdminGuardOptions {
  /** PARTY_ADMIN_KEY; without it every admin surface answers 404. */
  key?: string;
  /** Addresses or CIDR ranges allowed to reach the admin surfaces ("localhost" = 127.0.0.1 and ::1); empty = any. */
  allowedIps?: readonly string[];
  /** Wrong keys tolerated from one address inside the window before it is locked out. */
  maxFailures?: number;
  /** The window that counts failures, and how long a lockout lasts. */
  lockoutSeconds?: number;
  now?: () => number;
}

/** "::ffff:10.0.0.1" -> "10.0.0.1"; an IPv6 zone id is dropped. */
export function normalizeAddress(address: string | undefined): string {
  const bare = (address || "").split("%")[0].trim();
  return bare.toLowerCase().startsWith("::ffff:") && net.isIPv4(bare.slice(7)) ? bare.slice(7) : bare;
}

/** Parsed PARTY_ADMIN_ALLOWED_IPS. An entry that is not an address or a range stops the server at startup. */
export class AddressAllowList {
  private readonly list = new net.BlockList();
  readonly size: number;

  constructor(entries: readonly string[] = []) {
    let count = 0;
    for (const raw of entries) {
      const entry = raw.trim();
      if (!entry) continue;
      this.add(entry);
      count++;
    }
    this.size = count;
  }

  private add(entry: string): void {
    if (entry.toLowerCase() === "localhost") {
      this.list.addAddress("127.0.0.1", "ipv4");
      this.list.addAddress("::1", "ipv6");
      return;
    }
    const [address, prefixText] = entry.split("/");
    const family = net.isIPv4(address) ? "ipv4" : net.isIPv6(address) ? "ipv6" : null;
    if (!family) throw new Error(`PARTY_ADMIN_ALLOWED_IPS: "${entry}" is not an IP address or CIDR range.`);
    if (prefixText === undefined) {
      this.list.addAddress(address, family);
      return;
    }
    const prefix = Number(prefixText);
    if (!/^\d{1,3}$/.test(prefixText) || prefix > (family === "ipv4" ? 32 : 128))
      throw new Error(`PARTY_ADMIN_ALLOWED_IPS: "${entry}" has an invalid prefix length.`);
    this.list.addSubnet(address, prefix, family);
  }

  allows(address: string | undefined): boolean {
    const value = normalizeAddress(address);
    const family = net.isIPv4(value) ? "ipv4" : net.isIPv6(value) ? "ipv6" : null;
    return !!family && this.list.check(value, family);
  }
}

interface FailureRecord {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

/** Wrong keys per address, in memory. IPv6 clients count per /64, so rotating inside one subnet does not help. */
export class AdminFailureTracker {
  private readonly records = new Map<string, FailureRecord>();
  private readonly windowMs: number;

  constructor(
    private readonly maxFailures: number,
    lockoutSeconds: number,
    private readonly now: () => number = Date.now,
  ) {
    this.windowMs = Math.max(1, lockoutSeconds) * 1000;
  }

  static keyOf(address: string | undefined): string {
    const value = normalizeAddress(address) || "unknown";
    if (!net.isIPv6(value)) return value;
    const groups = expandIpv6(value);
    return groups ? groups.slice(0, 4).join(":") + "::/64" : value;
  }

  /** Seconds until the address may try again; 0 when it is not locked out. */
  lockedFor(address: string | undefined): number {
    const record = this.records.get(AdminFailureTracker.keyOf(address));
    const remaining = record ? record.lockedUntil - this.now() : 0;
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  /** Counts a wrong or missing key. Returns true when this failure started a lockout. */
  fail(address: string | undefined): boolean {
    const key = AdminFailureTracker.keyOf(address);
    const now = this.now();
    let record = this.records.get(key);
    if (!record || (record.lockedUntil <= now && now - record.windowStart > this.windowMs)) {
      record = { count: 0, windowStart: now, lockedUntil: 0 };
      this.records.set(key, record);
      if (this.records.size > MAX_TRACKED_ADDRESSES) this.prune(now);
    }
    if (record.lockedUntil > now) return false;
    record.count++;
    if (record.count < this.maxFailures) return false;
    record.lockedUntil = now + this.windowMs;
    record.count = 0;
    record.windowStart = now;
    return true;
  }

  succeed(address: string | undefined): void {
    this.records.delete(AdminFailureTracker.keyOf(address));
  }

  private prune(now: number): void {
    for (const [key, record] of this.records) {
      if (record.lockedUntil <= now && now - record.windowStart > this.windowMs) this.records.delete(key);
    }
    for (const key of this.records.keys()) {
      if (this.records.size <= MAX_TRACKED_ADDRESSES) break;
      this.records.delete(key);
    }
  }
}

/** The eight groups of an IPv6 address (lowercase hex), or null when it is malformed. */
function expandIpv6(address: string): string[] | null {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  return [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map(group =>
    (parseInt(group, 16) || 0).toString(16),
  );
}

export interface AdminGuard {
  /** Whether PARTY_ADMIN_KEY is set. */
  readonly enabled: boolean;
  /** 404 for addresses outside the allowlist (and for every request while no key is set). */
  allowlist: RequestHandler;
  /** The allowlist, the lockout and the bearer key. `enabled` lets a route also require a setting of its own. */
  requireKey(enabled?: boolean): RequestHandler;
  tracker: AdminFailureTracker;
}

/** Every admin surface shares one guard, so wrong keys anywhere count together. */
export function createAdminGuard(options: AdminGuardOptions = {}): AdminGuard {
  const key = options.key || "";
  const allowList = new AddressAllowList(options.allowedIps);
  const tracker = new AdminFailureTracker(
    Math.max(1, options.maxFailures ?? 10),
    options.lockoutSeconds ?? 900,
    options.now,
  );
  const address = (req: Request) => req.ip || req.socket.remoteAddress;
  const outside = (req: Request) => allowList.size > 0 && !allowList.allows(address(req));

  const allowlist: RequestHandler = (req, res, next) => {
    if (!key || outside(req)) {
      res.sendStatus(404);
      return;
    }
    next();
  };

  const requireKey =
    (enabled = true): RequestHandler =>
    (req, res, next) => {
      if (!key || !enabled || outside(req)) {
        res.sendStatus(404);
        return;
      }
      const retry = tracker.lockedFor(address(req));
      if (retry > 0) {
        res.setHeader("Retry-After", String(retry));
        res.status(429).json({ error: "Too many wrong admin keys. Retry later." });
        return;
      }
      const header = req.headers.authorization || "";
      if (!header.startsWith("Bearer ") || !timingSafeEqual(digest(header.slice(7)), digest(key))) {
        if (tracker.fail(address(req)))
          console.warn(`[admin] lockout for ${normalizeAddress(address(req)) || "unknown address"} after wrong keys`);
        res.sendStatus(401);
        return;
      }
      tracker.succeed(address(req));
      next();
    };

  return { enabled: !!key, allowlist, requireKey, tracker };
}
