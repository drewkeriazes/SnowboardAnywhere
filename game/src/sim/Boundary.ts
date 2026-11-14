import type { Features } from '../pack/types';

/**
 * FEAT-305: the resort's outer edge, for the orange boundary rope (world/BoundaryRope.ts) and the out of bounds
 * crossing (sim/OutOfBounds.ts). Pure, pack coordinates (x east, y north).
 *
 * From the pack's `features.boundary` when it has one (the ski area polygon, MapPacker FEAT-313). Packs today have
 * none, so the edge is derived from the runs and lifts: their lines on a 10 m grid, closed by CLOSE m (gaps between
 * runs under twice that fill in), the holes filled, then pulled back to MARGIN m outside the outermost run lines.
 * Areas under MIN_AREA (a lone track off in the valley) are left out. The outline is traced with marching squares,
 * smoothed, and cut into spans of about SPACING m: one post per vertex, and the rope runs post to post.
 *
 * Rings are counter-clockwise, so in bounds is on the left of each span; `crossing` uses that to say which way the
 * rider went over the rope. Spans with a post in a building or on a road (the base village, where the outline cuts
 * through town) are open: no rope there, and crossing them does not count.
 */
const CELL = 10; // m
const CLOSE = 200; // m: the closing radius (runs up to 2 x CLOSE apart join)
const MARGIN = 60; // m outside the run and lift lines
const MIN_AREA = 300000; // m2
export const SPACING = 12; // m between posts
const BUCKET = 64; // m: the span hash

export type Ring = Float64Array; // x0, y0, x1, y1, ... closed (the last post links back to the first)

export class Boundary {
  /** the spans' hash: bucket key -> [ring index, post index] pairs */
  private readonly hash = new Map<number, number[]>();
  /** per ring, per span (post i to post i + 1): 1 where there is no rope */
  readonly open: Uint8Array[];

