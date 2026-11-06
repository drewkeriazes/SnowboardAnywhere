/**
 * Seeded PRNG for anything inside the simulation (mulberry32). Sim code must draw from this,
 * never Math.random, so a recorded input stream replays the same run. Visual-only effects
 * (spray, camera shake, goggle flakes) may keep Math.random.
 */
export class Rng {
  private s: number;
  constructor(seed = 1) { this.s = seed >>> 0; }
  seed(seed: number): void { this.s = seed >>> 0; }
  /** uniform in [0, 1) */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
