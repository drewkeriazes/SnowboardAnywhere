/**
 * FEAT-059: the shape of a mogul field.
 *
 * Real fields are a staggered (checkerboard) pattern of bumps with rounded tops and sharp troughs,
 * about 5.7 m apart on a measured Colorado run, with the troughs running down the fall line. The
 * pack says where fields are and how tall (the `moguls` tile set, 0..1 m); this file turns that into
 * a height at a point, in pack metres, aligned to the local downhill direction. Fields creep uphill
 * about 8 cm a day over a season, so the phase takes a creep distance.
 *
 * Local anchors (BUG-064, built with BUG-062): the grid is laid out from the centres of 40 m cells,
 * not from the pack origin. Rotating the grid around an origin kilometres away turned every tenth of a
 * degree of change in the fall direction into metres of shift, so the bumps re-shuffled across every
 * mesh triangle and came out as zig-zag creases. Each point blends the four nearest cells' bumps with a
 * smooth maximum, not an average: neighbouring cells' grids can be half a spacing out of phase, and an
 * average would cancel them into flat bands. The fall line comes from
 * a 30 m difference on the base surface so it holds its direction across a run.
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
/** half-width of the central difference the fall line is measured over, metres (BUG-064) */
export const MOGUL_FALL_D = 30;
/** anchor cell size, metres: the grid is laid out from each cell's centre (BUG-064) */
export const MOGUL_CELL = 40;

const TWO_PI = Math.PI * 2;
const JITTER_CELL = 25; // m: scale of the phase jitter that breaks the perfect grid
const JITTER_RAD = 0.8;
/** sharpness of the smooth maximum that blends neighbouring cells' bumps (on heights 0..1) */
const CELL_SMAX = 16;

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

/** smoothstep over the middle 8 m of a 40 m cell gap: one cell's bumps alone over most of the cell */
function cellBlend(t: number): number {
  const z = Math.min(1, Math.max(0, (t - 0.4) / 0.2));
  return z * z * (3 - 2 * z);
}
/** d cellBlend / dt */
function cellBlendD(t: number): number {
  const z = (t - 0.4) / 0.2;
  return z <= 0 || z >= 1 ? 0 : 30 * z * (1 - z);
}

/**
 * Bump height (0..amp) at pack (x, y). `fallX, fallY` is the downhill direction (any length; zero
 * means east), `creepM` shifts the field uphill by that many metres.
 */
export function mogulHeight(x: number, y: number, amp: number, fallX: number, fallY: number, creepM: number): number {
  return mogulEval(x, y, amp, fallX, fallY, creepM, null);
}

/**
 * Height and its slope in one evaluation (BUG-062 review: the shader took three height taps per pixel
 * for the slope): writes [h, dh/dx, dh/dy] into `out` and returns h. The slope leaves out the slow
 * 25 m phase jitter (about 3%), which is what MOGUL_GLSL's mogulHG does too.
 */
export function mogulHeightGrad(x: number, y: number, amp: number, fallX: number, fallY: number, creepM: number, out: number[]): number {
  return mogulEval(x, y, amp, fallX, fallY, creepM, out);
}

