import * as THREE from 'three';

/**
 * FEAT-156: the tree atlas, drawn in code at load. One 1024 x 1024 RGBA texture holds every branch
 * card and bark swatch, in grey: the geometry's vertex colours give each species its colour, so one
 * atlas (and one material per LOD) serves all eight species.
 *
 *   top 768 px: 4 x 3 cells of 256 px, the branch sprays (CELL in species.ts); a spray runs from the
 *               trunk end (u = 0) to its tip (u = 1), centred across (v = 0.5)
 *   bottom 256 px: 8 bark swatches of 128 x 256, wrapping around (u) and up (v) the trunk
 *
 * Transparent texels carry the cell's mean colour so mipmaps don't fringe dark, and each mip level
 * rescales alpha so the share of texels over the 0.5 cutoff stays what it is at full size (the cards
 * keep their body at a distance instead of thinning out).
 */

export const ATLAS = 1024;
const CELLS_X = 4, CELL_PX = 256, BARK_W = 128, BARK_H = 256;

export interface UvRect { u0: number; v0: number; u1: number; v1: number }

/** UV rect of a branch cell (v up; the canvas top row is v = 1) */
export function cellRect(cell: number, insetPx = 3): UvRect {
  const cx = cell % CELLS_X, cy = Math.floor(cell / CELLS_X);
  const x0 = cx * CELL_PX + insetPx, x1 = (cx + 1) * CELL_PX - insetPx;
  const y0 = cy * CELL_PX + insetPx, y1 = (cy + 1) * CELL_PX - insetPx;
  return { u0: x0 / ATLAS, u1: x1 / ATLAS, v0: 1 - y1 / ATLAS, v1: 1 - y0 / ATLAS };
}

/** UV rect of a bark swatch */
export function barkRect(i: number, insetPx = 3): UvRect {
  const x0 = i * BARK_W + insetPx, x1 = (i + 1) * BARK_W - insetPx;
  const y0 = 3 * CELL_PX + insetPx, y1 = 3 * CELL_PX + BARK_H - insetPx;
  return { u0: x0 / ATLAS, u1: x1 / ATLAS, v0: 1 - y1 / ATLAS, v1: 1 - y0 / ATLAS };
}

