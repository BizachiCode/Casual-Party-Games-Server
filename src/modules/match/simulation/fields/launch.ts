import { cancelSkill } from "../skills/phases.js";
import { type FieldKind, noDuration, noFlow } from "./field-kind.js";

/** Launch: a grounded runner stepping on the pad is thrown up at `strength` m/s. Twin: LaunchField.cs. */
export const launch: FieldKind = {
  validate(field, check) {
    check.number(field.strength, 8, 24, "launch.strength");
    check.number(field.height, 0.1, 0.5, "launch.height");
    check.require(field.y >= 0, "launch must stand on a platform top");
    noDuration(field, check);
    noFlow(field, check);
  },
  apply(runner, field, { entered, tick }) {
    if (!entered || runner.knockedDown || !runner.grounded) return;
    runner.vy = field.strength;
    runner.grounded = false;
    runner.skillUsed = false;
    runner.launchTick = tick;
    cancelSkill(runner);
  },
};
