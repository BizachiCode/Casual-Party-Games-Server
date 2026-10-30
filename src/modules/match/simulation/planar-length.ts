/**
 * Length of a planar vector as sqrt(x * x + z * z), the exact operations the C# simulation uses (Math.Sqrt), so both
 * sides stay bit-identical. Math.hypot can round the last bit differently, and the parity test catches that on long
 * matches, so the simulation never uses it.
 */
export const planarLength = (x: number, z: number): number => Math.sqrt(x * x + z * z);