export interface TreeAtlas {
  texture: THREE.DataTexture;
  /** mean linear value of the opaque texels of each branch cell (12) and bark swatch (8): the geometry divides its tint by it */
  cellMean: number[];
  barkMean: number[];
  /** generation time (ms) and texture memory (bytes, mipmaps included) */
  ms: number;
  bytes: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** strokes batched by grey level, so one stroke() per level instead of one per needle */
class Strokes {
  private readonly paths = new Map<string, Path2D>();
  line(x0: number, y0: number, x1: number, y1: number, grey: number, width: number): void {
    const g = Math.max(0, Math.min(255, Math.round(grey / 8) * 8)), w = Math.max(0.5, Math.round(width * 4) / 4);
    const key = `${g}|${w}`;
    let p = this.paths.get(key);
    if (!p) { p = new Path2D(); this.paths.set(key, p); }
    p.moveTo(x0, y0); p.lineTo(x1, y1);
  }
  flush(ctx: Ctx): void {
    ctx.lineCap = 'round';
    for (const [key, p] of this.paths) {
      const [g, w] = key.split('|').map(Number);
      ctx.strokeStyle = `rgb(${g},${g},${g})`; ctx.lineWidth = w; ctx.stroke(p);
    }
    this.paths.clear();
  }
}

interface SprayStyle {
  /** tip drop across the cell (share of the cell height, + is down) */
  droop: number;
  /** branchlets per side, their angle off the stem (rad), length (share of the half height) and droop */
  twigs: number; twigAngle: number; twigLen: number; twigDroop: number;
  /** needle length and width (px), needles per px of stem, spread off the stem (rad), forward lean */
  needleLen: number; needleW: number; density: number; spread: number;
  /** outline: spray half-height at u (0..1) as a share of the cell half height */
  outline: (u: number) => number;
  /** grey range of the needles, the stem grey */
  lo: number; hi: number; stem: number;
  /** pine: needles only in tufts at the twig tips (share of the twig) */
  tuft?: number;
}

function curvePoint(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number): [number, number, number] {
  const it = 1 - t;
  const x = it * it * x0 + 2 * it * t * cx + t * t * x1, y = it * it * y0 + 2 * it * t * cy + t * t * y1;
  const dx = 2 * it * (cx - x0) + 2 * t * (x1 - cx), dy = 2 * it * (cy - y0) + 2 * t * (y1 - cy);
  return [x, y, Math.atan2(dy, dx)];
}

/** a ragged needle mass along a quadratic curve: a filled body plus needle strokes off its edges */
function needleMass(ctx: Ctx, s: Strokes, r: () => number, st: SprayStyle, x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, from: number, scale: number): void {
  const steps = 10, left: [number, number][] = [], right: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = from + (1 - from) * i / steps;
    const [x, y, a] = curvePoint(x0, y0, cx, cy, x1, y1, t);
    const taper = st.tuft ? 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, (i / steps) * 0.85 + 0.15)) : 0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, t * 0.95 + 0.05));
    const w = st.needleLen * scale * taper * 0.75;
    const nx = -Math.sin(a), ny = Math.cos(a);
    left.push([x + nx * w * (0.7 + 0.5 * r()), y + ny * w * (0.7 + 0.5 * r())]);
    right.push([x - nx * w * (0.7 + 0.5 * r()), y - ny * w * (0.7 + 0.5 * r())]);
  }
  const g = Math.round(st.lo - 25 + 15 * r());
  ctx.fillStyle = `rgb(${g},${g},${g})`;
  ctx.beginPath(); ctx.moveTo(...left[0]);
  for (const p of left) ctx.lineTo(...p);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(...right[i]);
  ctx.closePath(); ctx.fill();
  const len = Math.hypot(x1 - x0, y1 - y0) * (1 - from);
  const n = Math.max(3, Math.round(len * st.density));
  for (let i = 0; i < n; i++) {
    const t = from + (1 - from) * (i + r()) / n;
    const [x, y, a] = curvePoint(x0, y0, cx, cy, x1, y1, t);
    const taper = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.05));
    for (const side of [-1, 1]) {
      const na = a + side * st.spread * (0.7 + 0.5 * r());
      const nl = st.needleLen * scale * taper * (0.75 + 0.6 * r());
      s.line(x, y, x + Math.cos(na) * nl, y + Math.sin(na) * nl, st.lo + (st.hi - st.lo) * r(), st.needleW * (0.8 + 0.5 * r()));
    }
  }
}

function drawSpray(ctx: Ctx, ox: number, oy: number, st: SprayStyle, seed: number): void {
  const r = rng(seed), s = new Strokes(), stems = new Strokes();
  const W = CELL_PX, H = CELL_PX, m = 6;
  ctx.save();
  ctx.beginPath(); ctx.rect(ox + 2, oy + 2, W - 4, H - 4); ctx.clip();
  const x0 = ox + m, y0 = oy + H / 2, x1 = ox + W - m - st.needleLen * 0.5, y1 = oy + H / 2 + st.droop * H * 0.3;
  const cx = ox + W * 0.55, cy = oy + H / 2 + st.droop * H * 0.08;
  for (let i = 0; i < 16; i++) {
    const [ax, ay] = curvePoint(x0, y0, cx, cy, x1, y1, i / 16), [bx, by] = curvePoint(x0, y0, cx, cy, x1, y1, (i + 1) / 16);
    stems.line(ax, ay, bx, by, st.stem, 4 - 2.5 * (i / 16));
  }
  // branchlets, alternating sides, their tips on the outline
  const twigs: [number, number, number, number, number, number][] = [];
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < st.twigs; i++) {
      const t = 0.06 + 0.86 * (i + (side > 0 ? 0.5 : 0) + 0.2 * r()) / st.twigs;
      const [bx, by, a] = curvePoint(x0, y0, cx, cy, x1, y1, t);
      const half = st.outline(t) * (H * 0.5 - 4) - st.needleLen * 0.5;
      if (half < 4) continue;
      const rel = st.twigAngle * (0.85 + 0.3 * r()), ang = a + side * rel;
      const L = Math.min(W * 0.55, half / Math.max(0.35, Math.sin(rel))) * st.twigLen * (0.85 + 0.25 * r());
      const ex = bx + Math.cos(ang) * L, ey = by + Math.sin(ang) * L + st.twigDroop * L * 0.4;
      const qx = (bx + ex) / 2 + Math.cos(a) * L * 0.12, qy = (by + ey) / 2;
      twigs.push([bx, by, qx, qy, ex, ey]);
      for (let k = 0; k < 4; k++) {
        const [px, py] = curvePoint(bx, by, qx, qy, ex, ey, k / 4), [px2, py2] = curvePoint(bx, by, qx, qy, ex, ey, (k + 1) / 4);
        stems.line(px, py, px2, py2, st.stem + 10, 2 - 1.2 * (k / 4));
      }
    }
  }
  stems.flush(ctx);
  for (const [bx, by, qx, qy, ex, ey] of twigs) needleMass(ctx, s, r, st, bx, by, qx, qy, ex, ey, st.tuft ?? 0, 0.9);
  needleMass(ctx, s, r, st, x0, y0, cx, cy, x1, y1, st.tuft ? 1 - st.tuft : 0.05, 1.05);
  s.flush(ctx);
  ctx.restore();
}

