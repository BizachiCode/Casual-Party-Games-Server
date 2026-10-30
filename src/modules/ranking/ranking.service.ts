import type { Database } from "../../infrastructure/database/database.js";
import { ApiError } from "../../shared/errors.js";
import type { PartyConfig } from "../content/content.types.js";
import type { MatchSnapshot } from "../match/simulation/party-simulation.js";
import type { RankingRepository } from "./ranking.repository.js";

/** Stars owed to an account for one finished match; the reward service pays them. */
export interface MatchReward {
  id: string;
  won: boolean;
  credits: number;
}

const BOARDS = ["wins", "points", "season", "mode", "timeTrial", "friends", "level"];
const UNRANKED_MODES = ["arcade", "timeTrial"];

/** Profile totals, monthly (UTC) rankings and time-trial records from finished matches. */
export class RankingService {
  constructor(
    private readonly db: Database,
    private readonly rankings: RankingRepository,
    private readonly config: PartyConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  season(): string {
    return this.clock().toISOString().slice(0, 7);
  }

  /**
   * Records a finished match once per account. Ranked boards count only matches with at least two signed-in players;
   * arcade and time trial give no XP or Stars.
   */
  recordMatch(matchId: string, state: MatchSnapshot, accounts: Map<string, string>): Promise<MatchReward[]> {
    if (state.phase !== "finished") throw new Error("Only finished authority results may be recorded.");
    return this.db.transaction(async () => {
      await this.db.lockUsers(accounts.values());
      const ranked =
        !UNRANKED_MODES.includes(state.mode) &&
        state.players.filter(player => !player.bot && accounts.has(player.id)).length >= 2;
      const rewards: MatchReward[] = [];
      for (const player of state.players) {
        const id = accounts.get(player.id);
        if (!id || player.bot) continue;
        if (!(await this.rankings.recordReceipt(matchId, id))) continue;
        const won = state.winnerIds.includes(player.id) ? 1 : 0;
        const xp = UNRANKED_MODES.includes(state.mode) ? 0 : 25 + won * 75;
        await this.rankings.addProfileResult(id, xp, xp ? won : 0);
        if (ranked) await this.rankings.addRanking(id, state.mode, this.season(), won, Math.max(0, player.totalScore));
        if (state.mode === "timeTrial" && player.finishTime > 0)
          await this.rankings.recordTime(id, state.courseId, player.finishTime);
        rewards.push({ id, won: !!won, credits: xp ? 50 + won * 100 : 0 });
      }
      return rewards;
    });
  }

  async board(query: { board?: unknown; mode?: unknown; courseId?: unknown; offset?: unknown } = {}, viewerId = "") {
    const board = (query.board ?? "wins") as string;
    const mode = (query.mode ?? "tournament") as string;
    const courseId = (query.courseId ?? "") as string;
    if (!BOARDS.includes(board)) throw new ApiError(400, "Unknown ranking.");
    if (!this.config.modes.some(candidate => candidate.id === mode)) throw new ApiError(400, "Unknown mode.");
    const season = this.season();
    const offset = Math.floor(Math.max(0, Math.min(10000, Number(query.offset) || 0)));
    let rows;
    if (board === "timeTrial") {
      if (!this.config.courses.some(course => course.id === courseId && course.kind === "race"))
        throw new ApiError(400, "Select a race course.");
      rows = await this.rankings.timeTrial(courseId, offset);
    } else if (board === "level") {
      rows = await this.rankings.levels(offset);
    } else {
      if (board === "friends" && !viewerId) throw new ApiError(401, "Sign in for the friends ranking.");
      rows = await this.rankings.totals(
        board === "points" ? "points" : "wins",
        {
          season: board === "season" ? season : undefined,
          mode: board === "mode" ? mode : undefined,
          friendsOf: board === "friends" ? viewerId : undefined,
        },
        offset,
      );
    }
    return { board, mode, courseId, season, entries: rows.map((row, i) => ({ ...row, rank: offset + i + 1 })) };
  }
}
