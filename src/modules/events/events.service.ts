import { ServerError } from "colyseus";
import type { Database } from "../../infrastructure/database/database.js";
import { ApiError } from "../../shared/errors.js";
import type { CollectionRepository } from "../collection/collection.repository.js";
import type { CollectionService } from "../collection/collection.service.js";
import type { PartyConfig } from "../content/content.types.js";
import type { MatchSnapshot } from "../match/simulation/party-simulation.js";
import type { MatchmakingService } from "../matchmaking/matchmaking.service.js";
import type { MatchReward } from "../ranking/ranking.service.js";
import {
  DAY_MS,
  validateEventCatalog,
  type EventCatalog,
  type EventDefinition,
  type EventGoalDefinition,
} from "./events.catalog.js";
import type { EventRepository, EventTotals } from "./events.repository.js";
import { currentOccurrence, lastEndedOccurrence, nextOccurrence, type Occurrence } from "./events.schedule.js";

/** Upcoming events are announced this far ahead. */
const UPCOMING_MS = 14 * DAY_MS;
/** A finished occurrence can still be claimed for this long. */
const CLAIM_GRACE_MS = DAY_MS;

/** Where battle pass XP goes; the season service provides it. */
export interface PassXpSink {
  /** Adds XP to the current season once per `receiptKey`; returns the XP granted. */
  grantXp(userId: string, receiptKey: string, xp: number): Promise<number>;
}

/** A running event a player may search for: where it is played and the occurrence its matches count toward. */
export interface EventAdmission {
  eventId: string;
  queue: string;
  mode: string;
  playlist: string;
  courseId: string;
  minLevel: number;
  occurrence: string;
}

/** What the match rooms ask of the events: whether an event runs, and who may play it. */
export interface EventGate {
  /** The running event, in this queue. Throws a ServerError otherwise (unknown, over, wrong queue). */
  resolve(eventId: unknown, queue?: string): EventAdmission;
  /** Like resolve(), and the player must also have reached the event's minimum level (guests are level 1). */
  admit(eventId: unknown, queue: string, level: number): EventAdmission;
  /** Whether an occurrence of the event is running now. */
  isRunning(eventId: string): boolean;
}

/** An event as every client may see it. */
export interface EventListing {
  id: string;
  title: string;
  queue: string;
  mode: string;
  playlist: string;
  courseId: string;
  minLevel: number;
  active: boolean;
  startsAt: string;
  endsAt: string;
  goals: EventGoalDefinition[];
}

export interface EventGoalState extends EventGoalDefinition {
  current: number;
  claimed: boolean;
  claimable: boolean;
}

/** An event with one account's progress on an occurrence. */
export interface EventState extends Omit<EventListing, "goals"> {
  occurrence: string;
  matches: number;
  wins: number;
  goals: EventGoalState[];
}

interface Window {
  event: EventDefinition;
  occurrence: Occurrence;
  active: boolean;
}

/**
 * Timed events. The developer's catalog says when an event runs, in which queue and on which playlist or course;
 * the matchmaking room admits players to it, finished matches count toward the current occurrence, and its goals pay
 * Stars, shards, a character and battle pass XP once per occurrence.
 */
export class EventService implements EventGate {
  private readonly catalog: EventCatalog;
  private readonly modes = new Map<string, string>();

  constructor(
    private readonly db: Database,
    private readonly events: EventRepository,
    private readonly collection: CollectionService,
    private readonly collectionRecords: CollectionRepository,
    matchmaking: MatchmakingService,
    config: PartyConfig,
    catalog: EventCatalog,
    private readonly passes?: PassXpSink,
    private readonly clock: () => Date = () => new Date(),
  ) {
    validateEventCatalog(catalog, { config, queues: matchmaking.catalog.queues, characters: collection.catalog });
    this.catalog = structuredClone(catalog);
    for (const queue of matchmaking.catalog.queues) this.modes.set(queue.id, queue.mode);
  }

  private now(): number {
    return this.clock().getTime();
  }

  /** Every event of the catalog, for the GM console. */
  definitions(): EventDefinition[] {
    return structuredClone(this.catalog.events);
  }

  private definition(eventId: unknown): EventDefinition | undefined {
    return typeof eventId === "string" ? this.catalog.events.find(event => event.id === eventId) : undefined;
  }

