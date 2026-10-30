import type { Database } from "../../infrastructure/database/database.js";
import { ApiError } from "../../shared/errors.js";
import type { PartyContent } from "../content/content.types.js";
import { currentOccurrence, lastEndedOccurrence, nextOccurrence } from "../events/events.schedule.js";
import type { EventService } from "../events/events.service.js";
import type { MatchRegistry } from "../match/match-registry.js";
import type { MatchmakingService } from "../matchmaking/matchmaking.service.js";
import type { OperationsService } from "../operations/operations.service.js";
import type { PresenceService } from "../presence/presence.service.js";
import type { RankingService } from "../ranking/ranking.service.js";
import { seasonWindow } from "../season/season.catalog.js";
import type { SeasonService } from "../season/season.service.js";
import type { SquadRegistry } from "../squad/squad-registry.js";
import type { AccountCounts, AdminInsightsRepository, EconomyTotals } from "./admin-insights.repository.js";

export interface AdminInsightsDependencies {
  db: Database;
  records: AdminInsightsRepository;
  content: PartyContent;
  matchmaking: MatchmakingService;
  seasons: SeasonService;
  events: EventService;
  rankings: RankingService;
  operations: OperationsService;
  matches: MatchRegistry;
  squads: SquadRegistry;
  clock: () => Date;
  /** Who is online; without it `onlineNow` counts the accounts seated in matches instead. */
  presence?: PresenceService;
}

const DAY_MS = 86400000;
const ACTIVITY_DAYS = 14;

/** GET /overview. */
export interface Overview {
  service: ReturnType<OperationsService["metrics"]> & { squads: number; partyMembers: number; searching: number };
  accounts: AccountCounts & { onlineNow: number };
  reports: { open: number };
  economy: EconomyTotals & { premium: { seasonId: string; owners: number } | null };
  activity: {
    /** 14 UTC days, oldest first, today last. */
    days: string[];
    newAccounts: number[];
    /** Distinct players with a finished match that day. */
    players: number[];
    matches: number[];
    wins: number[];
  };
  season: { id: string; startsAt: number; endsAt: number } | null;
}

/** GET /catalog. Times are milliseconds since the epoch. */
export interface CatalogView {
  protocol: number;
  revision: string;
  initialCredits: number;
  dailyCredits: number;
  starterId: string;
  characters: { id: string; name: string; rarity: string; craftCost: number; duplicateShards: number }[];
  banners: { id: string; name: string; cost: number; tenCost: number }[];
  courses: { id: string; name: string; kind: string }[];
  playlists: { id: string; name: string; courseIds: string[]; shuffle: boolean }[];
  modes: { id: string; name: string; teamSize: number }[];
  queues: {
    id: string;
    mode: string;
    minPlayers: number;
    maxPlayers: number;
    searchSeconds: number;
    fillBots: boolean;
  }[];
  seasons: {
    id: string;
    name: string;
    startsAt: number;
    endsAt: number;
    tiers: number;
    premiumCost: number;
    premiumCurrency: string;
    running: boolean;
  }[];
  events: {
    id: string;
    name: string;
    queue: string;
    playlist: string;
    courseId: string;
    minLevel: number;
    /** The window running now, else the next one, else the last one. */
    startsAt: number;
    endsAt: number;
    repeatDays: number;
    running: boolean;
  }[];
  goals: {
    id: string;
    name: string;
    scope: string;
    metric: string;
    target: number;
    credits: number;
    xp: number;
    passXp: number;
  }[];
}

/** GET /rankings: the board players see, every row carrying the account id. */
export type RankingsView = Awaited<ReturnType<RankingService["board"]>>;

/** The GM overview (service, accounts, economy, charts), the content catalog and the leaderboards. */
export class AdminInsightsService {
  constructor(private readonly deps: AdminInsightsDependencies) {}

  async overview(): Promise<Overview> {
    const { records, operations, squads, matchmaking, seasons, matches, presence } = this.deps;
    const now = +this.deps.clock();
    const running = seasons.current();
    const online = presence
      ? presence.onlineIds().length
      : new Set(matches.all().flatMap(room => [...room.accounts.values()])).size;
    return {
      service: {
        ...operations.metrics(),
        squads: squads.all().length,
        partyMembers: squads.all().reduce((sum, room) => sum + room.size, 0),
        searching: matchmaking.searchingCount,
      },
      accounts: { ...(await records.accounts(now)), onlineNow: online },
      reports: { open: await records.openReports() },
      economy: {
        ...(await records.economy()),
        premium: running ? { seasonId: running.id, owners: await records.premiumOwners(running.id) } : null,
      },
      activity: await this.activity(now),
      season: running
        ? { id: running.id, startsAt: Date.parse(running.startsAt), endsAt: Date.parse(running.endsAt) }
        : null,
    };
  }

