/**
 * FEAT-059: the shape of a mogul field.
 *
 * Real fields are a staggered (checkerboard) pattern of bumps with rounded tops and sharp troughs,
 * about 5.7 m apart on a measured Colorado run, with the troughs running down the fall line. The
 * pack says where fields are and how tall (the `moguls` tile set, 0..1 m); this file turns that into
 * a height at a point, in pack metres, aligned to the local downhill direction. Fields creep uphill
 * about 8 cm a day over a season, so the phase takes a creep distance.
 *
 * The field is laid out along the fall line by projecting the position onto the downhill direction.
 * Done with the raw local direction that falls apart (BUG-062): 700 m from the pack origin a tenth of
 * a degree of noise in the direction shifts the phase by more than a metre, so the bumps came out as
 * broken contour lines that changed at every mesh triangle. So the direction snaps to one of 24 fixed
 * world headings (15 degrees apart) and the two nearest patterns crossfade, the way the corduroy
 * stripes do: inside a bin the field is perfectly coherent, and a run that curves rotates it in steps
 * too small to notice.
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
/** fixed world headings the fall line snaps to (BUG-062) */
const FALL_BINS = 24;
const FALL_BIN = TWO_PI / FALL_BINS;

/** cheap 2D hash to -1..1, in uint32 arithmetic so MOGUL_GLSL reproduces it bit for bit */
function hash(ix: number, iy: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(salt, 1442695041)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xffff) / 32767.5 - 1;
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
  // heading of the fall line snapped to the two nearest fixed bins (zero length means east)
  const q = Math.atan2(fallY, fallX) / FALL_BIN;
  const k0 = Math.floor(q);
  const tq = q - k0;
  const t = tq <= 0.25 ? 0 : tq >= 0.75 ? 1 : (() => { const z = (tq - 0.25) * 2; return z * z * (3 - 2 * z); })();
  const j1 = JITTER_RAD * jitter(x, y, 1), j2 = JITTER_RAD * jitter(x, y, 2);
  const f0 = pattern(x, y, k0 * FALL_BIN, creepM, j1, j2);
  const f = t <= 0 ? f0 : f0 + (pattern(x, y, (k0 + 1) * FALL_BIN, creepM, j1, j2) - f0) * t;
  const s = 0.5 + 0.5 * f;
  return a * Math.pow(s, 1.6);
}

/** the -1..1 staggered pattern with the fall line at heading `ang` (radians from east, counter-clockwise) */
function pattern(x: number, y: number, ang: number, creepM: number, j1: number, j2: number): number {
  const fx = Math.cos(ang), fy = Math.sin(ang);
  // u along the fall line (positive downhill), v across it
  const u = x * fx + y * fy;
  const v = -x * fy + y * fx;
  const k = TWO_PI / MOGUL_SPACING;
  return Math.sin(k * (u + creepM) + j1) * Math.sin(k * v + j2);
}

/**
 * The same field in GLSL for the terrain shader, which shades coarser chunks (no bump geometry) with
 * it: mogulH(pxy, fall, amp, creep) takes pack coordinates (x east, y north) and the downhill
 * direction in the same frame. Keep in step with mogulHeight above.
 */
export const MOGUL_GLSL = /* glsl */ `
  float mogHash(int ix, int iy, int salt) {
    uint h = uint(ix) * 374761393u + uint(iy) * 668265263u + uint(salt) * 1442695041u;
    h = (h ^ (h >> 13u)) * 1274126177u;
    h ^= h >> 16u;
    return float(h & 0xffffu) / 32767.5 - 1.0;
  }
  float mogJitter(vec2 p, int salt) {
    vec2 f = p / ${JITTER_CELL.toFixed(1)};
    vec2 i = floor(f);
    vec2 t = f - i;
    t = t * t * (3.0 - 2.0 * t);
    int ix = int(i.x), iy = int(i.y);
    float a = mogHash(ix, iy, salt), b = mogHash(ix + 1, iy, salt), c = mogHash(ix, iy + 1, salt), d = mogHash(ix + 1, iy + 1, salt);
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
  }
  float mogPattern(vec2 pxy, float ang, float creep, float j1, float j2) {
    vec2 fd = vec2(cos(ang), sin(ang));
    float u = dot(pxy, fd);
    float v = -pxy.x * fd.y + pxy.y * fd.x;
    float k = 6.2831853 / ${MOGUL_SPACING.toFixed(2)};
    return sin(k * (u + creep) + j1) * sin(k * v + j2);
  }
  float mogulH(vec2 pxy, vec2 fall, float amp, float creep) {
    float q = atan(fall.y, fall.x) / ${FALL_BIN.toFixed(8)};
    float k0 = floor(q);
    float t = smoothstep(0.25, 0.75, q - k0);
    float j1 = ${JITTER_RAD.toFixed(2)} * mogJitter(pxy, 1), j2 = ${JITTER_RAD.toFixed(2)} * mogJitter(pxy, 2);
    float f0 = mogPattern(pxy, k0 * ${FALL_BIN.toFixed(8)}, creep, j1, j2);
    float f1 = mogPattern(pxy, (k0 + 1.0) * ${FALL_BIN.toFixed(8)}, creep, j1, j2);
    float f = mix(f0, f1, t);
    return amp * pow(0.5 + 0.5 * f, 1.6);
  }
`;

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
