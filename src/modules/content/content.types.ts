// Shapes of the catalogs exported from Unity (Tools > Casual Party > Content > Exporter). The C# twins live in
// Assets/CasualPartyMultiplayer/Core/Backend/BackendProtocol.cs and Core/Collection.

export type CourseKind = "race" | "survival" | "lava" | "tiles" | "collect" | "hill";
export type FieldKind = "launch" | "wind" | "boost" | "slime" | "punch";

export interface PlatformDefinition {
  x: number;
  /** Height of the top at the centre (the mid-height of a ramp); never below 0. */
  y: number;
  z: number;
  width: number;
  depth: number;
  /** Metres the top climbs from the back edge (-Z) to the front edge (+Z); negative goes down. 0 is flat. */
  rise?: number;
  /** Thickness below the top. A solid platform (above 0) blocks runners lower than its top, like a wall. */
  height?: number;
  motionX?: number;
  /** Vertical sway of a lift, in metres, on the same clock as motionX/motionZ. */
  motionY?: number;
  motionZ?: number;
  motionSpeed?: number;
  motionPhase?: number;
  vanishDelay?: number;
  conveyorX?: number;
  conveyorZ?: number;
  slippery?: number;
}

export interface HazardDefinition {
  /** "" orbits, swingX/swingZ swing, bounce bobs, roll travels from its start along travelX/Y/Z and starts over. */
  kind?: "" | "swingX" | "swingZ" | "bounce" | "roll" | null;
  x: number;
  y: number;
  z: number;
  reach: number;
  speed: number;
  phase: number;
  radius: number;
  period?: number;
  onSeconds?: number;
  /** Horizontal speed a hit gives the runner, in m/s. 0 or absent uses the standard 11. */
  push?: number;
  /** Upward speed a hit gives the runner, in m/s. 0 or absent uses the standard 7. */
  lift?: number;
  /** Seconds without control after a hit. 0 or absent uses the standard 0.45. */
  stun?: number;
  /** Throw the runner without knocking it down: it stays on its feet and steers again once the stun ends. */
  fling?: boolean;
  /** Roll hazards: the path of one run, in metres; `speed` is metres per second along it. */
  travelX?: number;
  travelY?: number;
  travelZ?: number;
  /** Length along X, in metres: a log instead of a ball. 0 keeps the ball. */
  length?: number;
}

export interface PickupDefinition {
  x: number;
  y: number;
  z: number;
  value: number;
  respawnSeconds: number;
}

export interface CourseFieldDefinition {
  kind: FieldKind;
  x: number;
  y: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  strength?: number;
  duration?: number;
  flowX?: number;
  flowZ?: number;
  period?: number;
  onSeconds?: number;
  phase?: number;
}

export interface CourseDefinition {
  id: string;
  title: string;
  kind: CourseKind;
  finish: number;
  platforms: PlatformDefinition[];
  hazards: HazardDefinition[];
  checkpoints: number[];
  lavaStart: number;
  lavaSpeed: number;
  targetScore: number;
  hillRadius: number;
  pickups: PickupDefinition[];
  fields?: CourseFieldDefinition[];
}

export interface PlaylistDefinition {
  id: string;
  title: string;
  courseIds: string[];
  shuffle?: boolean;
}
export interface ModeDefinition {
  id: string;
  title: string;
  teamSize: number;
}

/**
 * Tuning for one skill (modules/match/simulation/skills). `kind` picks the behaviour; each kind reads only the
 * fields it documents and ignores the others.
 */
export interface SkillDefinition {
  id: string;
  kind: string;
  /** Dive: horizontal launch speed (faster runners keep their own). Punch: speed it throws a target at. */
  speed: number;
  /** Dive: upward speed from the ground. Punch: upward speed it gives a target. */
  lift: number;
  /** Dive: upward speed when used in the air (once per jump). */
  airLift: number;
  /** Dive: seconds lying on the belly after landing. */
  landedSeconds: number;
  /** Dive: seconds getting back up, without control. */
  recoverSeconds: number;
  /** Dive: slide deceleration in m/s² while landed and recovering. */
  friction: number;
  /** Seconds before it can be used again (dive: after getting up; action skills: after each use). */
  cooldownSeconds: number;
  /** Punch: metres it reaches. */
  reach?: number;
  /** Punch: degrees either side of the facing direction it reaches. */
  arc?: number;
  /** Punch: seconds a target has no control. */
  stun?: number;
  /** Punch: knock targets down (ragdoll until they land) instead of throwing them on their feet. */
  knockdown?: boolean;
  /** Punch: forward speed in m/s the swing starts with, a short dash (0 = none). */
  lunge?: number;
}

/** How one kind of bot plays; see modules/match/simulation/bots.ts. */
export interface BotProfile {
  id: string;
  /** Relative chance that a new bot plays this way. */
  weight: number;
  /** Each bot runs at a fixed fraction of full speed drawn from this range. */
  speedMin: number;
  speedMax: number;
  /** Metres it strays from the centre line (a lane picked per platform) and sways around it. */
  lane: number;
  sway: number;
  /** Metres its take-off varies around 1.5 m before a platform edge: early jumps fall short, late ones slip off. */
  jumpError: number;
  /** Chance, per platform edge, to forget to jump. */
  missChance: number;
  /** Chance, per platform, to dive across the gap after it. */
  diveChance: number;
  /** Chance to notice a log rolling down its lane and step out of the way. */
  dodgeChance: number;
  /** Chance per second to use the action skill (a punch) while it would reach someone. */
  actionChance: number;
  /** Chance per second to stop and hesitate, for half to one and a half times pauseSeconds. */
  pauseChance: number;
  pauseSeconds: number;
}

