import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';
import { aspectOf, snowpackChanged, snowpackDepth, snowpackState, type SnowpackState } from '../sim/Snowpack';
import { SPECIES, VARIANTS, hash01, fadeWidth, treeMaterial, treeDepthMaterial, newBand, SHRUBS, SHRUB_KINDS, WILLOW, YOUNG_CONIFER, buildShrubGeometries, type TreeKit, type ShrubGeometrySet } from './trees';
import { vegetationNearRadius } from './Vegetation';

/**
 * FEAT-159: the shrubs and understory (DATA-020's shrub set: willow, juniper, sagebrush, young conifers,
 * Gambel oak), drawn within about 300 m of the camera with the tree kit (trees/shrubs.ts for the shrubs,
 * the kit's spruce and fir LOD1 for the young conifers) and buried by the snowpack (sim/Snowpack.ts).
 *
 * Burial: the terrain is the snow surface, so each shrub is sunk by the snowpack depth at its spot (the
 * season, its height and aspect, the new snow; +-10 % per shrub for drifting) and only what stands above
 * it is drawn. A juniper, sagebrush or young conifer buried past its top still shows as a snow-covered
 * hump (SHRUBS[k].hump, fading out under 2 m more snow); willow and oak stems just go under. The material
 * (materials.ts, SHRUB) caps the visible tops with the tree snow, drifts snow round the stems where they
 * leave the snow (the per-instance `aShrub`: snow line and drift height, a few cm on a thin stem) and covers a half-buried mat or sapling in a mound.
 *
 * Drawing: one InstancedMesh per kind x variant (20), filled from the shrubs within the reach of where the
 * camera was, regathered every 25 m of movement or when the snowpack changes; the band (materials.ts)
 * dithers them out over the last few metres. About 1,500 shrubs at most in reach on Vail, under 60
 * triangles each (young conifers 96), so whole meshes are culled by three.js, not tiles.
 *
 * Physics: young conifers standing over 1.5 m above the snow get a trunk like a tree; the rest is brush
 * (Collider.addBrush): ridden through and over, a little slower (rider/Ride.ts) with a brush sound
 * (Audio.ts). Both follow the burial.
 */

/** the reach at full density (m); scaled with the trees' near radius by the graphics setting */
const REACH = 300;
/** regather after the camera has moved this far (m) */
const MARGIN = 25;
/** cells are loaded within the reach plus this (m), and dropped past twice it */
const LOAD_PAD = 200;
/** draw a shrub only when this much of it (m) shows above the snow */
const MIN_SHOW = 0.04;
/** a young conifer standing this tall above the snow (m) is a trunk to hit, not brush */
const TRUNK_H = 1.5;
/** brush this low above the snow (m) is not felt */
const BRUSH_MIN = 0.1;
/** a buried hump fades out under this much more snow (m) than the shrub's height */
const HUMP_FADE = 2;
/** young conifers: spruce or fir (kit species), 60 / 40 */
const YOUNG_SPECIES = [0, 3];
const OFF = -1e9;

/** one mesh's worth: a kind and variant, its geometry and which material */
interface Combo { kind: number; geo: THREE.BufferGeometry; young: boolean; name: string }

interface Cell {
  cx: number;
  cy: number;
  data: Float32Array | null;
  loading: boolean;
  missing: boolean;
  /** per shrub: combo index, crown radius (m), yaw, brightness, drift jitter */
  combo: Uint8Array | null;
  crown: Float32Array | null;
  yaw: Float32Array | null;
  tint: Float32Array | null;
  jit: Float32Array | null;
  /** the snow surface under it (m, NaN until the fine height tile is in) and its aspect weights */
  gz: Float32Array | null;
  south: Float32Array | null;
  north: Float32Array | null;
  /** collider entries made the first time a shrub was gathered (null: none yet) */
  trunk: (Float32Array | null)[];
  brush: (Float32Array | null)[];
}