  constructor(readonly rings: Ring[], readonly source: 'pack' | 'runs') {
    this.open = rings.map((r) => new Uint8Array(r.length / 2));
    rings.forEach((r, ri) => {
      const n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = Math.min(r[2 * i], r[2 * j]), x1 = Math.max(r[2 * i], r[2 * j]);
        const y0 = Math.min(r[2 * i + 1], r[2 * j + 1]), y1 = Math.max(r[2 * i + 1], r[2 * j + 1]);
        for (let by = Math.floor(y0 / BUCKET); by <= Math.floor(y1 / BUCKET); by++) for (let bx = Math.floor(x0 / BUCKET); bx <= Math.floor(x1 / BUCKET); bx++) {
          const k = key(bx, by);
          let a = this.hash.get(k);
          if (!a) this.hash.set(k, a = []);
          a.push(ri, i);
        }
      }
    });
  }

  /** total rope length (m) and post count */
  get length(): number { let L = 0; for (const r of this.rings) { const n = r.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; L += Math.hypot(r[2 * j] - r[2 * i], r[2 * j + 1] - r[2 * i + 1]); } } return L; }
  get posts(): number { return this.rings.reduce((s, r) => s + r.length / 2, 0); }

  /**
   * The rope crossed moving from (x0, y0) to (x1, y1): +1 out of bounds, -1 back in, 0 not crossed (or out and back
   * in within the step). Meant for one frame's move (a few metres); a long jump checks every bucket it spans.
   */
  crossing(x0: number, y0: number, x1: number, y1: number): number {
    let net = 0;
    const seen = new Set<number>();
    const bx0 = Math.floor(Math.min(x0, x1) / BUCKET), bx1 = Math.floor(Math.max(x0, x1) / BUCKET);
    const by0 = Math.floor(Math.min(y0, y1) / BUCKET), by1 = Math.floor(Math.max(y0, y1) / BUCKET);
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      const a = this.hash.get(key(bx, by));
      if (!a) continue;
      for (let k = 0; k < a.length; k += 2) {
        const ri = a[k], i = a[k + 1], id = ri * 1e7 + i;
        if (seen.has(id) || this.open[ri][i]) continue;
        seen.add(id);
        const r = this.rings[ri], n = r.length / 2, j = (i + 1) % n;
        const ax = r[2 * i], ay = r[2 * i + 1], ex = r[2 * j] - ax, ey = r[2 * j + 1] - ay;
        const s0 = ex * (y0 - ay) - ey * (x0 - ax), s1 = ex * (y1 - ay) - ey * (x1 - ax);
        if ((s0 > 0) === (s1 > 0)) continue;
        // the move's line must separate the span's ends too
        const mx = x1 - x0, my = y1 - y0;
        const t0 = mx * (ay - y0) - my * (ax - x0), t1 = mx * (ay + ey - y0) - my * (ax + ex - x0);
        if ((t0 > 0) === (t1 > 0)) continue;
        net += s0 > 0 ? 1 : -1; // left (in) to right (out) is out
      }
    }
    return Math.sign(net);
  }

  /** The pack's polygon when it ships one, else the outline of its runs and lifts; null with nothing to go on. */
  static fromFeatures(f: Features, bounds: { minX: number; minY: number; maxX: number; maxY: number }): Boundary | null {
    const given = (f.boundary ?? []).filter((b) => b.points && b.points.length >= 3);
    if (given.length) {
      const rings = given.map((b) => resample(ccw(Float64Array.from(b.points.flatMap((p) => [p[0], p[1]]))), SPACING)).filter((r) => r.length >= 6);
      if (rings.length) return new Boundary(rings, 'pack').gaps(f);
    }
    const lines: number[][] = [];
    for (const r of f.runs) if (r.points.length >= 2) lines.push(r.points.flatMap((p) => [p[0], p[1]]));
    for (const l of f.lifts) { const s = l.cable?.length >= 2 ? l.cable : l.stations; if (s && s.length >= 2) lines.push(s.flatMap((p) => [p[0], p[1]])); }
    if (!lines.length) return null;
    const rings = outline(lines, bounds).map((r) => resample(ccw(chaikin(chaikin(r))), SPACING)).filter((r) => r.length >= 6);
    return rings.length ? new Boundary(rings, 'runs').gaps(f) : null;
  }

  /** open the spans either side of a post inside a building footprint or within ROAD_PAD m of a road's edge */
  private gaps(f: Features): this {
    const items = new Map<number, number[]>(); // bucket -> indices: buildings b, roads ~r
    const put = (x0: number, y0: number, x1: number, y1: number, id: number) => {
      for (let by = Math.floor(y0 / BUCKET); by <= Math.floor(y1 / BUCKET); by++) for (let bx = Math.floor(x0 / BUCKET); bx <= Math.floor(x1 / BUCKET); bx++) {
        const k = key(bx, by); let a = items.get(k); if (!a) items.set(k, a = []); a.push(id);
      }
    };
    f.buildings.forEach((b, i) => {
      if (b.points.length < 3) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of b.points) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      put(x0, y0, x1, y1, i);
    });
    f.roads.forEach((r, i) => {
      const pad = (r.width ?? 6) / 2 + ROAD_PAD;
      for (let p = 0; p + 1 < r.points.length; p++) {
        const a = r.points[p], b = r.points[p + 1];
        put(Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad, ~(i * 4096 + p));
      }
    });
    const blocked = (x: number, y: number): boolean => {
      const a = items.get(key(Math.floor(x / BUCKET), Math.floor(y / BUCKET)));
      if (!a) return false;
      for (const id of a) {
        if (id >= 0) { if (inPolygon(f.buildings[id].points, x, y)) return true; continue; }
        const v = ~id, r = f.roads[Math.floor(v / 4096)], p = v % 4096, A = r.points[p], B = r.points[p + 1];
        if (segDist(x, y, A[0], A[1], B[0], B[1]) < (r.width ?? 6) / 2 + ROAD_PAD) return true;
      }
      return false;
    };
    this.rings.forEach((r, ri) => {
      const n = r.length / 2, open = this.open[ri];
      for (let i = 0; i < n; i++) if (blocked(r[2 * i], r[2 * i + 1])) { open[i] = 1; open[(i + n - 1) % n] = 1; }
    });
    return this;
  }
}

const ROAD_PAD = 2; // m past a road's edge

function inPolygon(pts: readonly (readonly number[])[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax, ey = by - ay, L = ex * ex + ey * ey;
  const u = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / L)) : 0;
  return Math.hypot(x - ax - ex * u, y - ay - ey * u);
}

const key = (bx: number, by: number) => (bx + 32768) * 65536 + (by + 32768);

