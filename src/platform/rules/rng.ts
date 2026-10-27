import { randomInt } from "node:crypto";
import type { Rng } from "./types.js";

/** Production RNG: cryptographically secure, server side. */
export const cryptoRng: Rng = {
  int: (min, max) => randomInt(min, max + 1),
};

/** Reproducible RNG for simulations and replays (mulberry32). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    int(min, max) {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return min + Math.floor(r * (max - min + 1));
    },
  };
}

/** Test RNG that returns the given values in order and checks each is in range. */
export function scriptedRng(values: number[]): Rng & { remaining(): number } {
  const queue = [...values];
  return {
    int(min, max) {
      if (!queue.length) throw new Error("scriptedRng exhausted");
      const v = queue.shift()!;
      if (v < min || v > max)
        throw new Error(`scriptedRng value ${v} outside [${min}, ${max}]`);
      return v;
    },
    remaining: () => queue.length,
  };
}
