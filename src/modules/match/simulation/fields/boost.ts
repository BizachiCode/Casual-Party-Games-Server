import { type FieldKind, noFlow } from "./field-kind.js";

/** Boost: entering multiplies the runner's speed by `strength` for `duration` seconds. Twin: BoostField.cs. */
export const boost: FieldKind = {
  validate(field, check) {
    check.number(field.strength, 1.05, 2, "boost.strength");
    check.number(field.duration, 0.1, 10, "boost.duration");
    check.require(field.y >= 0 && field.height <= 1, "boost floor volume");
    noFlow(field, check);
  },
  apply(runner, field, { entered, elapsed, tick }) {
    if (!entered || runner.knockedDown) return;
    runner.boostUntil = elapsed + field.duration;
    runner.boostFactor = field.strength;
    runner.boostTick = tick;
  },
};