export class Shrubs {
  readonly group = new THREE.Group();
  readonly shrubGeo: ShrubGeometrySet;
  /** the lit materials (shrubs; young conifers, with LOD1's snow share), for the cascaded shadows */
  readonly mat: { shrub: THREE.MeshStandardMaterial; young: THREE.MeshStandardMaterial };
  private readonly depth: THREE.MeshDepthMaterial;
  private readonly band = newBand();
  /** cells: loaded; instances: in loaded cells; drawn: in the meshes; buried: gathered but under the snow */
  readonly stats = { cells: 0, instances: 0, drawn: 0, buried: 0, gathers: 0 };
  /** cells in range still downloading */
  pending = 0;
  private readonly pack: Pack;
  private readonly collider: Collider | null;
  private readonly cells = new Map<string, Cell>();
  private readonly combos: Combo[] = [];
  private readonly meshes: (THREE.InstancedMesh | null)[] = [];
  private readonly staged: number[][] = [];
  private reach = REACH;
  private readonly at = { x: NaN, y: NaN };
  private dirty = true;
  /** while some shrubs in reach wait for their fine height tile: regather at this time (ms) */
  private retry = Infinity;
  private snow: SnowpackState = snowpackState(2, 'mid', 0);
  private readonly aspect: [number, number] = [0, 0];
  private readonly mtx = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly keep = new Set<string>();
  private readonly bury: Burial = { vis: 0, line: 0, mound: 0 };

  constructor(pack: Pack, collider: Collider | null, kit: TreeKit) {
    this.pack = pack;
    this.collider = collider;
    // FEAT-230: cells a partial pack had not got yet load again once its rest is in
    pack.onComplete(() => { for (const [k, c] of this.cells) if (c.missing && !c.loading) { this.cells.delete(k); this.dirty = true; } });
    const youngTris = Math.max(...YOUNG_SPECIES.flatMap((s) => kit.geo.lod1[s].map((g) => (g.index ? g.index.count : g.getAttribute('position').count) / 3)));
    this.shrubGeo = buildShrubGeometries(kit.atlas.cellMean, kit.atlas.barkMean, youngTris);
    const tex = kit.atlas.texture, wind = { value: 0 };
    this.mat = {
      shrub: treeMaterial(tex, { band: this.band, wind, alphaToCoverage: true, shrub: true }),
      young: treeMaterial(tex, { band: this.band, wind, alphaToCoverage: false, snowK: 0.6, shrub: true }),
    };
    this.mat.shrub.name = 'shrubs'; this.mat.young.name = 'shrubs young conifers';
    this.depth = treeDepthMaterial(tex, { band: this.band, wind, alphaToCoverage: false, shrub: true });
    for (let k = 0; k < SHRUB_KINDS; k++) {
      if (k === YOUNG_CONIFER) {
        for (const s of YOUNG_SPECIES) for (let v = 0; v < VARIANTS; v++) this.combos.push({ kind: k, geo: kit.geo.lod1[s][v], young: true, name: `${SPECIES[s].name} ${v}` });
      } else {
        this.shrubGeo.geo[k].forEach((g, v) => this.combos.push({ kind: k, geo: g, young: false, name: `${SHRUBS[k].name} ${v}` }));
      }
    }
    for (let i = 0; i < this.combos.length; i++) { this.meshes.push(null); this.staged.push([]); }
    this.setBand();
  }

  /** the day's snowpack (sim/Snowpack.ts); the shrubs are buried again when it changes by a couple of centimetres */
  setSnowpack(st: SnowpackState): void {
    if (!snowpackChanged(this.snow, st)) return;
    this.snow = st;
    this.dirty = true;
  }
  get snowpack(): SnowpackState { return this.snow; }

  /** the snowpack depth (m) at a point, as the shrubs there are buried (headless checks) */
  depthAt(x: number, y: number): number {
    const n = this.pack.groundNormal(x, y, [0, 0, 1]);
    const a = aspectOf(n[0], n[1], this.aspect);
    return snowpackDepth(this.snow, this.pack.terrainHeight(x, y), a[0], a[1]);
  }

  private setBand(): void {
    const f = fadeWidth(this.reach) / 2;
    this.band.value.set(-2, -1, this.reach - f, this.reach + f);
  }

