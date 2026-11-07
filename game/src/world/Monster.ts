import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Pack } from '../pack/Pack';
import type { MonsterState, Outrun } from '../sim/Outrun';
import type { Collider } from '../sim/Collider';
import type { Bootprints } from './Bootprints';
import { twoBone, setWorldQuat } from './RiderRig';
import type { Puffs } from './Puffs';

/**
 * The Abominable (FEAT-099): the Outrun monster, a procedural skinned rig in the style of
 * RiderRig. About 3.5 m tall standing, white shaggy fur (jittered flat-shaded tubes and tufts),
 * a blue face, big teeth and a jaw bone that the eat sequence stretches snake-style. It gallops
 * on all fours: the body leans forward with speed and the four limbs are solved by two-bone IK
 * to swinging targets, so the gait needs no keyframes. Standing, it breathes and looks around.
 *
 * Bind pose: upright, facing -Z, limbs hanging along -Y. Heading h (clockwise from north) is a
 * rotation of -h about +Y, as for the rider.
 */
export const MBONES = ['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'Jaw',
  'LArm', 'LFore', 'LHand', 'RArm', 'RFore', 'RHand',
  'LThigh', 'LShin', 'LFoot', 'RThigh', 'RShin', 'RFoot'] as const;
export type MBone = typeof MBONES[number];
const PARENT: Record<MBone, MBone | null> = {
  Hips: null, Spine: 'Hips', Chest: 'Spine', Neck: 'Chest', Head: 'Neck', Jaw: 'Head',
  LArm: 'Chest', LFore: 'LArm', LHand: 'LFore', RArm: 'Chest', RFore: 'RArm', RHand: 'RFore',
  LThigh: 'Hips', LShin: 'LThigh', LFoot: 'LShin', RThigh: 'Hips', RShin: 'RThigh', RFoot: 'RShin',
};
const HIP_H = 1.75;
const OFFSET: Record<MBone, [number, number, number]> = {
  Hips: [0, HIP_H, 0], Spine: [0, 0.35, 0], Chest: [0, 0.4, 0], Neck: [0, 0.38, 0], Head: [0, 0.22, 0], Jaw: [0, -0.08, -0.18],
  LArm: [-0.58, 0.28, 0], LFore: [0, -0.95, 0], LHand: [0, -0.85, 0],
  RArm: [0.58, 0.28, 0], RFore: [0, -0.95, 0], RHand: [0, -0.85, 0],
  LThigh: [-0.3, -0.12, 0], LShin: [0, -0.85, 0], LFoot: [0, -0.72, 0],
  RThigh: [0.3, -0.12, 0], RShin: [0, -0.85, 0], RFoot: [0, -0.72, 0],
};
const BI = (n: MBone) => MBONES.indexOf(n);
type W = [MBone, number][];
interface Ring { y: number; rx: number; rz: number; x?: number; z?: number; w: W }

