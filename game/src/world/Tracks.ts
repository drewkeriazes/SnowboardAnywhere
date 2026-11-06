import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Rider } from '../sim/Rider';

/**
 * Tracks in the snow as real 3D grooves. Every STEP metres on the snow a cross-section is laid
 * across the line of travel:
 *
 *   snow ____/‾‾\                    /‾‾\____ snow
 *                \__________________/
 *       berm lip   wall   pressed floor   wall   berm lip
 *
 * The floor is DEPTH below the surface (about 2 in), the walls are steep, and the snow pushed
 * aside forms a low lip each side; the outer edge blends into the terrain with alpha 0. Because
 * the floor is below the terrain surface, the vertex shader pulls the depth value a few cm toward
 * the camera so the terrain does not hide it, while real objects in front still occlude it.
 * Clean narrow groove when carving, wide shallow smear when skidding, deeper in powder.
 * Skis cut two narrow grooves. Ring buffer of MAX sections per lane (about 3 km); old track
 * fills back in (depth and alpha fade) over FADE seconds.
 */
const MAX = 6000;
const STEP = 0.5; // m between sections
const DEPTH = 0.05; // m, about 2 in on a groomer
const FADE = 600; // s until the snow has filled the track back in
// cross-section profile: [offset across in units of the half width (+ fixed metres), height factor of DEPTH, alpha]
// x = sx * half + dx
const PROFILE: { sx: number; dx: number; h: number; a: number }[] = [
  { sx: -1, dx: -0.09, h: 0.0, a: 0 },   // outer edge, blends into snow
  { sx: -1, dx: -0.04, h: 0.35, a: 1 },  // berm lip
  { sx: -1, dx: 0.0, h: 0.15, a: 1 },    // wall top
  { sx: -1, dx: 0.025, h: -1.0, a: 1 },  // floor edge
  { sx: 1, dx: -0.025, h: -1.0, a: 1 },  // floor edge
  { sx: 1, dx: 0.0, h: 0.15, a: 1 },
  { sx: 1, dx: 0.04, h: 0.35, a: 1 },
  { sx: 1, dx: 0.09, h: 0.0, a: 0 },
];
const P = PROFILE.length;

class Lane {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  private readonly col: Float32Array;
  private readonly idx: Uint32Array;
  // per section: the data needed to re-shape it as it fills in
  private readonly secC: Float32Array; // centre x, y, z(surface) in three.js coords, across x, across z, half width, depth, tilt
  private readonly age: Float32Array;
  private head = 0;
  private count = 0;
  private lastSlot = -1;
  private readonly geo: THREE.BufferGeometry;

  constructor(material: THREE.Material) {
    this.pos = new Float32Array(MAX * P * 3);
    this.nor = new Float32Array(MAX * P * 3);
    this.col = new Float32Array(MAX * P * 4);
    this.idx = new Uint32Array(MAX * (P - 1) * 6);
    this.secC = new Float32Array(MAX * 8);
    this.age = new Float32Array(MAX).fill(1e9);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(this.idx, 1).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.receiveShadow = true;
  }

  gap(): void { this.lastSlot = -1; }

  /**
   * Add a section. (cx, cy, cz) centre on the snow in three.js coords; (ax, az) unit vector
   * across the track (three.js x/z); half width; depth (m); surface(x, z) returns the snow height.
   */
  add(cx: number, cy: number, cz: number, ax: number, az: number, half: number, depth: number, tilt: number, surface: (x: number, z: number) => number): void {
    const s = this.head;
    const o = s * 8;
    this.secC[o] = cx; this.secC[o + 1] = cy; this.secC[o + 2] = cz; this.secC[o + 3] = ax; this.secC[o + 4] = az; this.secC[o + 5] = half; this.secC[o + 6] = depth; this.secC[o + 7] = tilt;
    this.age[s] = 0;
    // snow heights under each profile vertex (follow the slope across the track)
    for (let k = 0; k < P; k++) {
      const pr = PROFILE[k];
      const off = pr.sx * half + pr.dx;
      this.ground[s * P + k] = surface(cx + ax * off, cz + az * off);
    }
    this.shape(s);
    // quads to the previous section of this stroke
    const q = s * (P - 1) * 6;
    if (this.lastSlot >= 0) {
      const a = this.lastSlot * P, b = s * P;
      for (let k = 0; k < P - 1; k++) this.idx.set([a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k], q + k * 6);
    } else this.idx.fill(0, q, q + (P - 1) * 6);
    // the quads stored at the next slot joined the section we just overwrote: break them
    const nq = ((s + 1) % MAX) * (P - 1) * 6;
    this.idx.fill(0, nq, nq + (P - 1) * 6);
    this.lastSlot = s;
    this.head = (s + 1) % MAX;
    this.count = Math.min(MAX, this.count + 1);
    this.geo.index!.needsUpdate = true;
    this.flag();
  }
  private readonly ground = new Float32Array(MAX * P);

