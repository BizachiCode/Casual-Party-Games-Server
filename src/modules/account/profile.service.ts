import type { Database } from "../../infrastructure/database/database.js";
import { ApiError } from "../../shared/errors.js";
import type { CollectionService } from "../collection/collection.service.js";
import { type AccountRepository, nameTaken } from "./account.repository.js";
import { type AccountService, nameTakenError, type Profile } from "./account.service.js";

/** XP of one level (the level is `1 + floor(xp / 250)`, the same rule as AccountService.profile). */
export const XP_PER_LEVEL = 250;
const HOUR_MS = 3600000;

export interface ProfileStats {
  level: number;
  xp: number;
  xpIntoLevel: number;
  xpForLevel: number;
  wins: number;
  matches: number;
  /** 0 to 1; 0 without matches. */
  winRate: number;
  createdAt: number;
  charactersOwned: number;
  charactersTotal: number;
  /** Courses with a time trial record. */
  bestTimes: number;
}
/** When the name may change: `nextAt` is a time in milliseconds, 0 = now. */
export interface RenameInfo {
  cooldownHours: number;
  nextAt: number;
}
export interface ProfileView {
  profile: Profile;
  stats: ProfileStats;
  rename: RenameInfo;
}

/** The 429 for a rename inside the cooldown; the route also sends `retryAt` (milliseconds). */
export class NameCooldownError extends ApiError {
  constructor(
    readonly retryAt: number,
    hours: number,
  ) {
    super(429, `You can change your name again in ${hours} ${hours === 1 ? "hour" : "hours"}.`, "NAME_COOLDOWN");
  }
}

export interface ProfileDependencies {
  db: Database;
  accounts: AccountService;
  records: AccountRepository;
  collection: CollectionService;
  /** Hours between two renames; 0 = no limit. */
  cooldownHours: number;
  clock: () => Date;
}

/** What a player sees and edits about themselves: nickname (with a cooldown), icon and statistics. */
export class ProfileService {
  constructor(private readonly deps: ProfileDependencies) {}

  private rename(changedAt: number): RenameInfo {
    const { cooldownHours, clock } = this.deps;
    const nextAt = changedAt > 0 ? changedAt + cooldownHours * HOUR_MS : 0;
    return { cooldownHours, nextAt: cooldownHours > 0 && nextAt > +clock() ? nextAt : 0 };
  }

  private async profile(id: string): Promise<Profile> {
    const profile = await this.deps.accounts.profile(id);
    if (!profile) throw new ApiError(404, "Account not found.");
    return profile;
  }

  async view(id: string): Promise<ProfileView> {
    const { records, collection } = this.deps;
    const profile = await this.profile(id);
    const state = await collection.state(id);
    return {
      profile,
      stats: {
        level: profile.level,
        xp: profile.xp,
        xpIntoLevel: profile.xp % XP_PER_LEVEL,
        xpForLevel: XP_PER_LEVEL,
        wins: profile.wins,
        matches: profile.matches,
        winRate: profile.matches > 0 ? Math.min(1, profile.wins / profile.matches) : 0,
        createdAt: profile.createdAt,
        charactersOwned: state.owned.length,
        charactersTotal: collection.catalog.characters.length,
        bestTimes: await records.timeTrialCount(id),
      },
      rename: this.rename((await records.nameState(id))?.nameChangedAt ?? 0),
    };
  }

  /**
   * Changes the display name. The same name again changes nothing; otherwise the cooldown since the last change
   * applies (the first change of an account is free). Players already in a match keep the old name until the next one.
   */
  async setName(id: string, raw: unknown): Promise<{ profile: Profile; rename: RenameInfo }> {
    const { db, records, accounts, clock } = this.deps;
    const name = accounts.names.check(raw);
    const changedAt = await db.transaction(async () => {
      await db.lockUsers([id]);
      const state = await records.nameState(id);
      if (!state) throw new ApiError(404, "Account not found.");
      if (state.displayName === name) return state.nameChangedAt;
      const now = +clock();
      const retryAt = this.rename(state.nameChangedAt).nextAt;
      if (retryAt > now) throw new NameCooldownError(retryAt, Math.max(1, Math.ceil((retryAt - now) / HOUR_MS)));
      try {
        await records.setName(id, name, now);
      } catch (error) {
        if (nameTaken(error)) throw nameTakenError();
        throw error;
      }
      return now;
    });
    return { profile: await this.profile(id), rename: this.rename(changedAt) };
  }

  /** Sets the icon: a character the player owns, or "" to show the equipped one. */
  async setAvatar(id: string, avatar: string): Promise<{ profile: Profile }> {
    const { records, collection } = this.deps;
    if (avatar && !(await collection.state(id)).owned.includes(avatar))
      throw new ApiError(400, "Unlock this character first.", "AVATAR_NOT_OWNED");
    await records.setAvatar(id, avatar);
    return { profile: await this.profile(id) };
  }
}