/** Tube through rings along Y, skinned by the ring weights, with a shaggy radial jitter. */
function tube(rings: Ring[], radial = 12, sub = 2, shag = 0.05): THREE.BufferGeometry {
  const pos: number[] = [], si: number[] = [], sw: number[] = [], idx: number[] = [];
  const pushW = (w: W) => {
    const m = new Map<number, number>();
    for (const [b, v] of w) m.set(BI(b), (m.get(BI(b)) ?? 0) + v);
    const e = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const s = e.reduce((t, [, v]) => t + v, 0) || 1;
    for (let k = 0; k < 4; k++) { si.push(e[k]?.[0] ?? 0); sw.push(e[k] ? e[k][1] / s : 0); }
  };
  const lerpW = (a: W, b: W, t: number): W => [...a.map(([n, v]) => [n, v * (1 - t)] as [MBone, number]), ...b.map(([n, v]) => [n, v * t] as [MBone, number])];
  const all: Ring[] = [];
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      all.push({ y: a.y + (b.y - a.y) * t, rx: a.rx + (b.rx - a.rx) * t, rz: a.rz + (b.rz - a.rz) * t, x: (a.x ?? 0) + ((b.x ?? 0) - (a.x ?? 0)) * t, z: (a.z ?? 0) + ((b.z ?? 0) - (a.z ?? 0)) * t, w: lerpW(a.w, b.w, t) });
    }
  }
  all.push(rings[rings.length - 1]);
  for (const r of all) for (let k = 0; k < radial; k++) {
    const a = (k / radial) * Math.PI * 2;
    const j = 1 + (Math.random() - 0.5) * 2 * shag / Math.max(0.05, r.rx);
    pos.push((r.x ?? 0) + Math.cos(a) * r.rx * j, r.y + (Math.random() - 0.5) * shag, (r.z ?? 0) + Math.sin(a) * r.rz * j); pushW(r.w);
  }
  for (let i = 0; i < all.length - 1; i++) for (let k = 0; k < radial; k++) {
    const a = i * radial + k, b = i * radial + (k + 1) % radial, c = a + radial, d = b + radial;
    idx.push(a, b, c, b, d, c);
  }
  for (const [ri, last] of [[0, false], [all.length - 1, true]] as const) {
    const r = all[ri], ci = pos.length / 3;
    pos.push(r.x ?? 0, r.y, r.z ?? 0); pushW(r.w);
    for (let k = 0; k < radial; k++) {
      const a = ri * radial + k, b = ri * radial + (k + 1) % radial;
      if (last) idx.push(ci, a, b); else idx.push(ci, b, a);
    }
  }
  if (all[0].y < all[all.length - 1].y) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function rigid(g: THREE.BufferGeometry, bone: MBone, at: [number, number, number], rot?: THREE.Euler): THREE.BufferGeometry {
  if (rot) g.applyQuaternion(new THREE.Quaternion().setFromEuler(rot));
  g.translate(at[0], at[1], at[2]);
  g.deleteAttribute('uv');
  const n = g.getAttribute('position').count;
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? BI(bone) : 0)), 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  return g;
}

export interface MonsterMats { fur: THREE.MeshStandardMaterial; belly: THREE.MeshStandardMaterial; face: THREE.MeshStandardMaterial; teeth: THREE.MeshStandardMaterial; eye: THREE.MeshStandardMaterial; claw: THREE.MeshStandardMaterial }
export function monsterMaterials(): MonsterMats {
  const m = (color: number, roughness = 0.95, metalness = 0, flat = true) => new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: flat });
  return { fur: m(0xeef3fa), belly: m(0xd9e4f2), face: m(0x4f7fd6, 0.7, 0, false), teeth: m(0xfffff0, 0.4, 0, false), eye: m(0x111111, 0.3, 0.1, false), claw: m(0x2b2f36, 0.5, 0.1, false) };
}

/** Eat-sequence pose inputs (FEAT-100), world targets in the three.js frame. */
export interface EatPose {
  x: number; y: number; z: number; heading: number;
  /** 0 upright .. 1 galloping crouch */
  lean: number;
  lHand: THREE.Vector3 | null; rHand: THREE.Vector3 | null;
  /** radians, positive tips the head back */
  headPitch: number;
  /** 0 closed .. 1 unhinged (the jaw bone stretches to 4x) */
  jaw: number;
}

const _v = [0, 1, 2, 3, 4, 5].map(() => new THREE.Vector3());
const _q = new THREE.Quaternion();

export class MonsterView {
  readonly group = new THREE.Group();
  readonly bones: Record<MBone, THREE.Bone>;
  readonly mats: MonsterMats;
  private readonly body = new THREE.Group();
  private idleT = Math.random() * 10;
  private lean = 0;
  private bob = 0;
  private readonly jawRest: THREE.Vector3;
  /** last solved world positions of the hands and feet (three.js), for spray and prints */
  readonly ends: Record<'LHand' | 'RHand' | 'LFoot' | 'RFoot', THREE.Vector3> = { LHand: new THREE.Vector3(), RHand: new THREE.Vector3(), LFoot: new THREE.Vector3(), RFoot: new THREE.Vector3() };