  /** Write positions, normals and colours of section s from its stored data and age. */
  private shape(s: number): void {
    const o = s * 8;
    const cx = this.secC[o], cz = this.secC[o + 2], ax = this.secC[o + 3], az = this.secC[o + 4], half = this.secC[o + 5];
    // tilt -1..1: the board on its edge. Positive = the right-hand edge is engaged: that side of the
    // floor is deepest with a near-vertical wall, the other side rises to a shallow shelf, and the
    // displaced snow piles up on the outside of the turn.
    const tilt = this.secC[o + 7];
    const ringAge = ((this.head - s + MAX) % MAX) / MAX;
    const fill = Math.max(0, 1 - this.age[s] / FADE) * (1 - ringAge * ringAge); // 1 fresh .. 0 filled in
    const depth = this.secC[o + 6] * fill;
    const xs: number[] = [], ys: number[] = [];
    for (let k = 0; k < P; k++) {
      const pr = PROFILE[k];
      const off = pr.sx * half + pr.dx;
      const side = pr.sx; // -1 left, +1 right
      let h = pr.h;
      if (h < 0) h = -(1 + 0.85 * tilt * side);                 // floor: deep at the engaged edge, shelf at the other
      else if (pr.h > 0.2) h = pr.h * (1 - 0.6 * tilt * side);  // lip: bigger on the outside of the turn
      xs.push(off); ys.push(this.ground[s * P + k] + h * depth);
      const v = (s * P + k) * 3;
      this.pos[v] = cx + ax * off; this.pos[v + 1] = ys[k]; this.pos[v + 2] = cz + az * off;
    }
    // normals from the profile slope across the track (smoothed between neighbours)
    for (let k = 0; k < P; k++) {
      const k0 = Math.max(0, k - 1), k1 = Math.min(P - 1, k + 1);
      const dx = xs[k1] - xs[k0], dy = ys[k1] - ys[k0];
      const len = Math.hypot(dx, dy) || 1;
      // across-track 2D normal (-dy, dx) mapped back to world: across vector * nx + up * ny
      const nx = -dy / len, ny = dx / len;
      const v = (s * P + k) * 3;
      this.nor[v] = ax * nx; this.nor[v + 1] = ny; this.nor[v + 2] = az * nx;
    }
    // colour: pressed floor slightly brighter and smoother, walls pick up their shading from the normals
    for (let k = 0; k < P; k++) {
      const c = (s * P + k) * 4;
      const floor = PROFILE[k].h < 0;
      const tone = floor ? 0.97 : 0.93;
      this.col[c] = tone * 0.95; this.col[c + 1] = tone * 0.97; this.col[c + 2] = tone; this.col[c + 3] = PROFILE[k].a * Math.min(1, fill * 3);
    }
  }

  private flag(): void {
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Age and re-shape (called a couple of times a second). */
  tick(dt: number): void {
    for (let s = 0; s < this.count; s++) { this.age[s] += dt; this.shape(s); }
    this.flag();
  }

  clear(): void { this.idx.fill(0); this.count = 0; this.head = 0; this.lastSlot = -1; this.geo.index!.needsUpdate = true; }
  dispose(): void { this.geo.dispose(); }
}

export class Tracks {
  readonly group = new THREE.Group();
  private readonly pack: Pack;
  private readonly mat: THREE.MeshLambertMaterial;
  private lanes: Lane[] = [];
  private offsets: number[] = [0];
  private lastX = NaN;
  private lastY = NaN;
  private tickAcc = 0;
  discipline: 'board' | 'ski' = 'board';

  constructor(pack: Pack) {
    this.pack = pack;
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, depthWrite: true, side: THREE.DoubleSide });
    // the floor is below the terrain surface: bias the depth a few cm toward the camera so the
    // terrain does not cover it, but nearer geometry (rider, trees, ridges) still does
    this.mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        {
          vec3 toCam = normalize(-mvPosition.xyz);
          float bias = 0.09 + 0.0015 * length(mvPosition.xyz); // grows a little with distance for depth precision
          vec4 biased = projectionMatrix * vec4(mvPosition.xyz + toCam * bias, 1.0);
          gl_Position.z = biased.z / biased.w * gl_Position.w;
        }`);
    };
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
    const sp = Math.hypot(r.vx, r.vy);
    const fx = sp > 0.3 ? r.vx / sp : Math.sin(r.heading), fy = sp > 0.3 ? r.vy / sp : Math.cos(r.heading);
    const ax = fy, ay = -fx; // right-hand side, pack coords
    const skid = Math.min(1, r.skid);
    const s = r.surface;
    const powder = Math.max(0, 1 - s.groomed - s.rock - s.scree);
    // edge angle from the physics (same inclination the rider model leans by): flat base going
    // straight presses the full board width; on edge the board cuts a narrow, deeper, tilted trench
    const phi = Math.atan(r.lateralG * 0.8);                 // + = turning toward the right-hand side
    const edge = Math.min(1, Math.abs(phi) / 0.6) * (1 - skid);
    const tilt = Math.sign(phi) * edge;
    const boardHalf = this.discipline === 'ski' ? 0.05 : 0.13;
    const half = boardHalf * (1 - 0.7 * edge) + (this.discipline === 'ski' ? 0.2 : 0.55) * skid;
    const depth = DEPTH * (1 + 0.6 * powder) * (1 + 0.6 * edge) * (1 - 0.6 * skid) * (s.rock + s.scree > 0.5 ? 0.3 : 1);
    const surface = (x: number, z: number) => this.pack.groundHeight(x, -z);
    this.offsets.forEach((off, i) => {
      const cx = r.x + ax * off, cy = r.y + ay * off;
      const g = this.pack.groundHeight(cx, cy);
      this.lanes[i].add(cx, g, -cy, ax, -ay, half, depth, tilt, surface);
    });
  }

  clear(): void { for (const l of this.lanes) l.clear(); this.lastX = NaN; }
  dispose(): void { for (const l of this.lanes) l.dispose(); this.mat.dispose(); }
}
