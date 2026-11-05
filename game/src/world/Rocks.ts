import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';

const RADIUS = 2500;

interface Cell { cx: number; cy: number; mesh: THREE.InstancedMesh | null; loading: boolean; missing: boolean }

/** Instanced rocks streamed per cell. Types: 0 outcrop (flat slab), 1 boulder, 2 talus clump. */
export class Rocks {
  readonly group = new THREE.Group();
  private readonly pack: Pack;
  private readonly collider: Collider | null;
  private readonly cells = new Map<string, Cell>();
  private readonly geo: THREE.BufferGeometry;
  private readonly mat = new THREE.MeshStandardMaterial({ color: 0x5c5650, roughness: 0.95, flatShading: true });
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly e = new THREE.Euler();
  private readonly c = new THREE.Color();

  constructor(pack: Pack, collider: Collider | null) {
    this.pack = pack;
    this.collider = collider;
    const g = new THREE.DodecahedronGeometry(0.5, 0);
    // roughen
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const k = 0.85 + 0.3 * ((Math.sin(i * 12.9898) * 43758.5453) % 1);
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * (0.6 + 0.3 * k), pos.getZ(i) * k);
    }
    g.computeVertexNormals();
    this.geo = g;
  }

  update(x: number, y: number): void {
    const inst = this.pack.meta.instances;
    if (!inst) return;
    const cs = inst.cellSize;
    const keep = new Set<string>();
    const cx0 = Math.max(0, Math.floor((x - RADIUS - inst.minX) / cs)), cx1 = Math.min(inst.cellsX - 1, Math.floor((x + RADIUS - inst.minX) / cs));
    const cy0 = Math.max(0, Math.floor((y - RADIUS - inst.minY) / cs)), cy1 = Math.min(inst.cellsY - 1, Math.floor((y + RADIUS - inst.minY) / cs));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${cx}_${cy}`;
        keep.add(key);
        if (!this.cells.has(key)) {
          const cell: Cell = { cx, cy, mesh: null, loading: true, missing: false };
          this.cells.set(key, cell);
          this.load(cell);
        }
      }
    }
    for (const [key, cell] of this.cells) {
      if (keep.has(key)) continue;
      if (cell.mesh) { this.group.remove(cell.mesh); cell.mesh.dispose(); }
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
      const mesh = new THREE.InstancedMesh(this.geo, this.mat, n);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (let i = 0; i < n; i++) {
        const o = i * 6;
        const size = d[o + 3], yaw = d[o + 4], type = d[o + 5];
        this.e.set(type === 0 ? 0.2 : 0, yaw, type === 0 ? 0.3 : 0);
        this.q.setFromEuler(this.e);
        this.p.set(d[o], d[o + 2] - size * 0.15, -d[o + 1]);
        if (type === 0) this.s.set(size * 2.2, size * 0.8, size * 1.6);
        else if (type === 1) this.s.set(size, size, size);
        else this.s.set(size * 1.3, size * 0.5, size * 1.1);
        this.m.compose(this.p, this.q, this.s);
        mesh.setMatrixAt(i, this.m);
        const v = 0.8 + 0.4 * ((Math.abs(Math.sin(d[o] * 0.37 + d[o + 1] * 0.11)) * 10) % 1);
        this.c.setRGB(0.36 * v, 0.34 * v, 0.31 * v);
        mesh.setColorAt(i, this.c);
        if (this.collider && size > 0.9) this.collider.add(d[o], d[o + 1], size * 0.5, d[o + 2] - 1, d[o + 2] + size);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      cell.mesh = mesh;
      this.group.add(mesh);
    } catch {
      cell.missing = true;
    } finally {
      cell.loading = false;
    }
  }
}