  constructor(mats = monsterMaterials()) {
    this.mats = mats;
    this.group.name = 'monster'; this.body.name = 'monster body';
    this.group.add(this.body);
    const bones = {} as Record<MBone, THREE.Bone>;
    for (const n of MBONES) {
      const b = new THREE.Bone(); b.name = n; b.position.set(...OFFSET[n]); bones[n] = b;
      const p = PARENT[n]; (p ? bones[p] : this.body).add(b);
    }
    this.bones = bones;
    this.jawRest = bones.Jaw.position.clone();
    this.body.updateMatrixWorld(true);
    const wp = (n: MBone) => bones[n].getWorldPosition(new THREE.Vector3());
    const hip = wp('Hips').y, chest = wp('Chest').y, neck = wp('Neck').y, head = wp('Head');
    const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const put = (mat: THREE.Material, g: THREE.BufferGeometry) => { if (!buckets.has(mat)) buckets.set(mat, []); buckets.get(mat)!.push(g); };
    // torso: a big barrel from the seat to the shoulders
    put(mats.fur, tube([
      { y: neck + 0.1, rx: 0.42, rz: 0.36, w: [['Neck', 0.7], ['Chest', 0.3]] },
      { y: chest + 0.08, rx: 0.72, rz: 0.55, w: [['Chest', 1]] },
      { y: chest - 0.25, rx: 0.7, rz: 0.56, w: [['Chest', 0.6], ['Spine', 0.4]] },
      { y: hip + 0.15, rx: 0.62, rz: 0.52, w: [['Spine', 0.6], ['Hips', 0.4]] },
      { y: hip - 0.15, rx: 0.55, rz: 0.48, w: [['Hips', 1]] },
      { y: hip - 0.42, rx: 0.38, rz: 0.34, w: [['Hips', 1]] },
    ], 14, 2, 0.07));
    // a paler belly plate on the front
    put(mats.belly, rigid(new THREE.SphereGeometry(0.45, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), 'Spine', [0, hip + 0.05, -0.42], new THREE.Euler(-Math.PI / 2, 0, 0)));
    // head: fur ball, blue face, eyes, brow, upper teeth
    put(mats.fur, rigid(new THREE.SphereGeometry(0.46, 14, 10), 'Head', [0, head.y + 0.22, 0.02]));
    put(mats.face, rigid(new THREE.SphereGeometry(0.34, 14, 10), 'Head', [0, head.y + 0.14, -0.28]));
    for (const sx of [-1, 1]) {
      put(mats.eye, rigid(new THREE.SphereGeometry(0.07, 8, 6), 'Head', [sx * 0.15, head.y + 0.26, -0.56]));
      put(mats.fur, rigid(new THREE.BoxGeometry(0.22, 0.08, 0.14), 'Head', [sx * 0.16, head.y + 0.36, -0.52], new THREE.Euler(0.3, 0, sx * 0.25)));
    }
    for (let i = 0; i < 6; i++) {
      const a = -0.5 + i * 0.2;
      put(mats.teeth, rigid(new THREE.ConeGeometry(0.035, 0.14, 5), 'Head', [Math.sin(a) * 0.26, head.y + 0.0, -0.34 - Math.cos(a) * 0.26], new THREE.Euler(Math.PI, 0, 0)));
    }
    // jaw: hangs from the jaw bone (local y 0 at the hinge, down to -0.28), blue with teeth pointing up
    const jawY = head.y + OFFSET.Jaw[1], jawZ = OFFSET.Jaw[2];
    put(mats.face, rigid(new THREE.BoxGeometry(0.5, 0.3, 0.44), 'Jaw', [0, jawY - 0.17, jawZ - 0.12]));
    put(mats.fur, rigid(new THREE.BoxGeometry(0.56, 0.16, 0.3), 'Jaw', [0, jawY - 0.2, jawZ + 0.02]));
    for (let i = 0; i < 5; i++) {
      const a = -0.44 + i * 0.22;
      put(mats.teeth, rigid(new THREE.ConeGeometry(0.03, 0.12, 5), 'Jaw', [Math.sin(a) * 0.2, jawY - 0.02, jawZ - 0.12 - Math.cos(a) * 0.2]));
    }
    // limbs
    for (const s of ['L', 'R'] as const) {
      const A = `${s}Arm` as MBone, F = `${s}Fore` as MBone, H = `${s}Hand` as MBone;
      const a = wp(A), f = wp(F), h = wp(H), x = a.x;
      put(mats.fur, tube([
        { x, y: a.y + 0.15, rx: 0.3, rz: 0.3, w: [['Chest', 1]] },
        { x, y: a.y - 0.05, rx: 0.28, rz: 0.27, w: [['Chest', 0.4], [A, 0.6]] },
        { x, y: f.y + 0.1, rx: 0.22, rz: 0.22, w: [[A, 1]] },
        { x, y: f.y, rx: 0.21, rz: 0.21, w: [[A, 0.5], [F, 0.5]] },
        { x, y: f.y - 0.15, rx: 0.22, rz: 0.22, w: [[F, 1]] },
        { x, y: h.y + 0.05, rx: 0.17, rz: 0.17, w: [[F, 0.7], [H, 0.3]] },
      ], 10, 2, 0.06));
      put(mats.fur, rigid(new THREE.SphereGeometry(0.2, 8, 6), H, [x, h.y - 0.06, -0.02]));
      for (let c = 0; c < 3; c++) put(mats.claw, rigid(new THREE.ConeGeometry(0.035, 0.18, 4), H, [x + (c - 1) * 0.1, h.y - 0.12, -0.22], new THREE.Euler(-Math.PI / 2, 0, 0)));
      const T = `${s}Thigh` as MBone, Sh = `${s}Shin` as MBone, Ft = `${s}Foot` as MBone;
      const t = wp(T), k = wp(Sh), an = wp(Ft), tx = t.x;
      put(mats.fur, tube([
        { x: tx, y: t.y + 0.12, rx: 0.32, rz: 0.32, w: [['Hips', 1]] },
        { x: tx, y: t.y - 0.1, rx: 0.3, rz: 0.3, w: [['Hips', 0.4], [T, 0.6]] },
        { x: tx, y: k.y + 0.12, rx: 0.25, rz: 0.25, w: [[T, 1]] },
        { x: tx, y: k.y, rx: 0.24, rz: 0.24, w: [[T, 0.5], [Sh, 0.5]] },
        { x: tx, y: k.y - 0.15, rx: 0.24, rz: 0.24, w: [[Sh, 1]] },
        { x: tx, y: an.y + 0.08, rx: 0.2, rz: 0.2, w: [[Sh, 0.7], [Ft, 0.3]] },
      ], 10, 2, 0.06));
      put(mats.fur, rigid(new THREE.BoxGeometry(0.32, 0.16, 0.5), Ft, [tx, an.y - 0.04, -0.1]));
      for (let c = 0; c < 3; c++) put(mats.claw, rigid(new THREE.ConeGeometry(0.035, 0.16, 4), Ft, [tx + (c - 1) * 0.1, an.y - 0.06, -0.42], new THREE.Euler(-Math.PI / 2, 0, 0)));
    }
    // tufts of fur on the shoulders, back and head
    for (let i = 0; i < 36; i++) {
      const onHead = i >= 26;
      const a = Math.random() * Math.PI * 2, el = (Math.random() - 0.3) * 1.2;
      const r = onHead ? 0.44 : 0.68, cy = onHead ? head.y + 0.22 : chest - 0.05;
      const dir = new THREE.Vector3(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el) * (onHead ? 1 : 0.8));
      if (!onHead && dir.z < -0.2) continue; // not across the belly
      const cone = new THREE.ConeGeometry(0.05, 0.22 + Math.random() * 0.14, 4);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      cone.translate(0, 0.1, 0); cone.applyQuaternion(q);
      put(mats.fur, rigid(cone, onHead ? 'Head' : 'Chest', [dir.x * r, cy + dir.y * r * 0.9, dir.z * r]));
    }
    const skel = new THREE.Skeleton(MBONES.map((n) => bones[n]));
    for (const [mat, geos] of buckets) {
      const g = mergeGeometries(geos, false)!;
      const m = new THREE.SkinnedMesh(g, mat);
      m.name = `monster ${Object.entries(mats).find(([, v]) => v === mat)?.[0] ?? 'mesh'}`;
      m.castShadow = true; m.frustumCulled = false;
      this.body.add(m);
      m.bind(skel);
    }
  }

  /** Place the body: pack position and heading. */
  private place(x: number, y: number, z: number, heading: number): void {
    this.group.position.set(x, z, -y);
    this.group.rotation.set(0, -heading, 0);
  }

  /** Two-bone IK for one limb to a world target with a world pole direction. */
  private limb(up: MBone, lo: MBone, end: MBone, target: THREE.Vector3, pole: THREE.Vector3): void {
    twoBone(this.bones[up], this.bones[lo], this.bones[end], target, pole);
    this.bones[end].getWorldPosition(this.ends[end as keyof typeof this.ends]);
  }

  /** World target from body-local (x right, y up, z back) coordinates. */
  private local(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 { return out.set(x, y, z).applyQuaternion(this.group.quaternion).add(this.group.position); }

  /**
   * Chase pose from the sim state: gallop on all fours at speed, stand and pant when waiting,
   * tuck into a leap between lift towers.
   */
  updateChase(m: MonsterState, pack: Pack, dt: number, puffs: Puffs | null, prints: Bootprints | null): void {
    this.place(m.x, m.y, m.z, m.heading);
    const B = this.bones;
    const onLift = m.mode === 'lift';
    const want = onLift ? 1 : Math.min(1, m.speed / 7);
    this.lean += (want - this.lean) * Math.min(1, dt * 4);
    const L = this.lean;
    this.idleT += dt;
    const ph = m.phase * Math.PI * 2;
    // body: crouch and pitch forward with the lean, bob with the stride
    this.bob = L * 0.14 * Math.sin(2 * ph);
    const idle = (1 - L) * 0.03 * Math.sin(this.idleT * 1.7);
    B.Hips.position.set(0, HIP_H - 0.62 * L + this.bob + idle + (onLift ? 0.3 : 0), -0.1 * L);
    B.Hips.rotation.set(-1.0 * L, 0, 0.06 * L * Math.sin(ph));
    B.Spine.rotation.set(-0.12 * L, 0.05 * L * Math.sin(ph), 0);
    B.Chest.rotation.set(-0.12 * L, 0.05 * L * Math.sin(ph), 0);
    // head up to look where it is going, a little weave
    B.Neck.rotation.set(0.6 * L + 0.05 * Math.sin(this.idleT * 0.9), 0.15 * (1 - L) * Math.sin(this.idleT * 0.7), 0);
    B.Head.rotation.set(0.55 * L, 0, 0);
    // panting jaw
    B.Jaw.scale.set(1, 1, 1); B.Jaw.position.copy(this.jawRest);
    B.Jaw.rotation.set(0.25 + 0.2 * Math.max(0, Math.sin(this.idleT * 4)) * (0.5 + 0.5 * L), 0, 0);
    this.group.updateMatrixWorld(true);
    // limbs: swing targets in the body frame, feet on the snow
    const gz = this.group.position.y;
    const ground = (wx: number, wz: number) => { const g = pack.groundHeight(wx, -wz); return Number.isNaN(g) ? gz : g; };
    const A = 0.95 * L, H = 0.55 * L;
    const limbs: [MBone, MBone, MBone, number, number, number, number][] = [
      // up, lo, end, lateral, rest z, phase offset, stand height
      ['LArm', 'LFore', 'LHand', -0.6, -1.45, 0.0, 1.05],
      ['RArm', 'RFore', 'RHand', 0.6, -1.45, 0.12, 1.05],
      ['LThigh', 'LShin', 'LFoot', -0.36, 0.25, 0.5, 0.08],
      ['RThigh', 'RShin', 'RFoot', 0.36, 0.25, 0.62, 0.08],
    ];
    for (const [up, lo, end, lat, restZ, off, standH] of limbs) {
      const u = (m.phase + off) % 1, a = u * Math.PI * 2;
      const arm = up === 'LArm' || up === 'RArm';
      let tx = lat, tz = restZ * L + (arm ? 0.45 : 0.15) * (1 - L) + A * Math.cos(a) * (arm ? 1 : 1.1), ty: number;
      if (onLift) { tx = lat * 1.2; tz = arm ? -1.2 : 0.6; ty = arm ? 0.9 : 0.5; }
      else {
        const lift = Math.max(0, Math.sin(a)) * H;
        const w = this.local(tx, 0, tz, _v[0]);
        ty = ground(w.x, w.z) - gz + 0.08 + lift;
        ty = ty * L + (standH + (arm ? 0.02 * Math.sin(this.idleT * 1.7) : 0)) * (1 - L);
      }
      const target = this.local(tx, ty, tz, _v[1]);
      const pole = arm ? this.local(lat * 2, 0, 1.5, _v[2]).sub(this.group.position) : this.local(lat, 0, -2, _v[2]).sub(this.group.position);
      this.limb(up, lo, end, target, pole);
      // claws down: the end bone takes the body yaw, pitched onto the slope
      setWorldQuat(B[end], _q.copy(this.group.quaternion));
    }
    // footfall: spray off the hind feet and a big print
    if (m.footfall && !onLift) {
      const foot = m.phase < 0.5 ? this.ends.LFoot : this.ends.RFoot;
      puffs?.emit(foot.x, foot.y + 0.1, foot.z, 10 + Math.floor(m.speed), [0xffffff, 0xeaf2ff], 0.5, 2.5, 2.5, 0.7);
      prints?.add({ side: m.phase < 0.5 ? 0 : 1, x: foot.x, y: -foot.z, yaw: m.heading, speed: m.speed, kick: 1, smearX: 0, smearY: 0 }, 0.22);
    }
  }

  /** The eat sequence pose (FEAT-100): upright, hands on targets, head and jaw driven by the timeline. */
  poseEat(p: EatPose, pack: Pack, dt: number): void {
    this.place(p.x, p.y, p.z, p.heading);
    const B = this.bones;
    this.lean += (p.lean - this.lean) * Math.min(1, dt * 6);
    const L = this.lean;
    this.idleT += dt;
    B.Hips.position.set(0, HIP_H - 0.62 * L + 0.02 * Math.sin(this.idleT * 2), -0.1 * L);
    B.Hips.rotation.set(-1.0 * L, 0, 0);
    B.Spine.rotation.set(-0.1 * L, 0, 0); B.Chest.rotation.set(-0.1 * L, 0, 0);
    B.Neck.rotation.set(0.5 * L + p.headPitch * 0.4, 0, 0);
    B.Head.rotation.set(0.5 * L + p.headPitch * 0.6, 0, 0);
    // the jaw: opens, then stretches to four times its length when unhinged
    const open = Math.min(1, p.jaw * 2), stretch = Math.max(0, p.jaw * 2 - 1);
    B.Jaw.rotation.set(0.15 + 0.7 * open, 0, 0);
    B.Jaw.scale.set(1 + 0.5 * stretch, 1 + 5 * stretch, 1 + 0.6 * stretch);
    B.Jaw.position.copy(this.jawRest);
    this.group.updateMatrixWorld(true);
    const gz = this.group.position.y;
    const ground = (wx: number, wz: number) => { const g = pack.groundHeight(wx, -wz); return Number.isNaN(g) ? gz : g; };
    // feet planted wide
    for (const [up, lo, end, lat] of [['LThigh', 'LShin', 'LFoot', -0.42], ['RThigh', 'RShin', 'RFoot', 0.42]] as const) {
      const w = this.local(lat, 0, 0.1, _v[0]);
      const target = this.local(lat, ground(w.x, w.z) - gz + 0.08, 0.1, _v[1]);
      this.limb(up, lo, end, target, this.local(lat, 0, -2, _v[2]).sub(this.group.position));
      setWorldQuat(B[end], _q.copy(this.group.quaternion));
    }
    // hands: on the targets, else hanging
    for (const [up, lo, end, lat, t] of [['LArm', 'LFore', 'LHand', -0.75, p.lHand], ['RArm', 'RFore', 'RHand', 0.75, p.rHand]] as const) {
      const target = t ? _v[1].copy(t) : this.local(lat, 1.0, 0.05, _v[1]);
      const pole = this.local(lat * 2.5, 0.5, 0.8, _v[2]).sub(this.group.position);
      this.limb(up, lo, end, target, pole);
    }
  }

  /** World position (three.js) just inside the mouth. */
  mouth(out: THREE.Vector3): THREE.Vector3 { this.group.updateMatrixWorld(true); return out.set(0, -0.12, -0.5).applyMatrix4(this.bones.Head.matrixWorld); }
  hand(side: 'L' | 'R', out: THREE.Vector3): THREE.Vector3 { return out.copy(this.ends[`${side}Hand`]); }
  belly(out: THREE.Vector3): THREE.Vector3 { this.group.updateMatrixWorld(true); return out.set(0, 0.1, -0.75).applyMatrix4(this.bones.Spine.matrixWorld); }

  dispose(): void {
    this.body.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
  }
}

