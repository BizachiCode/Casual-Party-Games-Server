import { createHash, randomBytes, randomInt, randomUUID, scrypt as rawScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { ApiError, ensure } from "../../shared/errors.js";
import type { ModerationService } from "../moderation/moderation.service.js";
import { cleanName, NAME_MAX_LENGTH, NameRules } from "./name-rules.js";
import type { PresenceService } from "../presence/presence.service.js";
import { type AccountRepository, nameTaken } from "./account.repository.js";

const scrypt = promisify(rawScrypt) as (password: string, salt: string, length: number) => Promise<Buffer>;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");
const SESSION_MS = 7 * 86400000;
/** An account's last-seen time is written at most this often by authenticated requests. */
const LAST_SEEN_INTERVAL_MS = 5 * 60000;
const LAST_SEEN_TRACKED = 20000;
const DEVICE_ID = /^[A-Za-z0-9-]{16,64}$/;
const DEVICE_SECRET = /^[A-Za-z0-9_-]{32,128}$/;
/** The name older clients gave every guest (and this server, for a refused name); see renameDefaultGuest. */
const LEGACY_GUEST_NAME = "Runner";
/** A guest without a usable name of its own, like the Unity client's default guest names: Guest- and 5 digits. */
const guestName = () => "Guest-" + String(randomInt(0, 100000)).padStart(5, "0");
/** Generated names tried before giving up; every display name is unique (see nameKey), so a name can be taken. */
const NAME_ATTEMPTS = 20;
/** Refuses a name the player chose when another account already has it. */
export const nameTakenError = () => new ApiError(409, "Someone already has that name.", "NAME_TAKEN");

export interface Profile {
  id: string;
  username: string;
  displayName: string;
  xp: number;
  wins: number;
  matches: number;
  color: number;
  level: number;
  /** A device guest account that has not chosen a username and password yet. */
  guest: boolean;
  /** The icon: a character id the player owns, or empty (show the equipped character). */
  avatar: string;
  /** Milliseconds since the epoch; 0 for accounts created before the GM console. */
  createdAt: number;
}
export interface SignedIn {
  token: string;
  profile: Profile;
}

const shorten = (name: string) => Array.from(name).slice(0, NAME_MAX_LENGTH).join("");

/**
 * Online accounts: a username and password exchanged for a 7-day bearer token, or a device guest account that needs
 * neither and can be upgraded to a normal account later. Offline players play without any; an account adds the
 * collection, missions, seasons, rankings and friends.
 */
export class AccountService {
  /** account id -> when its last-seen time was last written by this process. */
  private readonly seenWritten = new Map<string, number>();

  constructor(
    private readonly accounts: AccountRepository,
    private readonly presence: PresenceService,
    /** Bans; without it nobody is banned. */
    private readonly moderation?: ModerationService,
    /** The display name rules; the built-in blocklist when absent. */
    readonly names: NameRules = new NameRules(),
  ) {}

  async profile(id: string): Promise<Profile | null> {
    const row = await this.accounts.profile(id);
    return row ? { ...row, level: 1 + Math.floor(row.xp / 250) } : null;
  }

  /** The lower-cased username and the password of a sign-up, or a 400. */
  private credentials(body: { username?: unknown; password?: unknown }): { username: string; password: string } {
    const { password } = body;
    ensure(
      typeof body.username === "string" && /^[a-zA-Z0-9_]{3,20}$/.test(body.username),
      400,
      "Username must have 3–20 letters, digits or underscores.",
    );
    ensure(
      typeof password === "string" && password.length >= 8 && password.length <= 128,
      400,
      "Password must have 8–128 characters.",
    );
    return { username: body.username.toLowerCase(), password };
  }

  async register(body: { username?: unknown; password?: unknown; displayName?: unknown }): Promise<SignedIn> {
    const { username, password } = this.credentials(body);
    // An explicit name must follow the name rules and be free. The default is the username, or a guest name when the
    // username breaks the name rules or another account already has it as its name.
    const chosen = cleanName(body.displayName) ? this.names.check(shorten(cleanName(body.displayName))) : "";
    ensure(!(await this.accounts.usernameTaken(username)), 409, "Username unavailable.");
    const salt = randomBytes(16).toString("hex");
    const digest = await scrypt(password, salt, 64);
    const id = randomUUID();
    for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
      const name = chosen || (attempt === 0 ? this.names.orElse(username, "") : "") || guestName();
      try {
        await this.accounts.create({
          id,
          username,
          displayName: name,
          salt,
          passwordHash: digest.toString("hex"),
          createdAt: Date.now(),
          lastSeen: Date.now(),
        });
        return this.openSession(id);
      } catch (error) {
        if (nameTaken(error)) {
          if (chosen) throw nameTakenError();
          continue;
        }
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") throw new ApiError(409, "Username unavailable.");
        throw error;
      }
    }
    throw new ApiError(503, "No free name found. Retry shortly.");
  }

  /**
   * Signs in with this device's guest account, creating it the first time. The device id names the device and the
   * secret proves it; only the secret's SHA-256 is stored. The account gets a generated username and a password
   * nobody knows, until upgrade() gives it real ones.
   */
  async guest(body: { deviceId?: unknown; deviceSecret?: unknown; displayName?: unknown }): Promise<SignedIn> {
    const { deviceId, deviceSecret } = body;
    ensure(typeof deviceId === "string" && DEVICE_ID.test(deviceId), 400, "Invalid device id.");
    ensure(typeof deviceSecret === "string" && DEVICE_SECRET.test(deviceSecret), 400, "Invalid device secret.");
    const secretHash = hashSecret(deviceSecret);
    // A guest must always be able to sign in: a missing name, one the rules refuse or one another account already has
    // becomes a guest name, retried until it is free.
    let requested = this.names.orElse(shorten(cleanName(body.displayName)), "");
    for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
      const known = await this.accounts.deviceLogin(deviceId);
      if (known) {
        if (timingSafeEqual(Buffer.from(secretHash, "hex"), Buffer.from(known.secretHash, "hex"))) {
          await this.renameDefaultGuest(known.userId, body.displayName);
          return this.openSession(known.userId);
        }
        // The same cost as a failed password login, so the answer takes as long as any other refusal.
        await scrypt(deviceSecret, "unavailable-device", 64);
        throw new ApiError(401, "Invalid device credentials.");
      }
      const name = requested || guestName();
      const id = randomUUID();
      try {
        await this.accounts.createGuest(
          {
            id,
            username: "guest_" + randomBytes(5).toString("hex"),
            displayName: name,
            salt: randomBytes(16).toString("hex"),
            // Not the digest of any password: the account can only be entered from its device until it is upgraded.
            passwordHash: randomBytes(64).toString("hex"),
            createdAt: Date.now(),
            lastSeen: Date.now(),
          },
          { deviceId, secretHash, createdAt: Date.now() },
        );
        return this.openSession(id);
      } catch (error) {
        // The name is taken (another one next time), another request registered this device first, or the generated
        // username was taken: look again.
        if (nameTaken(error)) requested = "";
        else if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
      }
    }
    throw new ApiError(503, "Guest sign-in unavailable. Retry shortly.");
  }

  /**
   * A guest still named "Runner" and never renamed got that name automatically (older clients sent it for every
   * device); it takes the name its device sends now, or a free guest name. A name the player chose is never replaced.
   */
  private async renameDefaultGuest(userId: string, displayName: unknown): Promise<void> {
    const state = await this.accounts.nameState(userId);
    if (!state || state.displayName !== LEGACY_GUEST_NAME || state.nameChangedAt) return;
    let requested = this.names.orElse(shorten(cleanName(displayName)), "");
    if (requested === LEGACY_GUEST_NAME) requested = "";
    for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
      try {
        await this.accounts.setName(userId, requested || guestName(), state.nameChangedAt);
        return;
      } catch (error) {
        if (!nameTaken(error)) throw error;
        requested = "";
      }
    }
  }

  /** Gives a guest account a username and password. The device keeps signing in to it. */
  async upgrade(id: string, body: { username?: unknown; password?: unknown }): Promise<Profile> {
    const { username, password } = this.credentials(body);
    ensure((await this.accounts.profile(id))?.guest, 409, "Account already has a username.");
    ensure(!(await this.accounts.usernameTaken(username)), 409, "Username unavailable.");
    const salt = randomBytes(16).toString("hex");
    const digest = await scrypt(password, salt, 64);
    try {
      ensure(
        await this.accounts.upgradeGuest(id, username, salt, digest.toString("hex")),
        409,
        "Account already has a username.",
      );
    } catch (error) {
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") throw new ApiError(409, "Username unavailable.");
      throw error;
    }
    return this.profile(id);
  }

  async login(body: { username?: unknown; password?: unknown }): Promise<SignedIn> {
    const { username, password } = body;
    ensure(
      typeof username === "string" && username.length <= 20 && typeof password === "string" && password.length <= 128,
      400,
      "Invalid credentials.",
    );
    const user = await this.accounts.byUsername(username.toLowerCase());
    // Always run the expensive hash, also for unknown users, so timing does not reveal which usernames exist.
    const digest = await scrypt(password, user?.salt || "unavailable-user", 64);
    ensure(user && timingSafeEqual(digest, Buffer.from(user.passwordHash, "hex")), 401, "Invalid credentials.");
    return this.openSession(user.id);
  }

  async logout(token: string): Promise<Profile | null> {
    const user = await this.authenticate(token);
    await this.accounts.closeSession(hashToken(token));
    if (user) await this.presence.forget(user.id);
    return user;
  }

  /** The profile behind a bearer token, or null. Also marks the account as online. */
  async authenticate(token: unknown): Promise<Profile | null> {
    if (typeof token !== "string" || !token || token.length > 200) return null;
    const userId = await this.accounts.sessionUser(hashToken(token));
    if (!userId) return null;
    this.presence.touch(userId);
    this.markSeen(userId);
    return this.profile(userId);
  }

  /** Writes the account's last-seen time, at most once per interval; the request does not wait for it. */
  private markSeen(userId: string): void {
    const now = Date.now();
    if (now - (this.seenWritten.get(userId) ?? 0) < LAST_SEEN_INTERVAL_MS) return;
    if (this.seenWritten.size >= LAST_SEEN_TRACKED) {
      for (const [id, written] of this.seenWritten)
        if (now - written >= LAST_SEEN_INTERVAL_MS) this.seenWritten.delete(id);
      if (this.seenWritten.size >= LAST_SEEN_TRACKED) this.seenWritten.clear();
    }
    this.seenWritten.set(userId, now);
    this.accounts.setLastSeen(userId, now).catch(() => this.seenWritten.delete(userId));
  }

  /** Ends every session of the account (a ban, or a moderator's decision); returns how many there were. */
  revokeSessions(userId: string): Promise<number> {
    return this.accounts.closeSessions(userId);
  }

  /** token -> account id for every still-valid token; rooms re-check their players once per second. */
  async authenticateBatch(tokens: unknown[]): Promise<Map<string, string>> {
    const valid = [
      ...new Set(tokens.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 200)),
    ];
    if (!valid.length) return new Map();
    const byHash = await this.accounts.sessionUsers(valid.map(hashToken));
    return new Map(valid.filter(t => byHash.has(hashToken(t))).map(t => [t, byHash.get(hashToken(t))]));
  }

  async setColor(id: string, color: unknown): Promise<void> {
    ensure(Number.isInteger(color) && (color as number) >= 0 && (color as number) < 8, 400, "Invalid color.");
    await this.accounts.setColor(id, color as number);
  }

  private async openSession(userId: string): Promise<SignedIn> {
    // A suspended account gets no session, whichever way it signs in.
    await this.moderation?.assertNotBanned(userId);
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    await this.accounts.openSession(hashToken(token), userId, now + SESSION_MS);
    this.seenWritten.set(userId, now);
    await this.accounts.setLastSeen(userId, now);
    return { token, profile: await this.profile(userId) };
  }
}
