import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';

/**
 * Streams tree instances per 1 km cell around the rider and draws them with GPU instancing.
 * Species: 0 conifer, 1 aspen (leafless), 2 krummholz. Near cells get full geometry, far cells a
 * single-cone silhouette.
 */
let NEAR_RADIUS = 1500;
let FAR_RADIUS = 4500;
/** Headless / weak GPU: far fewer instances. */
export function setVegetationBudget(near: number, far: number): void { NEAR_RADIUS = near; FAR_RADIUS = far; }
/** Scale the near/far radii by a 0.25..1 density (1 = full 1500 / 4500 m). */
export function setVegetationDensity(d: number): void { const k = Math.max(0.25, Math.min(1, d)); NEAR_RADIUS = 1500 * k; FAR_RADIUS = 4500 * k; }

interface Cell {
  key: string;
  cx: number;
  cy: number;
  data: Float32Array | null;
  meshes: THREE.Object3D[];
  near: boolean | null; // which geometry set is built
  loading: boolean;
  missing: boolean;
}

function makeConifer(detail: 'near' | 'far'): THREE.BufferGeometry {
  // unit tree: height 1, trunk at the origin pointing +y
  const parts: THREE.BufferGeometry[] = [];
  if (detail === 'near') {
    const trunk = new THREE.CylinderGeometry(0.018, 0.03, 0.35, 5);
    trunk.translate(0, 0.17, 0);
    parts.push(trunk);
    // [radius, height, baseY] of each foliage tier, unit tree height 1
    const tiers = [
      [0.26, 0.30, 0.22],
      [0.21, 0.30, 0.42],
      [0.15, 0.28, 0.62],
      [0.08, 0.22, 0.78],
    ];
    for (const [r, h, baseY] of tiers) {
      const cone = new THREE.ConeGeometry(r, h, 7);
      cone.translate(0, baseY + h / 2, 0);
      parts.push(cone);
    }
  } else {
    const cone = new THREE.ConeGeometry(0.2, 0.85, 5);
    cone.translate(0, 0.575, 0);
    parts.push(cone);
    const trunk = new THREE.CylinderGeometry(0.02, 0.03, 0.2, 4);
    trunk.translate(0, 0.1, 0);
    parts.push(trunk);
  }
  return mergeGeometries(parts);
}

function makeAspen(detail: 'near' | 'far'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.012, 0.025, 0.95, detail === 'near' ? 6 : 4);
  trunk.translate(0, 0.475, 0);
  parts.push(trunk);
  if (detail === 'near') {
    // a few bare branches
    for (let i = 0; i < 5; i++) {
      const b = new THREE.CylinderGeometry(0.004, 0.008, 0.28, 3);
      const a = (i / 5) * Math.PI * 2 + 0.4;
      b.rotateZ(0.9).rotateY(a);
      b.translate(Math.cos(a) * 0.09, 0.55 + i * 0.08, Math.sin(a) * 0.09);
      parts.push(b);
    }
  }
  // sparse twig crown as a translucent-looking thin cone (drawn opaque but grey)
  const crown = new THREE.ConeGeometry(0.16, 0.45, 5);
  crown.translate(0, 0.72, 0);
  parts.push(crown);
  return mergeGeometries(parts);
}

function makeKrummholz(): THREE.BufferGeometry {
  const cone = new THREE.ConeGeometry(0.42, 0.9, 6);
  cone.translate(0, 0.45, 0);
  return cone;
}

/** Minimal merge for non-indexed/indexed geometries with position + normal. */
function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (const g of geos) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
    }
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + base);
    else for (let i = 0; i < p.count; i++) idx.push(i + base);
    base += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

export class Vegetation {
  readonly group = new THREE.Group();
  private readonly pack: Pack;
  private readonly collider: Collider | null;
  private readonly cells = new Map<string, Cell>();
  private readonly geo = {
    conifer: { near: makeConifer('near'), far: makeConifer('far') },
    aspen: { near: makeAspen('near'), far: makeAspen('far') },
    krummholz: { near: makeKrummholz(), far: makeKrummholz() },
  };
  readonly mat = {
    conifer: new THREE.MeshStandardMaterial({ color: 0x2c4a2e, roughness: 0.95, flatShading: true }),
    coniferFar: new THREE.MeshStandardMaterial({ color: 0x2b4530, roughness: 1.0, flatShading: true }),
    aspen: new THREE.MeshStandardMaterial({ color: 0xd9d6cc, roughness: 0.9, flatShading: true }),
    krummholz: new THREE.MeshStandardMaterial({ color: 0x33503a, roughness: 1.0, flatShading: true }),
  };
  readonly stats = { cells: 0, instances: 0 };
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpC = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(pack: Pack, collider: Collider | null) {
    this.pack = pack;
    this.collider = collider;
  }