  /** The running occurrence of every active event, and the next one of every event starting within two weeks. */
  private visibleWindows(now: number): Window[] {
    const windows: Window[] = [];
    for (const event of this.catalog.events) {
      const current = currentOccurrence(event, now);
      if (current) {
        windows.push({ event, occurrence: current, active: true });
        continue;
      }
      const next = nextOccurrence(event, now);
      if (next && next.startsAt - now <= UPCOMING_MS) windows.push({ event, occurrence: next, active: false });
    }
    return windows;
  }

  /** Occurrences of the event whose goals can be claimed: the running one and one that ended within a day. */
  private claimWindows(event: EventDefinition, now: number): Window[] {
    const windows: Window[] = [];
    const current = currentOccurrence(event, now);
    if (current) windows.push({ event, occurrence: current, active: true });
    const ended = lastEndedOccurrence(event, now);
    if (ended && now - ended.endsAt < CLAIM_GRACE_MS) windows.push({ event, occurrence: ended, active: false });
    return windows;
  }

  private static order(left: Window, right: Window): number {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return left.occurrence.startsAt - right.occurrence.startsAt || left.event.id.localeCompare(right.event.id);
  }

  private listing({ event, occurrence, active }: Window): EventListing {
    return {
      id: event.id,
      title: event.title,
      queue: event.queue,
      mode: this.modes.get(event.queue),
      playlist: event.playlist,
      courseId: event.courseId,
      minLevel: event.minLevel,
      active,
      startsAt: new Date(occurrence.startsAt).toISOString(),
      endsAt: new Date(occurrence.endsAt).toISOString(),
      goals: event.goals.map(goal => ({ ...goal })),
    };
  }

  /** The events anyone may see: active ones first, then the upcoming ones by start. */
  list() {
    const now = this.now();
    return {
      serverTime: new Date(now).toISOString(),
      events: this.visibleWindows(now)
        .sort(EventService.order)
        .map(window => this.listing(window)),
    };
  }

  private entry(window: Window, totals: EventTotals | undefined, claimed: Set<string> | undefined): EventState {
    const progress = totals ?? { matches: 0, wins: 0 };
    return {
      ...this.listing(window),
      occurrence: window.occurrence.key,
      matches: progress.matches,
      wins: progress.wins,
      goals: window.event.goals.map(goal => {
        const current = progress[goal.metric];
        const done = claimed?.has(goal.id) ?? false;
        return { ...goal, current, claimed: done, claimable: !done && current >= goal.target };
      }),
    };
  }

  /**
   * The same events with the account's progress. An occurrence that ended within a day is listed too while the
   * account still has a reward to claim from it.
   */
  async state(userId: string) {
    const now = this.now();
    const visible = this.visibleWindows(now);
    const grace = this.catalog.events.flatMap(event => this.claimWindows(event, now).filter(window => !window.active));
    const windows = [...visible, ...grace];
    const keys = windows.map(window => window.occurrence.key);
    const progress = await this.events.progress(userId, keys);
    const claims = await this.events.claimed(userId, keys);
    const entries = windows
      .map(window => ({
        window,
        state: this.entry(window, progress.get(window.occurrence.key), claims.get(window.occurrence.key)),
      }))
      .filter(({ window, state }) => visible.includes(window) || state.goals.some(goal => goal.claimable));
    return {
      serverTime: new Date(now).toISOString(),
      events: entries.sort((left, right) => EventService.order(left.window, right.window)).map(({ state }) => state),
    };
  }

