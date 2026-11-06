import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';

const RADIUS = 2500;
const VARIANTS = 4;

interface Cell { cx: number; cy: number; meshes: THREE.InstancedMesh[]; loading: boolean; missing: boolean }

/**
 * Instanced rocks streamed per cell. Each rock picks one of four noise-displaced low-poly
 * variants, is sunk into the ground, tilted so its base follows the slope, and tinted with a
 * little per-instance variation plus a snow cap on top. Types: 0 outcrop (wide slab),
 * 1 boulder, 2 talus clump (flat spread).
 */
export class Rocks {
  readonly group = new THREE.Group();
  private readonly pack: Pack;
  private readonly collider: Collider | null;
  private readonly cells = new Map<string, Cell>();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mat: THREE.MeshStandardMaterial;
  get material(): THREE.MeshStandardMaterial { return this.mat; }
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly n = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly normalTmp = [0, 0, 1];

  constructor(pack: Pack, collider: Collider | null) {
    this.pack = pack;
    this.collider = collider;
    for (let v = 0; v < VARIANTS; v++) this.geos.push(makeRock(v * 7.31 + 1.7));
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1.0, metalness: 0.0, flatShading: true });
  }

  /** Stream cells in the box around the rider (x, y) and the look-ahead point (ax, ay). */
  update(x: number, y: number, ax = x, ay = y): void {
    const inst = this.pack.meta.instances;
    if (!inst) return;
    const cs = inst.cellSize;
    const keep = new Set<string>();
    const cx0 = Math.max(0, Math.floor((Math.min(x, ax) - RADIUS - inst.minX) / cs)), cx1 = Math.min(inst.cellsX - 1, Math.floor((Math.max(x, ax) + RADIUS - inst.minX) / cs));
    const cy0 = Math.max(0, Math.floor((Math.min(y, ay) - RADIUS - inst.minY) / cs)), cy1 = Math.min(inst.cellsY - 1, Math.floor((Math.max(y, ay) + RADIUS - inst.minY) / cs));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${cx}_${cy}`;
        keep.add(key);
        if (!this.cells.has(key)) {
          const cell: Cell = { cx, cy, meshes: [], loading: true, missing: false };
          this.cells.set(key, cell);
          this.load(cell);
        }
      }
    }
    for (const [key, cell] of this.cells) {
      if (keep.has(key)) continue;
      for (const m of cell.meshes) { this.group.remove(m); m.dispose(); }
      this.cells.delete(key);
    }
  }

  private async load(cell: Cell): Promise<void> {
    try {
      const resp = await fetch(`${this.pack.baseUrl}/rocks/${cell.cx}_${cell.cy}.bin`);
      if (!resp.ok) { cell.missing = true; return; }
      const d = new Float32Array(await resp.arrayBuffer());
      const n = d.length / 6;
      if (n === 0) return;
      // bucket by variant
      const buckets: number[][] = Array.from({ length: VARIANTS }, () => []);
      for (let i = 0; i < n; i++) buckets[hashIndex(d[i * 6], d[i * 6 + 1]) % VARIANTS].push(i);
      for (let v = 0; v < VARIANTS; v++) {
        const list = buckets[v];
        if (list.length === 0) continue;
        const mesh = new THREE.InstancedMesh(this.geos[v], this.mat, list.length);
        mesh.castShadow = true; mesh.receiveShadow = true;
        list.forEach((i, k) => {
          const o = i * 6;
          const x = d[o], y = d[o + 1], size = Math.max(0.6, d[o + 3]), yaw = d[o + 4], type = d[o + 5];
          // snap to loaded terrain when we have it; the pack's z is the fallback before tiles arrive
          let z = d[o + 2];
          for (const set of this.pack.sets) { if (set.contains(x, y)) { const h = set.sample(x, y); if (!Number.isNaN(h)) { z = h; break; } } }
          // orient the rock's up axis to the ground normal, then spin around it
          const nn = this.pack.groundNormal(x, y, this.normalTmp) as number[];
          this.n.set(nn[0], nn[2], -nn[1]);
          this.q.setFromUnitVectors(this.up, this.n);
          this.q2.setFromAxisAngle(this.up, yaw);
          this.q.multiply(this.q2);
          // sink: outcrops and talus sit deep, boulders a bit less
          const sink = type === 1 ? 0.35 : 0.5;
          this.p.set(x, z - size * sink, -y);
          if (type === 0) this.s.set(size * 2.4, size * 1.0, size * 1.7);
          else if (type === 1) this.s.set(size * 1.1, size * 1.0, size * 1.0);
          else this.s.set(size * 1.6, size * 0.6, size * 1.3);
          this.m.compose(this.p, this.q, this.s);
          mesh.setMatrixAt(k, this.m);
          // greys with a slight warm or cool cast per instance
          const t = hash01(x * 0.37 + y * 0.11);
          const u = hash01(x * 0.07 - y * 0.23);
          this.c.setRGB(0.30 + 0.18 * t + 0.05 * u, 0.29 + 0.16 * t, 0.28 + 0.14 * t + 0.06 * (1 - u));
          mesh.setColorAt(k, this.c);
          // tall boulders are walls; slabs, talus and small boulders can be ridden up and launched off
          if (this.collider && size > 0.9) this.collider.add(x, y, size * 0.55, z - 1, z + size * 0.6, type === 1 && size > 2.2 ? 0 : 1);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        cell.meshes.push(mesh);
        this.group.add(mesh);
      }
    } catch {
      cell.missing = true;
    } finally {
      cell.loading = false;
    }
  }
}

function hash01(v: number): number { const s = Math.sin(v) * 43758.5453; return s - Math.floor(s); }
function hashIndex(x: number, y: number): number { return Math.floor(hash01(x * 12.9898 + y * 78.233) * 1e4); }

/**
 * A rock: icosphere with two octaves of value noise pushed along the normals, flattened a
 * little, with per-vertex colour that is lighter on upward faces (snow dusting) and darker
 * in crevices. Unit size (about 1 m across).
 */
function makeRock(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 2).toNonIndexed();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const noise = (x: number, y: number, z: number, f: number) => {
    // cheap smooth-ish hash noise: sum of sines at irrational offsets
    return 0.5 + 0.5 * Math.sin(x * f * 1.7 + seed) * Math.sin(y * f * 2.3 + seed * 0.7) * Math.sin(z * f * 1.9 + seed * 1.3);
  };
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const d = v.length();
    const n1 = noise(v.x, v.y, v.z, 3.0), n2 = noise(v.x, v.y, v.z, 7.5);
    const r = d * (0.78 + 0.32 * n1 + 0.12 * n2);
    v.normalize().multiplyScalar(r);
    // chisel: squash a couple of random planes to get facets
    const k = 0.5 + 0.5 * Math.sin(seed * 3.1);
    v.y *= 0.75 + 0.2 * k;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  // vertex colour: snow on top-facing faces, darker low
  const col = new Float32Array(pos.count * 3);
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const ny = nor.getY(i);
    const snow = THREE.MathUtils.smoothstep(ny, 0.55, 0.9);
    const shade = 0.7 + 0.3 * Math.max(0, ny);
    // vertex colour multiplies the per-instance grey (about 0.35), so snow is > 1 to come out white
    col[i * 3] = (1 - snow) * shade + snow * 2.5;
    col[i * 3 + 1] = (1 - snow) * shade + snow * 2.55;
    col[i * 3 + 2] = (1 - snow) * shade + snow * 2.7;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