/** chamfer (3-4) distance in thirds of a cell from every cell where `seed` is 1 */
function chamfer(seed: Uint8Array, nx: number, ny: number): Uint32Array {
  const INF = 0x3fffffff, d = new Uint32Array(nx * ny);
  for (let i = 0; i < d.length; i++) d[i] = seed[i] ? 0 : INF;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i; let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + 3);
    if (j > 0) { v = Math.min(v, d[k - nx] + 3); if (i > 0) v = Math.min(v, d[k - nx - 1] + 4); if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + 4); }
    d[k] = v;
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i; let v = d[k];
    if (i < nx - 1) v = Math.min(v, d[k + 1] + 3);
    if (j < ny - 1) { v = Math.min(v, d[k + nx] + 3); if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + 4); if (i > 0) v = Math.min(v, d[k + nx - 1] + 4); }
    d[k] = v;
  }
  return d;
}

/** the in bounds area of the lines on the grid, traced into rings (world metres, not yet smoothed) */
function outline(lines: number[][], b: { minX: number; minY: number; maxX: number; maxY: number }): Ring[] {
  // two cells of padding on every side, so every outline closes
  const x0 = b.minX - 2 * CELL, y0 = b.minY - 2 * CELL;
  const nx = Math.ceil((b.maxX - b.minX) / CELL) + 4, ny = Math.ceil((b.maxY - b.minY) / CELL) + 4;
  const seed = new Uint8Array(nx * ny);
  for (const l of lines) for (let p = 0; p + 3 < l.length; p += 2) {
    const ax = l[p], ay = l[p + 1], bx = l[p + 2], by = l[p + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL / 2)));
    for (let s = 0; s <= n; s++) {
      const i = Math.floor((ax + (bx - ax) * s / n - x0) / CELL), j = Math.floor((ay + (by - ay) * s / n - y0) / CELL);
      if (i >= 2 && j >= 2 && i < nx - 2 && j < ny - 2) seed[j * nx + i] = 1;
    }
  }
  const third = CELL / 3;
  const dIn = chamfer(seed, nx, ny);
  const out = new Uint8Array(nx * ny);
  for (let k = 0; k < out.length; k++) out[k] = dIn[k] * third > CLOSE ? 1 : 0;
  for (let i = 0; i < nx; i++) { out[i] = out[i + nx] = out[(ny - 1) * nx + i] = out[(ny - 2) * nx + i] = 1; }
  for (let j = 0; j < ny; j++) { out[j * nx] = out[j * nx + 1] = out[j * nx + nx - 1] = out[j * nx + nx - 2] = 1; }
  const dOut = chamfer(out, nx, ny);
  const inside = new Uint8Array(nx * ny);
  for (let k = 0; k < inside.length; k++) inside[k] = dOut[k] * third > CLOSE - MARGIN ? 1 : 0;
  // fill the holes: outside cells the border cannot reach
  const reach = new Uint8Array(nx * ny), stack: number[] = [0];
  reach[0] = 1;
  while (stack.length) {
    const k = stack.pop()!, i = k % nx, j = (k - i) / nx;
    const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
    for (const q of nb) if (q >= 0 && !reach[q] && !inside[q]) { reach[q] = 1; stack.push(q); }
  }
  for (let k = 0; k < inside.length; k++) if (!reach[k]) inside[k] = 1;
  // drop the small areas
  const label = new Int32Array(nx * ny);
  let next = 0;
  for (let k0 = 0; k0 < inside.length; k0++) {
    if (!inside[k0] || label[k0]) continue;
    const id = ++next, cells: number[] = [k0];
    label[k0] = id;
    for (let c = 0; c < cells.length; c++) {
      const k = cells[c], i = k % nx, j = (k - i) / nx;
      const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
      for (const q of nb) if (q >= 0 && inside[q] && !label[q]) { label[q] = id; cells.push(q); }
    }
    if (cells.length * CELL * CELL < MIN_AREA) for (const k of cells) inside[k] = 0;
  }
  return march(inside, nx, ny).map((r) => {
    const o = new Float64Array(r.length);
    for (let i = 0; i < r.length; i += 2) { o[i] = x0 + (r[i] + 0.5) * CELL; o[i + 1] = y0 + (r[i + 1] + 0.5) * CELL; }
    return o;
  });
}

/**
 * Marching squares on the cell centres: rings through the midpoints between inside and outside cells, in grid units
 * (cell centre = integer). Every crossing midpoint belongs to exactly two squares, so the segments link into loops.
 */
