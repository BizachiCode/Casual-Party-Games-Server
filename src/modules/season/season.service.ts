import type { Database } from "../../infrastructure/database/database.js";
import { ApiError } from "../../shared/errors.js";
import type { CollectionRepository } from "../collection/collection.repository.js";
import type { CollectionService } from "../collection/collection.service.js";
import type { CharacterCatalog } from "../content/content.types.js";
import type { MatchSnapshot } from "../match/simulation/party-simulation.js";
import type { MatchReward } from "../ranking/ranking.service.js";
import {
  canonicalJson,
  parseFrozenPolicy,
  seasonWindow,
  validateSeasonCatalog,
  type PremiumCurrency,
  type SeasonCatalog,
  type SeasonPolicy,
  type SeasonReward,
  type SeasonTier,
} from "./season.catalog.js";
import type { SeasonRepository } from "./season.repository.js";

const UNRANKED_MODES = ["arcade", "timeTrial"];
const TRACKS = ["free", "premium"] as const;
export type PassTrack = (typeof TRACKS)[number];

/** One reward of the pass as a player sees it. */
export interface TrackView extends SeasonReward {
  claimed: boolean;
  claimable: boolean;
}
export interface TierView {
  id: string;
  xp: number;
  free: TrackView;
  premium: TrackView;
}
/** GET /api/season/state. */
export interface SeasonView {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  claimUntil: string;
  serverTime: string;
  xp: number;
  level: number;
  dailyMatches: number;
  dailyMatchCap: number;
  /** Running now. */
  active: boolean;
  /** Rewards can be claimed and premium bought: from the start until the claim grace ends. */
  claimOpen: boolean;
  upcoming: boolean;
  premium: { owned: boolean; currency: PremiumCurrency; cost: number };
  /** The season that follows this one, if one is scheduled. */
  next: { id: string; title: string; startsAt: string } | null;
  tiers: TierView[];
}

/**
 * The battle pass: seasons scheduled in the catalog, each with a free and a premium track. Matches with enough
 * signed-in players give XP up to a daily cap, and missions and events add XP through grantXp. A tier pays its
 * rewards on a track once the player has the XP (and, for premium, owns the track) until a grace period after the
 * season ends. A season's policy freezes when it first runs, so a later edit cannot change a running season.
 */
export class SeasonService {
  private readonly catalog: SeasonCatalog;

  constructor(
    private readonly db: Database,
    private readonly seasons: SeasonRepository,
    private readonly collection: CollectionService,
    private readonly collectionRecords: CollectionRepository,
    catalog: SeasonCatalog,
    private readonly clock: () => Date = () => new Date(),
  ) {
    validateSeasonCatalog(catalog, collection.catalog);
    this.catalog = structuredClone(catalog);
  }

  /**
   * Whether `catalog` can replace this one at the next start (an uploaded export): it must be valid for `characters`,
   * and the season running now must keep the policy it froze with, or the server would refuse to start.
   */
  async checkReplacement(catalog: SeasonCatalog, characters: CharacterCatalog): Promise<void> {
    validateSeasonCatalog(catalog, characters);
    const now = +this.clock();
    const running = catalog.seasons.find(season => {
      const { start, end } = seasonWindow(season);
      return now >= start && now < end;
    });
    if (!running) return;
    const frozen = await this.seasons.policy(running.id);
    if (frozen !== null && frozen !== canonicalJson(running))
      throw new ApiError(
        400,
        "Season " + running.id + " is running with a different policy; edit the next season, or wait until it ends.",
      );
  }

  /** The catalog season running at `now`, if any. */
  current(now: Date = this.clock()): SeasonPolicy | undefined {
    return this.catalog.seasons.find(season => {
      const { start, end } = seasonWindow(season);
      return +now >= start && +now < end;
    });
  }

