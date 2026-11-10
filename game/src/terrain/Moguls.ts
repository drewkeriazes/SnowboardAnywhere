/**
 * FEAT-059 / FEAT-147: the shape of a mogul field.
 *
 * The pack says where fields are and how strong (the `moguls` tile set, 0..1); this file turns that into
 * a height at a point, in pack metres, aligned to the local downhill direction.
 *
 * Rider lines (FEAT-147): moguls are cut by the lines riders take. The field is a set of lines down the
 * fall line, each a sine wave across it with its own turn rhythm (a left and a right turn every 4 to
 * 7 m, the bump spacing along the line). The lines
 * are the troughs; the snow between two neighbouring lines is a bump wherever the gap between them opens
 * up and a saddle where it pinches, so neighbours turning out of phase leave the staggered bumps of a
 * zipper line, and the low line weaves around each bump (BUG-064). Lines that share one rhythm give
 * regular rows; loose ones, with their own rhythm and phase, give an uneven field; every few lines one
 * dominant line swings wide and leaves a clear zipper either side. Each bump is +-30% of its neighbours'
 * height. The set of lines changes every 80 m (a pattern region of 2 x 2 anchor cells), so the field is
 * never the same pattern top to bottom.
 *
 * Size from the slope (FEAT-147): a unit amplitude is about 0.55 m of bump at 16 deg and 1.38 m at
 * 32 deg and steeper, so with the per-bump spread the biggest bumps on a steep run reach 1.8 m (rider
 * height) and a moderate one's are knee to thigh high. The slope is the length of the fall vector the
 * callers already measure (a 30 m difference on the base surface), so the physics and the shader agree.
 *
 * Local anchors (BUG-064, built with BUG-062): the pattern is laid out from the centres of 40 m cells,
 * not from the pack origin. Rotating it around an origin kilometres away turned every tenth of a degree
 * of change in the fall direction into metres of shift. Each point blends the four nearest cells' bumps
 * over an 8 m band with a variance-preserving mix (the mean plus the weighted deviations over the root
 * of the summed squared weights, as for blending texture tiles): a plain average cancels neighbours'
 * out-of-phase patterns into flat bands, and a smooth maximum creases where two fields cross (BUG-062
 * used one; FEAT-147's taller bumps snapped in at the band edges). A soft cap keeps two overlapping
 * crests under the tallest bump. Fields creep uphill about 8 cm a day over a season, so the phase takes
 * a creep distance.
 *
 * Pure functions: both the physics (Pack.terrainHeight) and the near terrain mesh (Pack.height) add the
 * same bumps, and MOGUL_GLSL is the same field for the shader, so the board sits on what the player sees.
 */

/** bump spacing along a rider line (one left and one right turn), metres: each pattern region picks one
 *  in this range (5.7 m measured on a Colorado run, Physics Today, Riflesight Notch) */
export const MOGUL_TURN_MIN = 4;
export const MOGUL_TURN_MAX = 7;
/** tallest bump the client draws (a unit amplitude on a steep run, the tallest per-bump spread); the
 *  terrain skirts (at least 2 m) must cover it */
export const MOGUL_MAX_AMP = 1.8;
/** uphill creep per day, metres (about 10 m a season) */
export const MOGUL_CREEP_M_PER_DAY = 0.08;
/** half-width of the central difference the fall line is measured over, metres (BUG-064) */
export const MOGUL_FALL_D = 30;
/** anchor cell size, metres: the pattern is laid out from each cell's centre (BUG-064) */
export const MOGUL_CELL = 40;
/** anchor cells per side of a pattern region: the set of rider lines changes every 80 m (FEAT-147) */
export const MOGUL_REGION = 2;

