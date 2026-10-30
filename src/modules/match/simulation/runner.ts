import type { BotBrain } from "./bots.js";

export type RunnerStatus = "racing" | "qualified" | "eliminated";

/** One player's authoritative state. Snapshots publish a subset; the rest is latched input and motor bookkeeping. */
export interface Runner {
  id: string;
  name: string;
  bot: boolean;
  ready: boolean;
  status: RunnerStatus;
  team: number;
  color: number;
  characterId: string;
  // Motion
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  groundIndex: number;
  checkpoint: number;
  facingX: number;
  facingZ: number;
  // Latched input (rising edges wait for the next tick)
  seq: number;
  inputTick: number;
  /** The stick, in world space, inside the unit circle. */
  inputX: number;
  inputZ: number;
  jump: boolean;
  dive: boolean;
  jumped: boolean;
  dived: boolean;
  /** The action button (see skills/index.ts): latched like jump and dive, and whether it was held last input. */
  action: boolean;
  acted: boolean;
  // Dive button skill (see skills/)
  skillPhase: number;
  skillUntil: number;
  skillUsed: boolean;
  dashing: boolean;
  // Hits and course fields
  hitUntil: number;
  knockedDown: boolean;
  impactX: number;
  impactY: number;
  impactZ: number;
  landSpeed: number;
  boostUntil: number;
  boostFactor: number;
  slimeFactor: number;
  windX: number;
  windZ: number;
  inWind: boolean;
  fieldContacts: boolean[];
  // Event clocks: the tick each last happened, so clients cue every event exactly once
  jumpTick: number;
  diveTick: number;
  hitTick: number;
  landTick: number;
  respawnTick: number;
  emoteTick: number;
  launchTick: number;
  boostTick: number;
  /** The tick the action skill was last used; also where its cooldown counts from. */
  actionTick: number;
  // Results
  score: number;
  totalScore: number;
  finishTime: number;
  deaths: number;
  emote: string;
  emoteUntil: number;
  // Synchronized animation (see animation-state.ts)
  animationState?: number;
  animationTick?: number;
  animationRound?: number;
  /** Bots only: profile, habits and current decisions (see bots.ts). Never published. */
  brain?: BotBrain;
}
