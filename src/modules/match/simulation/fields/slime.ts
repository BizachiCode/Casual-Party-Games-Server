import { type FieldKind, noDuration, noFlow } from "./field-kind.js";

/** Slime: a grounded runner moves at `strength` times its speed; the strongest overlap wins. Twin: SlimeField.cs. */
export const slime: FieldKind = {
  validate(field, check) {
    check.number(field.strength, 0.2, 0.9, "slime.strength");
    check.require(field.y >= 0 && field.height <= 1, "slime floor volume");
    noDuration(field, check);
    noFlow(field, check);
  },
  apply(runner, field) {
    if (runner.grounded) runner.slimeFactor = Math.min(runner.slimeFactor, field.strength);
  },
};