const SIZE_LO = 0.55; // m of bump per unit amplitude at SIZE_DEG0 and below
const SIZE_HI = 1.38; // ... at SIZE_DEG1 and steeper (x 1.3 per-bump spread = 1.79 m)
const SIZE_DEG0 = 16;
const SIZE_DEG1 = 32;
const VAR = 0.3; // per-bump height spread, +-
const WF_REF = 1.7; // gap width (in lane widths) that makes a full-height bump
const JITTER_CELL = 25; // m: scale of the slow warp that bends the lines
const JITTER_U = 0.8; // m of warp along and across the fall line
const JITTER_V = 0.8;
/** mean of one cell's field (n, 0..1.3): the cell blend keeps it and scales the deviations */
const N_MEAN = 0.33;
/** the soft cap on the blended field: unchanged up to CAP_KNEE, never above 1 + VAR */
const CAP_KNEE = 1.1;
const CAP_TOP = 1 + VAR;

/** bump height in metres per unit amplitude for a slope of `slopeTan` (rise over run) */
export function mogulSize(slopeTan: number): number {
  const d = Math.atan(Math.abs(slopeTan)) * (180 / Math.PI);
  const t = Math.min(1, Math.max(0, (d - SIZE_DEG0) / (SIZE_DEG1 - SIZE_DEG0)));
  return SIZE_LO + (SIZE_HI - SIZE_LO) * t * t * (3 - 2 * t);
}

/** cheap 2D hash to -1..1, in uint32 arithmetic so MOGUL_GLSL reproduces it bit for bit */
function hash(ix: number, iy: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(salt, 1442695041)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xffff) / 32767.5 - 1;
}
const h01 = (ix: number, iy: number, salt: number) => 0.5 + 0.5 * hash(ix, iy, salt);

/** bilinear value noise in -1..1 at a 25 m cell size; writes its slope [d/dx, d/dy] into `g` */
function jitter(x: number, y: number, salt: number, g: number[]): number {
  const fx = x / JITTER_CELL, fy = y / JITTER_CELL;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash(ix, iy, salt), b = hash(ix + 1, iy, salt), c = hash(ix, iy + 1, salt), d = hash(ix + 1, iy + 1, salt);
  const lo = a * (1 - sx) + b * sx, hi = c * (1 - sx) + d * sx;
  g[0] = ((b - a) * (1 - sy) + (d - c) * sy) * 6 * tx * (1 - tx) / JITTER_CELL;
  g[1] = (hi - lo) * 6 * ty * (1 - ty) / JITTER_CELL;
  return lo * (1 - sy) + hi * sy;
}
const JG1 = [0, 0], JG2 = [0, 0];

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

/** one pattern region's rider lines (FEAT-147) */
interface Region {
  rx: number; ry: number;
  lam: number; // bump spacing along a line (a left and a right turn), m
  w: number; // lane width (line to line across the fall line), m
  order: number; // 0 every line its own rhythm and phase .. 1 all lines in step (rows)
  dom: number; // every dom-th line is a dominant one (0: none)
  domOff: number;
  phi: number;
}
function region(rx: number, ry: number, out: Region): Region {
  out.rx = rx; out.ry = ry;
  out.lam = MOGUL_TURN_MIN + (MOGUL_TURN_MAX - MOGUL_TURN_MIN) * h01(rx, ry, 11);
  out.w = out.lam * (0.62 + 0.2 * h01(rx, ry, 12));
  out.order = h01(rx, ry, 13);
  out.dom = h01(rx, ry, 16) < 0.3 ? 0 : 3 + Math.floor(h01(rx, ry, 14) * 2.999);
  out.domOff = Math.floor(h01(rx, ry, 15) * 4.999);
  out.phi = 6.2831853 * h01(rx, ry, 17);
  return out;
}

/** line i of region r at distance U down the fall line: writes [v across, dv/dU] into `o` */
function line(r: Region, i: number, U: number, o: number[]): void {
  const dom = r.dom > 0 && (((i + r.domOff) % r.dom) + r.dom) % r.dom === 0;
  const loose = dom ? 0 : 1 - r.order;
  const lam = r.lam * (1 + 0.36 * loose * (h01(r.rx * 97 + i, r.ry, 21) - 0.5));
  const phi = r.phi + i * Math.PI + 2.2 * loose * (h01(r.rx * 97 + i, r.ry, 22) - 0.5);
  const a = r.w * (dom ? 0.42 : 0.24 + 0.14 * h01(r.rx * 97 + i, r.ry, 23));
  const kap = 6.2831853 / lam;
  const th = kap * U + phi;
  o[0] = i * r.w + a * Math.sin(th);
  o[1] = a * kap * Math.cos(th);
}

