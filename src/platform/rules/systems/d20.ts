import type { DieGroup, Rng } from "../types.js";

export const ADVANTAGE = ["none", "advantage", "disadvantage"] as const;
export type Advantage = (typeof ADVANTAGE)[number];

/** Roll a d20, with advantage / disadvantage keeping the higher / lower of two. */
export function rollD20(rng: Rng, mode: Advantage = "none") {
  const values = mode === "none" ? [rng.int(1, 20)] : [rng.int(1, 20), rng.int(1, 20)];
  const natural =
    mode === "advantage" ? Math.max(...values) : mode === "disadvantage" ? Math.min(...values) : values[0];
  const group: DieGroup = {
    label: mode === "none" ? "d20" : mode === "advantage" ? "d20 优势" : "d20 劣势",
    sides: 20,
    values,
    ...(mode === "none" ? {} : { kept: [natural] }),
  };
  return { natural, group };
}

export const signed = (n: number) => (n >= 0 ? `+${n}` : String(n));