  /** stream cells round the camera (and the look-ahead point ax, ay) and regather when it has moved; x, y the rider (pack metres) */
  update(x: number, y: number, ax = x, ay = y, cam?: THREE.Vector3): void {
    const inst = this.pack.meta.instances;
    if (!inst || !inst.shrubCount) return;
    const cpx = cam ? cam.x : x, cpy = cam ? -cam.z : y;
    const reach = REACH * Math.max(0.4, Math.min(1, vegetationNearRadius() / 1500));
    if (Math.abs(reach - this.reach) > 1) { this.reach = reach; this.setBand(); this.dirty = true; }
    const cs = inst.cellSize, load = this.reach + LOAD_PAD, drop = load + LOAD_PAD;
    const keep = this.keep;
    keep.clear();
    let pending = 0;
    const cx0 = Math.max(0, Math.floor((Math.min(cpx, ax) - load - inst.minX) / cs)), cx1 = Math.min(inst.cellsX - 1, Math.floor((Math.max(cpx, ax) + load - inst.minX) / cs));
    const cy0 = Math.max(0, Math.floor((Math.min(cpy, ay) - load - inst.minY) / cs)), cy1 = Math.min(inst.cellsY - 1, Math.floor((Math.max(cpy, ay) + load - inst.minY) / cs));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const minX = inst.minX + cx * cs, minY = inst.minY + cy * cs;
      const d = Math.min(rectDist(cpx, cpy, minX, minY, cs), rectDist(ax, ay, minX, minY, cs));
      if (d > load) continue;
      const key = `${cx}_${cy}`;
      keep.add(key);
      let cell = this.cells.get(key);
      if (!cell) {
        cell = { cx, cy, data: null, loading: false, missing: false, combo: null, crown: null, yaw: null, tint: null, jit: null, gz: null, south: null, north: null, trunk: [], brush: [] };
        this.cells.set(key, cell);
        this.load(cell);
      }
      if (cell.loading) pending++;
    }
    for (const [key, cell] of this.cells) {
      if (keep.has(key)) continue;
      const minX = inst.minX + cell.cx * cs, minY = inst.minY + cell.cy * cs;
      if (Math.min(rectDist(cpx, cpy, minX, minY, cs), rectDist(ax, ay, minX, minY, cs)) < drop) continue; // hysteresis
      this.dropCell(cell);
      this.cells.delete(key);
      this.dirty = true;
    }
    if (this.dirty || Math.hypot(cpx - this.at.x, cpy - this.at.y) > MARGIN || performance.now() > this.retry) this.gather(cpx, cpy);
    this.pending = pending;
    let n = 0;
    for (const c of this.cells.values()) if (c.data) n += c.data.length / 6;
    this.stats.cells = this.cells.size; this.stats.instances = n;
  }

  private async load(cell: Cell): Promise<void> {
    const listed = this.pack.meta.instances?.shrubCells;
    if (listed && !listed.includes(`${cell.cx}_${cell.cy}`)) { cell.missing = true; return; } // empty cell, no request
    if (!this.pack.has('shrubs', `${cell.cx}_${cell.cy}`)) { cell.missing = true; return; } // FEAT-230: not yet
    cell.loading = true;
    try {
      const resp = await fetch(`${this.pack.baseUrl}/shrubs/${cell.cx}_${cell.cy}.bin`);
      if (!resp.ok) { cell.missing = true; return; }
      const d = new Float32Array(await resp.arrayBuffer());
      if (this.cells.get(`${cell.cx}_${cell.cy}`) !== cell) return; // dropped while loading
      this.prepare(cell, d);
      this.dirty = true;
    } catch {
      cell.missing = true;
    } finally {
      cell.loading = false;
    }
  }

  /** per shrub: its mesh (kind x variant), crown, yaw, brightness and drift jitter */
  private prepare(cell: Cell, d: Float32Array): void {
    const n = d.length / 6;
    const combo = new Uint8Array(n), crown = new Float32Array(n), yaw = new Float32Array(n), tint = new Float32Array(n), jit = new Float32Array(n);
    const first: number[] = [];
    this.combos.forEach((c, i) => { if (first[c.kind] === undefined) first[c.kind] = i; });
    for (let i = 0; i < n; i++) {
      const o = i * 6, x = d[o], y = d[o + 1], h = d[o + 3], r = d[o + 4];
      const kind = Math.max(0, Math.min(SHRUB_KINDS - 1, Math.round(d[o + 5])));
      if (kind === YOUNG_CONIFER) {
        const sp = hash01(x, y, 7) < 0.6 ? 0 : 1, v = Math.floor(hash01(x, y, 3) * VARIANTS) % VARIANTS;
        combo[i] = first[kind] + sp * VARIANTS + v;
        // a young tree is bushier than a grown one of its species: 1.35 times its natural crown, nudged by the record
        const nat = SPECIES[YOUNG_SPECIES[sp]].radius * h * 1.35;
        crown[i] = Math.max(nat, Math.min(r, 0.32 * h));
      } else {
        combo[i] = first[kind] + Math.floor(hash01(x, y, 3) * SHRUBS[kind].variants) % SHRUBS[kind].variants;
        // a willow record is one bush of a clump: kept to about a third of its height across, so the clump reads as stems close together
        crown[i] = Math.max(0.15, kind === WILLOW ? Math.min(r, 0.35 * h) : r);
      }
      yaw[i] = hash01(x, y, 5) * Math.PI * 2;
      tint[i] = 0.92 + 0.16 * hash01(x, y, 13);
      jit[i] = 0.9 + 0.2 * hash01(x, y, 23);
    }
    cell.combo = combo; cell.crown = crown; cell.yaw = yaw; cell.tint = tint; cell.jit = jit;
    cell.gz = new Float32Array(n).fill(NaN); cell.south = new Float32Array(n); cell.north = new Float32Array(n);
    cell.trunk = new Array(n).fill(null); cell.brush = new Array(n).fill(null);
    cell.data = d;
  }

  /** the snow surface and its aspect under shrub i: inside the fine set once its tile is in (NaN until then), outside it from the mid / far sets at once */
  private resolve(cell: Cell, i: number): void {
    const d = cell.data!, x = d[i * 6], y = d[i * 6 + 1], fine = this.pack.fine;
    if (fine && fine.contains(x, y) && Number.isNaN(fine.sample(x, y))) return; // inside the fine set, tile not loaded yet
    cell.gz![i] = this.pack.terrainHeight(x, y);
    // the aspect from a 4 m difference (the slope the snow lies on, not the 1 m bumps)
    const e = 4, hl = this.pack.demHeight(x - e, y), hr = this.pack.demHeight(x + e, y), hd = this.pack.demHeight(x, y - e), hu = this.pack.demHeight(x, y + e);
    const nx = -(hr - hl) / (2 * e), ny = -(hu - hd) / (2 * e), l = Math.hypot(nx, ny, 1);
    const a = aspectOf(nx / l, ny / l, this.aspect);
    cell.south![i] = a[0]; cell.north![i] = a[1];
  }

  /** refill the meshes from the shrubs within reach of (x, y), buried by the snowpack, and set their colliders */
  private gather(x: number, y: number): void {
    this.at.x = x; this.at.y = y; this.dirty = false;
    this.stats.gathers++;
    const inst = this.pack.meta.instances!, cs = inst.cellSize;
    const r = this.reach + fadeWidth(this.reach) / 2 + MARGIN, r2 = r * r;
    for (const s of this.staged) s.length = 0;
    let buried = 0, unresolved = 0;
    const st = this.snow, col = this.collider;
    for (const cell of this.cells.values()) {
      const d = cell.data;
      if (!d) continue;
      const minX = inst.minX + cell.cx * cs, minY = inst.minY + cell.cy * cs;
      if (rectDist(x, y, minX, minY, cs) > r) continue;
      const n = d.length / 6;
      for (let i = 0; i < n; i++) {
        const o = i * 6, sx = d[o], sy = d[o + 1];
        const ex = sx - x, ey = sy - y;
        if (ex * ex + ey * ey > r2) continue;
        if (Number.isNaN(cell.gz![i])) this.resolve(cell, i);
        const resolved = !Number.isNaN(cell.gz![i]);
        if (!resolved) unresolved++;
        const gz = resolved ? cell.gz![i] : d[o + 2], h = d[o + 3], kind = this.combos[cell.combo![i]].kind, k = SHRUBS[kind];
        const depth = snowpackDepth(st, gz, cell.south![i], cell.north![i]) * (st.override === null ? cell.jit![i] : 1);
        const above = h - depth, vis = buryShrub(kind, h, depth, this.bury).vis;
        // colliders (made on first sight; only where the ground under it is known)
        if (col && resolved) {
          const trunkUp = kind === YOUNG_CONIFER && above >= TRUNK_H;
          if (kind === YOUNG_CONIFER) {
            let t = cell.trunk[i];
            if (!t && trunkUp) t = cell.trunk[i] = col.add(sx, sy, Math.max(0.12, h * 0.02), gz - 1, gz + above);
            if (t) { t[3] = trunkUp ? gz - 1 : OFF; t[4] = trunkUp ? gz + above : OFF; }
          }
          let b = cell.brush[i];
          const brushUp = !trunkUp && above > BRUSH_MIN;
          if (!b && brushUp) b = cell.brush[i] = col.addBrush(sx, sy, cell.crown![i] * 0.85, gz + above, k.brush);
          if (b) b[3] = brushUp ? gz + above : OFF;
        }
        if (vis < MIN_SHOW) { buried++; continue; }
        this.staged[cell.combo![i]].push(cell.cx * 65536 + cell.cy, i, gz + vis - h, this.bury.line, this.bury.mound, k.drift);
      }
    }
    // fill the meshes
    let drawn = 0;
    const cellOf = (key: number): Cell | undefined => this.cells.get(`${Math.floor(key / 65536)}_${key % 65536}`);
    for (let c = 0; c < this.combos.length; c++) {
      const list = this.staged[c], n = list.length / 6;
      let mesh = this.meshes[c];
      if (n === 0) { if (mesh) mesh.visible = false; continue; }
      if (!mesh || mesh.instanceMatrix.count < n) mesh = this.makeMesh(c, Math.ceil(n * 1.5) + 16);
      const attr = mesh.geometry.getAttribute('aShrub') as THREE.InstancedBufferAttribute, sa = attr.array as Float32Array;
      const ca = mesh.instanceColor!.array as Float32Array;
      for (let q = 0; q < n; q++) {
        const e = q * 6, cell = cellOf(list[e])!, i = list[e + 1], o = i * 6, d = cell.data!;
        const cr = cell.crown![i], h = d[o + 3];
        this.q.setFromAxisAngle(this.up, cell.yaw![i]);
        this.mtx.compose(this.pos.set(d[o], list[e + 2], -d[o + 1]), this.q, this.scl.set(cr, h, cr));
        mesh.setMatrixAt(q, this.mtx);
        sa[q * 3] = list[e + 3]; sa[q * 3 + 1] = list[e + 4]; sa[q * 3 + 2] = list[e + 5];
        const t = cell.tint![i];
        ca[q * 3] = t; ca[q * 3 + 1] = t; ca[q * 3 + 2] = t;
      }
      mesh.count = n;
      mesh.visible = true;
      for (const a of [mesh.instanceMatrix, attr, mesh.instanceColor!]) { a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; }
      mesh.computeBoundingSphere();
      drawn += n;
    }
    this.stats.drawn = drawn;
    this.stats.buried = buried;
    // shrubs inside the fine set whose tile is not in yet (on the pack's z, without colliders): try again shortly
    this.retry = unresolved > 0 ? performance.now() + 500 : Infinity;
  }

  /** a mesh for combo c with room for `cap` instances: the kit geometry's attributes shared, its own per-instance snow line */
  private makeMesh(c: number, cap: number): THREE.InstancedMesh {
    const old = this.meshes[c];
    // not the geometry: its vertex attributes are the kit's (the young conifers share Vegetation's LOD1 buffers)
    if (old) { this.group.remove(old); old.dispose(); }
    const combo = this.combos[c], src = combo.geo, g = new THREE.BufferGeometry();
    g.index = src.index;
    for (const name of Object.keys(src.attributes)) g.setAttribute(name, src.getAttribute(name));
    g.setAttribute('aShrub', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
    g.boundingBox = src.boundingBox; g.boundingSphere = src.boundingSphere;
    const mesh = new THREE.InstancedMesh(g, combo.young ? this.mat.young : this.mat.shrub, cap);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.name = `shrubs ${combo.name}`;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.customDepthMaterial = this.depth;
    this.meshes[c] = mesh;
    this.group.add(mesh);
    return mesh;
  }

  private dropCell(cell: Cell): void {
    if (this.collider) {
      for (const t of cell.trunk) if (t) this.collider.remove(t);
      for (const b of cell.brush) if (b) this.collider.removeBrush(b);
    }
    cell.data = null;
  }
}

