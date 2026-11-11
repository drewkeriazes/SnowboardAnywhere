import { hash01 } from './species';

/**
 * FEAT-074: the stems a tree cell's stand density asks for, generated when the cell loads near the camera.
 * The pack keeps the detected crowns (trees/) and, per 1 km cell, stands/<cx>_<cy>.png
 * (pipeline/stands.py): per 4 m cell the chance of one stem (R), the stand height (G) and species (B), and
 * in the lower half the ground height (R high byte, G low). Every draw is a hash of the 4 m cell's centre,
 * so a cell generates the same stems every time, and a lower density keeps a subset of a higher one.
 */

/** one cell's decoded stand image and where it sits (pack metres, the cell's south-west corner) */
export interface StandGrid {
  /** RGBA bytes, `size` wide and 2 * `size` tall, row 0 = north */
  px: Uint8ClampedArray;
  size: number;
  res: number;
  minX: number;
  minY: number;
  zBase: number;
  zScale: number;
  hStep: number;
}

/** hash salts: keep, jitter x, jitter y, height */
const S_KEEP = 41, S_JX = 42, S_JY = 43, S_H = 44;
/** a stem stands within this share of its 4 m cell round the centre */
const JITTER = 0.9;

/** the stored ground height (m) of 4 m cell (i, j), or NaN where the image holds none */
function sampleZ(g: StandGrid, i: number, j: number): number {
  const o = (g.size * g.size + i * g.size + j) * 4, q = g.px[o] * 256 + g.px[o + 1];
  return q === 0 ? NaN : q / g.zScale + g.zBase;
}

/**
 * The ground height (m) at (x, y) from the grid's 4 m samples: bilinear between the four round it (linear
 * extrapolation in the outer half cell at the image's edges), or the nearest sample when one is missing.
 */
function groundAt(g: StandGrid, x: number, y: number): number {
  const n = g.size, top = g.minY + n * g.res;
  const fj = (x - g.minX) / g.res - 0.5, fi = (top - y) / g.res - 0.5;
  const j0 = Math.max(0, Math.min(n - 2, Math.floor(fj))), i0 = Math.max(0, Math.min(n - 2, Math.floor(fi)));
  const tx = fj - j0, ty = fi - i0;
  const a = sampleZ(g, i0, j0), b = sampleZ(g, i0, j0 + 1), c = sampleZ(g, i0 + 1, j0), d = sampleZ(g, i0 + 1, j0 + 1);
  if (!Number.isNaN(a + b + c + d)) return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  const own = sampleZ(g, Math.max(0, Math.min(n - 1, Math.round(fi))), Math.max(0, Math.min(n - 1, Math.round(fj))));
  if (!Number.isNaN(own)) return own;
  for (const z of [a, b, c, d]) if (!Number.isNaN(z)) return z;
  return NaN;
}

/**
 * The generated stems of a cell at `density` (0..1 of the stand's full density), as pack tree records
 * (x, y, z, height, crown 0 = the species' own, species id).
 */
export function generateStems(g: StandGrid, density: number): Float32Array {
  const n = g.size, res = g.res, top = g.minY + n * res, px = g.px;
  if (density <= 0) return new Float32Array(0);
  let count = 0;
  for (let i = 0, o = 0; i < n * n; i++, o += 4) {
    const p = px[o];
    if (p === 0) continue;
    const cx = g.minX + ((i % n) + 0.5) * res, cy = top - (Math.floor(i / n) + 0.5) * res;
    if (hash01(cx, cy, S_KEEP) < (p / 255) * density) count++;
  }
  const out = new Float32Array(count * 6);
  let k = 0;
  for (let i = 0, o = 0; i < n * n && k < count; i++, o += 4) {
    const p = px[o];
    if (p === 0) continue;
    const cx = g.minX + ((i % n) + 0.5) * res, cy = top - (Math.floor(i / n) + 0.5) * res;
    if (hash01(cx, cy, S_KEEP) >= (p / 255) * density) continue;
    const x = cx + (hash01(cx, cy, S_JX) - 0.5) * res * JITTER, y = cy + (hash01(cx, cy, S_JY) - 0.5) * res * JITTER;
    const z = groundAt(g, x, y);
    const b = k * 6;
    out[b] = x; out[b + 1] = y; out[b + 2] = Number.isNaN(z) ? g.zBase : z;
    out[b + 3] = px[o + 1] * g.hStep * (0.75 + 0.25 * hash01(cx, cy, S_H));
    out[b + 4] = 0; out[b + 5] = px[o + 2];
    k++;
  }
  return out;
}
