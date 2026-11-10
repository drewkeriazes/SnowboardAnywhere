import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';
import { TreeKit, SPECIES_COUNT, VARIANTS, speciesFor, variantFor, crownRadius, hash01, fadeWidth, farAttrs, farGeometry, type FarAttrs } from './trees';

/**
 * Streams tree instances per 1 km cell around the rider and draws them with the FEAT-156 tree kit
 * (trees/): eight species, four variants each, and four LODs picked per tree by its distance from the
 * camera, with a dither crossfade at each edge:
 *   LOD0 branch cards  0..80 m      one InstancedMesh per species x variant, from the trees near the camera
 *   LOD1 cones         80..400 m    the same, from a wider ring
 *   LOD2 crossed quads 400..1500 m  one mesh per cell (all species), from the baked impostor atlas
 *   impostors          1500..4500 m one mesh per cell, camera-facing quads from the same atlas
 * The two near sets are rebuilt on the CPU when the camera has moved part of their margin; the far
 * meshes hold a whole cell and the shader drops the trees outside their band. Distances scale with
 * the graphics setting (setVegetationDensity / setVegetationBudget).
 */
let NEAR_RADIUS = 1500;
let FAR_RADIUS = 4500;
/** LOD0 / LOD1 reach as a share of 80 / 400 m */
let LOD_K = 1;
/** FEAT-153: how far the tree impostors reach (m), where the terrain's canopy lift takes over */
export function vegetationFarRadius(): number { return FAR_RADIUS; }
/** Headless / weak GPU: far fewer instances. */
export function setVegetationBudget(near: number, far: number): void { NEAR_RADIUS = near; FAR_RADIUS = far; LOD_K = Math.max(0.5, Math.min(1, near / 1500)); }
/** Scale the near/far radii by a 0.25..1 density (1 = full 1500 / 4500 m); the LOD0 / LOD1 reach scales more gently. */
export function setVegetationDensity(d: number): void { const k = Math.max(0.25, Math.min(1, d)); NEAR_RADIUS = 1500 * k; FAR_RADIUS = 4500 * k; LOD_K = 0.6 + 0.4 * k; }

/** the LOD band edges for the current setting (m from the camera) */
function edges(): [number, number, number, number] {
  const b2 = NEAR_RADIUS, b1 = Math.min(400 * LOD_K, b2 * 0.8), b0 = Math.min(80 * LOD_K, b1 * 0.5);
  return [b0, b1, b2, FAR_RADIUS];
}

/** sub-tiles per cell side for the near-set gather */
const TILES = 10;
/** the near sets are rebuilt once the camera has moved this far from where they were gathered (m) */
const MARGIN0 = 25, MARGIN1 = 60;
/** krummholz flags stream downwind: the prevailing westerlies blow toward +x (east) */
const FLAG_YAW = 0;

interface Cell {
  key: string;
  cx: number;
  cy: number;
  data: Float32Array | null;
  /** per tree: kit species, variant, crown radius (m), yaw, colour variation (3) */
  sp: Uint8Array | null;
  va: Uint8Array | null;
  cr: Float32Array | null;
  yaw: Float32Array | null;
  tint: Float32Array | null;
  /** tree indices grouped by sub-tile; tile t holds order[tileStart[t] .. tileStart[t + 1]) */
  order: Uint32Array | null;
  tileStart: Uint32Array | null;
  zMin: number;
  zMax: number;
  far: FarAttrs | null;
  lod2: THREE.Mesh | null;
  imp: THREE.Mesh | null;
  loading: boolean;
  missing: boolean;
}

/** one near LOD: an InstancedMesh per species x variant, filled from the trees within `radius` of where it was gathered */
interface NearSet {
  lod: 0 | 1;
  meshes: (THREE.InstancedMesh | null)[];
  lists: number[][];
  x: number;
  y: number;
  radius: number;
  dirty: boolean;
  count: number;
}

