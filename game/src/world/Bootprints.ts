import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Plant } from './Gait';
import { FADE } from './Tracks';

/**
 * Bootprints (FEAT-067): one dent per foot plant, stamped where the gait put the boot down, as one
 * InstancedMesh over a ring buffer of MAX prints. The dent is a boot-sole shaped hollow (about
 * 0.32 x 0.13 m, heel and toe a little deeper) with a low rim that blends into the snow:
 *
 *   snow __/‾\                  /‾\__ snow
 *            \___heel____toe___/
 *
 * Per print: depth (2 to 3 cm on a groomer, 10 to 25 cm in powder), a kick of snow thrown up at the
 * toe when sprinting, and a smear (local x/z) that drags the downhill side out when slipping or
 * climbing steep snow. Prints fill back in over the board tracks' FADE: the depth and alpha fade
 * with age, ticked a couple of times a second.
 */
const MAX = 4000;
/**
 * BUG-020: tamped snow gets no new edge. A plant less than MIN_STEP (m, times the print scale) from that
 * foot's last print, or with its centre within OVERLAP (m, times scale) of a live print, does not add a
 * print: it presses the existing dent a little deeper (up to DEEPEN_CAP times its depth) instead.
 */
const MIN_STEP = 0.25, OVERLAP = 0.14, DEEPEN = 1.15, DEEPEN_CAP = 1.6;
const GRID = 0.5; // m, spatial hash cell for the overlap lookup
/** half length and half width of the sole (m) */
const SOLE_HL = 0.16, SOLE_HW = 0.065;
/** geometry heights are in units of this depth (m); the shader scales them to each print's depth */
const NOMINAL = 0.05;
/** rings around the sole outline: scale of the outline, height (units of NOMINAL, - = down), alpha */
const RINGS: [number, number, number][] = [
  [0.45, -1, 1], [0.8, -1, 1], [0.95, -0.9, 1], // floor
  [1.06, 0.1, 1],   // wall top
  [1.22, 0.14, 1],  // rim of pushed snow
  [1.5, 0, 0],      // blends into the snow
];
const SEG = 20;

