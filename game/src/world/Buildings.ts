import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { BuildingFeature } from '../pack/types';
import type { Collider } from '../sim/Collider';
import type { Ground } from '../terrain/Terrain';

/**
 * Buildings extruded from OSM footprints in features.json. Walls and a snow-covered roof are
 * merged into one geometry per 1 km cell (a few draw calls for the whole resort). FEAT-071: each
 * building gets a style class (on-mountain timber, Alpine village stucco, house, hut, utility) that
 * sets its colours, its height when OSM has none, a steep snowy gable roof over any footprint that
 * fills its rectangle, and facade bands (stone base, windows per storey, timber under the eaves).
 * The base is sunk below the footprint's lowest ground sample so nothing floats on a slope.
 */
const SINK = 2.5; // m below the lowest ground point under the footprint

/** BUG-045: a building=roof canopy: post width and the fascia depth under the roof edge (m) */
const POST = 0.35, CANOPY_FASCIA = 0.6;
/** canopy posts go at corners turning more than POST_TURN (radians), no closer than POST_GAP (m) */
const POST_TURN = 30 * Math.PI / 180, POST_GAP = 3;

/**
 * BUG-045: where a canopy's posts stand. A post per OSM node would wall in a canopy traced with
 * many nodes, so only real corners get one; a round or smooth outline gets about six, evenly spaced.
 */