  /**
   * Pays one goal of the running occurrence (or of one that ended less than a day ago): Stars, shards, a character
   * (its duplicate shards when owned) and battle pass XP, all keyed by occurrence and goal so a retry pays nothing
   * twice. Returns the new state.
   */
  async claim(userId: string, eventId: unknown, goalId: unknown) {
    if (typeof eventId !== "string" || typeof goalId !== "string")
      throw new ApiError(400, "Event and goal id required.");
    const event = this.definition(eventId);
    if (!event) throw new ApiError(400, "Unknown event.");
    const goal = event.goals.find(candidate => candidate.id === goalId);
    if (!goal) throw new ApiError(400, "Unknown goal.");
    return this.db.transaction(async () => {
      await this.db.lockUsers([userId]);
      const windows = this.claimWindows(event, this.now());
      if (!windows.length) throw new ApiError(409, "This event is not running.");
      const keys = windows.map(window => window.occurrence.key);
      const progress = await this.events.progress(userId, keys);
      const claims = await this.events.claimed(userId, keys);
      let alreadyClaimed = false;
      for (const { occurrence } of windows) {
        if (claims.get(occurrence.key)?.has(goal.id)) {
          alreadyClaimed = true;
          continue;
        }
        const totals = progress.get(occurrence.key) ?? { matches: 0, wins: 0 };
        if (totals[goal.metric] < goal.target) continue;
        await this.pay(userId, occurrence.key, goal);
        return this.state(userId);
      }
      if (alreadyClaimed) return this.state(userId); // A retry after a lost response is safe.
      throw new ApiError(409, "Goal not completed.");
    });
  }

  private async pay(userId: string, occurrence: string, goal: EventGoalDefinition): Promise<void> {
    const receipt = "event:" + occurrence + ":" + goal.id;
    await this.events.claim(userId, occurrence, goal.id);
    await this.collection.init(userId);
    await this.collection.reward(userId, receipt, goal.credits);
    let shards = goal.shards;
    // A character the player already owns pays its duplicate shards instead.
    if (goal.characterId && !(await this.collectionRecords.grantCharacter(userId, goal.characterId))) {
      shards += this.collection.catalog.characters.find(character => character.id === goal.characterId).duplicateShards;
    }
    if (shards > 0) await this.collectionRecords.addShards(userId, shards);
    await this.passes?.grantXp(userId, receipt, goal.passXp);
  }

  /**
   * Counts a finished event match toward the running occurrence for every account that earned Stars in it (humans of
   * a ranked mode), once per match; a win also counts a win. Nothing counts once the event is over.
   */
  async record(matchId: string, eventId: string, state: MatchSnapshot, rewards: MatchReward[]): Promise<void> {
    if (!eventId) return;
    if (state.phase !== "finished") throw new Error("Only finished authority results may advance an event.");
    const event = this.definition(eventId);
    if (!event || state.mode !== this.modes.get(event.queue)) return;
    const occurrence = currentOccurrence(event, this.now());
    if (!occurrence) return;
    await this.db.transaction(async () => {
      await this.db.lockUsers(rewards.map(reward => reward.id));
      for (const reward of rewards) {
        if (!reward.credits) continue;
        if (await this.events.countMatch(reward.id, matchId)) {
          await this.events.addMatch(reward.id, occurrence.key, reward.won);
        }
      }
    });
  }

  resolve(eventId: unknown, queue = ""): EventAdmission {
    const event = this.definition(eventId);
    if (!event) throw new ServerError(404, "Unknown event.");
    const occurrence = currentOccurrence(event, this.now());
    if (!occurrence) throw new ServerError(409, "This event is not running.");
    if (queue && queue !== event.queue) throw new ServerError(400, "This event is played in another queue.");
    return {
      eventId: event.id,
      queue: event.queue,
      mode: this.modes.get(event.queue),
      playlist: event.playlist,
      courseId: event.courseId,
      minLevel: event.minLevel,
      occurrence: occurrence.key,
    };
  }

  admit(eventId: unknown, queue: string, level: number): EventAdmission {
    const admission = this.resolve(eventId, queue);
    if (level < admission.minLevel)
      throw new ServerError(403, "Reach level " + admission.minLevel + " to play this event.");
    return admission;
  }

  /**
   * The characters that goals of this catalog still pay: those of events that repeat, and of events that ended less
   * than a day ago. A content release must keep them, as it keeps the characters of a running season.
   */
  promisedCharacters(): string[] {
    const now = this.now();
    const promised = new Set<string>();
    for (const event of this.catalog.events) {
      if (!event.repeatDays && now - Date.parse(event.endsAt) >= CLAIM_GRACE_MS) continue;
      for (const goal of event.goals) if (goal.characterId) promised.add(goal.characterId);
    }
    return [...promised];
  }

  isRunning(eventId: string): boolean {
    const event = this.definition(eventId);
    return !!event && !!currentOccurrence(event, this.now());
  }
}