function printGeometry(HL: number, HW: number): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], toe: number[] = [], idx: number[] = [];
  // centre vertex
  pos.push(0, -NOMINAL, 0); col.push(0.68, 0.76, 0.91, 1); toe.push(0);
  for (const [sc, h, a] of RINGS) {
    for (let k = 0; k < SEG; k++) {
      const t = (k / SEG) * Math.PI * 2;
      const c = Math.cos(t), s = Math.sin(t);
      // superellipse outline: squarish sides, rounded heel and toe; toe toward -Z
      const x = HW * sc * Math.sign(c) * Math.pow(Math.abs(c), 0.6);
      const z = HL * sc * Math.sign(s) * Math.pow(Math.abs(s), 0.6);
      let y = h;
      if (h < 0) y = h * (0.85 + 0.25 * Math.pow(Math.abs(z) / HL, 2) + (z > 0 ? 0.08 : 0)); // heel and toe sink deeper
      pos.push(x, y * NOMINAL, z);
      // the terrain's average snow albedo (TerrainMaterial: uSnow and uSnowShade mixed by the wind
      // tone, times the grain, comes to about 0.83, 0.86, 0.94): the rim matches the snow around it,
      // the walls and floor go toward the blue shade so the hollow reads as a dent
      const shade = h < 0 ? 0.75 : h < 0.15 ? 0.45 : 0;
      col.push(0.83 - 0.2 * shade, 0.86 - 0.14 * shade, 0.94 - 0.04 * shade, a);
      // the toe end of the rim is where a sprinting boot throws snow up
      toe.push(h > 0 && z < -HL * 0.4 ? Math.min(1, (-z / (HL * sc) - 0.4) / 0.5) : 0);
    }
  }
  for (let k = 0; k < SEG; k++) idx.push(0, 1 + ((k + 1) % SEG), 1 + k);
  for (let r = 0; r < RINGS.length - 1; r++) {
    for (let k = 0; k < SEG; k++) {
      const a = 1 + r * SEG + k, b = 1 + r * SEG + ((k + 1) % SEG), c = a + SEG, d = b + SEG;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setAttribute('toe', new THREE.Float32BufferAttribute(toe, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  // faces must point up; flip the winding if the centre fan came out facing down
  const n = g.getAttribute('normal');
  if (n.getY(0) < 0) {
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.setIndex(idx); g.computeVertexNormals();
  }
  return g;
}

export class Bootprints {
  readonly mesh: THREE.InstancedMesh;
  private readonly pack: Pack;
  private readonly mat: THREE.MeshStandardMaterial;
  private readonly depth: THREE.InstancedBufferAttribute;
  private readonly fill: THREE.InstancedBufferAttribute;
  private readonly kick: THREE.InstancedBufferAttribute;
  private readonly smear: THREE.InstancedBufferAttribute;
  private readonly age = new Float32Array(MAX).fill(1e9);
  /** BUG-020: where each print is (pack x, y), its first depth, which cell it is filed under, and each foot's last print */
  private readonly px = new Float32Array(MAX);
  private readonly py = new Float32Array(MAX);
  private readonly depth0 = new Float32Array(MAX);
  private readonly cellOf: (string | null)[] = new Array(MAX).fill(null);
  private readonly grid = new Map<string, Set<number>>();
  private readonly lastOf: number[] = [-1, -1];
  private readonly scale: number;
  /** plants that pressed into an existing print instead of adding one (for checks) */
  reused = 0;
  private head = 0;
  private count = 0;
  private tickAcc = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly qy = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);

  /** `scale` (FEAT-101): bigger soles for the monster's prints (3 is about a metre long). */
  constructor(pack: Pack, scale = 1) {
    this.pack = pack;
    this.scale = scale;
    const HL = SOLE_HL * scale;
    const g = printGeometry(HL, SOLE_HW * scale);
    this.depth = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    this.fill = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    this.kick = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    this.smear = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aDepth', this.depth); g.setAttribute('aFill', this.fill); g.setAttribute('aKick', this.kick); g.setAttribute('aSmear', this.smear);
    // same lighting model and roughness as the terrain, so the rim is the snow's brightness (a
    // Lambert material came out whiter than the terrain and the prints read as raised slabs)
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, depthWrite: true, roughness: 0.9 });
    this.mat.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute float aDepth;\nattribute float aFill;\nattribute float aKick;\nattribute vec2 aSmear;\nattribute float toe;\n' + shader.vertexShader
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          // scale the nominal hollow to this print's depth as it fills in; kicked snow at the toe
          transformed.y *= aDepth * aFill / ${NOMINAL.toFixed(3)};
          transformed.y += toe * aKick * aFill * 0.035;
          // smear: the downhill side of the print drawn out along aSmear (local x/z)
          float sl = length(aSmear);
          if (sl > 1e-4) transformed.xz += aSmear * clamp(dot(position.xz, aSmear / sl) / ${HL.toFixed(3)}, 0.0, 1.0);`)
        .replace('#include <color_vertex>', '#include <color_vertex>\n  vColor.a *= min(1.0, aFill * 3.0);')
        // the hollow is below the terrain surface: pull its depth toward the camera by about its
        // own depth so the terrain does not cover it (nearer objects still do), as the tracks do
        .replace('#include <project_vertex>', `#include <project_vertex>
          {
            vec3 toCam = normalize(-mvPosition.xyz);
            float bias = 0.04 + aDepth * aFill * 1.1 + 0.0015 * length(mvPosition.xyz);
            vec4 biased = projectionMatrix * vec4(mvPosition.xyz + toCam * bias, 1.0);
            gl_Position.z = biased.z / biased.w * gl_Position.w;
          }`);
    };
    this.mesh = new THREE.InstancedMesh(g, this.mat, MAX);
    this.mesh.name = 'bootprints';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.receiveShadow = true;
  }

  /** Stamp one print at a foot plant. `depth` (m) from how far the boot sank. */
  add(p: Plant, depth: number): void {
    // BUG-020: a foot that has hardly moved, or lands in an existing print, presses that print instead
    const last = this.lastOf[p.side];
    if (last >= 0 && this.live(last) && Math.hypot(p.x - this.px[last], p.y - this.py[last]) < MIN_STEP * this.scale) { this.press(last); return; }
    const hit = this.overlapping(p.x, p.y);
    if (hit >= 0) { this.press(hit); this.lastOf[p.side] = hit; return; }
    const s = this.head;
    const z = this.pack.groundHeight(p.x, p.y);
    if (Number.isNaN(z)) return;
    this.file(s, p.x, p.y);
    this.lastOf[p.side] = s;
    const nn = this.pack.groundNormal(p.x, p.y) as number[];
    this.n.set(nn[0], nn[2], -nn[1]).normalize();
    // yaw (heading convention) about up, then tilted onto the snow
    this.qy.setFromAxisAngle(this.up, -p.yaw);
    this.q.setFromUnitVectors(this.up, this.n).multiply(this.qy);
    this.m.compose(this.p.set(p.x, z, -p.y), this.q, this.one);
    this.mesh.setMatrixAt(s, this.m);
    this.depth.setX(s, depth);
    this.depth0[s] = depth;
    this.kick.setX(s, p.kick);
    // smear (pack x/y) into the print's local x/z: rotate by -yaw. Local -Z is the toe direction
    // (pack heading), local +X the boot's right.
    const c = Math.cos(p.yaw), si = Math.sin(p.yaw);
    const fwd = p.smearX * si + p.smearY * c, rgt = p.smearX * c - p.smearY * si;
    this.smear.setXY(s, rgt, -fwd);
    this.age[s] = 0;
    this.fill.setX(s, 1);
    this.head = (s + 1) % MAX;
    this.count = Math.min(MAX, this.count + 1);
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.depth.needsUpdate = this.kick.needsUpdate = this.smear.needsUpdate = this.fill.needsUpdate = true;
  }

  /** a print that is still a visible dent (not filled back in or overwritten) */
  private live(s: number): boolean { return this.cellOf[s] !== null && this.fill.getX(s) > 0.3; }

  /** the live print whose centre is within OVERLAP of (x, y), or -1 */
  private overlapping(x: number, y: number): number {
    const r = OVERLAP * this.scale, cx = Math.floor(x / GRID), cy = Math.floor(y / GRID);
    let best = -1, bd = r;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const set = this.grid.get(`${cx + i},${cy + j}`);
      if (set) for (const s of set) {
        const d = Math.hypot(x - this.px[s], y - this.py[s]);
        if (d < bd && this.live(s)) { bd = d; best = s; }
      }
    }
    return best;
  }

  /** press an existing print a little deeper (capped) and freshen it, instead of adding an edge */
  private press(s: number): void {
    this.reused++;
    this.depth.setX(s, Math.min(this.depth0[s] * DEEPEN_CAP, this.depth.getX(s) * DEEPEN));
    this.age[s] = 0; this.fill.setX(s, 1);
    this.depth.needsUpdate = this.fill.needsUpdate = true;
  }

  /** file slot s under its grid cell, taking it out of the cell of the print it overwrites */
  private file(s: number, x: number, y: number): void {
    const old = this.cellOf[s];
    if (old !== null) this.grid.get(old)?.delete(s);
    const key = `${Math.floor(x / GRID)},${Math.floor(y / GRID)}`;
    let set = this.grid.get(key);
    if (!set) { set = new Set(); this.grid.set(key, set); }
    set.add(s); this.cellOf[s] = key; this.px[s] = x; this.py[s] = y;
  }

  /** Per frame: age the prints and let the snow fill them back in. */
  update(dt: number): void {
    this.tickAcc += dt;
    if (this.tickAcc < 0.5) return;
    for (let s = 0; s < this.count; s++) {
      this.age[s] += this.tickAcc;
      // the oldest prints in the ring also fade so the overwrite is not a pop
      const ringAge = ((this.head - 1 - s + MAX) % MAX) / MAX;
      this.fill.setX(s, Math.max(0, 1 - this.age[s] / FADE) * (1 - ringAge * ringAge));
    }
    this.fill.needsUpdate = true;
    this.tickAcc = 0;
  }

  get stats(): { prints: number } { return { prints: this.count }; }
  clear(): void { this.count = 0; this.head = 0; this.mesh.count = 0; this.grid.clear(); this.cellOf.fill(null); this.lastOf[0] = this.lastOf[1] = -1; }
  dispose(): void { this.mesh.geometry.dispose(); this.mat.dispose(); }
}