/** Bots: when they take the empty lobby seats and how they play. */
export interface BotSettings {
  /** Seconds after the lobby opens before the first bot joins. */
  joinDelay: number;
  /** Seconds between two bots joining, drawn between these. */
  joinIntervalMin: number;
  joinIntervalMax: number;
  profiles: BotProfile[];
}

/**
 * Where runners stand when a round starts or after a fall (see PartySimulation.respawn). Runners are 2 x radius
 * wide, so neighbours closer than that stand inside each other.
 */
export interface SpawnSettings {
  /** Race start line: runners per row, metres between two runners of a row and between two rows. */
  startPerRow: number;
  startColumnGap: number;
  startRowGap: number;
  /** Race start line: every other row shifts this far sideways, so rows do not line up. */
  startStagger: number;
  /** Race respawn behind a later checkpoint. Keep it compact: a checkpoint may have a gap behind it. */
  checkpointPerRow: number;
  checkpointColumnGap: number;
  checkpointRowGap: number;
  /** Survival, lava, tiles, crown and hill arenas: a grid around the centre. */
  arenaPerRow: number;
  arenaGap: number;
}

/** One round of a drawn playlist: the course kinds it draws from, or a list of courses that replaces them. */
export interface RoundPool {
  kinds: string[];
  /** Courses this round draws from, by id; when set it is used instead of `kinds` (missing or empty: by kind). */
  courseIds?: string[];
}

/** How drawn playlists pick their courses, and the map carousel shown before every round (see matchRules). */
export interface RoundDrawSettings {
  /** Seconds of the map carousel before each round's countdown; 0 shows none. */
  revealSeconds: number;
  /** One pool per round of a drawn ("shuffle") playlist; a match never plays a course twice while a pool has others. */
  rounds: RoundPool[];
}

/** How long a match room holds a lost seat and stays open once the match is over (see PartyRoom). */
export interface MatchRoomSettings {
  /** Seconds a runner whose connection dropped keeps the seat; never once eliminated or once the match is over. */
  reconnectSeconds: number;
  /** Seconds a finished match stays open after its results are stored; then the room closes. */
  closeAfterFinishSeconds: number;
}

export interface PartyConfig {
  protocol: number;
  revision: string;
  tickRate: number;
  maxPlayers: number;
  matchSize: number;
  raceSeconds: number;
  survivalSeconds: number;
  countdownSeconds: number;
  resultSeconds: number;
  scoreSeconds: number;
  speed: number;
  acceleration: number;
  gravity: number;
  jumpSpeed: number;
  radius: number;
  height: number;
  /** Id of the skill every runner uses with the dive button (a "dive" slot kind). */
  skill: string;
  /** Id of the skill on the action button (an "action" slot kind, such as punch); empty for none. */
  action?: string;
  skills: SkillDefinition[];
  bots: BotSettings;
  spawn: SpawnSettings;
  room: MatchRoomSettings;
  roundDraw: RoundDrawSettings;
  courses: CourseDefinition[];
  playlists: PlaylistDefinition[];
  modes: ModeDefinition[];
}

export type Rarity = "common" | "rare" | "epic" | "legendary";

export interface CharacterDefinition {
  id: string;
  name: string;
  rarity: Rarity;
  accessory?: string;
  color: number[];
  duplicateShards: number;
  craftCost: number;
}

export interface BannerDefinition {
  id: string;
  title: string;
  cost: number;
  tenCost: number;
  epicPity: number;
  legendaryPity: number;
  weights: { rarity: Rarity; weight: number }[];
}

export interface CharacterCatalog {
  version: number;
  currency: string;
  initialCredits: number;
  dailyCredits: number;
  starterId: string;
  characters: CharacterDefinition[];
  banners: BannerDefinition[];
}

/**
 * A mission or achievement. Daily goals count from the UTC day, weekly goals from the Monday of the ISO week (both
 * with the matches / wins / teams metrics), achievements are lifetime. `xp` is account XP, `passXp` battle pass XP.
 */
export interface GoalDefinition {
  id: string;
  title: string;
  scope: "daily" | "weekly" | "achievement";
  metric: "matches" | "wins" | "teams" | "level" | "collection";
  target: number;
  credits: number;
  xp: number;
  /** Battle pass XP a claim adds, 0 to 10000; absent counts as 0. */
  passXp?: number;
}

export interface GoalCatalog {
  version: number;
  goals: GoalDefinition[];
}

/** The three catalogs in force for this process. */
export interface PartyContent {
  config: PartyConfig;
  characterCatalog: CharacterCatalog;
  goalCatalog: GoalCatalog;
}

/** An exported, checksummed release of the three catalogs (Exports/Server/party-bundle.json). */
export interface ContentBundle {
  formatVersion: 1;
  gameplayJson: string;
  charactersJson: string;
  goalsJson: string;
  checksum: string;
}