function canopyPosts(pts: number[][]): number[][] {
  const n = pts.length, out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n], p = pts[i], c = pts[(i + 1) % n];
    const t = Math.abs(Math.atan2((p[0] - a[0]) * (c[1] - p[1]) - (p[1] - a[1]) * (c[0] - p[0]), (p[0] - a[0]) * (c[0] - p[0]) + (p[1] - a[1]) * (c[1] - p[1])));
    if (t < POST_TURN) continue;
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= POST_GAP) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < POST_GAP) out.pop();
  if (out.length >= 3) return out;
  let perim = 0;
  for (let i = 0; i < n; i++) perim += Math.hypot(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1]);
  const spacing = Math.max(POST_GAP, perim / 6);
  const even: number[][] = [pts[0]];
  let run = 0;
  for (let i = 1; i < n; i++) {
    run += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (run >= spacing) { even.push(pts[i]); run = 0; }
  }
  const last = even[even.length - 1];
  if (even.length > 3 && Math.hypot(last[0] - pts[0][0], last[1] - pts[0][1]) < spacing / 2) even.pop();
  return even.length >= 3 ? even : pts;
}
/** BUG-024: named buildings bigger than this (m^2) with no height in OSM get a lodge height */
const BIG_LODGE_M2 = 1500; // keep in step with BIG_LODGE_M2 in MapPacker-SnowboardAnywhere/pipeline/build_pack.py (old packs only)
/** twice the signed shoelace area: positive for a counter-clockwise footprint */
function signedArea2(pts: number[][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a;
}
/** edges shorter than this (m) get the plain wall quad only, no facade bands (keeps curved blocks cheap) */
const MIN_FACADE_EDGE = 3;

export class Buildings {
  readonly group = new THREE.Group();
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });
  get material(): THREE.MeshStandardMaterial { return this.mat; }

  private readonly collider: Collider | null;
  /** BUG-088: the terrain; a 1 km cell's buildings are drawn once the ground under it has its real heights (null: at once) */
  ground: Ground | null = null;
  /** BUG-088: cells still hidden, waiting for their ground: the mesh and its cell's rect (pack metres) */
  private waiting: { mesh: THREE.Mesh; minX: number; minY: number }[] = [];
  /** FEAT-071: the lowest building base in the pack (the village floor) */
  private readonly valleyFloor: number;

  constructor(pack: Pack, collider: Collider | null = null) {
    this.collider = collider;
    let vf = Infinity;
    for (const b of pack.features.buildings) if (Number.isFinite(b.zBase)) vf = Math.min(vf, b.zBase);
    this.valleyFloor = Number.isFinite(vf) ? vf : 0;
    const cells = new Map<string, BuildingFeature[]>();
    for (const b of pack.features.buildings) {
      if (b.points.length < 3) continue;
      const k = `${Math.floor(b.points[0][0] / 1000)}_${Math.floor(b.points[0][1] / 1000)}`;
      let arr = cells.get(k);
      if (!arr) { arr = []; cells.set(k, arr); }
      arr.push(b);
    }
    for (const [key, list] of cells) {
      const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
      for (const b of list) this.extrude(pack, b, pos, nor, col, idx);
      if (pos.length === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.mat);
      mesh.name = `buildings ${key}`;
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.visible = false;
      const [kx, ky] = key.split('_').map(Number);
      this.waiting.push({ mesh, minX: kx * 1000, minY: ky * 1000 });
      this.group.add(mesh);
    }
  }

  /**
   * BUG-088: show each cell's buildings once the terrain under it is real. They stand on the pipeline's ground
   * heights, so on the first frames, before the tiles there have loaded, they would float over the flat sheet.
   * A footprint can reach past its cell (it is binned by its first point), so the rect is grown by 200 m.
   */
  update(): void {
    if (!this.waiting.length) return;
    this.waiting = this.waiting.filter((w) => {
      if (this.ground && !this.ground.groundReady(w.minX - 200, w.minY - 200, w.minX + 1200, w.minY + 1200)) return true;
      w.mesh.visible = true;
      return false;
    });
  }

  private extrude(pack: Pack, b: BuildingFeature, pos: number[], nor: number[], col: number[], idx: number[]): void {
    // footprint in pack coords; drop a duplicated closing point
    let pts = b.points;
    if (pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
    if (pts.length < 3) return;
    // ground: lowest sample under the footprint (zBase from the pipeline as the fallback)
    let zMin = Infinity, zMax = -Infinity;
    for (const p of pts) {
      // only real samples (tiles may not be loaded yet); the pipeline's zBase is the fallback
      let h = NaN;
      for (const s of pack.sets) { if (s.contains(p[0], p[1])) { h = s.sample(p[0], p[1]); if (!Number.isNaN(h)) break; } }
      if (Number.isNaN(h)) continue;
      zMin = Math.min(zMin, h); zMax = Math.max(zMax, h);
    }
    // BUG-024: built before the tiles load, so usually no samples: the pipeline's lowest and highest
    // ground. The roof goes above the HIGHEST ground, or a big footprint on a slope is buried uphill.
    const hi = b.zMax ?? b.zBase;
    if (!Number.isFinite(zMin)) { zMin = b.zBase; zMax = hi; }
    const base = Math.min(zMin, b.zBase) - SINK;
    const sArea = signedArea2(pts);
    const area = Math.abs(sArea) / 2;
    const kind = b.kind ?? 'yes';
    // FEAT-071: a style class from where the building is and what it is tagged
    const style = styleOf(b, area, this.valleyFloor);
    let height = Math.max(3, b.height || 5);
    // older packs: a big named lodge with only the 5.5 m default is 3 to 4 storeys (Eagle's Nest)
    // packs with zMax already apply this rule in MapPacker's build_pack.py only when OSM has no height, so skip it there
    if (b.zMax === undefined && b.name && height <= 5.5 && area > BIG_LODGE_M2) height = 12;
    // FEAT-071: the pipeline's untagged defaults (5.5 m, or 9 m for hotels and shops) become a height
    // by class and size; heights from building:levels or height tags are kept
    // packs with heightDefault use the flag; older packs fall back to the magic values
    const untagged = b.heightDefault ?? (b.height === 5.5 || (b.height === 9 && DEFAULT_9.has(kind)));
    if (untagged) height = classHeight(style, kind, area, !!b.name);
    const top = Math.max(zMax, hi) + height;
    const P = PALETTE[style];
    const wall = P.wall;
    const roofSnow = [0.95, 0.96, 1.0];
    // ensure counter-clockwise (positive area) in x/y so wall normals face out
    if (sArea < 0) pts = [...pts].reverse();
    const n = pts.length;
    const quad = (q: number[][], nx: number, ny: number, nz: number, c: number[]) => {
      const v0 = pos.length / 3;
      for (const [x, y, z] of q) { pos.push(x, z, -y); nor.push(nx, nz, -ny); col.push(c[0], c[1], c[2]); }
      idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
    };
    // BUG-045: a canopy (building=roof: lift stations, covered decks) is a roof on posts with the
    // ground left walkable under it, not a solid block; only the posts stop the rider
    const canopy = kind === 'roof';
    if (canopy) {
      for (const p of canopyPosts(pts)) {
        if (this.collider) this.collider.add(p[0], p[1], POST / 2 + 0.05, base, top);
        for (let i = 0; i < 4; i++) {
          const a0 = (i * Math.PI) / 2 + Math.PI / 4, a1 = a0 + Math.PI / 2, r = POST * 0.71;
          const x0 = p[0] + Math.cos(a0) * r, y0 = p[1] + Math.sin(a0) * r, x1 = p[0] + Math.cos(a1) * r, y1 = p[1] + Math.sin(a1) * r;
          const nx = Math.cos(a0 + Math.PI / 4), ny = Math.sin(a0 + Math.PI / 4);
          quad([[x0, y0, base], [x1, y1, base], [x1, y1, top], [x0, y0, top]], nx, ny, 0, [0.3, 0.3, 0.32]);
        }
      }
    } else if (this.collider) this.collider.addFootprint(pts.map((p) => [p[0], p[1]] as [number, number]), base, top);
    // walls: one quad per edge with a flat normal (a canopy only has a fascia under its roof edge)
    const wallBase = canopy ? top - CANOPY_FASCIA : base;
    const storeys = Math.max(1, Math.round((top - Math.max(zMax, hi)) / STOREY));
    for (let i = 0; i < n; i++) {
      const a = pts[i], c = pts[(i + 1) % n];
      const ex = c[0] - a[0], ey = c[1] - a[1];
      const len = Math.hypot(ex, ey) || 1;
      const nx = ey / len, ny = -ex / len; // outward for CCW footprint (x east, y north)
      quad([[a[0], a[1], wallBase], [c[0], c[1], wallBase], [c[0], c[1], top], [a[0], a[1], top]], nx, ny, 0, wall);
      if (canopy || len < MIN_FACADE_EDGE) continue;
      // FEAT-071 facade, just proud of the wall: a stone base band up to the highest ground plus a
      // little, a dark window band per storey (huts get one small one), and a timber band under the eaves
      const o = 0.04, ox = nx * o, oy = ny * o;
      const band = (z0: number, z1: number, inset: number, colour: number[]) => {
        if (len < 2 * inset + 0.8 || z1 <= z0) return;
        const ux = ex / len, uy = ey / len, ax = a[0] + ux * inset + ox, ay = a[1] + uy * inset + oy, cx = c[0] - ux * inset + ox, cy = c[1] - uy * inset + oy;
        quad([[ax, ay, z0], [cx, cy, z0], [cx, cy, z1], [ax, ay, z1]], nx, ny, 0, colour);
      };
      const g = Math.max(zMax, hi);
      band(base, g + STONE_H, 0, P.stone);
      for (let k = 0; k < storeys; k++) {
        const z0 = g + k * STOREY + (k === 0 ? STONE_H + 0.3 : 0.9), z1 = g + k * STOREY + 2.2;
        if (z1 < top - 0.4) band(z0, z1, style === 'hut' ? Math.max(0.6, len / 2 - 0.5) : 0.7, GLASS);
      }
      band(top - 0.35, top, 0, P.trim);
    }
    // roof: FEAT-071 a steep snowy gable over the footprint's rectangle (along the longest edge) when
    // the footprint fills most of it, for any number of points; L and T shapes and big village
    // blocks keep a flat snow roof with a dark eave strip
    let best = 0, ax = 1, ay = 0;
    for (let i = 0; i < n; i++) { const a = pts[i], c = pts[(i + 1) % n]; const l = Math.hypot(c[0] - a[0], c[1] - a[1]); if (l > best) { best = l; ax = (c[0] - a[0]) / l; ay = (c[1] - a[1]) / l; } }
    const px = -ay, py = ax;
    let a0 = Infinity, a1 = -Infinity, p0 = Infinity, p1 = -Infinity;
    for (const p of pts) { const u = p[0] * ax + p[1] * ay, v = p[0] * px + p[1] * py; a0 = Math.min(a0, u); a1 = Math.max(a1, u); p0 = Math.min(p0, v); p1 = Math.max(p1, v); }
    const fill = area / Math.max(1e-6, (a1 - a0) * (p1 - p0));
    const flat = canopy || fill < MIN_FILL || (style === 'village' && area > FLAT_BLOCK_M2 && !b.name) || style === 'utility';
    if (!flat) {
      // ridge along the rectangle's long side; eaves overhang by OVERHANG all round
      let [ua, ub, va, vb] = [a0, a1, p0, p1];
      let [dx, dy, qx, qy] = [ax, ay, px, py];
      // ridge along the perpendicular instead: keep the frame right-handed (q = -a) so faces still wind outward
      if (a1 - a0 < p1 - p0) { [ua, ub, va, vb] = [p0, p1, -a1, -a0]; [dx, dy, qx, qy] = [px, py, -ax, -ay]; }
      const half = (vb - va) / 2, mid = (va + vb) / 2, rise = Math.min(9, half * PITCH[style]);
      const at = (u: number, v: number) => [dx * u + qx * v, dy * u + qy * v];
      const peak = top + rise, e = OVERHANG, drop = e * PITCH[style];
      // the two snow slopes, from eave (overhang, a little lower) to the ridge
      for (const side of [-1, 1]) {
        const vE = side < 0 ? va - e : vb + e;
        const [x0, y0] = at(ua - e, vE), [x1, y1] = at(ub + e, vE), [x2, y2] = at(ub + e, mid), [x3, y3] = at(ua - e, mid);
        const nh = Math.hypot(rise, half), sx = (qx * side * rise) / nh, sy = (qy * side * rise) / nh, sz = half / nh;
        const q = side < 0 ? [[x0, y0, top - drop], [x1, y1, top - drop], [x2, y2, peak], [x3, y3, peak]] : [[x1, y1, top - drop], [x0, y0, top - drop], [x3, y3, peak], [x2, y2, peak]];
        quad(q, sx, sy, sz, roofSnow);
        // the snow's thickness at the eave and a timber fascia under it
        const f0 = side < 0 ? [x0, y0] : [x1, y1], f1 = side < 0 ? [x1, y1] : [x0, y0];
        quad([[f0[0], f0[1], top - drop - SNOW_T], [f1[0], f1[1], top - drop - SNOW_T], [f1[0], f1[1], top - drop], [f0[0], f0[1], top - drop]], qx * side, qy * side, 0, roofSnow);
        quad([[f0[0], f0[1], top - drop - SNOW_T - 0.25], [f1[0], f1[1], top - drop - SNOW_T - 0.25], [f1[0], f1[1], top - drop - SNOW_T], [f0[0], f0[1], top - drop - SNOW_T]], qx * side, qy * side, 0, P.trim);
      }
      // gable ends: wall-coloured triangles from the eaves to the ridge, at the rectangle's ends
      for (const end of [-1, 1]) {
        const u = end < 0 ? ua : ub;
        const [lx, ly] = at(u, va), [rx, ry] = at(u, vb), [mx, my] = at(u, mid);
        const v0 = pos.length / 3;
        const tri = end < 0 ? [[rx, ry, top], [lx, ly, top], [mx, my, peak]] : [[lx, ly, top], [rx, ry, top], [mx, my, peak]];
        for (const [x, y, z] of tri) { pos.push(x, z, -y); nor.push(dx * end, 0, -dy * end); col.push(P.gable[0], P.gable[1], P.gable[2]); }
        idx.push(v0, v0 + 1, v0 + 2);
      }
      // a flat lid at the eave height over the footprint, so a footprint narrower than its rectangle is closed
      const shape = pts.map((p) => new THREE.Vector2(p[0], p[1]));
      const v0 = pos.length / 3;
      for (const p of pts) { pos.push(p[0], top - 0.02, -p[1]); nor.push(0, 1, 0); col.push(roofSnow[0], roofSnow[1], roofSnow[2]); }
      for (const t of THREE.ShapeUtils.triangulateShape(shape, [])) idx.push(v0 + t[0], v0 + t[1], v0 + t[2]);
      return;
    }
    const shape = pts.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(shape, []);
    if (canopy) {
      // the canopy's underside, seen from the deck below
      const v0 = pos.length / 3;
      for (const p of pts) { pos.push(p[0], top - CANOPY_FASCIA, -p[1]); nor.push(0, -1, 0); col.push(wall[0] * 0.6, wall[1] * 0.6, wall[2] * 0.6); }
      for (const t of tris) idx.push(v0 + t[0], v0 + t[2], v0 + t[1]);
    }
    const v0 = pos.length / 3;
    for (const p of pts) { pos.push(p[0], top, -p[1]); nor.push(0, 1, 0); col.push(roofSnow[0], roofSnow[1], roofSnow[2]); }
    for (const t of tris) idx.push(v0 + t[0], v0 + t[1], v0 + t[2]);
    // a dark eave strip just under the roof edge so flat roofs read as a building, not a snow pile
    const eave = top - 0.5;
    for (let i = 0; i < n; i++) {
      const a = pts[i], c = pts[(i + 1) % n];
      const ex = c[0] - a[0], ey = c[1] - a[1], len = Math.hypot(ex, ey) || 1;
      const nx = ey / len, ny = -ex / len;
      quad([[a[0] + nx * 0.15, a[1] + ny * 0.15, eave], [c[0] + nx * 0.15, c[1] + ny * 0.15, eave], [c[0] + nx * 0.15, c[1] + ny * 0.15, top + 0.05], [a[0] + nx * 0.15, a[1] + ny * 0.15, top + 0.05]], nx, ny, 0, [0.25, 0.2, 0.16]);
    }
  }
}

