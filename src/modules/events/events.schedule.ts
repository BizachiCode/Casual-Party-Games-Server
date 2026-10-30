import { DAY_MS, type EventDefinition } from "./events.catalog.js";

/** One run of an event: the window [startsAt, endsAt) in epoch milliseconds, and the key progress is stored under. */
export interface Occurrence {
  eventId: string;
  index: number;
  startsAt: number;
  endsAt: number;
  /** `<event id>@<UTC start date>`; occurrences are at least a day apart, so the key is unique. */
  key: string;
}

type Schedule = Pick<EventDefinition, "id" | "startsAt" | "endsAt" | "repeatDays">;

/** Occurrence `index` (0 is the first window) of the event. */
export function occurrenceOf(event: Schedule, index: number): Occurrence {
  const offset = index * event.repeatDays * DAY_MS;
  const startsAt = Date.parse(event.startsAt) + offset;
  return {
    eventId: event.id,
    index,
    startsAt,
    endsAt: Date.parse(event.endsAt) + offset,
    key: event.id + "@" + new Date(startsAt).toISOString().slice(0, 10),
  };
}

/** Index of the latest occurrence that has started by `now`, or -1 before the first one. */
function latestStarted(event: Schedule, now: number): number {
  const first = Date.parse(event.startsAt);
  if (now < first) return -1;
  return event.repeatDays ? Math.floor((now - first) / (event.repeatDays * DAY_MS)) : 0;
}

/** The occurrence running at `now`, if any. */
export function currentOccurrence(event: Schedule, now: number): Occurrence | null {
  const index = latestStarted(event, now);
  if (index < 0) return null;
  const occurrence = occurrenceOf(event, index);
  return now < occurrence.endsAt ? occurrence : null;
}

/** The first occurrence that starts after `now`; none once a single-window event has begun. */
export function nextOccurrence(event: Schedule, now: number): Occurrence | null {
  const index = latestStarted(event, now);
  if (index < 0) return occurrenceOf(event, 0);
  return event.repeatDays ? occurrenceOf(event, index + 1) : null;
}

/** The latest occurrence that has already ended at `now`, if any. */
export function lastEndedOccurrence(event: Schedule, now: number): Occurrence | null {
  const index = latestStarted(event, now);
  if (index < 0) return null;
  const latest = occurrenceOf(event, index);
  if (now >= latest.endsAt) return latest;
  return index > 0 ? occurrenceOf(event, index - 1) : null;
}