function march(v: Uint8Array, nx: number, ny: number): number[][] {
  // an edge id: horizontal edge between (i, j) and (i + 1, j) = 2 * (j * nx + i), vertical between (i, j) and (i, j + 1) = that + 1
  const H = (i: number, j: number) => 2 * (j * nx + i), V = (i: number, j: number) => 2 * (j * nx + i) + 1;
  const link = new Map<number, number[]>();
  const add = (a: number, b: number) => { (link.get(a) ?? link.set(a, []).get(a)!).push(b); (link.get(b) ?? link.set(b, []).get(b)!).push(a); };
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = v[j * nx + i], b = v[j * nx + i + 1], c = v[(j + 1) * nx + i + 1], d = v[(j + 1) * nx + i];
    const code = a | (b << 1) | (c << 2) | (d << 3);
    if (code === 0 || code === 15) continue;
    const bot = H(i, j), right = V(i + 1, j), top = H(i, j + 1), left = V(i, j);
    switch (code) {
      case 1: case 14: add(left, bot); break;
      case 2: case 13: add(bot, right); break;
      case 3: case 12: add(left, right); break;
      case 4: case 11: add(right, top); break;
      case 6: case 9: add(bot, top); break;
      case 7: case 8: add(left, top); break;
      case 5: add(left, bot); add(right, top); break; // a and c inside: kept apart (the flood fills are 4-connected)
      case 10: add(bot, right); add(top, left); break; // b and d inside: kept apart
    }
  }
  const pt = (e: number): [number, number] => {
    const k = e >> 1, i = k % nx, j = (k - i) / nx;
    return e & 1 ? [i, j + 0.5] : [i + 0.5, j];
  };
  const used = new Set<number>(), rings: number[][] = [];
  for (const start of link.keys()) {
    if (used.has(start)) continue;
    const ring: number[] = [];
    let prev = -1, cur = start;
    while (!used.has(cur)) {
      used.add(cur);
      const [x, y] = pt(cur); ring.push(x, y);
      const nb = link.get(cur)!;
      const nxt = nb[0] !== prev ? nb[0] : nb[1];
      prev = cur; cur = nxt;
      if (cur === undefined) break;
    }
    if (ring.length >= 8) rings.push(ring);
  }
  return rings;
}

function chaikin(r: Ring): Ring {
  const n = r.length / 2, o = new Float64Array(n * 4);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = r[2 * i], ay = r[2 * i + 1], bx = r[2 * j], by = r[2 * j + 1];
    o[4 * i] = 0.75 * ax + 0.25 * bx; o[4 * i + 1] = 0.75 * ay + 0.25 * by;
    o[4 * i + 2] = 0.25 * ax + 0.75 * bx; o[4 * i + 3] = 0.25 * ay + 0.75 * by;
  }
  return o;
}

/** counter-clockwise (positive area, x east y north) */
function ccw(r: Ring): Ring {
  const n = r.length / 2;
  let a = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1]; }
  if (a >= 0) return r;
  const o = new Float64Array(r.length);
  for (let i = 0; i < n; i++) { o[2 * i] = r[2 * (n - 1 - i)]; o[2 * i + 1] = r[2 * (n - 1 - i) + 1]; }
  return o;
}

/** posts every `step` m along the closed ring (the last span evened out) */
function resample(r: Ring, step: number): Ring {
  const n = r.length / 2;
  let L = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; L += Math.hypot(r[2 * j] - r[2 * i], r[2 * j + 1] - r[2 * i + 1]); }
  const m = Math.max(3, Math.round(L / step)), ds = L / m, o = new Float64Array(m * 2);
  let seg = 0, segStart = 0, segLen = Math.hypot(r[2] - r[0], r[3] - r[1]);
  for (let k = 0; k < m; k++) {
    const s = k * ds;
    while (s > segStart + segLen && seg < n - 1) { segStart += segLen; seg++; const j = (seg + 1) % n; segLen = Math.hypot(r[2 * j] - r[2 * seg], r[2 * j + 1] - r[2 * seg + 1]); }
    const j = (seg + 1) % n, u = segLen > 0 ? (s - segStart) / segLen : 0;
    o[2 * k] = r[2 * seg] + (r[2 * j] - r[2 * seg]) * u; o[2 * k + 1] = r[2 * seg + 1] + (r[2 * j + 1] - r[2 * seg + 1]) * u;
  }
  return o;
}
