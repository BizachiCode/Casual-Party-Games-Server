import type { ContentCheck } from "../../../content/content.validation.js";
import type { CourseFieldDefinition } from "../../../content/content.types.js";
import type { Runner } from "../runner.js";

/** The moment a field acts on a runner. */
export interface FieldContact {
  /** The runner was outside the volume (or it was off) last step: one-shot fields fire only then. */
  entered: boolean;
  elapsed: number;
  tick: number;
}

/**
 * One kind of course field: what a volume does to a runner whose feet are inside it while it is on. The shared loop
 * (fields/index.ts) tracks entering, the on/off duty cycle and the wind cap; a kind only applies its effect.
 *
 * Every kind has a twin in Assets/CasualPartyMultiplayer/Core/Simulation/Fields (wind.ts -> WindField.cs) doing the
 * same operations in the same order; register both (fields/index.ts, PartyFields.cs). test:parity compares them.
 */
export interface FieldKind {
  /** Checks the definition fields this kind reads beyond the common ones (position, size, duty cycle). */
  validate(field: CourseFieldDefinition, check: ContentCheck): void;
  /** Called every step the runner is inside the active volume. */
  apply(runner: Runner, field: CourseFieldDefinition, contact: FieldContact): void;
}

/** Shared rule: fields that do not push have no flow. */
export function noFlow(field: CourseFieldDefinition, check: ContentCheck): void {
  check.require(!(field.flowX || field.flowZ), "flow only applies to wind/punch fields");
}

/** Shared rule: fields that do not last have no duration. */
export function noDuration(field: CourseFieldDefinition, check: ContentCheck): void {
  check.number(field.duration ?? 0, 0, 0, "unused field duration");
}