export interface Burial {
  /** how much shows above the snow (m): the part above it, or a buried mat's or sapling's hump; under MIN_SHOW it is not drawn */
  vis: number;
  /** the snow line: the share of the height under the snow as drawn (the material's drift) */
  line: number;
  /** 0..1 the snow mound over a half-buried mat or sapling (the material's cover) */
  mound: number;
}

/** how a shrub of `kind` and height h (m) shows under `depth` m of snow (the game and treeshot) */
export function buryShrub(kind: number, h: number, depth: number, out: Burial = { vis: 0, line: 0, mound: 0 }): Burial {
  const k = SHRUBS[kind];
  const hump = k.hump > 0 ? Math.min(k.hump, 0.35 * h) * Math.max(0, 1 - Math.max(0, depth - h) / HUMP_FADE) : 0;
  out.vis = Math.max(h - depth, hump);
  out.line = 1 - out.vis / h;
  out.mound = k.mound * smooth(0.5, 1, depth / h);
  return out;
}
/** draw a shrub only when this much of it (m) shows above the snow */
export const SHRUB_MIN_SHOW = MIN_SHOW;

/** distance from (x, y) to a square cell (m), 0 inside */
function rectDist(x: number, y: number, minX: number, minY: number, size: number): number {
  return Math.hypot(Math.max(minX - x, 0, x - minX - size), Math.max(minY - y, 0, y - minY - size));
}

function smooth(a: number, b: number, x: number): number { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
