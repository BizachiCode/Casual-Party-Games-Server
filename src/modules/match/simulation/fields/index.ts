import type { ContentCheck } from "../../../content/content.validation.js";
import type { CourseDefinition, CourseFieldDefinition } from "../../../content/content.types.js";
import type { Runner } from "../runner.js";
import { boost } from "./boost.js";
import type { FieldKind } from "./field-kind.js";
import { launch } from "./launch.js";
import { punch } from "./punch.js";
import { slime } from "./slime.js";
import { wind } from "./wind.js";
import { planarLength } from "../planar-length.js";

export type { FieldContact, FieldKind } from "./field-kind.js";

/**
 * Every course field kind by name. To add one, write a kind file next to these, list it here and in PartyFields.cs
 * (Core/Simulation/Fields), then use the kind in a course. Server-owned volumes: no client trigger, buff, wind or
 * launch result is accepted.
 */
export const fieldKinds: Record<string, FieldKind> = { launch, wind, boost, slime, punch };

const MAX_WIND = 20;

export function fieldActive(field: CourseFieldDefinition, time: number): boolean {
  return (
    !field.period || (((time + (field.phase || 0)) % field.period) + field.period) % field.period < field.onSeconds
  );
}

export function insideField(field: CourseFieldDefinition, x: number, y: number, z: number): boolean {
  return (
    Math.abs(x - field.x) <= field.width / 2 &&
    Math.abs(z - field.z) <= field.depth / 2 &&
    y >= field.y - 0.01 &&
    y <= field.y + field.height
  );
}

/** The rules every field follows, then its kind's own. */
export function validateField(field: CourseFieldDefinition, check: ContentCheck): void {
  check.require(field && Object.hasOwn(fieldKinds, field.kind), "field.kind");
  check.number(field.x, -10000, 10000, "field.x");
  check.number(field.z, -10000, 10000, "field.z");
  check.number(field.y, -5, 45, "field.y");
  check.number(field.width, 0.2, 100, "field.width");
  check.number(field.depth, 0.2, 100, "field.depth");
  check.number(field.height, 0.1, 12, "field.height");
  check.number(field.flowX ?? 0, -20, 20, "field.flowX");
  check.number(field.flowZ ?? 0, -20, 20, "field.flowZ");
  check.number(field.phase ?? 0, -1000, 1000, "field.phase");
  check.number(field.period ?? 0, 0, 120, "field.period");
  check.number(field.onSeconds ?? 0, 0, field.period ?? 0, "field.onSeconds");
  check.require(!field.period || (field.period >= 0.2 && field.onSeconds >= 0.1), "field duty cycle");
  fieldKinds[field.kind].validate(field, check);
}

/** Course volumes in catalog order, then the wind cap. Runs at the start of every movement step. */
export function applyFields(runner: Runner, course: CourseDefinition, elapsed: number, tick: number): void {
  runner.windX = 0;
  runner.windZ = 0;
  runner.inWind = false;
  runner.slimeFactor = 1;
  for (const [index, field] of (course.fields || []).entries()) {
    const inside = fieldActive(field, elapsed) && insideField(field, runner.x, runner.y, runner.z);
    const entered = inside && !runner.fieldContacts[index];
    runner.fieldContacts[index] = inside;
    if (inside) fieldKinds[field.kind].apply(runner, field, { entered, elapsed, tick });
  }
  const wind = planarLength(runner.windX, runner.windZ);
  if (wind > MAX_WIND) {
    runner.windX *= MAX_WIND / wind;
    runner.windZ *= MAX_WIND / wind;
  }
}