  /**
   * Freezes the catalog policy of season `id`, or fails if a different one is already frozen. The check runs when the
   * server starts and on every write to the running season.
   */
  async ensure(id: string): Promise<SeasonPolicy> {
    const season = this.catalog.seasons.find(candidate => candidate.id === id);
    if (!season) throw new Error("Season " + id + " is not in the catalog.");
    const policy = canonicalJson(season);
    await this.seasons.freeze(id, policy);
    if ((await this.seasons.policy(id)) !== policy)
      throw new Error(
        "Season " + id + " is running with a different policy; edit the next season, or wait until " + id + " ends.",
      );
    return season;
  }

  /** Startup: freezes the running season, if there is one. */
  async ensureCurrent(): Promise<void> {
    const season = this.current();
    if (season) await this.ensure(season.id);
  }

  /** The policy of a season: the frozen one when it exists, else the catalog's (frozen now when `freeze`). */
  private async load(id: string, freeze = false): Promise<SeasonPolicy> {
    const stored = await this.seasons.policy(id);
    const frozen = stored ? parseFrozenPolicy(stored) : null;
    if (frozen) return frozen;
    const scheduled = this.catalog.seasons.find(season => season.id === id);
    if (!scheduled) throw new ApiError(404, "Season not found.");
    return freeze ? this.ensure(id) : scheduled;
  }

  /** Every season, oldest first: frozen policies win over the catalog, and frozen ones dropped from it stay. */
  private async schedule(): Promise<SeasonPolicy[]> {
    const merged = new Map<string, SeasonPolicy>();
    for (const row of await this.seasons.definitions()) {
      const frozen = parseFrozenPolicy(row.policy);
      if (frozen) merged.set(frozen.id, frozen);
    }
    for (const season of this.catalog.seasons) if (!merged.has(season.id)) merged.set(season.id, season);
    return [...merged.values()].sort((first, second) => Date.parse(first.startsAt) - Date.parse(second.startsAt));
  }

  /** Every season (frozen policies and the catalog), oldest first, for the GM console. */
  seasonSchedule(): Promise<SeasonPolicy[]> {
    return this.schedule();
  }

  /** The season asked for, else the running one, the one still claimable, the next one. */
  private pick(schedule: SeasonPolicy[], requested: unknown, now: number): SeasonPolicy {
    if (requested !== undefined && requested !== null && requested !== "") {
      if (typeof requested !== "string" || !/^[a-z0-9-]{1,64}$/.test(requested))
        throw new ApiError(400, "Invalid season.");
      const season = schedule.find(candidate => candidate.id === requested);
      if (!season) throw new ApiError(404, "Season not found.");
      return season;
    }
    const windows = schedule.map(season => ({ season, ...seasonWindow(season) }));
    const running = windows.find(entry => now >= entry.start && now < entry.end);
    const claimable = windows.filter(entry => now >= entry.end && now < entry.claimUntil).at(-1);
    const upcoming = windows.find(entry => now < entry.start);
    const found = running ?? claimable ?? upcoming;
    if (!found) throw new ApiError(404, "No season scheduled.");
    return found.season;
  }

  /** Season XP is capped per UTC day and per season. */
  private dailyKey(season: string, now: Date): string {
    return season + ":" + now.toISOString().slice(0, 10);
  }

  async record(
    matchId: string,
    state: MatchSnapshot,
    accounts: Map<string, string>,
    rewards: MatchReward[],
  ): Promise<void> {
    if (state.phase !== "finished") throw new Error("Only finished authority results may advance a season.");
    if (UNRANKED_MODES.includes(state.mode)) return;
    const now = this.clock();
    const running = this.current(now);
    if (!running) return;
    const participants = new Set(
      state.players.filter(player => !player.bot && accounts.has(player.id)).map(player => accounts.get(player.id)),
    );
    if (participants.size < running.minimumParticipants) return;
    await this.db.transaction(async () => {
      await this.db.lockUsers(accounts.values());
      const policy = await this.ensure(running.id);
      const dailyKey = this.dailyKey(policy.id, now);
      const cap = policy.tiers.at(-1).xp;
      for (const reward of rewards) {
        if (!reward.credits || !participants.has(reward.id)) continue;
        if (await this.seasons.matchCounted(reward.id, matchId)) continue;
        const daily = await this.seasons.dailyMatches(reward.id, dailyKey);
        const xp = daily < policy.dailyMatchCap ? policy.matchXp + (reward.won ? policy.winBonus : 0) : 0;
        await this.seasons.countMatch(reward.id, matchId, policy.id, xp);
        if (!xp) continue;
        await this.seasons.addDailyMatch(reward.id, dailyKey);
        await this.seasons.addXp(reward.id, policy.id, xp, cap);
      }
    });
  }