export class Vegetation {
  readonly group = new THREE.Group();
  readonly kit: TreeKit;
  /** the lit materials (for the cascaded shadows) */
  readonly mat: { lod0: THREE.MeshStandardMaterial; lod1: THREE.MeshStandardMaterial };
  private readonly pack: Pack;
  private readonly collider: Collider | null;
  private readonly cells = new Map<string, Cell>();
  readonly stats = { cells: 0, instances: 0, lod0: 0, lod1: 0 };
  /** BUG-063: stop building cell meshes after this many ms per update (0 = no limit; headless keeps 0) */
  budgetMs = 0;
  /** BUG-063: cells in range still downloading or waiting for their meshes after the last update */
  pending = 0;
  private readonly near: NearSet[] = [0, 1].map((lod) => ({ lod: lod as 0 | 1, meshes: new Array(SPECIES_COUNT * VARIANTS).fill(null), lists: [], x: NaN, y: NaN, radius: 0, dirty: true, count: 0 }));
  private impostorsOn = true;
  private readonly cam = new THREE.Vector3(NaN, 0, 0);
  private readonly legacy: boolean;
  private bandKey = '';

  constructor(pack: Pack, collider: Collider | null) {
    this.pack = pack;
    this.collider = collider;
    this.kit = new TreeKit();
    this.mat = this.kit.mat;
    // packs from before DATA-020 have 0 conifer, 1 aspen, 2 krummholz only
    this.legacy = pack.meta.treeSpecies === undefined;
  }

  /** Bake the LOD2 / impostor atlases (needs the renderer). `on` false: no billboards, LOD2 runs to the far edge. */
  enableImpostors(renderer: THREE.WebGLRenderer, on = true): void {
    this.kit.bake(renderer);
    this.impostorsOn = on;
    this.bandKey = '';
  }
  /** Light the far LODs like the meshes: the sun (direction toward it) and the hemisphere light. */
  setLight(sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number, hemiSky: THREE.Color, hemiGround: THREE.Color, hemiIntensity: number): void {
    this.kit.setLight(sunDir, sunColor, sunIntensity, hemiSky, hemiGround, hemiIntensity);
  }

