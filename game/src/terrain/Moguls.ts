/**
 * FEAT-059: the shape of a mogul field.
 *
 * Real fields are a staggered (checkerboard) pattern of bumps with rounded tops and sharp troughs,
 * about 5.7 m apart on a measured Colorado run, with the troughs running down the fall line. The
 * pack says where fields are and how tall (the `moguls` tile set, 0..1 m); this file turns that into
 * a height at a point, in pack metres, aligned to the local downhill direction. Fields creep uphill
 * about 8 cm a day over a season, so the phase takes a creep distance.
 *
 * Pure functions: both the physics (Pack.terrainHeight) and the near terrain mesh (Pack.height)
 * add the same bumps, so the board sits on what the player sees.
 */

/** bump spacing along and across the fall line, metres (Physics Today, Riflesight Notch) */
export const MOGUL_SPACING = 5.7;
/** tallest bump the client draws; the terrain skirts (at least 2 m) must cover it */
export const MOGUL_MAX_AMP = 1.0;
/** uphill creep per day, metres (about 10 m a season) */
export const MOGUL_CREEP_M_PER_DAY = 0.08;

const TWO_PI = Math.PI * 2;
const JITTER_CELL = 25; // m: scale of the phase jitter that breaks the perfect grid
const JITTER_RAD = 0.8;

/** cheap 2D hash to -1..1 */
function hash(ix: number, iy: number, salt: number): number {
  let h = (ix * 374761393 + iy * 668265263 + salt * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h & 0xffff) / 0x7fff) - 1;
}

/** bilinear value noise in -1..1 at a 25 m cell size */
function jitter(x: number, y: number, salt: number): number {
  const fx = x / JITTER_CELL, fy = y / JITTER_CELL;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash(ix, iy, salt), b = hash(ix + 1, iy, salt), c = hash(ix, iy + 1, salt), d = hash(ix + 1, iy + 1, salt);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/**
 * Bump height (0..amp) at pack (x, y). `fallX, fallY` is the downhill direction (any length; zero
 * means east), `creepM` shifts the field uphill by that many metres.
 */
export function mogulHeight(x: number, y: number, amp: number, fallX: number, fallY: number, creepM: number): number {
  if (amp <= 0) return 0;
  const a = Math.min(MOGUL_MAX_AMP, amp);
  let l = Math.hypot(fallX, fallY);
  let fx = 1, fy = 0;
  if (l > 1e-6) { fx = fallX / l; fy = fallY / l; }
  // u along the fall line (positive downhill), v across it
  const u = x * fx + y * fy;
  const v = -x * fy + y * fx;
  const k = TWO_PI / MOGUL_SPACING;
  const f = Math.sin(k * (u + creepM) + JITTER_RAD * jitter(x, y, 1)) * Math.sin(k * v + JITTER_RAD * jitter(x, y, 2));
  const s = 0.5 + 0.5 * f;
  return a * Math.pow(s, 1.6);
}

/**
 * Unit downhill direction at (x, y) from central differences of `baseH` at +-d metres, written into
 * `out` ([fx, fy]); (1, 0) when the ground is flat.
 */
export function fallFrom(baseH: (x: number, y: number) => number, x: number, y: number, out: number[], d = 6): number[] {
  const gx = (baseH(x + d, y) - baseH(x - d, y)) / (2 * d);
  const gy = (baseH(x, y + d) - baseH(x, y - d)) / (2 * d);
  const l = Math.hypot(gx, gy);
  if (l < 1e-6) { out[0] = 1; out[1] = 0; return out; }
  out[0] = -gx / l; out[1] = -gy / l;
  return out;
}