/** bare twigs branching toward the tip (aspen crowns, snag stubs) */
function drawTwigs(ctx: Ctx, ox: number, oy: number, seed: number, depth: number, spread: number, grey: number, width: number): void {
  const r = rng(seed), s = new Strokes();
  const W = CELL_PX, H = CELL_PX;
  const grow = (x: number, y: number, a: number, len: number, w: number, d: number): void => {
    const steps = 4;
    let px = x, py = y, pa = a;
    for (let i = 0; i < steps; i++) {
      pa += (r() - 0.5) * 0.35;
      const nx = px + Math.cos(pa) * len / steps, ny = py + Math.sin(pa) * len / steps;
      s.line(px, py, nx, ny, grey + (r() - 0.5) * 30, Math.max(0.6, w * (1 - i / steps * 0.35)));
      px = nx; py = ny;
      if (d > 0 && i >= 1 && r() < 0.55) grow(px, py, pa + (r() < 0.5 ? -1 : 1) * spread * (0.6 + 0.6 * r()), len * (0.45 + 0.2 * r()), w * 0.65, d - 1);
    }
    if (d > 0) {
      grow(px, py, pa - spread * (0.4 + 0.5 * r()), len * (0.55 + 0.2 * r()), w * 0.7, d - 1);
      grow(px, py, pa + spread * (0.4 + 0.5 * r()), len * (0.55 + 0.2 * r()), w * 0.7, d - 1);
    }
  };
  grow(ox + 8, oy + H / 2, (r() - 0.5) * 0.2, W * 0.36, width, depth);
  ctx.save(); ctx.beginPath(); ctx.rect(ox + 2, oy + 2, W - 4, H - 4); ctx.clip();
  s.flush(ctx);
  ctx.restore();
}

/** opaque foliage mass for the LOD1 cones */
function drawDense(ctx: Ctx, ox: number, oy: number, seed: number): void {
  const r = rng(seed), s = new Strokes();
  ctx.fillStyle = 'rgb(150,150,150)'; ctx.fillRect(ox, oy, CELL_PX, CELL_PX);
  for (let i = 0; i < 1400; i++) {
    const x = ox + r() * CELL_PX, y = oy + r() * CELL_PX, a = Math.PI * (0.25 + 0.5 * r()) * (r() < 0.5 ? 1 : -1) + Math.PI / 2, l = 4 + 6 * r();
    s.line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 110 + 120 * r(), 1.6);
  }
  s.flush(ctx);
}