  /**
   * Stream cells around the rider (x, y) and the look-ahead point (ax, ay): a cell's distance is to the
   * nearer of the two. `cam` (three.js world) is where the LOD bands are measured from; it defaults to
   * the last one given, or the rider.
   */
  update(x: number, y: number, ax = x, ay = y, cam?: THREE.Vector3): void {
    const inst = this.pack.meta.instances;
    if (!inst) return;
    if (cam) this.cam.copy(cam);
    else if (Number.isNaN(this.cam.x)) this.cam.set(x, 0, -y);
    this.kit.setView(this.cam, performance.now() / 1000);
    const cpx = this.cam.x, cpy = -this.cam.z;
    // LOD bands for the current setting
    const [b0, b1, b2, b3] = edges();
    const bandKey = `${b0}|${b1}|${b2}|${b3}|${this.impostorsOn}`;
    if (bandKey !== this.bandKey) {
      this.bandKey = bandKey;
      this.kit.setBands(b0, b1, b2, b3, this.impostorsOn);
      for (const n of this.near) n.dirty = true;
    }
    const cs = inst.cellSize;
    const r = FAR_RADIUS;
    const cx0 = Math.max(0, Math.floor((Math.min(x, ax) - r - inst.minX) / cs)), cx1 = Math.min(inst.cellsX - 1, Math.floor((Math.max(x, ax) + r - inst.minX) / cs));
    const cy0 = Math.max(0, Math.floor((Math.min(y, ay) - r - inst.minY) / cs)), cy1 = Math.min(inst.cellsY - 1, Math.floor((Math.max(y, ay) + r - inst.minY) / cs));
    const keep = new Set<string>();
    let count = 0, pending = 0, built = 0;
    const t0 = performance.now();
    const f1 = fadeWidth(b1) / 2, f2 = fadeWidth(b2) / 2;
    const far = this.kit.far;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const ccx = inst.minX + (cx + 0.5) * cs, ccy = inst.minY + (cy + 0.5) * cs;
        const d = Math.min(Math.hypot(ccx - x, ccy - y), Math.hypot(ccx - ax, ccy - ay)) - cs * 0.71;
        if (d > FAR_RADIUS) continue;
        const key = `${cx}_${cy}`;
        keep.add(key);
        let cell = this.cells.get(key);
        if (!cell) {
          cell = { key, cx, cy, data: null, sp: null, va: null, cr: null, yaw: null, tint: null, order: null, tileStart: null, zMin: 0, zMax: 0, far: null, lod2: null, imp: null, loading: false, missing: false };
          this.cells.set(key, cell);
        }
        if (!cell.data && !cell.loading && !cell.missing) this.load(cell);
        if (cell.loading) pending++;
        if (!cell.data) continue;
        count += cell.data.length / 6;
        if (!far) { pending++; continue; } // waiting for the impostor bake
        // which far LODs this cell needs, from the camera's nearest and farthest distance to it
        const minX = inst.minX + cx * cs, minY = inst.minY + cy * cs;
        const dx = Math.max(minX - cpx, 0, cpx - minX - cs), dy = Math.max(minY - cpy, 0, cpy - minY - cs);
        const dMin = Math.hypot(dx, dy);
        const dMax = Math.hypot(Math.max(Math.abs(cpx - minX), Math.abs(cpx - minX - cs)), Math.max(Math.abs(cpy - minY), Math.abs(cpy - minY - cs)));
        const wantLod2 = dMax > b1 - f1 && (!this.impostorsOn || dMin < b2 + f2);
        const wantImp = this.impostorsOn && dMax > b2 - f2;
        if ((wantLod2 && !cell.lod2) || (wantImp && !cell.imp)) {
          // BUG-063: at least one build per update, then only while inside the time budget
          if (this.budgetMs <= 0 || built === 0 || performance.now() - t0 < this.budgetMs) { this.buildFar(cell, wantLod2, wantImp); built++; }
          else pending++;
        }
        if (cell.lod2) cell.lod2.visible = wantLod2;
        if (cell.imp) cell.imp.visible = wantImp;
      }
    }
    for (const [key, cell] of this.cells) {
      if (keep.has(key)) continue;
      this.dropCell(cell);
      if (cell.data && this.collider) {
        const minX = inst.minX + cell.cx * cs, minY = inst.minY + cell.cy * cs;
        this.collider.clearRect(minX, minY, minX + cs, minY + cs);
      }
      this.cells.delete(key);
      for (const n of this.near) n.dirty = true;
    }
    // the near sets: regather once the camera has moved part of their margin
    for (const n of this.near) {
      const margin = n.lod === 0 ? MARGIN0 : MARGIN1;
      const reach = (n.lod === 0 ? b0 + fadeWidth(b0) / 2 : b1 + f1) + margin;
      if (n.dirty || Math.hypot(cpx - n.x, cpy - n.y) > margin || Math.abs(reach - n.radius) > 1) this.gather(n, cpx, cpy, reach);
    }
    this.pending = pending;
    this.stats.cells = this.cells.size;
    this.stats.instances = count;
    this.stats.lod0 = this.near[0].count;
    this.stats.lod1 = this.near[1].count;
  }

  private async load(cell: Cell): Promise<void> {
    cell.loading = true;
    const listed = this.pack.meta.instances?.treeCells;
    if (listed && !listed.includes(`${cell.cx}_${cell.cy}`)) { cell.missing = true; cell.loading = false; return; } // empty cell, no request
    try {
      const resp = await fetch(`${this.pack.baseUrl}/trees/${cell.cx}_${cell.cy}.bin`);
      if (!resp.ok) { cell.missing = true; return; }
      const buf = await resp.arrayBuffer();
      cell.data = new Float32Array(buf);
      this.prepare(cell);
      if (this.collider) {
        const d = cell.data;
        for (let i = 0; i < d.length; i += 6) {
          const h = d[i + 3];
          this.collider.add(d[i], d[i + 1], Math.max(0.15, h * 0.02), d[i + 2] - 1, d[i + 2] + h);
        }
      }
      for (const n of this.near) n.dirty = true;
    } catch {
      cell.missing = true;
    } finally {
      cell.loading = false;
    }
  }

  /** per-tree species, variant, crown, yaw and colour, and the sub-tile index for the near gather */
  private prepare(cell: Cell): void {
    const d = cell.data!, n = d.length / 6;
    const inst = this.pack.meta.instances!;
    const sp = new Uint8Array(n), va = new Uint8Array(n), cr = new Float32Array(n), yaw = new Float32Array(n), tint = new Float32Array(n * 3);
    const tileOf = new Uint16Array(n), counts = new Uint32Array(TILES * TILES + 1);
    const ts = inst.cellSize / TILES, minX = inst.minX + cell.cx * inst.cellSize, minY = inst.minY + cell.cy * inst.cellSize;
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * 6, x = d[o], y = d[o + 1], h = d[o + 3];
      const s = speciesFor(d[o + 5], x, y, this.legacy);
      sp[i] = s; va[i] = variantFor(s, x, y);
      cr[i] = crownRadius(s, h, d[o + 4]);
      yaw[i] = s === 2 ? FLAG_YAW + (hash01(x, y, 11) - 0.5) * 0.7 : hash01(x, y, 5) * Math.PI * 2;
      // colour variation: about +-6% brightness and a slight hue shift
      const b = 0.94 + 0.12 * hash01(x, y, 13);
      tint[i * 3] = b * (0.97 + 0.06 * hash01(x, y, 17)); tint[i * 3 + 1] = b; tint[i * 3 + 2] = b * (0.97 + 0.06 * hash01(x, y, 19));
      const tx = Math.min(TILES - 1, Math.max(0, Math.floor((x - minX) / ts))), ty = Math.min(TILES - 1, Math.max(0, Math.floor((y - minY) / ts)));
      tileOf[i] = ty * TILES + tx; counts[tileOf[i] + 1]++;
      zMin = Math.min(zMin, d[o + 2]); zMax = Math.max(zMax, d[o + 2] + h);
    }
    for (let t = 0; t < TILES * TILES; t++) counts[t + 1] += counts[t];
    const order = new Uint32Array(n), fill = counts.slice(0, TILES * TILES);
    for (let i = 0; i < n; i++) order[fill[tileOf[i]]++] = i;
    cell.sp = sp; cell.va = va; cell.cr = cr; cell.yaw = yaw; cell.tint = tint; cell.order = order; cell.tileStart = counts;
    cell.zMin = n ? zMin : 0; cell.zMax = n ? zMax : 0;
  }

  /** the far meshes of a cell (built once, then shown or hidden as the camera moves) */
  private buildFar(cell: Cell, lod2: boolean, imp: boolean): void {
    const far = this.kit.far!, d = cell.data!, n = d.length / 6;
    if (!cell.far) {
      const a = farAttrs(n);
      for (let i = 0; i < n; i++) {
        const o = i * 6;
        a.iPos.setXYZ(i, d[o], d[o + 2] - 0.3, -d[o + 1]);
        a.iScale.setXY(i, cell.cr![i], d[o + 3]);
        a.iYaw.setX(i, cell.yaw![i]);
        a.iColor.setXYZ(i, cell.tint![i * 3], cell.tint![i * 3 + 1], cell.tint![i * 3 + 2]);
        a.iSpec.setX(i, cell.sp![i]);
      }
      cell.far = a;
    }
    const inst = this.pack.meta.instances!, cs = inst.cellSize;
    const sphere = new THREE.Sphere(new THREE.Vector3(inst.minX + (cell.cx + 0.5) * cs, (cell.zMin + cell.zMax) / 2, -(inst.minY + (cell.cy + 0.5) * cs)), Math.hypot(cs * 0.71, (cell.zMax - cell.zMin) / 2 + 30));
    const make = (template: THREE.InstancedBufferGeometry, mat: THREE.Material, name: string): THREE.Mesh => {
      const g = farGeometry(template, cell.far!);
      g.boundingSphere = sphere.clone();
      const m = new THREE.Mesh(g, mat);
      m.name = `trees ${cell.cx}_${cell.cy} ${name}`;
      m.castShadow = false; m.receiveShadow = false;
      this.group.add(m);
      return m;
    };
    if (lod2 && !cell.lod2) cell.lod2 = make(this.kit.crossed, far.lod2, 'lod2');
    if (imp && !cell.imp) cell.imp = make(this.kit.billboard, far.imp, 'impostor');
  }

  private dropCell(cell: Cell): void {
    for (const m of [cell.lod2, cell.imp]) if (m) { this.group.remove(m); m.geometry.dispose(); }
    cell.lod2 = cell.imp = null; cell.far = null;
  }

  /** refill a near set from the trees within `radius` of (x, y) (pack metres) */
  private gather(n: NearSet, x: number, y: number, radius: number): void {
    const inst = this.pack.meta.instances!, cs = inst.cellSize, ts = cs / TILES, r2 = radius * radius;
    const lists = n.lists;
    for (let k = 0; k < SPECIES_COUNT * VARIANTS; k++) (lists[k] ??= []).length = 0;
    const cellRefs: Cell[] = [];
    for (const cell of this.cells.values()) {
      if (!cell.order) continue;
      const minX = inst.minX + cell.cx * cs, minY = inst.minY + cell.cy * cs;
      if (x + radius < minX || x - radius > minX + cs || y + radius < minY || y - radius > minY + cs) continue;
      const ci = cellRefs.push(cell) - 1, d = cell.data!;
      const tx0 = Math.max(0, Math.floor((x - radius - minX) / ts)), tx1 = Math.min(TILES - 1, Math.floor((x + radius - minX) / ts));
      const ty0 = Math.max(0, Math.floor((y - radius - minY) / ts)), ty1 = Math.min(TILES - 1, Math.floor((y + radius - minY) / ts));
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        const t = ty * TILES + tx;
        for (let j = cell.tileStart![t]; j < cell.tileStart![t + 1]; j++) {
          const i = cell.order![j], o = i * 6, ex = d[o] - x, ey = d[o + 1] - y;
          if (ex * ex + ey * ey > r2) continue;
          lists[cell.sp![i] * VARIANTS + cell.va![i]].push(ci, i);
        }
      }
    }
    let total = 0;
    for (let k = 0; k < SPECIES_COUNT * VARIANTS; k++) {
      const list = lists[k], cnt = list.length / 2;
      let mesh = n.meshes[k];
      if (cnt === 0) { if (mesh) mesh.visible = false; continue; }
      if (!mesh || mesh.instanceMatrix.count < cnt) {
        if (mesh) { this.group.remove(mesh); mesh.dispose(); }
        const s = Math.floor(k / VARIANTS), v = k % VARIANTS, cap = Math.ceil(cnt * 1.5) + 16;
        mesh = new THREE.InstancedMesh(n.lod === 0 ? this.kit.geo.lod0[s][v] : this.kit.geo.lod1[s][v], n.lod === 0 ? this.kit.mat.lod0 : this.kit.mat.lod1, cap);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        mesh.name = `trees lod${n.lod} ${s}.${v}`;
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        mesh.customDepthMaterial = n.lod === 0 ? this.kit.depth.lod0 : this.kit.depth.lod1;
        mesh.frustumCulled = false; // the set surrounds the camera
        n.meshes[k] = mesh;
        this.group.add(mesh);
      }
      const m = mesh.instanceMatrix.array as Float32Array, c = mesh.instanceColor!.array as Float32Array;
      for (let q = 0; q < cnt; q++) {
        const cell = cellRefs[list[q * 2]], i = list[q * 2 + 1], o = i * 6, d = cell.data!;
        const s = cell.cr![i], h = d[o + 3], a = cell.yaw![i], ca = Math.cos(a), sa = Math.sin(a), b = q * 16;
        // rotation about y by the yaw, scale (crown, height, crown), at the base (three.js: x east, y up, z = -north)
        m[b] = ca * s; m[b + 1] = 0; m[b + 2] = -sa * s; m[b + 3] = 0;
        m[b + 4] = 0; m[b + 5] = h; m[b + 6] = 0; m[b + 7] = 0;
        m[b + 8] = sa * s; m[b + 9] = 0; m[b + 10] = ca * s; m[b + 11] = 0;
        m[b + 12] = d[o]; m[b + 13] = d[o + 2] - 0.3; m[b + 14] = -d[o + 1]; m[b + 15] = 1;
        c[q * 3] = cell.tint![i * 3]; c[q * 3 + 1] = cell.tint![i * 3 + 1]; c[q * 3 + 2] = cell.tint![i * 3 + 2];
      }
      mesh.count = cnt;
      mesh.visible = true;
      mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, cnt * 16); mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.clearUpdateRanges(); mesh.instanceColor!.addUpdateRange(0, cnt * 3); mesh.instanceColor!.needsUpdate = true;
      total += cnt;
    }
    n.x = x; n.y = y; n.radius = radius; n.dirty = false; n.count = total;
  }
}
