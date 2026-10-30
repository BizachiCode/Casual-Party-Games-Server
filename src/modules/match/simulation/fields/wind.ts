import { type FieldKind, noDuration } from "./field-kind.js";

/** Wind: drifts the runner by flowX/flowZ m/s while inside, in the air too. Twin: WindField.cs. */
export const wind: FieldKind = {
  validate(field, check) {
    check.number(field.strength ?? 0, 0, 0, "wind.strength");
    check.require((field.flowX ?? 0) !== 0 || (field.flowZ ?? 0) !== 0, "wind requires flow");
    noDuration(field, check);
  },
  apply(runner, field) {
    runner.windX += field.flowX || 0;
    runner.windZ += field.flowZ || 0;
    runner.inWind = true;
  },
};
