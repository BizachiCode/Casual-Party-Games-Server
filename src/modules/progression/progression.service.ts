import type { Database } from "../../infrastructure/database/database.js";
import { ApiError } from "../../shared/errors.js";
import type { AccountService } from "../account/account.service.js";
import type { CollectionService } from "../collection/collection.service.js";
import type { GoalCatalog } from "../content/content.types.js";
import type { MatchSnapshot } from "../match/simulation/party-simulation.js";
import type { MatchReward } from "../ranking/ranking.service.js";
import type { ProgressionRepository } from "./progression.repository.js";

const DAY_MS = 86400000;

/** Where claimed goals send their battle pass XP: SeasonService.grantXp. */
export interface PassXpSink {
  grantXp(userId: string, receiptKey: string, xp: number): Promise<number>;
}

/** The Monday (UTC) of the ISO week that contains `moment`, as YYYY-MM-DD. */
export function weekStart(moment: Date): string {
  const midnight = Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate());
  const daysSinceMonday = (moment.getUTCDay() + 6) % 7;
  return new Date(midnight - daysSinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Daily and weekly missions and lifetime achievements. Progress is derived from server receipts, the profile and the
 * collection, never from client counters; a claim pays Stars, XP and battle pass XP once per period (a UTC day, an ISO
 * week, or for good).
 */
export class ProgressionService {
  constructor(
    private readonly db: Database,
    private readonly progression: ProgressionRepository,
    private readonly catalog: GoalCatalog,
    private readonly accounts: AccountService,
    private readonly collection: CollectionService,
    private readonly clock: () => Date = () => new Date(),
    private readonly seasons?: PassXpSink,
  ) {
    const ids = new Set<string>();
    for (const goal of catalog.goals) {
      const metrics =
        goal.scope === "achievement" ? ["matches", "wins", "level", "collection"] : ["matches", "wins", "teams"];
      if (
        ids.has(goal.id) ||
        !/^[a-z0-9-]+$/.test(goal.id) ||
        !["daily", "weekly", "achievement"].includes(goal.scope) ||
        !metrics.includes(goal.metric) ||
        !Number.isSafeInteger(goal.target) ||
        goal.target < 1 ||
        !Number.isSafeInteger(goal.credits) ||
        goal.credits < 0 ||
        !Number.isSafeInteger(goal.xp) ||
        goal.xp < 0 ||
        !Number.isSafeInteger(goal.passXp ?? 0) ||
        (goal.passXp ?? 0) < 0 ||
        (goal.passXp ?? 0) > 10000
      )
        throw new Error("Invalid mission catalogue.");
      ids.add(goal.id);
    }
  }

  private day(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  /** Counts a finished match toward today's goals for every account that earned Stars in it. */
  async record(matchId: string, state: MatchSnapshot, rewards: MatchReward[]): Promise<void> {
    for (const reward of rewards) {
      if (!reward.credits) continue;
      if (await this.progression.countMatch(reward.id, matchId)) {
        await this.progression.addDaily(reward.id, this.day(), reward.won, ["duos", "squads"].includes(state.mode));
      }
    }
  }

  async state(id: string) {
    const now = this.clock();
    const day = now.toISOString().slice(0, 10);
    const week = weekStart(now);
    const profile = await this.accounts.profile(id);
    const inventory = await this.collection.state(id);
    const totals: Record<string, Record<string, number>> = {
      daily: { ...(await this.progression.daily(id, day)) },
      weekly: { ...(await this.progression.range(id, week, day)) },
      achievement: {
        matches: profile.matches,
        wins: profile.wins,
        level: profile.level,
        collection: inventory.owned.length,
      },
    };
    const goals = await Promise.all(
      this.catalog.goals.map(async goal => {
        const claimed = await this.progression.claimed(id, goal.id, this.period(goal.scope, day, week));
        const current = totals[goal.scope][goal.metric] || 0;
        return { ...goal, passXp: goal.passXp ?? 0, current, claimed, claimable: !claimed && current >= goal.target };
      }),
    );
    return {
      day,
      week,
      dayEndsAt: new Date(Date.parse(day) + DAY_MS).toISOString(),
      weekEndsAt: new Date(Date.parse(week) + 7 * DAY_MS).toISOString(),
      goals,
    };
  }

  /** The claim key of a goal: today, this week ("week:<Monday>") or "lifetime". */
  private period(scope: string, day: string, week: string): string {
    return scope === "daily" ? day : scope === "weekly" ? "week:" + week : "lifetime";
  }

  claim(id: string, goalId: unknown) {
    return this.db.transaction(async () => {
      await this.db.lockUsers([id]);
      const { day, week, goals } = await this.state(id);
      const goal = goals.find(candidate => candidate.id === goalId);
      if (!goal) throw new ApiError(400, "Unknown goal.");
      if (goal.claimed) return this.state(id); // A retry after a lost response is safe.
      if (!goal.claimable) throw new ApiError(409, "Goal not completed.");
      const period = this.period(goal.scope, day, week);
      const source = "goal:" + period + ":" + goal.id;
      await this.progression.claim(id, goal.id, period);
      await this.collection.reward(id, source, goal.credits);
      await this.progression.addXp(id, goal.xp);
      await this.seasons?.grantXp(id, source, goal.passXp);
      return this.state(id);
    });
  }
}