/** grey bark, drawn wrapped across the swatch so it tiles around the trunk and from segment to segment up it */
function drawBark(ctx: Ctx, i: number, kind: 'scaly' | 'aspen' | 'smooth' | 'plates' | 'furrows' | 'grain', seed: number): void {
  const r = rng(seed), ox = i * BARK_W, oy = 3 * CELL_PX, W = BARK_W, H = BARK_H;
  ctx.save();
  ctx.beginPath(); ctx.rect(ox, oy, W, H); ctx.clip();
  const base = kind === 'aspen' ? 225 : kind === 'smooth' ? 190 : kind === 'grain' ? 185 : 150;
  ctx.fillStyle = `rgb(${base},${base},${base})`; ctx.fillRect(ox, oy, W, H);
  const wrap = (f: (dx: number, dy: number) => void): void => { for (const dx of [-W, 0, W]) for (const dy of [-H, 0, H]) f(dx, dy); };
  const blob = (x: number, y: number, rx: number, ry: number, g: number): void => wrap((dx, dy) => { ctx.fillStyle = `rgb(${g},${g},${g})`; ctx.beginPath(); ctx.ellipse(ox + x + dx, oy + y + dy, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); });
  const s = new Strokes();
  const line = (x0: number, y0: number, x1: number, y1: number, g: number, w: number): void => wrap((dx, dy) => s.line(ox + x0 + dx, oy + y0 + dy, ox + x1 + dx, oy + y1 + dy, g, w));
  if (kind === 'scaly' || kind === 'plates') {
    const n = kind === 'scaly' ? 420 : 160, sz = kind === 'scaly' ? 5 : 11;
    for (let k = 0; k < n; k++) blob(r() * W, r() * H, sz * (0.6 + 0.8 * r()), sz * (0.4 + 0.5 * r()), base - 50 + 90 * r());
    for (let k = 0; k < n / 2; k++) { const x = r() * W, y = r() * H; line(x, y, x + (r() - 0.5) * 8, y + 3 + 6 * r(), 60 + 30 * r(), 1.2); }
  } else if (kind === 'furrows') {
    for (let k = 0; k < 9; k++) { // deep vertical furrows, wavy, with lighter ridges between
      let x = (k + r() * 0.5) * W / 9; const w = 4 + 4 * r();
      for (let y = 0; y < H; y += 8) { const nx = x + (r() - 0.5) * 6; line(x, y, nx, y + 8, 40 + 25 * r(), w); x = nx; }
    }
    for (let k = 0; k < 220; k++) { const x = r() * W, y = r() * H; line(x, y, x + (r() - 0.5) * 3, y + 5 + 10 * r(), 175 + 50 * r(), 1.5); }
  } else if (kind === 'aspen') {
    for (let k = 0; k < 60; k++) { const x = r() * W, y = r() * H; line(x, y, x, y + 10 + 30 * r(), 205 + 30 * r(), 2 + 3 * r()); } // faint vertical streaks
    for (let k = 0; k < 40; k++) { const x = r() * W, y = r() * H, l = 4 + 10 * r(); line(x - l / 2, y, x + l / 2, y, 95 + 40 * r(), 1.2); } // lenticels
    for (let k = 0; k < 7; k++) { // the black "eye" scars where branches fell
      const x = r() * W, y = r() * H, w = 9 + 8 * r();
      blob(x, y, w, w * 0.45, 45); blob(x, y - w * 0.18, w * 0.75, w * 0.2, 70);
    }
  } else if (kind === 'smooth') {
    for (let k = 0; k < 90; k++) { const x = r() * W, y = r() * H; line(x, y, x + 3 + 6 * r(), y, 150 + 40 * r(), 1.5); } // lenticels and resin blisters
    for (let k = 0; k < 30; k++) blob(r() * W, r() * H, 2 + 2 * r(), 1.5 + r(), 160);
  } else {
    for (let k = 0; k < 140; k++) { let x = r() * W, y = r() * H; const g = 140 + 80 * r(); for (let j = 0; j < 6; j++) { const nx = x + (r() - 0.5) * 3; line(x, y, nx, y + 8, g, 1 + r() * 1.5); x = nx; y += 8; } }
    for (let k = 0; k < 18; k++) { let x = r() * W, y = r() * H; for (let j = 0; j < 4; j++) { const nx = x + (r() - 0.5) * 4; line(x, y, nx, y + 12, 70, 2); x = nx; y += 12; } }
  }
  s.flush(ctx);
  ctx.restore();
}

function newCanvas(): { ctx: Ctx; read: () => Uint8ClampedArray } {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas'); c.width = ATLAS; c.height = ATLAS;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    return { ctx, read: () => ctx.getImageData(0, 0, ATLAS, ATLAS).data };
  }
  const c = new OffscreenCanvas(ATLAS, ATLAS);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return { ctx, read: () => ctx.getImageData(0, 0, ATLAS, ATLAS).data };
}

const SRGB_TO_LIN = (() => { const t = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); } return t; })();

/** rects (in pixels, image rows from the top) that keep their own alpha coverage through the mips */
function regions(): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let c = 0; c < 12; c++) out.push([(c % CELLS_X) * CELL_PX, Math.floor(c / CELLS_X) * CELL_PX, CELL_PX, CELL_PX]);
  return out;
}

