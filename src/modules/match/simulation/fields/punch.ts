import { knockBack } from "../effects.js";
import type { FieldKind } from "./field-kind.js";
import { planarLength } from "../planar-length.js";

/**
 * Punch field: entering knocks the runner down along flowX/flowZ with `strength` m/s of lift and `duration` seconds
 * without control. Twin: PunchField.cs.
 */
export const punch: FieldKind = {
  validate(field, check) {
    check.number(field.strength, 2, 12, "punch.strength");
    check.number(field.duration, 0.2, 1, "punch.duration");
    const flow = planarLength(field.flowX || 0, field.flowZ || 0);
    check.require(flow >= 1 && flow <= 20, "punch flow magnitude");
  },
  apply(runner, field, { entered, elapsed, tick }) {
    if (!entered || runner.knockedDown || elapsed < runner.hitUntil) return;
    knockBack(runner, field.flowX, field.strength, field.flowZ, elapsed + field.duration, true, tick);
  },
};