const REG = [0, 1, 2, 3].map(() => ({ rx: 0, ry: 0, lam: 0, w: 0, order: 0, dom: 0, domOff: 0, phi: 0 } as Region));
const LA = [0, 0], LB = [0, 0], LC = [0, 0];
const CELL = [0, 0, 0];

/**
 * One cell's field at local (U down the fall line incl. creep and warp, V across): writes
 * [n, dn/dU, dn/dV] into CELL, n in 0..1.3 (times the bump size gives metres).
 */
function cellField(r: Region, U: number, V: number): void {
  const i0 = Math.floor(V / r.w);
  line(r, i0, U, LA); line(r, i0 + 1, U, LB);
  let j = i0, lo = LA, hi = LB;
  if (V < LA[0]) { line(r, i0 - 1, U, LC); j = i0 - 1; lo = LC; hi = LA; }
  else if (V >= LB[0]) { line(r, i0 + 2, U, LC); j = i0 + 1; lo = LB; hi = LC; }
  const g = hi[0] - lo[0], gU = hi[1] - lo[1];
  const t = Math.min(1, Math.max(0, (V - lo[0]) / g));
  const tU = -(lo[1] + t * gU) / g, tV = 1 / g;
  const s = Math.max(Math.sin(Math.PI * t), 1e-6); // same guard as MOGUL_GLSL
  const sh = Math.pow(s, 1.5), shT = 1.5 * Math.sqrt(s) * Math.PI * Math.cos(Math.PI * t);
  const q = g / (r.w * WF_REF);
  const wf = q >= 1 ? 1 : Math.pow(q, 1.5), wfG = q >= 1 ? 0 : 1.5 * Math.sqrt(q) / (r.w * WF_REF);
  // per-bump spread: value noise along the gap, knots one bump (two turns) apart
  const kb = U / r.lam, m = Math.floor(kb), f = kb - m;
  const ha = hash(r.rx * 97 + j, r.ry * 89 + m, 31), hb = hash(r.rx * 97 + j, r.ry * 89 + m + 1, 31);
  const sf = f * f * (3 - 2 * f);
  const mult = 1 + VAR * (ha + (hb - ha) * sf), multU = VAR * (hb - ha) * 6 * f * (1 - f) / r.lam;
  CELL[0] = mult * wf * sh;
  CELL[1] = multU * wf * sh + mult * wfG * gU * sh + mult * wf * shT * tU;
  CELL[2] = mult * wf * shT * tV;
}

/**
 * Bump height (0..MOGUL_MAX_AMP m) at pack (x, y). `fallX, fallY` is the downhill vector with the
 * slope as its length (rise over run; zero means flat, facing east), `amp` the field strength 0..1,
 * `creepM` shifts the field uphill by that many metres.
 */
export function mogulHeight(x: number, y: number, amp: number, fallX: number, fallY: number, creepM: number): number {
  return mogulEval(x, y, amp, fallX, fallY, creepM, null);
}

/**
 * Height and its slope in one evaluation (BUG-062 review: the shader took three height taps per pixel
 * for the slope): writes [h, dh/dx, dh/dy] into `out` and returns h. The slope leaves out the change of
 * the bump size and the fall direction across the ground, which is what MOGUL_GLSL's mogulHG does too.
 */
export function mogulHeightGrad(x: number, y: number, amp: number, fallX: number, fallY: number, creepM: number, out: number[]): number {
  return mogulEval(x, y, amp, fallX, fallY, creepM, out);
}