  /**
   * Adds XP to the running season once per `receiptKey` (a mission claim, an event goal): no daily cap, never past the
   * last tier. Joins the caller's transaction. Returns the XP added, 0 for a repeated key, a missing season or an
   * amount that is not positive.
   */
  async grantXp(userId: string, receiptKey: string, xp: number): Promise<number> {
    if (typeof receiptKey !== "string" || !receiptKey || receiptKey.length > 191)
      throw new Error("A pass XP grant needs a receipt key of 1 to 191 characters.");
    if (!Number.isSafeInteger(xp) || xp <= 0) return 0;
    const running = this.current();
    if (!running) return 0;
    return this.db.transaction(async () => {
      await this.db.lockUsers([userId]);
      const policy = await this.ensure(running.id);
      const cap = policy.tiers.at(-1).xp;
      const granted = Math.min(xp, cap - (await this.seasons.xp(userId, policy.id)));
      if (!(await this.seasons.countGrant(userId, receiptKey, policy.id, granted))) return 0;
      if (granted > 0) await this.seasons.addXp(userId, policy.id, granted, cap);
      return granted;
    });
  }

  /** Characters the catalog or a frozen policy still promises: running, in claim grace or upcoming seasons. */
  async promisedCharacters(): Promise<string[]> {
    const now = +this.clock();
    const promised = new Set<string>();
    for (const season of await this.schedule()) {
      if (now >= seasonWindow(season).claimUntil) continue;
      for (const tier of season.tiers) {
        for (const track of TRACKS) if (tier[track].characterId) promised.add(tier[track].characterId);
      }
    }
    return [...promised];
  }

  async state(userId: string, requested?: unknown): Promise<SeasonView> {
    const schedule = await this.schedule();
    const now = this.clock();
    const season = this.pick(schedule, requested, +now);
    const { start, end, claimUntil } = seasonWindow(season);
    const active = +now >= start && +now < end;
    const claimOpen = +now >= start && +now < claimUntil;
    const xp = await this.seasons.xp(userId, season.id);
    const dailyMatches = active ? await this.seasons.dailyMatches(userId, this.dailyKey(season.id, now)) : 0;
    const owned = season.premium.cost === 0 || (await this.seasons.premiumOwned(userId, season.id));
    const claimed = await this.seasons.claimed(userId, season.id);
    const view = (tier: SeasonTier, track: PassTrack): TrackView => {
      const reward = tier[track];
      const empty = !reward.credits && !reward.shards && !reward.characterId;
      const done = !empty && claimed.has(track + ":" + tier.id);
      return {
        credits: reward.credits,
        shards: reward.shards,
        characterId: reward.characterId,
        claimed: done,
        claimable: !empty && !done && claimOpen && xp >= tier.xp && (track === "free" || owned),
      };
    };
    const following = schedule.find(candidate => Date.parse(candidate.startsAt) > start);
    return {
      id: season.id,
      title: season.title,
      startsAt: season.startsAt,
      endsAt: season.endsAt,
      claimUntil: new Date(claimUntil).toISOString(),
      serverTime: now.toISOString(),
      xp,
      level: season.tiers.filter(tier => xp >= tier.xp).length,
      dailyMatches,
      dailyMatchCap: season.dailyMatchCap,
      active,
      claimOpen,
      upcoming: +now < start,
      premium: { owned, currency: season.premium.currency, cost: season.premium.cost },
      next: following ? { id: following.id, title: following.title, startsAt: following.startsAt } : null,
      tiers: season.tiers.map(tier => ({
        id: tier.id,
        xp: tier.xp,
        free: view(tier, "free"),
        premium: view(tier, "premium"),
      })),
    };
  }