  update(x: number, y: number): void {
    const inst = this.pack.meta.instances;
    if (!inst) return;
    const cs = inst.cellSize;
    const r = FAR_RADIUS;
    const cx0 = Math.max(0, Math.floor((x - r - inst.minX) / cs)), cx1 = Math.min(inst.cellsX - 1, Math.floor((x + r - inst.minX) / cs));
    const cy0 = Math.max(0, Math.floor((y - r - inst.minY) / cs)), cy1 = Math.min(inst.cellsY - 1, Math.floor((y + r - inst.minY) / cs));
    const keep = new Set<string>();
    let count = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const ccx = inst.minX + (cx + 0.5) * cs, ccy = inst.minY + (cy + 0.5) * cs;
        const d = Math.hypot(ccx - x, ccy - y) - cs * 0.71;
        if (d > FAR_RADIUS) continue;
        const key = `${cx}_${cy}`;
        keep.add(key);
        let cell = this.cells.get(key);
        if (!cell) {
          cell = { key, cx, cy, data: null, meshes: [], near: null, loading: false, missing: false };
          this.cells.set(key, cell);
        }
        if (!cell.data && !cell.loading && !cell.missing) this.load(cell);
        const wantNear = d < NEAR_RADIUS;
        if (cell.data && cell.near !== wantNear) this.buildMeshes(cell, wantNear);
        if (cell.data) count += cell.data.length / 6;
      }
    }
    for (const [key, cell] of this.cells) {
      if (keep.has(key)) continue;
      for (const m of cell.meshes) { this.group.remove(m); (m as THREE.InstancedMesh).dispose?.(); }
      if (cell.data && this.collider) {
        const minX = inst.minX + cell.cx * cs, minY = inst.minY + cell.cy * cs;
        this.collider.clearRect(minX, minY, minX + cs, minY + cs);
      }
      this.cells.delete(key);
    }
    this.stats.cells = this.cells.size;
    this.stats.instances = count;
  }

  private async load(cell: Cell): Promise<void> {
    cell.loading = true;
    try {
      const resp = await fetch(`${this.pack.baseUrl}/trees/${cell.cx}_${cell.cy}.bin`);
      if (!resp.ok) { cell.missing = true; return; }
      const buf = await resp.arrayBuffer();
      cell.data = new Float32Array(buf);
      if (this.collider) {
        const d = cell.data;
        for (let i = 0; i < d.length; i += 6) {
          const h = d[i + 3];
          this.collider.add(d[i], d[i + 1], Math.max(0.15, h * 0.02), d[i + 2] - 1, d[i + 2] + h);
        }
      }
    } catch {
      cell.missing = true;
    } finally {
      cell.loading = false;
    }
  }

  private buildMeshes(cell: Cell, near: boolean): void {
    for (const m of cell.meshes) { this.group.remove(m); (m as THREE.InstancedMesh).dispose?.(); }
    cell.meshes = [];
    const d = cell.data!;
    const n = d.length / 6;
    const bySpecies: number[][] = [[], [], []];
    for (let i = 0; i < n; i++) {
      const s = Math.min(2, Math.max(0, Math.round(d[i * 6 + 5])));
      bySpecies[s].push(i);
    }
    const sets: [number, THREE.BufferGeometry, THREE.Material][] = [
      [0, near ? this.geo.conifer.near : this.geo.conifer.far, near ? this.mat.conifer : this.mat.coniferFar],
      [1, near ? this.geo.aspen.near : this.geo.aspen.far, this.mat.aspen],
      [2, this.geo.krummholz.near, this.mat.krummholz],
    ];
    for (const [s, geo, mat] of sets) {
      const ids = bySpecies[s];
      if (ids.length === 0) continue;
      const mesh = new THREE.InstancedMesh(geo, mat, ids.length);
      mesh.castShadow = near;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      let k = 0;
      for (const i of ids) {
        const o = i * 6;
        const h = d[o + 3];
        const crown = d[o + 4];
        const seed = (d[o] * 12.9898 + d[o + 1] * 78.233) % 1;
        const yaw = seed * 6.283;
        this.tmpQ.setFromAxisAngle(this.up, yaw);
        this.tmpP.set(d[o], d[o + 2] - 0.3, -d[o + 1]);
        const w = s === 1 ? Math.max(h * 0.5, crown * 3) : Math.max(h * 0.9, crown * 3.2);
        this.tmpS.set(w, h, w);
        this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
        mesh.setMatrixAt(k, this.tmpM);
        // colour variation
        const v = 0.85 + 0.3 * ((seed * 7.13) % 1);
        if (s === 0) this.tmpC.setRGB(0.17 * v, 0.29 * v, 0.18 * v);
        else if (s === 1) this.tmpC.setRGB(0.85 * v, 0.84 * v, 0.80 * v);
        else this.tmpC.setRGB(0.2 * v, 0.31 * v, 0.22 * v);
        mesh.setColorAt(k, this.tmpC);
        k++;
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      cell.meshes.push(mesh);
    }
    cell.near = near;
  }
}