function mogulEval(x: number, y: number, amp: number, fallX: number, fallY: number, creepM: number, out: number[] | null): number {
  if (out) { out[0] = 0; out[1] = 0; out[2] = 0; }
  if (amp <= 0) return 0;
  const l = Math.hypot(fallX, fallY);
  const a = Math.min(1, amp) * mogulSize(l);
  let fx = 1, fy = 0;
  if (l > 1e-6) { fx = fallX / l; fy = fallY / l; }
  const ju = JITTER_U * jitter(x, y, 1, JG1), jv = JITTER_V * jitter(x, y, 2, JG2);
  // slopes of U (along the fall line) and V (across it) in pack x, y, the warp included
  const Ux = fx + JITTER_U * JG1[0], Uy = fy + JITTER_U * JG1[1], Vx = -fy + JITTER_V * JG2[0], Vy = fx + JITTER_V * JG2[1];
  // the four nearest cell centres and their weights
  const gx = x / MOGUL_CELL - 0.5, gy = y / MOGUL_CELL - 0.5;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const wx = cellBlend(gx - ix), wy = cellBlend(gy - iy);
  const dwx = cellBlendD(gx - ix) / MOGUL_CELL, dwy = cellBlendD(gy - iy) / MOGUL_CELL;
  // n = N_MEAN + sum w (n_c - N_MEAN) / sqrt(sum w^2): a cell alone gives its own field exactly
  let acc = 0, ww = 0, dax = 0, day = 0, dwx2 = 0, dwy2 = 0;
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
    const r = region(Math.floor((ix + ox) / MOGUL_REGION), Math.floor((iy + oy) / MOGUL_REGION), REG[c]);
    cellField(r, u + creepM + ju, v + jv);
    const dev = CELL[0] - N_MEAN;
    acc += w * dev; ww += w * w;
    if (out) {
      const hx = CELL[1] * Ux + CELL[2] * Vx, hy = CELL[1] * Uy + CELL[2] * Vy;
      dax += dwdx * dev + w * hx; day += dwdy * dev + w * hy;
      dwx2 += w * dwdx; dwy2 += w * dwdy;
    }
  }
  const rs = 1 / Math.sqrt(ww);
  let n = N_MEAN + acc * rs, k = 1;
  if (n > CAP_KNEE) { const d = (n - CAP_KNEE) / (CAP_TOP - CAP_KNEE); n = CAP_KNEE + (CAP_TOP - CAP_KNEE) * d / (1 + d); k = 1 / ((1 + d) * (1 + d)); }
  const h = a * n;
  if (out) {
    const s = a * k * rs, t = acc * rs * rs;
    out[0] = h; out[1] = s * (dax - t * dwx2); out[2] = s * (day - t * dwy2);
  }
  return h;
}

const f1 = (v: number) => v.toFixed(1);
const f3 = (v: number) => v.toFixed(3);

/**
 * The same field in GLSL for the terrain shader, which shades every chunk up to MOGUL_SHADE_MAX_RES
 * with it: mogulHG(pxy, fall, amp, creep) takes pack coordinates (x east, y north) and the downhill
 * vector in the same frame (slope as its length) and returns height and slope; mogulSize(slope) is the
 * bump size per unit amplitude. Keep in step with mogulEval above.
 */