  /**
   * Buys the premium track of a season that is running or in claim grace. Stars go through the credit ledger and gems
   * through the wallet, in one transaction; owning the track already (or a cost of 0, which gives it to everyone)
   * charges nothing.
   */
  buyPremium(userId: string, seasonId: string): Promise<SeasonView> {
    return this.db.transaction(async () => {
      await this.db.lockUsers([userId]);
      const before = await this.state(userId, seasonId);
      if (before.premium.owned) return before;
      if (!before.claimOpen) throw new ApiError(409, "This season's premium track is not on sale.");
      const policy = await this.load(before.id, true);
      const { currency, cost } = policy.premium;
      await this.collection.init(userId);
      if (cost > 0 && currency === "credits") {
        if (!(await this.collection.spend(userId, "pass:" + policy.id, cost)))
          throw new ApiError(409, "Not enough Stars.");
      } else if (cost > 0) {
        if ((await this.collectionRecords.wallet(userId)).shards < cost) throw new ApiError(409, "Not enough gems.");
        await this.collectionRecords.spendShards(userId, cost);
      }
      await this.seasons.buyPremium(userId, policy.id, +this.clock());
      return this.state(userId, policy.id);
    });
  }

  /** Pays one reward: Stars once per source, shards, and the character (its duplicate shards if already owned). */
  private async pay(userId: string, seasonId: string, tier: TierView, track: PassTrack): Promise<void> {
    const reward = tier[track];
    await this.seasons.claim(userId, seasonId, tier.id, track);
    await this.collection.init(userId);
    const source = "season:" + seasonId + ":" + tier.id + (track === "premium" ? ":premium" : "");
    await this.collection.reward(userId, source, reward.credits);
    let shards = reward.shards;
    if (reward.characterId && !(await this.collectionRecords.grantCharacter(userId, reward.characterId))) {
      const character = this.collection.catalog.characters.find(candidate => candidate.id === reward.characterId);
      shards += character?.duplicateShards ?? 0;
    }
    if (shards > 0) await this.collectionRecords.addShards(userId, shards);
  }

  /** Claims one reward of a tier; claiming it again returns the state, a reward not yet unlocked is a 409. */
  async claim(userId: string, seasonId: string, tierId: string, track: string = "free"): Promise<SeasonView> {
    if (!(TRACKS as readonly string[]).includes(track)) throw new ApiError(400, "Unknown reward track.");
    return this.db.transaction(async () => {
      await this.db.lockUsers([userId]);
      const state = await this.state(userId, seasonId);
      const tier = state.tiers.find(candidate => candidate.id === tierId);
      if (!tier) throw new ApiError(400, "Unknown season reward.");
      const entry = tier[track as PassTrack];
      if (entry.claimed) return state;
      if (!entry.claimable) throw new ApiError(409, "Season reward unavailable or not unlocked.");
      await this.pay(userId, state.id, tier, track as PassTrack);
      return this.state(userId, state.id);
    });
  }

  /** Claims every reward that is claimable now, on both tracks, in one transaction. */
  claimAll(userId: string, seasonId: string): Promise<SeasonView> {
    return this.db.transaction(async () => {
      await this.db.lockUsers([userId]);
      const state = await this.state(userId, seasonId);
      for (const tier of state.tiers) {
        for (const track of TRACKS) if (tier[track].claimable) await this.pay(userId, state.id, tier, track);
      }
      return this.state(userId, state.id);
    });
  }
}