  /** The last 14 UTC days (today last), with a zero for every day nothing happened. */
  private async activity(now: number): Promise<Overview["activity"]> {
    const today = Math.floor(now / DAY_MS) * DAY_MS;
    const dayStarts = Array.from({ length: ACTIVITY_DAYS }, (_, i) => today - (ACTIVITY_DAYS - 1 - i) * DAY_MS);
    const days = dayStarts.map(start => new Date(start).toISOString().slice(0, 10));
    const created = await this.deps.records.newAccountsByDay(dayStarts[0]);
    const played = new Map((await this.deps.records.playDays(days[0])).map(entry => [entry.day, entry]));
    return {
      days,
      newAccounts: dayStarts.map(start => created.get(start) ?? 0),
      players: days.map(day => played.get(day)?.players ?? 0),
      matches: days.map(day => played.get(day)?.matches ?? 0),
      wins: days.map(day => played.get(day)?.wins ?? 0),
    };
  }

  async catalog(): Promise<CatalogView> {
    const { content, matchmaking, seasons, events } = this.deps;
    const { config, characterCatalog, goalCatalog } = content;
    const now = +this.deps.clock();
    const running = seasons.current();
    return {
      protocol: config.protocol,
      revision: config.revision,
      initialCredits: characterCatalog.initialCredits,
      dailyCredits: characterCatalog.dailyCredits,
      starterId: characterCatalog.starterId,
      characters: characterCatalog.characters.map(character => ({
        id: character.id,
        name: character.name,
        rarity: character.rarity,
        craftCost: character.craftCost,
        duplicateShards: character.duplicateShards,
      })),
      banners: characterCatalog.banners.map(banner => ({
        id: banner.id,
        name: banner.title,
        cost: banner.cost,
        tenCost: banner.tenCost,
      })),
      courses: config.courses.map(course => ({ id: course.id, name: course.title, kind: course.kind })),
      playlists: config.playlists.map(playlist => ({
        id: playlist.id,
        name: playlist.title,
        courseIds: playlist.courseIds,
        shuffle: !!playlist.shuffle,
      })),
      modes: config.modes.map(mode => ({ id: mode.id, name: mode.title, teamSize: mode.teamSize })),
      queues: matchmaking.catalog.queues.map(queue => ({
        id: queue.id,
        mode: queue.mode,
        minPlayers: queue.players.min,
        maxPlayers: queue.players.max,
        searchSeconds: queue.search.seconds,
        fillBots: queue.bots.fill,
      })),
      seasons: (await seasons.seasonSchedule()).map(season => ({
        id: season.id,
        name: season.title,
        startsAt: seasonWindow(season).start,
        endsAt: seasonWindow(season).end,
        tiers: season.tiers.length,
        premiumCost: season.premium.cost,
        premiumCurrency: season.premium.currency,
        running: season.id === running?.id,
      })),
      events: events.definitions().map(event => {
        const current = currentOccurrence(event, now);
        const window = current ?? nextOccurrence(event, now) ?? lastEndedOccurrence(event, now);
        return {
          id: event.id,
          name: event.title,
          queue: event.queue,
          playlist: event.playlist,
          courseId: event.courseId,
          minLevel: event.minLevel,
          startsAt: window?.startsAt ?? Date.parse(event.startsAt),
          endsAt: window?.endsAt ?? Date.parse(event.endsAt),
          repeatDays: event.repeatDays,
          running: !!current,
        };
      }),
      goals: goalCatalog.goals.map(goal => ({
        id: goal.id,
        name: goal.title,
        scope: goal.scope,
        metric: goal.metric,
        target: goal.target,
        credits: goal.credits,
        xp: goal.xp,
        passXp: goal.passXp ?? 0,
      })),
    };
  }

  /** The board as players see it (same rows, same paging); the friends board needs a viewer, so it is refused. */
  rankings(query: { board?: unknown; mode?: unknown; courseId?: unknown; offset?: unknown }): Promise<RankingsView> {
    if (query.board === "friends")
      throw new ApiError(400, "The friends ranking depends on the player who looks at it.");
    return this.deps.rankings.board(query);
  }
}