/** FEAT-071 style classes: on-mountain lodges and huts, the Alpine village, houses, small huts, big plain blocks */
type Style = 'mountain' | 'village' | 'residential' | 'hut' | 'utility';
const STOREY = 3.2, STONE_H = 0.8, OVERHANG = 0.6, SNOW_T = 0.25;
/** a footprint must fill this much of its rectangle to get a pitched roof */
const MIN_FILL = 0.72;
/** unnamed village blocks bigger than this (m^2) keep a flat roof (garages, big commercial) */
const FLAT_BLOCK_M2 = 2500;
/** buildings this far above the lowest building in the pack count as on the mountain (m) */
const MOUNTAIN_ABOVE = 180;
const DEFAULT_9 = new Set(['hotel', 'apartments', 'commercial', 'retail']);
const RESIDENTIAL = new Set(['residential', 'house', 'detached', 'semidetached_house', 'terrace', 'cabin', 'apartments']);
/** roof pitch as rise over half-span: steep Alpine roofs (about 38 to 42 deg), lower on big lodges */
const PITCH: Record<Style, number> = { mountain: 0.75, village: 0.85, residential: 0.8, hut: 0.9, utility: 0.3 };
const GLASS = [0.11, 0.13, 0.17];
const PALETTE: Record<Style, { wall: number[]; stone: number[]; trim: number[]; gable: number[] }> = {
  mountain: { wall: [0.36, 0.25, 0.17], stone: [0.42, 0.41, 0.39], trim: [0.22, 0.15, 0.1], gable: [0.33, 0.23, 0.15] },
  village: { wall: [0.86, 0.81, 0.7], stone: [0.5, 0.48, 0.45], trim: [0.3, 0.2, 0.13], gable: [0.38, 0.26, 0.17] },
  residential: { wall: [0.58, 0.45, 0.32], stone: [0.45, 0.43, 0.4], trim: [0.26, 0.18, 0.12], gable: [0.5, 0.38, 0.27] },
  hut: { wall: [0.42, 0.3, 0.2], stone: [0.4, 0.39, 0.37], trim: [0.24, 0.16, 0.1], gable: [0.4, 0.28, 0.18] },
  utility: { wall: [0.58, 0.56, 0.53], stone: [0.45, 0.44, 0.42], trim: [0.3, 0.3, 0.3], gable: [0.58, 0.56, 0.53] },
};

function styleOf(b: BuildingFeature, area: number, valleyFloor: number): Style {
  const kind = b.kind ?? 'yes';
  if (!b.name && area < 60) return 'hut';
  if (RESIDENTIAL.has(kind) && kind !== 'apartments') return 'residential';
  if (b.zBase > valleyFloor + MOUNTAIN_ABOVE) return 'mountain';
  if (!b.name && (kind === 'industrial' || kind === 'warehouse' || kind === 'garage' || kind === 'garages' || kind === 'parking')) return 'utility';
  return 'village';
}

/** Height for a building with only the pipeline's default: by class, size and name (m, eave height). */
function classHeight(style: Style, kind: string, area: number, named: boolean): number {
  if (style === 'hut') return 3;
  if (style === 'residential') return area > 250 ? 7 : 6.4;
  if (kind === 'hotel' || kind === 'apartments') return area > 1500 ? 16 : 13;
  if (style === 'mountain') return named && area > 1000 ? 12 : area > 300 ? 7 : 4.5;
  if (style === 'utility') return 6;
  return area > 1200 ? 12 : area > 300 ? 9.6 : 6.4; // village: 2 to 4 storeys
}