function mogulEval(x: number, y: number, amp: number, fallX: number, fallY: number, creepM: number, out: number[] | null): number {
  if (out) { out[0] = 0; out[1] = 0; out[2] = 0; }
  if (amp <= 0) return 0;
  const a = Math.min(MOGUL_MAX_AMP, amp);
  const l = Math.hypot(fallX, fallY);
  let fx = 1, fy = 0;
  if (l > 1e-6) { fx = fallX / l; fy = fallY / l; }
  const j1 = JITTER_RAD * jitter(x, y, 1), j2 = JITTER_RAD * jitter(x, y, 2);
  const k = TWO_PI / MOGUL_SPACING;
  // the four nearest cell centres and their weights
  const gx = x / MOGUL_CELL - 0.5, gy = y / MOGUL_CELL - 0.5;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const wx = cellBlend(gx - ix), wy = cellBlend(gy - iy);
  const dwx = cellBlendD(gx - ix) / MOGUL_CELL, dwy = cellBlendD(gy - iy) / MOGUL_CELL;
  let acc = 0, dax = 0, day = 0;
  for (let c = 0; c < 4; c++) {
    const ox = c & 1, oy = c >> 1;
    const wxc = ox ? wx : 1 - wx, wyc = oy ? wy : 1 - wy;
    const w = wxc * wyc;
    const dwdx = (ox ? dwx : -dwx) * wyc, dwdy = wxc * (oy ? dwy : -dwy);
    if (w <= 0 && dwdx === 0 && dwdy === 0) continue;
    // u along the fall line (positive downhill), v across it, from this cell's centre
    const dx = x - (ix + ox + 0.5) * MOGUL_CELL, dy = y - (iy + oy + 0.5) * MOGUL_CELL;
    const u = dx * fx + dy * fy;
    const v = -dx * fy + dy * fx;
    const A = k * (u + creepM) + j1, B = k * v + j2;
    const sA = Math.sin(A), sB = Math.sin(B);
    const s = 0.5 + 0.5 * sA * sB;
    const e = Math.exp(CELL_SMAX * Math.pow(Math.max(s, 1e-6), 1.6)); // same guard as MOGUL_GLSL
    acc += w * e;
    if (out) {
      // d(s^1.6) = 0.8 s^0.6 df, with df from u = (fx, fy) and v = (-fy, fx)
      const cA = Math.cos(A), cB = Math.cos(B);
      const q = 0.8 * Math.pow(Math.max(s, 1e-6), 0.6) * k;
      const hx = q * (cA * sB * fx - sA * cB * fy), hy = q * (cA * sB * fy + sA * cB * fx);
      dax += dwdx * e + w * e * CELL_SMAX * hx;
      day += dwdy * e + w * e * CELL_SMAX * hy;
    }
  }
  // weights sum to 1, so one cell alone gives its own height exactly (and acc <= e^CELL_SMAX)
  const h = a * Math.log(acc) / CELL_SMAX;
  if (out) { out[0] = h; out[1] = a * dax / (CELL_SMAX * acc); out[2] = a * day / (CELL_SMAX * acc); }
  return h;
}

/**
 * The same field in GLSL for the terrain shader, which shades every chunk up to MOGUL_SHADE_MAX_RES
 * with it: mogulHG(pxy, fall, amp, creep) takes pack coordinates (x east, y north) and the downhill
 * direction in the same frame and returns height and slope. Keep in step with mogulEval above.
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
  // height and slope in one evaluation: vec3(h, dh/dx, dh/dy), pack frame (mogulHeightGrad above)
  vec3 mogulHG(vec2 pxy, vec2 fall, float amp, float creep) {
    float l = length(fall);
    vec2 fd = l > 1e-6 ? fall / l : vec2(1.0, 0.0);
    float j1 = ${JITTER_RAD.toFixed(2)} * mogJitter(pxy, 1), j2 = ${JITTER_RAD.toFixed(2)} * mogJitter(pxy, 2);
    float k = 6.2831853 / ${MOGUL_SPACING.toFixed(2)};
    vec2 g = pxy / ${MOGUL_CELL.toFixed(1)} - 0.5;
    vec2 gi = floor(g);
    vec2 z = clamp((g - gi - 0.4) / 0.2, 0.0, 1.0);
    vec2 w = z * z * (3.0 - 2.0 * z);
    vec2 dw = 30.0 * z * (1.0 - z) / ${MOGUL_CELL.toFixed(1)};
    float acc = 0.0;
    vec2 dacc = vec2(0.0);
    for (int c = 0; c < 4; c++) {
      vec2 o = vec2(float(c & 1), float(c >> 1));
      vec2 wo = mix(1.0 - w, w, o);
      vec2 dwo = mix(-dw, dw, o);
      float wc = wo.x * wo.y;
      vec2 dwc = vec2(dwo.x * wo.y, wo.x * dwo.y);
      // outside the 8 m blend bands a neighbour's weight and its slope are exactly 0: skip its trig
      if (wc <= 0.0 && dwc.x == 0.0 && dwc.y == 0.0) continue;
      vec2 d = pxy - (gi + o + 0.5) * ${MOGUL_CELL.toFixed(1)};
      float A = k * (dot(d, fd) + creep) + j1, B = k * (-d.x * fd.y + d.y * fd.x) + j2;
      float sA = sin(A), sB = sin(B), cA = cos(A), cB = cos(B);
      float s = 0.5 + 0.5 * sA * sB;
      // rounding can take s a hair below 0, where pow is undefined
      float e = exp(${CELL_SMAX.toFixed(1)} * pow(max(s, 1e-6), 1.6));
      float q = 0.8 * pow(max(s, 1e-6), 0.6) * k;
      vec2 dh = q * vec2(cA * sB * fd.x - sA * cB * fd.y, cA * sB * fd.y + sA * cB * fd.x);
      acc += wc * e;
      dacc += dwc * e + wc * e * ${CELL_SMAX.toFixed(1)} * dh;
    }
    return amp * vec3(log(acc), dacc / acc) / ${CELL_SMAX.toFixed(1)};
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