export function buildTreeAtlas(): TreeAtlas {
  const t0 = performance.now();
  const { ctx, read } = newCanvas();
  ctx.clearRect(0, 0, ATLAS, ATLAS);
  const at = (cell: number): [number, number] => [(cell % CELLS_X) * CELL_PX, Math.floor(cell / CELLS_X) * CELL_PX];
  const spruce: SprayStyle = { droop: 0.22, twigs: 9, twigAngle: 0.95, twigLen: 1, twigDroop: 0.35, needleLen: 13, needleW: 2.2, density: 0.2, spread: 0.85, outline: (u) => 0.35 + 0.6 * Math.sin(Math.PI * Math.min(1, u * 0.9 + 0.08)), lo: 150, hi: 250, stem: 95 };
  const fir: SprayStyle = { droop: 0.04, twigs: 10, twigAngle: 1.15, twigLen: 1, twigDroop: -0.05, needleLen: 11, needleW: 2.4, density: 0.22, spread: 1.05, outline: (u) => 0.45 + 0.45 * Math.min(1, u * 2.5) * (1 - 0.35 * u), lo: 140, hi: 235, stem: 100 };
  const douglas: SprayStyle = { droop: -0.05, twigs: 8, twigAngle: 0.85, twigLen: 1.05, twigDroop: 0.25, needleLen: 14, needleW: 2.3, density: 0.2, spread: 0.95, outline: (u) => 0.4 + 0.6 * Math.sin(Math.PI * Math.min(1, u * 0.85 + 0.1)), lo: 150, hi: 245, stem: 100 };
  const lodge: SprayStyle = { droop: -0.1, twigs: 4, twigAngle: 0.7, twigLen: 1, twigDroop: -0.25, needleLen: 30, needleW: 2.2, density: 0.32, spread: 0.55, outline: (u) => 0.3 + 0.6 * u, lo: 160, hi: 250, stem: 100, tuft: 0.45 };
  const limber: SprayStyle = { droop: -0.15, twigs: 5, twigAngle: 0.8, twigLen: 1, twigDroop: -0.35, needleLen: 26, needleW: 2.2, density: 0.32, spread: 0.7, outline: (u) => 0.35 + 0.6 * Math.sin(Math.PI * Math.min(1, u * 0.8 + 0.2)), lo: 150, hi: 245, stem: 105, tuft: 0.5 };
  drawSpray(ctx, ...at(0), spruce, 11);
  drawSpray(ctx, ...at(1), { ...spruce, droop: 0.32, twigs: 8 }, 12);
  drawSpray(ctx, ...at(2), fir, 21);
  drawSpray(ctx, ...at(3), { ...fir, twigs: 9, droop: 0.0, twigDroop: -0.15 }, 22);
  drawSpray(ctx, ...at(4), douglas, 31);
  drawSpray(ctx, ...at(5), { ...douglas, twigDroop: 0.4, droop: 0.05 }, 32);
  drawSpray(ctx, ...at(6), lodge, 41);
  drawSpray(ctx, ...at(7), limber, 51);
  drawTwigs(ctx, ...at(8), 61, 5, 0.42, 190, 3.2);
  drawTwigs(ctx, ...at(9), 62, 5, 0.55, 190, 2.8);
  drawTwigs(ctx, ...at(10), 71, 2, 0.6, 200, 5);
  drawDense(ctx, ...at(11), 81);
  const kinds = ['scaly', 'aspen', 'smooth', 'plates', 'furrows', 'smooth', 'grain', 'scaly'] as const;
  for (let i = 0; i < 8; i++) drawBark(ctx, i, kinds[i], 91 + i);
  const tDraw = performance.now();
  const img = read();
  const tRead = performance.now();

  // flip to v up, fill transparent texels with their cell's mean colour, measure the means
  const N = ATLAS * ATLAS;
  const base = new Uint8Array(N * 4);
  for (let y = 0; y < ATLAS; y++) base.set(img.subarray((ATLAS - 1 - y) * ATLAS * 4, (ATLAS - y) * ATLAS * 4), y * ATLAS * 4);
  const meanOf = (x0: number, yTop: number, w: number, h: number, fill: boolean): number => {
    let sum = 0, sumLin = 0, n = 0;
    for (let y = yTop; y < yTop + h; y++) {
      const row = (ATLAS - 1 - y) * ATLAS;
      for (let x = x0; x < x0 + w; x++) { const o = (row + x) * 4; if (base[o + 3] >= 128) { sum += base[o]; sumLin += SRGB_TO_LIN[base[o]]; n++; } }
    }
    const g = n ? Math.round(sum / n) : 128;
    if (fill) for (let y = yTop; y < yTop + h; y++) {
      const row = (ATLAS - 1 - y) * ATLAS;
      for (let x = x0; x < x0 + w; x++) { const o = (row + x) * 4; if (base[o + 3] < 128) { const a = base[o + 3] / 255, v = Math.round(base[o] * a + g * (1 - a)); base[o] = base[o + 1] = base[o + 2] = v; } }
    }
    return n ? sumLin / n : 0.5;
  };
  const cellMean = regions().map(([x, y, w, h]) => meanOf(x, y, w, h, true));
  const barkMean: number[] = [];
  for (let i = 0; i < 8; i++) barkMean.push(meanOf(i * BARK_W, 3 * CELL_PX, BARK_W, BARK_H, false));

  // mip chain with alpha coverage kept per cell
  const target = regions().map(([x, y, w, h]) => {
    let n = 0;
    for (let yy = y; yy < y + h; yy++) { const row = (ATLAS - 1 - yy) * ATLAS; for (let xx = x; xx < x + w; xx++) if (base[(row + xx) * 4 + 3] >= 128) n++; }
    return n / (w * h);
  });
  const mipmaps: { data: Uint8Array; width: number; height: number }[] = [{ data: base, width: ATLAS, height: ATLAS }];
  let bytes = base.length;
  let prev = base, size = ATLAS;
  while (size > 1) {
    const ns = size >> 1, out = new Uint8Array(ns * ns * 4);
    const rowS = size * 4;
    for (let y = 0; y < ns; y++) {
      let i0 = y * 2 * rowS, o = y * ns * 4;
      for (let x = 0; x < ns; x++, i0 += 8, o += 4) {
        const i1 = i0 + rowS;
        out[o] = (prev[i0] + prev[i0 + 4] + prev[i1] + prev[i1 + 4] + 2) >> 2;
        out[o + 1] = (prev[i0 + 1] + prev[i0 + 5] + prev[i1 + 1] + prev[i1 + 5] + 2) >> 2;
        out[o + 2] = (prev[i0 + 2] + prev[i0 + 6] + prev[i1 + 2] + prev[i1 + 6] + 2) >> 2;
        out[o + 3] = (prev[i0 + 3] + prev[i0 + 7] + prev[i1 + 3] + prev[i1 + 7] + 2) >> 2;
      }
    }
    const k = ATLAS / ns;
    regions().forEach(([x, yTop, w, h], ri) => {
      const cw = w / k, ch = h / k;
      if (cw < 4) return;
      const x0 = x / k, y0 = (ATLAS - yTop - h) / k; // v-up rows
      const hist = new Uint32Array(256);
      for (let yy = y0; yy < y0 + ch; yy++) for (let xx = x0; xx < x0 + cw; xx++) hist[out[(yy * ns + xx) * 4 + 3]]++;
      // the alpha above which the target share of texels lies
      const want = target[ri] * cw * ch;
      let acc = 0, cut = 255;
      for (let v = 255; v > 0; v--) { acc += hist[v]; if (acc >= want) { cut = v; break; } }
      const scale = 128 / Math.max(1, cut);
      for (let yy = y0; yy < y0 + ch; yy++) for (let xx = x0; xx < x0 + cw; xx++) { const o = (yy * ns + xx) * 4 + 3; out[o] = Math.min(255, out[o] * scale); }
    });
    mipmaps.push({ data: out, width: ns, height: ns });
    bytes += out.length;
    prev = out; size = ns;
  }

  const tMip = performance.now();
  (globalThis as unknown as { __atlasTimes?: number[] }).__atlasTimes = [tDraw - t0, tRead - tDraw, tMip - tRead];
  const tex = new THREE.DataTexture(base, ATLAS, ATLAS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = mipmaps as unknown as THREE.DataTexture['mipmaps'];
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.name = 'tree atlas';
  tex.needsUpdate = true;
  return { texture: tex, cellMean, barkMean, ms: performance.now() - t0, bytes };
}
