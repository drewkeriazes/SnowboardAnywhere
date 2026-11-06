import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Rider } from '../sim/Rider';

/**
 * Tracks in the snow: a ribbon draped on the terrain behind the board, recorded every STEP
 * metres while the rider is on the snow (a gap is left in the air or on a lift). Clean narrow
 * line when carving, wide smear when skidding, deeper looking in powder. Skis leave two lines.
 * Stored in a ring buffer of MAX points per lane (about 3 km at 0.5 m), oldest fading out.
 * Vertex RGBA so one draw call per lane; lit (Lambert) so it follows the time of day.
 */
const MAX = 6000;
const STEP = 0.5; // m between samples
const LIFT = 0.04; // m above the snow

class Lane {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly idx: Uint32Array;
  private readonly age: Float32Array; // seconds since the point was laid
  private readonly depth: Float32Array; // 0..1 how dark the point is (powder deeper)
  private head = 0;
  private count = 0;
  private lastSlot = -1; // slot of the previous point in the current stroke, -1 after a gap
  private readonly geo: THREE.BufferGeometry;

  constructor(material: THREE.Material) {
    this.pos = new Float32Array(MAX * 2 * 3);
    this.col = new Float32Array(MAX * 2 * 4);
    this.idx = new Uint32Array(MAX * 6);
    this.age = new Float32Array(MAX).fill(1e9);
    this.depth = new Float32Array(MAX);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const nor = new Float32Array(MAX * 2 * 3);
    for (let i = 0; i < MAX * 2; i++) nor[i * 3 + 1] = 1;
    this.geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    this.geo.setIndex(new THREE.BufferAttribute(this.idx, 1).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.receiveShadow = true;
  }

  gap(): void { this.lastSlot = -1; }

  /** Add a cross-section: centre (three.js coords), left/right edge points already computed. */
  add(lx: number, ly: number, lz: number, rx: number, ry: number, rz: number, depth: number): void {
    const s = this.head;
    const v = s * 2;
    this.pos.set([lx, ly, lz, rx, ry, rz], v * 3);
    this.age[s] = 0; this.depth[s] = depth;
    this.setColour(s);
    // quad between the previous point of this stroke and this one; a gap or an overwritten
    // predecessor leaves the slot degenerate
    const q = s * 6;
    if (this.lastSlot >= 0) {
      const a = this.lastSlot * 2, b = v;
      this.idx.set([a, a + 1, b, a + 1, b + 1, b], q);
    } else this.idx.fill(0, q, q + 6);
    // the quad that used to end at the next slot connected to the point we are about to overwrite next; break it
    const nq = ((s + 1) % MAX) * 6;
    this.idx.fill(0, nq, nq + 6);
    this.lastSlot = s;
    this.head = (s + 1) % MAX;
    this.count = Math.min(MAX, this.count + 1);
    const pa = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const ca = this.geo.getAttribute('color') as THREE.BufferAttribute;
    pa.needsUpdate = true; ca.needsUpdate = true; this.geo.index!.needsUpdate = true;
  }

  private setColour(s: number): void {
    // fresh track: a bluish shadow in the snow; fades over FADE seconds and by ring position
    const FADE = 600;
    const ringAge = ((this.head - s + MAX) % MAX) / MAX; // 0 newest .. 1 oldest
    const fade = Math.max(0, 1 - this.age[s] / FADE) * (1 - ringAge * ringAge);
    const a = (0.22 + 0.33 * this.depth[s]) * fade;
    const c = 0.82 - 0.12 * this.depth[s];
    for (const k of [0, 1]) {
      const o = (s * 2 + k) * 4;
      this.col[o] = c * 0.92; this.col[o + 1] = c * 0.95; this.col[o + 2] = c * 1.0; this.col[o + 3] = a;
    }
  }

  /** Age the points (called a few times a second). */
  tick(dt: number): void {
    for (let s = 0; s < this.count; s++) { this.age[s] += dt; this.setColour(s); }
    (this.geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void { this.idx.fill(0); this.count = 0; this.head = 0; this.lastSlot = -1; this.geo.index!.needsUpdate = true; }
  dispose(): void { this.geo.dispose(); }
}

export class Tracks {
  readonly group = new THREE.Group();
  private readonly pack: Pack;
  private readonly mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: THREE.DoubleSide });
  private lanes: Lane[] = [];
  private offsets: number[] = [0];
  private lastX = NaN;
  private lastY = NaN;
  private tickAcc = 0;
  discipline: 'board' | 'ski' = 'board';

  constructor(pack: Pack) {
    this.pack = pack;
    this.setDiscipline('board');
  }

  get material(): THREE.Material { return this.mat; }

  setDiscipline(d: 'board' | 'ski'): void {
    if (d === this.discipline && this.lanes.length) return;
    this.discipline = d;
    for (const l of this.lanes) { this.group.remove(l.mesh); l.dispose(); }
    this.offsets = d === 'ski' ? [-0.12, 0.12] : [0];
    this.lanes = this.offsets.map(() => new Lane(this.mat));
    for (const l of this.lanes) this.group.add(l.mesh);
    this.lastX = NaN;
  }

  /** Per frame. `riding` = on a chair or gondola (no track). */
  update(r: Rider, dt: number, riding: boolean): void {
    this.tickAcc += dt;
    if (this.tickAcc > 0.5) { for (const l of this.lanes) l.tick(this.tickAcc); this.tickAcc = 0; }
    if (!r.onGround || riding || r.crashed > 0) { for (const l of this.lanes) l.gap(); this.lastX = NaN; return; }
    if (!Number.isNaN(this.lastX) && Math.hypot(r.x - this.lastX, r.y - this.lastY) < STEP) return;
    if (Number.isNaN(this.lastX)) for (const l of this.lanes) l.gap();
    this.lastX = r.x; this.lastY = r.y;
    // across the line of travel
    const sp = Math.hypot(r.vx, r.vy);
    const fx = sp > 0.3 ? r.vx / sp : Math.sin(r.heading), fy = sp > 0.3 ? r.vy / sp : Math.cos(r.heading);
    const ax = fy, ay = -fx; // right-hand side, pack coords
    // width: a board carving on edge cuts a narrow line; skidding smears the board's whole length sideways
    const skid = Math.min(1, r.skid);
    const s = r.surface;
    const powder = Math.max(0, 1 - s.groomed - s.rock - s.scree);
    const half = this.discipline === 'ski' ? 0.05 + 0.25 * skid : 0.12 + 0.55 * skid + 0.08 * powder;
    const depth = Math.min(1, 0.35 + 0.65 * powder - 0.2 * skid);
    this.offsets.forEach((off, i) => {
      const cx = r.x + ax * off, cy = r.y + ay * off;
      const lx = cx - ax * half, ly = cy - ay * half, rx = cx + ax * half, ry = cy + ay * half;
      const lz = this.pack.groundHeight(lx, ly) + LIFT, rz = this.pack.groundHeight(rx, ry) + LIFT;
      this.lanes[i].add(lx, lz, -ly, rx, rz, -ry, depth);
    });
  }

  clear(): void { for (const l of this.lanes) l.clear(); this.lastX = NaN; }
  dispose(): void { for (const l of this.lanes) l.dispose(); this.mat.dispose(); }
}
