import type { Boundary } from './Boundary';
import { Rng } from './Rng';

/**
 * FEAT-305: the out of bounds easter egg's dice. Each frame the rider's move is checked against the boundary rope;
 * going over it outward is a crossing, and each crossing rolls once against `odds` (1 in 30; `?yetiodds=` sets it).
 * After a hit, COOLDOWN s pass before crossings roll again, so it never fires twice in a row; a crossing within
 * DEBOUNCE s of the last one (wobbling along the rope) is the same crossing. Coming back in bounds never rolls.
 * Pure: the session's frame feeds it positions, the yeti egg (modes/YetiEgg.ts) acts on a hit.
 */
export const ODDS = 1 / 30;
export const COOLDOWN = 120; // s after a hit
const DEBOUNCE = 3; // s
/** a move longer than this in one step is a teleport (the map, a respawn), not a crossing */
const JUMP = 40; // m

export type Crossed = 'none' | 'in' | 'out' | 'hit';

export class OutOfBounds {
  odds: number;
  readonly rng: Rng;
  /** counts, for the checks */
  crossings = 0;
  rolls = 0;
  hits = 0;
  private x = NaN;
  private y = NaN;
  /** seconds since the last hit and since the last crossing */
  private sinceHit = Infinity;
  private sinceCross = Infinity;

  constructor(private readonly boundary: Boundary, odds = ODDS, seed = (Math.random() * 2 ** 32) >>> 0) {
    this.odds = odds;
    this.rng = new Rng(seed);
  }

  /** forget the last position (teleports, the map, a respawn): the next update only sets it */
  reset(): void { this.x = this.y = NaN; }

  /**
   * The rider is at (x, y) after `dt` s. `live` false (on a lift, Outrun running, the replay, a detached camera) just
   * tracks the position. Returns what happened: a crossing outward that rolled a hit is 'hit'.
   */
  update(x: number, y: number, dt: number, live = true): Crossed {
    this.sinceHit += dt; this.sinceCross += dt;
    const x0 = this.x, y0 = this.y;
    this.x = x; this.y = y;
    if (!live || Number.isNaN(x0) || Math.hypot(x - x0, y - y0) > JUMP) return 'none';
    const c = this.boundary.crossing(x0, y0, x, y);
    if (c === 0) return 'none';
    const fresh = this.sinceCross > DEBOUNCE;
    this.sinceCross = 0;
    if (c < 0) return 'in';
    if (!fresh) return 'out';
    this.crossings++;
    if (this.sinceHit < COOLDOWN) return 'out';
    this.rolls++;
    if (this.rng.next() >= this.odds) return 'out';
    this.hits++; this.sinceHit = 0;
    return 'hit';
  }
}
