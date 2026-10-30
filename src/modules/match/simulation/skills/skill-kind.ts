import type { ContentCheck } from "../../../content/content.validation.js";
import type { SkillDefinition } from "../../../content/content.types.js";
import type { Runner } from "../runner.js";

/**
 * The button a skill kind belongs to. "dive" skills move the runner and run the phase machine in phases.ts (active,
 * landed, recover, cooldown). "action" skills are instant: they start, then wait out their cooldown.
 */
export type SkillSlot = "dive" | "action";

/** The match around a skill: what action skills read when they reach other runners. */
export interface SkillWorld {
  tick: number;
  tickRate: number;
  elapsed: number;
  /** Runners per team; above 1, a skill never hits a teammate. */
  teamSize: number;
}

/**
 * One kind of skill. A content definition picks a kind by name (SkillDefinition.kind) and a slot uses it
 * (PartyConfig.skill for the dive button, PartyConfig.action for the action button).
 *
 * Every kind has a twin with the same name in Assets/CasualPartyMultiplayer/Core/Simulation/Skills (dive.ts ->
 * DiveSkill.cs) doing the same operations in the same order: the offline game and the client's prediction run that
 * one, and test:parity compares both every tick. Register the kind in skills/index.ts and in PartySkills.cs.
 */
export interface SkillKind {
  slot: SkillSlot;
  /** Checks the definition fields this kind reads. */
  validate(skill: SkillDefinition, check: ContentCheck): void;
  /** The user's own change when the skill starts (both slots). The client predicts this for its own runner. */
  start(runner: Runner, skill: SkillDefinition): void;
  /** Dive slot: motion while landed and recovering, when the runner has no control. */
  slide?(runner: Runner, skill: SkillDefinition, dt: number): void;
  /** Action slot: what the skill does to the other runners, once every runner has moved this tick. */
  affect?(user: Runner, runners: readonly Runner[], skill: SkillDefinition, world: SkillWorld): void;
  /** Action slot: whether using it now would do anything. Bots only press the button when it would. */
  useful?(user: Runner, runners: readonly Runner[], skill: SkillDefinition, world: SkillWorld): boolean;
}
