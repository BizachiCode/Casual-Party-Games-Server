import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gameConfigDirectory } from "../../config/paths.js";
import type { CharacterCatalog, PartyConfig } from "../content/content.types.js";
import { isSurvival, usesCourse } from "../match/simulation/course-rules.js";
import type { QueueDefinition } from "../matchmaking/matchmaking.types.js";

export type EventMetric = "matches" | "wins";

/** One mission of an event, counted on its own occurrence. */
export interface EventGoalDefinition {
  id: string;
  title: string;
  metric: EventMetric;
  target: number;
  credits: number;
  shards: number;
  /** Battle pass XP paid with the reward. */
  passXp: number;
  /** "" or a catalog character; an owner gets its duplicate shards instead. */
  characterId: string;
}

/**
 * A timed event: a matchmaking queue played on a fixed playlist or course, with missions. The first occurrence spans
 * [startsAt, endsAt); with `repeatDays` it starts over every that many days.
 */
export interface EventDefinition {
  id: string;
  title: string;
  /** ISO instants, UTC. */
  startsAt: string;
  endsAt: string;
  /** 0 for a single window, else the days between the starts of two occurrences (1..366). */
  repeatDays: number;
  /** Matchmaking queue the event is searched in. */
  queue: string;
  /** Playlist of a playlist mode; "" or informative for a mode played on one course. */
  playlist: string;
  /** Course of a mode played on one course; ignored by the playlist modes. */
  courseId: string;
  minLevel: number;
  goals: EventGoalDefinition[];
}

export interface EventCatalog {
  version: 1;
  events: EventDefinition[];
}

/** What the catalog is checked against: the game's courses and playlists, the queues and the characters. */
export interface EventCatalogContext {
  config: PartyConfig;
  queues: QueueDefinition[];
  characters: CharacterCatalog;
}

export const DAY_MS = 86400000;
const MAX_EVENTS = 100;
const MAX_GOALS = 10;
/** Modes that pay no Stars, so a finished match never counts toward an event (same rule as ranking and season). */
const UNRANKED_MODES = ["arcade", "timeTrial"];
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** game_config/events.json, or the file in PARTY_EVENTS_CATALOG. */
export function loadEventCatalog(path = join(gameConfigDirectory, "events.json")): EventCatalog {
  return JSON.parse(readFileSync(path, "utf8"));
}

const integer = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 120;
const instant = (value: unknown) =>
  typeof value === "string" && INSTANT_PATTERN.test(value) && Number.isFinite(Date.parse(value));

function invalid(subject: string, detail: string): never {
  throw new Error("Invalid events catalog: " + subject + " " + detail);
}

function validateGoal(event: EventDefinition, goal: EventGoalDefinition, context: EventCatalogContext): void {
  const subject = 'event "' + event.id + '" goal "' + goal?.id + '"';
  if (typeof goal?.id !== "string" || !ID_PATTERN.test(goal.id)) invalid(subject, "needs an id of a-z, 0-9 and -.");
  if (!text(goal.title)) invalid(subject, "needs a title of 1 to 120 characters.");
  if (goal.metric !== "matches" && goal.metric !== "wins") invalid(subject, 'metric must be "matches" or "wins".');
  if (!integer(goal.target, 1, 1000)) invalid(subject, "target must be an integer from 1 to 1000.");
  if (!integer(goal.credits, 0, 10000)) invalid(subject, "credits must be an integer from 0 to 10000.");
  if (!integer(goal.shards, 0, 1000)) invalid(subject, "shards must be an integer from 0 to 1000.");
  if (!integer(goal.passXp, 0, 10000)) invalid(subject, "passXp must be an integer from 0 to 10000.");
  if (
    typeof goal.characterId !== "string" ||
    (goal.characterId && !context.characters.characters.some(character => character.id === goal.characterId))
  )
    invalid(subject, 'characterId "' + goal.characterId + '" is not a catalog character.');
}

/** The course a mode played on one course accepts: the same pick matchRules makes. */
function fitsMode(mode: string, course: PartyConfig["courses"][number]): boolean {
  if (mode === "arcade") return true;
  return mode === "survival" ? isSurvival(course) : course.kind === "race";
}

function validateEvent(event: EventDefinition, context: EventCatalogContext): void {
  const subject = 'event "' + event?.id + '"';
  if (typeof event?.id !== "string" || !ID_PATTERN.test(event.id)) invalid(subject, "needs an id of a-z, 0-9 and -.");
  if (!text(event.title)) invalid(subject, "needs a title of 1 to 120 characters.");
  if (!instant(event.startsAt) || !instant(event.endsAt))
    invalid(subject, "startsAt and endsAt must be UTC instants like 2026-10-30T00:00:00.000Z.");
  const length = Date.parse(event.endsAt) - Date.parse(event.startsAt);
  if (length <= 0) invalid(subject, "must end after it starts.");
  if (!integer(event.repeatDays, 0, 366)) invalid(subject, "repeatDays must be an integer from 0 to 366.");
  if (event.repeatDays && event.repeatDays * DAY_MS < length)
    invalid(
      subject,
      "repeats every " + event.repeatDays + " days, which is shorter than the event, so it would overlap.",
    );
  if (!integer(event.minLevel, 1, 100)) invalid(subject, "minLevel must be an integer from 1 to 100.");
  const queue = context.queues.find(candidate => candidate.id === event.queue);
  if (!queue) invalid(subject, 'queue "' + event.queue + '" is not a matchmaking queue.');
  if (UNRANKED_MODES.includes(queue.mode))
    invalid(subject, 'queue "' + queue.id + '" is unranked, so its matches never count toward an event.');
  if (typeof event.playlist !== "string" || typeof event.courseId !== "string")
    invalid(subject, "playlist and courseId must be text (empty for none).");
  const playlist = context.config.playlists.find(candidate => candidate.id === event.playlist);
  if (event.playlist && !playlist) invalid(subject, 'playlist "' + event.playlist + '" does not exist.');
  const course = context.config.courses.find(candidate => candidate.id === event.courseId);
  if (event.courseId && !course) invalid(subject, 'course "' + event.courseId + '" does not exist.');
  if (usesCourse(queue.mode)) {
    if (!course) invalid(subject, 'queue "' + queue.id + '" plays one course, so courseId is required.');
    if (!fitsMode(queue.mode, course))
      invalid(subject, 'course "' + course.id + '" cannot be played in the ' + queue.mode + " mode.");
  } else if (!playlist) {
    invalid(subject, 'queue "' + queue.id + '" plays a playlist, so playlist is required.');
  }
  if (!Array.isArray(event.goals) || event.goals.length > MAX_GOALS)
    invalid(subject, "needs at most " + MAX_GOALS + " goals.");
  const ids = new Set<string>();
  for (const goal of event.goals) {
    validateGoal(event, goal, context);
    if (ids.has(goal.id)) invalid(subject, 'has the goal id "' + goal.id + '" twice.');
    ids.add(goal.id);
  }
}

/** Throws unless the catalog is well formed and every queue, playlist, course and character in it exists. */
export function validateEventCatalog(catalog: EventCatalog, context: EventCatalogContext): void {
  if (catalog?.version !== 1 || !Array.isArray(catalog.events) || catalog.events.length > MAX_EVENTS)
    invalid("catalog", "needs version 1 and at most " + MAX_EVENTS + " events.");
  const ids = new Set<string>();
  for (const event of catalog.events) {
    validateEvent(event, context);
    if (ids.has(event.id)) invalid('event "' + event.id + '"', "appears twice.");
    ids.add(event.id);
  }
}
