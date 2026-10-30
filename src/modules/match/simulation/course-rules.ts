import type { CourseDefinition, PartyConfig, PlatformDefinition } from "../../content/content.types.js";

// Course motion is a pure function of match time, so the Unity client draws it with no network error.
// Mirrored by Core/Simulation/CourseRules.cs.

export const isSurvival = (course: CourseDefinition) => ["survival", "lava", "tiles"].includes(course.kind);

/** Where a platform's centre is at this match time; `y` is its top there (the mid-height of a ramp). */
export function platformPosition(platform: PlatformDefinition, time: number) {
  const angle = time * (platform.motionSpeed || 0) + (platform.motionPhase || 0);
  return {
    x: platform.x + Math.sin(angle) * (platform.motionX || 0),
    y: (platform.y || 0) + Math.sin(angle) * (platform.motionY || 0),
    z: platform.z + Math.sin(angle) * (platform.motionZ || 0),
  };
}

/** Height of a platform top at this z: flat, or a ramp climbing `rise` metres from its back to its front edge. */
export function platformTop(platform: PlatformDefinition, center: { y: number; z: number }, z: number): number {
  if (!platform.rise) return center.y;
  const half = platform.depth / 2;
  const along = Math.max(-half, Math.min(half, z - center.z));
  return center.y + (along * platform.rise) / platform.depth;
}

/** Hazard motion lives in hazards/, one file per kind. */
export { hazardPosition } from "./hazards/index.js";

export interface MatchOptions {
  mode?: string;
  playlist?: string;
  courseId?: string;
  seed?: number;
  /** Lobby: humans needed before the match may start. */
  minPlayers?: number;
  /** Lobby: empty seats are filled with bots when the match starts. */
  fillBots?: boolean;
  /** Lobby: most bots added at the start; negative means no limit. */
  maxBots?: number;
  /** Lobby: the match starts as soon as every human is ready. */
  readyCheck?: boolean;
  /** Lobby: seconds before the match starts on its own once enough humans are in; 0 leaves it to the other rules. */
  lobbySeconds?: number;
  /** Lobby: the match starts as soon as every seat holds a human. */
  startWhenFull?: boolean;
  /** Lobby: the host may start the match early, with the empty seats taken by bots or not (created rooms). */
  hostStart?: boolean;
}

/** When a lobby turns into a match. The defaults are the classic rule: start once every human is ready, bots fill. */
export interface LobbyRules {
  minPlayers: number;
  fillBots: boolean;
  maxBots: number;
  readyCheck: boolean;
  lobbySeconds: number;
  startWhenFull: boolean;
  hostStart: boolean;
}

export function lobbyRules(options: MatchOptions = {}): LobbyRules {
  return {
    minPlayers: Math.max(1, Math.floor(options.minPlayers ?? 1)),
    fillBots: options.fillBots ?? true,
    maxBots: Math.floor(options.maxBots ?? -1),
    readyCheck: options.readyCheck ?? true,
    lobbySeconds: Math.max(0, options.lobbySeconds ?? 0),
    startWhenFull: options.startWhenFull ?? false,
    hostStart: options.hostStart ?? false,
  };
}

export interface MatchRules {
  mode: string;
  playlist: string;
  teamSize: number;
  /** Course indices in config.courses, one per round. */
  indices: number[];
}

/** Resolves the mode and playlist a lobby asked for into the course order of the match. */
/** Modes played on one chosen course; the others play a playlist. */
export const usesCourse = (modeId: string) => ["race", "timeTrial", "survival", "arcade"].includes(modeId);

export function matchRules(config: PartyConfig, options: MatchOptions = {}): MatchRules {
  const mode = config.modes.find(candidate => candidate.id === (options.mode || "tournament"));
  const playlist = config.playlists.find(candidate => candidate.id === (options.playlist || "classic"));
  if (!mode || !playlist) throw new Error("Unknown mode or playlist");
  let courseIds = playlist.courseIds;
  let seed = (options.seed || 1) >>> 0;
  // Linear congruential roll: the same seed always draws the same courses, on the server and offline alike.
  const roll = (count: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % count;
  };
  if (playlist.shuffle) {
    // One draw per round from its pool (config.roundDraw), never a course twice while the pool has others.
    const played = new Set<string>();
    courseIds = config.roundDraw.rounds.map(round => {
      const listed = round.courseIds ?? [];
      const pool = listed.length
        ? config.courses.filter(course => listed.includes(course.id))
        : config.courses.filter(course => round.kinds.includes(course.kind));
      const fresh = pool.filter(course => !played.has(course.id));
      const from = fresh.length ? fresh : pool;
      const course = from[roll(from.length)];
      played.add(course.id);
      return course.id;
    });
  }
  if (usesCourse(mode.id)) {
    const candidates = config.courses.filter(course =>
      mode.id === "arcade" ? true : mode.id === "survival" ? isSurvival(course) : course.kind === "race",
    );
    // The course the player chose, or a drawn one.
    const chosen = candidates.find(course => course.id === options.courseId);
    courseIds = [(chosen ?? candidates[roll(candidates.length)]).id];
  }
  return {
    mode: mode.id,
    playlist: playlist.id,
    teamSize: mode.teamSize,
    indices: courseIds.map(id => config.courses.findIndex(course => course.id === id)),
  };
}