/**
 * All the monsters in the scene: one view per sim monster, created on spawn. Snow spray and
 * big footprints per footfall, a puff and a crack at trunks it bounds past (FEAT-101).
 */
export class Monsters {
  readonly group = new THREE.Group();
  readonly views = new Map<number, MonsterView>();
  private readonly mats = monsterMaterials();
  private readonly nearTmp: Float32Array[] = [];
  private readonly cracked = new Map<number, number>();
  onCrack: ((x: number, y: number, z: number) => void) | null = null;

  constructor(private readonly pack: Pack, private readonly collider: Collider | null, private readonly puffs: Puffs | null, private readonly prints: Bootprints | null) { this.group.name = 'monsters'; }

  get materials(): MonsterMats { return this.mats; }

  view(id: number): MonsterView | undefined { return this.views.get(id); }

  /** Per frame: sync views to the sim; `posing` ids are driven by the eat sequence instead. */
  update(outrun: Outrun, dt: number, posing: Set<number>): void {
    const live = new Set<number>();
    for (const m of outrun.monsters) {
      live.add(m.id);
      let v = this.views.get(m.id);
      if (!v) { v = new MonsterView(this.mats); this.views.set(m.id, v); this.group.add(v.group); }
      if (posing.has(m.id)) continue;
      v.updateChase(m, this.pack, dt, this.puffs, this.prints);
      // trunks it bounds past: a snow puff off the tree and a crack, once per trunk
      if (this.collider && m.mode !== 'lift' && m.speed > 3) {
        const near = this.collider.near(m.x, m.y, 1.2, this.nearTmp);
        for (const c of near) {
          if (c[5] !== 0) continue; // rocks do not snap
          const key = Math.round(c[0] * 10) * 100003 + Math.round(c[1] * 10);
          if ((this.cracked.get(key) ?? -99) > outrun.time - 20) continue;
          this.cracked.set(key, outrun.time);
          const z = this.pack.groundHeight(c[0], c[1]);
          this.puffs?.emit(c[0], (Number.isNaN(z) ? m.z : z) + 2 + Math.random() * 3, -c[1], 25, [0xffffff, 0xdde8f5, 0x9ec1a0], 1.2, 1.5, 1.0, 1.2, 1.5);
          this.onCrack?.(c[0], c[1], Number.isNaN(z) ? m.z : z);
        }
      }
    }
    for (const [id, v] of this.views) if (!live.has(id)) { this.group.remove(v.group); v.dispose(); this.views.delete(id); }
    if (this.cracked.size > 400) this.cracked.clear();
  }

  clear(): void { for (const v of this.views.values()) { this.group.remove(v.group); v.dispose(); } this.views.clear(); }
}
