/**
 * Spatial hash of vertical cylinders (tree trunks, rocks) for rider collisions.
 * Cells are 8 m; lookups check the 3x3 neighbourhood.
 */
const CELL = 8;
/** BUG-045: a rider this close above a wall's or building's top is standing on it, not in it (m) */
const ON_TOP = 0.05;

export interface Hit {
  x: number;
  y: number;
  nx: number;
  ny: number;
  /** 0 = hard wall (tree trunk, tall boulder), 1 = rampable rock */
  kind: number;
  /** obstacle top height (m) for ramp launches */
  top: number;
  /** true when the point started inside a building footprint and was pushed out across an edge */
  inside: boolean;
  /** BUG-045: true when the hit is a building footprint's edge, a ledge whose top can be stood on */
  ledge: boolean;
}

/** Closed building footprint, counter-clockwise in x/y, for inside tests. */
interface Footprint {
  pts: [number, number][];
  zBase: number;
  zTop: number;
}

/** Even-odd point-in-polygon test. */
function insidePoly(pts: [number, number][], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export class Collider {
  private readonly cells = new Map<string, Float32Array[]>(); // packed [x, y, radius, zBase, zTop, kind]
  private readonly hit: Hit = { x: 0, y: 0, nx: 0, ny: 0, kind: 0, top: 0, inside: false, ledge: false };
  private readonly footprints = new Map<number, Footprint[]>();

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  /** Numeric cell key for the footprint map: floorAt runs on every ground lookup, so no string per call. */
  private fkey(cx: number, cy: number): number {
    return (cx + 0x8000) * 0x10000 + (cy + 0x8000);
  }

  add(x: number, y: number, radius: number, zBase: number, zTop: number, kind = 0): void {
    const k = this.key(Math.floor(x / CELL), Math.floor(y / CELL));
    let arr = this.cells.get(k);
    if (!arr) { arr = []; this.cells.set(k, arr); }
    arr.push(new Float32Array([x, y, radius, zBase, zTop, kind]));
  }

  private readonly walls = new Map<string, Float32Array[]>(); // packed [x1, y1, x2, y2, zBase, zTop, ledge, realTop]

  /**
   * Add a vertical wall segment (a building edge or a railing). Registered in every cell its bbox
   * touches. `ledge` marks a building footprint's edge, whose top can be stepped or climbed onto.
   */
  addWall(x1: number, y1: number, x2: number, y2: number, zBase: number, zTop: number, ledge = false): Float32Array {
    const w = new Float32Array([x1, y1, x2, y2, zBase, zTop, ledge ? 1 : 0, zTop]);
    const cx0 = Math.floor(Math.min(x1, x2) / CELL), cx1 = Math.floor(Math.max(x1, x2) / CELL);
    const cy0 = Math.floor(Math.min(y1, y2) / CELL), cy1 = Math.floor(Math.max(y1, y2) / CELL);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const k = this.key(cx, cy);
      let arr = this.walls.get(k);
      if (!arr) { arr = []; this.walls.set(k, arr); }
      arr.push(w);
    }
    return w;
  }

  /**
   * Switch a wall returned by `addWall` off or back on (FEAT-073: the lift-line setting). An off
   * wall's top drops below any rider, so every lookup skips it; slot 7 keeps the real top.
   */
  setWallActive(w: Float32Array, on: boolean): void {
    w[5] = on ? w[7] : -Infinity;
  }

  /**
   * Add a closed building footprint (counter-clockwise). Its edges become walls, and a point inside
   * it is pushed out across the nearest edge instead of being held in by the walls.
   */
  addFootprint(pts: [number, number][], zBase: number, zTop: number): void {
    const n = pts.length;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = pts[i], c = pts[(i + 1) % n];
      this.addWall(a[0], a[1], c[0], c[1], zBase, zTop, true);
      minX = Math.min(minX, a[0]); maxX = Math.max(maxX, a[0]); minY = Math.min(minY, a[1]); maxY = Math.max(maxY, a[1]);
    }
    const f: Footprint = { pts, zBase, zTop };
    for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
        const k = this.fkey(cx, cy);
        let arr = this.footprints.get(k);
        if (!arr) { arr = []; this.footprints.set(k, arr); }
        arr.push(f);
      }
    }
  }

  /** The footprint containing (x, y) at height z, or null. */
  private footprintAt(x: number, y: number, z: number): Footprint | null {
    const arr = this.footprints.get(this.fkey(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!arr) return null;
    for (const f of arr) if (z < f.zTop - ON_TOP && z + 1.5 >= f.zBase && insidePoly(f.pts, x, y)) return f;
    return null;
  }

  /**
   * BUG-045: the highest building top under (x, y) that a rider at height z can stand on: no more than
   * `reach` above z (a step or a climb) and no more than 2 m below (already up there). -Infinity if none.
   */
  floorAt(x: number, y: number, z: number, reach: number): number {
    if (this.footprints.size === 0) return -Infinity;
    const arr = this.footprints.get(this.fkey(Math.floor(x / CELL), Math.floor(y / CELL)));
    let best = -Infinity;
    if (arr) for (const f of arr) if (f.zTop <= z + reach && f.zTop >= z - 2 && f.zTop > best && insidePoly(f.pts, x, y)) best = f.zTop;
    return best;
  }

  /**
   * True when a rider at (x, y, z) would be inside a building, or within `clear` metres of a
   * building wall, railing, trunk or rock. `clear` up to CELL is covered by the 3x3 lookup.
   */
  blocked(x: number, y: number, z: number, clear: number): boolean {
    if (this.footprintAt(x, y, z)) return true;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const k = this.key(cx + i, cy + j);
        const cyl = this.cells.get(k);
        if (cyl) for (const c of cyl) {
          if (z > c[4] || z + 1.5 < c[3]) continue;
          if (Math.hypot(x - c[0], y - c[1]) < c[2] + clear) return true;
        }
        const walls = this.walls.get(k);
        if (walls) for (const w of walls) {
          if (z > w[5] - ON_TOP || z + 1.5 < w[4]) continue;
          const ex = w[2] - w[0], ey = w[3] - w[1];
          const len2 = ex * ex + ey * ey || 1e-6;
          const t = Math.max(0, Math.min(1, ((x - w[0]) * ex + (y - w[1]) * ey) / len2));
          if (Math.hypot(x - w[0] - ex * t, y - w[1] - ey * t) < clear) return true;
        }
      }
    }
    return false;
  }

  /** Cylinders (trunks, rocks) within r of (x, y): packed [x, y, radius, zBase, zTop, kind]. r up to CELL. */
  near(x: number, y: number, r: number, out: Float32Array[] = []): Float32Array[] {
    out.length = 0;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cyl = this.cells.get(this.key(cx + i, cy + j));
      if (cyl) for (const c of cyl) if (Math.hypot(x - c[0], y - c[1]) < c[2] + r) out.push(c);
    }
    return out;
  }

  /**
   * BUG-032: first obstacle on the segment a -> b (pack metres), as a fraction 0..1 of the way from a;
   * 1 when the line is clear. Trunks and rocks are padded by `pad` m; building walls count too.
   * Used by the chase camera to stop behind a tree instead of inside it.
   */
  segmentHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad = 0.4): number {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let best = 1;
    const cx0 = Math.floor((Math.min(ax, bx) - CELL) / CELL), cx1 = Math.floor((Math.max(ax, bx) + CELL) / CELL);
    const cy0 = Math.floor((Math.min(ay, by) - CELL) / CELL), cy1 = Math.floor((Math.max(ay, by) + CELL) / CELL);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const k = this.key(cx, cy);
      const cyl = this.cells.get(k);
      if (cyl && len2 > 1e-6) for (const c of cyl) {
        // where the line passes closest to the trunk, then step back to where it enters the padded circle
        const r = c[2] + pad;
        const t0 = ((c[0] - ax) * dx + (c[1] - ay) * dy) / len2;
        const px = ax + dx * t0 - c[0], py = ay + dy * t0 - c[1];
        const miss2 = px * px + py * py;
        if (miss2 >= r * r) continue;
        const t = t0 - Math.sqrt((r * r - miss2) / len2);
        if (t < 0 || t >= best) continue;
        const z = az + (bz - az) * t;
        if (z > c[4] || z < c[3]) continue; // passes over the top (a rock) or below the base
        best = t;
      }
      const walls = this.walls.get(k);
      if (walls) for (const w of walls) {
        const ex = w[2] - w[0], ey = w[3] - w[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((w[0] - ax) * ey - (w[1] - ay) * ex) / den;
        const u = ((w[0] - ax) * dy - (w[1] - ay) * dx) / den;
        if (t < 0 || t >= best || u < 0 || u > 1) continue;
        const z = az + (bz - az) * t;
        if (z > w[5] || z < w[4]) continue;
        best = t;
      }
    }
    return best;
  }

  clearCell(cellKey: string): void {
    this.cells.delete(cellKey);
  }

  /** Remove everything inside a rectangle (used when an instance cell unloads). */
  clearRect(minX: number, minY: number, maxX: number, maxY: number): void {
    for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) this.cells.delete(this.key(cx, cy));
    }
  }

  /** Push a circle of radius r at (x, y, z) out of any cylinder it overlaps. Returns the hit or null. */
  resolve(x: number, y: number, z: number, r: number): Hit | null {
    let found: Hit | null = null;
    this.hit.inside = false; this.hit.ledge = false;
    // inside a building footprint (spawned, teleported or unloaded there): push out across the
    // nearest edge. The two-sided walls below would otherwise hold the rider in.
    const fp = this.footprintAt(x, y, z);
    if (fp) {
      const p = fp.pts, n = p.length;
      let bestD = Infinity, bx = x, by = y, bnx = 1, bny = 0;
      for (let i = 0; i < n; i++) {
        const a = p[i], c = p[(i + 1) % n];
        const ex = c[0] - a[0], ey = c[1] - a[1];
        const len2 = ex * ex + ey * ey || 1e-6;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / len2));
        const px = a[0] + ex * t, py = a[1] + ey * t;
        const d = Math.hypot(x - px, y - py);
        if (d < bestD) { const l = Math.sqrt(len2); bestD = d; bx = px; by = py; bnx = ey / l; bny = -ex / l; } // outward for CCW
      }
      x = bx + bnx * (r + 1e-3); y = by + bny * (r + 1e-3);
      this.hit.x = x; this.hit.y = y; this.hit.nx = bnx; this.hit.ny = bny; this.hit.kind = 0; this.hit.top = fp.zTop; this.hit.inside = true; this.hit.ledge = false;
      found = this.hit;
    }
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const arr = this.cells.get(this.key(cx + i, cy + j));
        if (!arr) continue;
        for (const c of arr) {
          if (z > c[4] || z + 1.5 < c[3]) continue;
          const dx = x - c[0], dy = y - c[1];
          const d = Math.hypot(dx, dy);
          const min = c[2] + r;
          if (d < min) {
            const nx = d > 1e-4 ? dx / d : 1, ny = d > 1e-4 ? dy / d : 0;
            x = c[0] + nx * min; y = c[1] + ny * min;
            this.hit.x = x; this.hit.y = y; this.hit.nx = nx; this.hit.ny = ny; this.hit.kind = c[5]; this.hit.top = c[4]; this.hit.ledge = false;
            found = this.hit;
          }
        }
      }
    }
    // walls: push out along the segment normal
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const arr = this.walls.get(this.key(cx + i, cy + j));
        if (!arr) continue;
        for (const w of arr) {
          if (z > w[5] - ON_TOP || z + 1.5 < w[4]) continue;
          const ex = w[2] - w[0], ey = w[3] - w[1];
          const len2 = ex * ex + ey * ey || 1e-6;
          const t = Math.max(0, Math.min(1, ((x - w[0]) * ex + (y - w[1]) * ey) / len2));
          const px = w[0] + ex * t, py = w[1] + ey * t;
          const dx = x - px, dy = y - py;
          const d = Math.hypot(dx, dy);
          if (d < r) {
            let nx: number, ny: number;
            if (d > 1e-4) { nx = dx / d; ny = dy / d; }
            else { const l = Math.sqrt(len2); nx = ey / l; ny = -ex / l; }
            x = px + nx * r; y = py + ny * r;
            this.hit.x = x; this.hit.y = y; this.hit.nx = nx; this.hit.ny = ny; this.hit.kind = 0; this.hit.top = w[5]; this.hit.ledge = w[6] === 1;
            found = this.hit;
          }
        }
      }
    }
    return found;
  }

  get count(): number {
    let n = 0;
    for (const a of this.cells.values()) n += a.length;
    return n;
  }
}
