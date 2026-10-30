import type { ValueTransformer } from "typeorm";

/** MySQL BIGINT columns hold millisecond timestamps, well inside the safe integer range. */
export const bigintNumber: ValueTransformer = {
  to: (value: number | null) => value,
  from: (value: string | number | null) => (value === null ? null : Number(value)),
};
