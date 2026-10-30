import { In } from "typeorm";
import type { Database } from "../../infrastructure/database/database.js";
import { User } from "../../infrastructure/database/entities/index.js";
import type { CollectionService } from "../collection/collection.service.js";
import type { EventService } from "../events/events.service.js";
import type { ProgressionService } from "../progression/progression.service.js";
import type { MatchReward, RankingService } from "../ranking/ranking.service.js";
import type { SeasonService } from "../season/season.service.js";
import type { MatchSnapshot } from "./simulation/party-simulation.js";

/**
 * Settles a finished match in one transaction: profile and ranking, Stars, daily goals, season XP and, for an event
 * match, event progress. Every step is keyed by the match id, so a retried settlement pays nothing twice. This is
 * the only link from gameplay to economy.
 */
export class MatchRewardService {
  constructor(
    private readonly db: Database,
    private readonly rankings: RankingService,
    private readonly collection: CollectionService,
    private readonly progression?: ProgressionService,
    private readonly seasons?: SeasonService,
    private readonly events?: EventService,
  ) {}

  /**
   * `accounts` maps session ids to account ids; guests and bots earn nothing. `eventId` is the timed event the room was
   * created for, if any: its rewarded accounts count the match toward the event.
   */
  complete(matchId: string, state: MatchSnapshot, accounts: Map<string, string>, eventId = ""): Promise<MatchReward[]> {
    return this.db.transaction(async () => {
      await this.db.lockUsers(accounts.values());
      // An account deleted while its match ran is gone (account deletion locks it too), so it earns nothing;
      // settling it would fail on its missing row and stop the whole settlement.
      accounts = await this.existing(accounts);
      const rewards = await this.rankings.recordMatch(matchId, state, accounts);
      for (const reward of rewards) await this.collection.reward(reward.id, "match:" + matchId, reward.credits);
      await this.progression?.record(matchId, state, rewards);
      await this.seasons?.record(matchId, state, accounts, rewards);
      await this.events?.record(matchId, eventId, state, rewards);
      return rewards;
    });
  }

  private async existing(accounts: Map<string, string>): Promise<Map<string, string>> {
    const ids = [...new Set(accounts.values())];
    if (!ids.length) return accounts;
    const rows = await this.db.repository(User).find({ where: { id: In(ids) }, select: { id: true } });
    const found = new Set(rows.map(row => row.id));
    return new Map([...accounts].filter(([, accountId]) => found.has(accountId)));
  }
}