export const MOGUL_GLSL = /* glsl */ `
  float mogHash(int ix, int iy, int salt) {
    uint h = uint(ix) * 374761393u + uint(iy) * 668265263u + uint(salt) * 1442695041u;
    h = (h ^ (h >> 13u)) * 1274126177u;
    h ^= h >> 16u;
    return float(h & 0xffffu) / 32767.5 - 1.0;
  }
  float mog01(int ix, int iy, int salt) { return 0.5 + 0.5 * mogHash(ix, iy, salt); }
  // value noise and its slope: vec3(v, dv/dx, dv/dy)
  vec3 mogJitter(vec2 p, int salt) {
    vec2 f = p / ${f1(JITTER_CELL)};
    vec2 i = floor(f);
    vec2 r = f - i;
    vec2 t = r * r * (3.0 - 2.0 * r);
    vec2 dt = 6.0 * r * (1.0 - r) / ${f1(JITTER_CELL)};
    int ix = int(i.x), iy = int(i.y);
    float a = mogHash(ix, iy, salt), b = mogHash(ix + 1, iy, salt), c = mogHash(ix, iy + 1, salt), d = mogHash(ix + 1, iy + 1, salt);
    float lo = mix(a, b, t.x), hi = mix(c, d, t.x);
    return vec3(mix(lo, hi, t.y), mix(b - a, d - c, t.y) * dt.x, (hi - lo) * dt.y);
  }
  float mogulSize(float slopeTan) {
    float d = degrees(atan(abs(slopeTan)));
    return ${f3(SIZE_LO)} + ${f3(SIZE_HI - SIZE_LO)} * smoothstep(${f1(SIZE_DEG0)}, ${f1(SIZE_DEG1)}, d);
  }
  // FEAT-147: a pattern region's rider lines; reg = (bump spacing, lane width, order, phase),
  // dom = (dominant every n-th line or 0, offset)
  vec2 mogLine(ivec2 rr, vec4 reg, ivec2 dom, int i, float U) {
    bool isDom = dom.x > 0 && mod(float(i + dom.y), float(dom.x)) < 0.5;
    float loose = isDom ? 0.0 : 1.0 - reg.z;
    float lam = reg.x * (1.0 + 0.36 * loose * (mog01(rr.x * 97 + i, rr.y, 21) - 0.5));
    float phi = reg.w + float(i) * 3.14159265 + 2.2 * loose * (mog01(rr.x * 97 + i, rr.y, 22) - 0.5);
    float a = reg.y * (isDom ? 0.42 : 0.24 + 0.14 * mog01(rr.x * 97 + i, rr.y, 23));
    float kap = 6.2831853 / lam;
    float th = kap * U + phi;
    return vec2(float(i) * reg.y + a * sin(th), a * kap * cos(th));
  }
  // one cell's field: vec3(n, dn/dU, dn/dV)
  vec3 mogCell(ivec2 rr, float U, float V) {
    float lam = ${f1(MOGUL_TURN_MIN)} + ${f1(MOGUL_TURN_MAX - MOGUL_TURN_MIN)} * mog01(rr.x, rr.y, 11);
    vec4 reg = vec4(lam, lam * (0.62 + 0.2 * mog01(rr.x, rr.y, 12)), mog01(rr.x, rr.y, 13), 6.2831853 * mog01(rr.x, rr.y, 17));
    ivec2 dom = ivec2(mog01(rr.x, rr.y, 16) < 0.3 ? 0 : 3 + int(floor(mog01(rr.x, rr.y, 14) * 2.999)), int(floor(mog01(rr.x, rr.y, 15) * 4.999)));
    int i0 = int(floor(V / reg.y));
    vec2 la = mogLine(rr, reg, dom, i0, U), lb = mogLine(rr, reg, dom, i0 + 1, U);
    int j = i0;
    vec2 lo = la, hi = lb;
    if (V < la.x) { j = i0 - 1; lo = mogLine(rr, reg, dom, i0 - 1, U); hi = la; }
    else if (V >= lb.x) { j = i0 + 1; lo = lb; hi = mogLine(rr, reg, dom, i0 + 2, U); }
    float g = hi.x - lo.x, gU = hi.y - lo.y;
    float t = clamp((V - lo.x) / g, 0.0, 1.0);
    float tU = -(lo.y + t * gU) / g, tV = 1.0 / g;
    // rounding can take s a hair below 0, where pow is undefined
    float s = max(sin(3.14159265 * t), 1e-6);
    float sh = pow(s, 1.5), shT = 1.5 * sqrt(s) * 3.14159265 * cos(3.14159265 * t);
    float q = g / (reg.y * ${f1(WF_REF)});
    float wf = q >= 1.0 ? 1.0 : pow(q, 1.5), wfG = q >= 1.0 ? 0.0 : 1.5 * sqrt(q) / (reg.y * ${f1(WF_REF)});
    float kb = U / lam, mb = floor(kb), f = kb - mb;
    int m = int(mb);
    float ha = mogHash(rr.x * 97 + j, rr.y * 89 + m, 31), hb = mogHash(rr.x * 97 + j, rr.y * 89 + m + 1, 31);
    float mult = 1.0 + ${f1(VAR)} * mix(ha, hb, f * f * (3.0 - 2.0 * f));
    float multU = ${f1(VAR)} * (hb - ha) * 6.0 * f * (1.0 - f) / lam;
    return vec3(mult * wf * sh, multU * wf * sh + mult * wfG * gU * sh + mult * wf * shT * tU, mult * wf * shT * tV);
  }
  // height and slope in one evaluation: vec3(h, dh/dx, dh/dy), pack frame (mogulHeightGrad above)
  vec3 mogulHG(vec2 pxy, vec2 fall, float amp, float creep) {
    float l = length(fall);
    float a = min(amp, 1.0) * mogulSize(l);
    vec2 fd = l > 1e-6 ? fall / l : vec2(1.0, 0.0);
    vec3 ju = ${f1(JITTER_U)} * mogJitter(pxy, 1), jv = ${f1(JITTER_V)} * mogJitter(pxy, 2);
    // slopes of U and V in pack x, y, the warp included
    vec2 gU = fd + ju.yz, gV = vec2(-fd.y, fd.x) + jv.yz;
    vec2 g = pxy / ${f1(MOGUL_CELL)} - 0.5;
    vec2 gi = floor(g);
    vec2 z = clamp((g - gi - 0.4) / 0.2, 0.0, 1.0);
    vec2 w = z * z * (3.0 - 2.0 * z);
    vec2 dw = 30.0 * z * (1.0 - z) / ${f1(MOGUL_CELL)};
    float acc = 0.0, ww = 0.0;
    vec2 dacc = vec2(0.0), dww = vec2(0.0);
    for (int c = 0; c < 4; c++) {
      vec2 o = vec2(float(c & 1), float(c >> 1));
      vec2 wo = mix(1.0 - w, w, o);
      vec2 dwo = mix(-dw, dw, o);
      float wc = wo.x * wo.y;
      vec2 dwc = vec2(dwo.x * wo.y, wo.x * dwo.y);
      // outside the 8 m blend bands a neighbour's weight and its slope are exactly 0: skip it
      if (wc <= 0.0 && dwc.x == 0.0 && dwc.y == 0.0) continue;
      vec2 d = pxy - (gi + o + 0.5) * ${f1(MOGUL_CELL)};
      ivec2 rr = ivec2(floor((gi + o) / ${f1(MOGUL_REGION)}));
      vec3 n = mogCell(rr, dot(d, fd) + creep + ju.x, -d.x * fd.y + d.y * fd.x + jv.x);
      float dev = n.x - ${N_MEAN.toFixed(2)};
      vec2 dh = n.y * gU + n.z * gV;
      acc += wc * dev; ww += wc * wc;
      dacc += dwc * dev + wc * dh;
      dww += wc * dwc;
    }
    float rs = inversesqrt(ww);
    float nn = ${N_MEAN.toFixed(2)} + acc * rs, k = 1.0;
    if (nn > ${CAP_KNEE.toFixed(2)}) {
      float d = (nn - ${CAP_KNEE.toFixed(2)}) / ${(CAP_TOP - CAP_KNEE).toFixed(2)};
      nn = ${CAP_KNEE.toFixed(2)} + ${(CAP_TOP - CAP_KNEE).toFixed(2)} * d / (1.0 + d);
      k = 1.0 / ((1.0 + d) * (1.0 + d));
    }
    return a * vec3(nn, k * rs * (dacc - acc * rs * rs * dww));
  }
`;

/**
 * Unit downhill direction at (x, y) from central differences of `baseH` at +-d metres, written into
 * `out` ([fx, fy]); (1, 0) when the ground is flat.
 */
export function fallFrom(baseH: (x: number, y: number) => number, x: number, y: number, out: number[], d = 6): number[] {
  downhillFrom(baseH, x, y, out, d);
  const l = Math.hypot(out[0], out[1]);
  if (l < 1e-6) { out[0] = 1; out[1] = 0; return out; }
  out[0] /= l; out[1] /= l;
  return out;
}

/**
 * Downhill vector at (x, y) with the slope (rise over run) as its length, from central differences of
 * `baseH` at +-d metres, written into `out` ([x, y]): what mogulHeight takes (FEAT-147).
 */
export function downhillFrom(baseH: (x: number, y: number) => number, x: number, y: number, out: number[], d = MOGUL_FALL_D): number[] {
  out[0] = -(baseH(x + d, y) - baseH(x - d, y)) / (2 * d);
  out[1] = -(baseH(x, y + d) - baseH(x, y - d)) / (2 * d);
  return out;
}
