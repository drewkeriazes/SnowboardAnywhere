import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';
import { BONES, setWorldQuat, type BoneName, type RiderRig } from './RiderRig';

/**
 * FEAT-046: a light Verlet ragdoll for crashes. One particle per rig joint plus the top of the head
 * (19), held together by the bone lengths and a few braces that keep the torso and pelvis rigid.
 * Seeded from the posed skeleton and the rider's velocity, with a random tumble. Particles collide
 * with the snow (Pack.groundHeight, with friction) and with trunks, rocks and walls (Collider).
 * Only the pelvis, chest, head and feet test against the Collider (cheap, and enough to stop the
 * body), so hands and knees can still pass through a trunk the pelvis stops at.
 * Every frame the bones are turned to point along their particles, so the skinned body follows.
 * All in three.js world space (x east, y up, z = -north).
 */
const STEP = 1 / 120, ITER = 8, G = 9.81, DAMP = 0.995;
/** snow friction on particles touching the ground (fraction of the slide kept per step) */
const GROUND_KEEP = 0.93;
/** pull of the whole body toward the sim's crash position (1/s), so the rider gets up where the sim is */
const TETHER = 2.5;
/** blend from the last ragdoll pose back to the animated pose (s) */
export const RAGDOLL_RECOVER = 0.4;
/**
 * Collider.resolve tests a 1.5 m tall body span starting at the z it is given (m); passing the
 * particle height minus half of that centres the span on the particle.
 */
const COLLIDE_HALF_SPAN = 0.75;

const N = BONES.length + 1; // + head top
const HEAD_TOP = BONES.length;
const IDX = (b: BoneName) => BONES.indexOf(b);
/** bones turned to point at a child particle: [bone, child particle, a second particle pair for the side axis] */
const AIM: [BoneName, number, [BoneName, BoneName] | null][] = [
  ['Hips', IDX('Spine'), ['LeftUpLeg', 'RightUpLeg']],
  ['Spine', IDX('Spine1'), null], ['Spine1', IDX('Spine2'), null],
  ['Spine2', IDX('Neck'), ['LeftArm', 'RightArm']],
  ['Neck', IDX('Head'), null], ['Head', HEAD_TOP, null],
  ['LeftArm', IDX('LeftForeArm'), null], ['LeftForeArm', IDX('LeftHand'), null],
  ['RightArm', IDX('RightForeArm'), null], ['RightForeArm', IDX('RightHand'), null],
  ['LeftUpLeg', IDX('LeftLeg'), null], ['LeftLeg', IDX('LeftFoot'), null],
  ['RightUpLeg', IDX('RightLeg'), null], ['RightLeg', IDX('RightFoot'), null],
];
/** extra rigid braces: pelvis, chest, and pelvis to chest corners */
const BRACES: [BoneName, BoneName][] = [
  ['LeftUpLeg', 'RightUpLeg'], ['LeftArm', 'RightArm'], ['LeftArm', 'Spine'], ['RightArm', 'Spine'],
  ['LeftUpLeg', 'Spine2'], ['RightUpLeg', 'Spine2'], ['LeftArm', 'LeftUpLeg'], ['RightArm', 'RightUpLeg'],
  ['Hips', 'Neck'], ['Spine2', 'Head'],
];
/** limbs may fold but not past this fraction of their straight length (keeps knees and elbows sane) */
const FOLD: [BoneName, BoneName, number][] = [
  ['LeftUpLeg', 'LeftFoot', 0.35], ['RightUpLeg', 'RightFoot', 0.35], ['LeftArm', 'LeftHand', 0.3], ['RightArm', 'RightHand', 0.3],
];
/** particle radius (m) for the ground: head and hips are bulkier */
const RADIUS = (i: number) => (i === HEAD_TOP || i === IDX('Head') ? 0.12 : i === IDX('Hips') ? 0.14 : 0.07);

export class Ragdoll {
  active = false;
  private readonly p = Array.from({ length: N }, () => new THREE.Vector3());
  private readonly o = Array.from({ length: N }, () => new THREE.Vector3());
  /** [a, b, rest length, min only] */
  private links: [number, number, number, boolean][] = [];
  private acc = 0;
  /** the bind direction of each aimed bone toward its child, in the bone's own frame */
  private readonly bindDir = new Map<BoneName, THREE.Vector3>();
  private readonly v1 = new THREE.Vector3(); private readonly v2 = new THREE.Vector3(); private readonly v3 = new THREE.Vector3();
  private readonly q1 = new THREE.Quaternion(); private readonly q2 = new THREE.Quaternion();

  constructor(private readonly pack: Pack, private readonly collider: Collider | null) {}

  /** Start from the rig's current world pose, moving at `vel` (world m/s), with a random tumble. */
  start(rig: RiderRig, vel: THREE.Vector3): void {
    const B = rig.bones;
    rig.body.updateMatrixWorld(true);
    BONES.forEach((b, i) => B[b].getWorldPosition(this.p[i]));
    B.Head.localToWorld(this.p[HEAD_TOP].set(0, 0.2, 0));
    // tumble: a spin about a horizontal axis across the travel direction, faster at speed
    const spd = vel.length();
    const axis = this.v1.set(vel.z, 0, -vel.x);
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
    axis.normalize().applyAxisAngle(this.v2.set(0, 1, 0), (Math.random() - 0.5) * 0.8);
    const w = Math.min(6, 1.5 + spd * 0.25) * (Math.random() < 0.5 ? 1 : -1);
    const centre = this.v2.copy(this.p[IDX('Hips')]);
    for (let i = 0; i < N; i++) {
      const r = this.v3.copy(this.p[i]).sub(centre);
      const tang = r.cross(axis).multiplyScalar(w); // w x r with the sign folded in
      this.o[i].copy(this.p[i]).addScaledVector(vel, -STEP).addScaledVector(tang, -STEP);
    }
    // constraints at the seeded lengths: bones, braces and fold limits
    const L = (a: number, b: number) => this.p[a].distanceTo(this.p[b]);
    this.links = [];
    for (let i = 1; i < BONES.length; i++) {
      const par = B[BONES[i]].parent?.name as BoneName | undefined;
      if (par && BONES.includes(par)) this.links.push([IDX(par), i, L(IDX(par), i), false]);
    }
    this.links.push([IDX('Head'), HEAD_TOP, L(IDX('Head'), HEAD_TOP), false]);
    for (const [a, b] of BRACES) this.links.push([IDX(a), IDX(b), L(IDX(a), IDX(b)), false]);
    for (const [a, b, k] of FOLD) {
      const ia = IDX(a), ib = IDX(b);
      const mid = IDX((a.replace('UpLeg', 'Leg').replace('Arm', 'ForeArm')) as BoneName);
      this.links.push([ia, ib, (L(ia, mid) + L(mid, ib)) * k, true]);
    }
    // bind directions: the child offset in each bone's own frame (bones are identity in the bind pose)
    for (const [bone, child] of AIM) {
      const q = B[bone].getWorldQuaternion(this.q1).invert();
      this.bindDir.set(bone, this.v1.copy(this.p[child]).sub(this.p[IDX(bone)]).applyQuaternion(q).normalize().clone());
    }
    this.acc = 0;
    this.active = true;
  }

  /** Step the particles; `tether` is the sim's crash position (world) that the body is pulled toward. */
  step(dt: number, tether: THREE.Vector3): void {
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= STEP) { this.acc -= STEP; this.tick(tether); }
  }

  private tick(tether: THREE.Vector3): void {
    const p = this.p, o = this.o;
    const hips = p[IDX('Hips')];
    const pullX = (tether.x - hips.x) * TETHER * STEP, pullZ = (tether.z - hips.z) * TETHER * STEP;
    for (let i = 0; i < N; i++) {
      const vx = (p[i].x - o[i].x) * DAMP, vy = (p[i].y - o[i].y) * DAMP, vz = (p[i].z - o[i].z) * DAMP;
      o[i].copy(p[i]);
      p[i].x += vx + pullX; p[i].y += vy - G * STEP * STEP; p[i].z += vz + pullZ;
    }
    for (let it = 0; it < ITER; it++) {
      for (const [a, b, rest, minOnly] of this.links) {
        const pa = p[a], pb = p[b];
        const dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        if (minOnly && d >= rest) continue;
        const k = (d - rest) / d * 0.5;
        pa.x += dx * k; pa.y += dy * k; pa.z += dz * k;
        pb.x -= dx * k; pb.y -= dy * k; pb.z -= dz * k;
      }
      this.collide();
    }
  }

  private collide(): void {
    const p = this.p, o = this.o;
    for (let i = 0; i < N; i++) {
      const q = p[i], r = RADIUS(i);
      const g = this.pack.groundHeight(q.x, -q.z) + r;
      if (q.y < g) {
        q.y = g;
        // friction: lose most of the slide along the snow this step
        o[i].x = q.x - (q.x - o[i].x) * GROUND_KEEP; o[i].z = q.z - (q.z - o[i].z) * GROUND_KEEP;
        if (o[i].y < q.y - 0.02) o[i].y = q.y - 0.02; // a little bounce, no more
      }
      if (this.collider && (i === IDX('Hips') || i === IDX('Head') || i === IDX('Spine2') || i === IDX('LeftFoot') || i === IDX('RightFoot'))) {
        const hit = this.collider.resolve(q.x, -q.z, q.y - COLLIDE_HALF_SPAN, r);
        if (hit) { q.x = hit.x; q.z = -hit.y; o[i].x = q.x; o[i].z = q.z; }
      }
    }
  }

  /** Turn the rig's bones to follow the particles (parents first) and put the pelvis on its particle. */
  apply(rig: RiderRig): void {
    const B = rig.bones;
    const hips = B.Hips;
    hips.position.copy(hips.parent!.worldToLocal(this.v1.copy(this.p[IDX('Hips')])));
    hips.updateMatrixWorld(true);
    for (const [bone, child, side] of AIM) {
      const b = B[bone];
      const cur = b.getWorldQuaternion(this.q1);
      const want = this.v1.copy(this.p[child]).sub(this.p[IDX(bone)]).normalize();
      const have = this.v2.copy(this.bindDir.get(bone)!).applyQuaternion(cur);
      // swing: the shortest turn from where the bone points to where its particle is
      this.q2.setFromUnitVectors(have, want);
      cur.premultiply(this.q2);
      if (side) {
        // twist about the bone so its sideways axis lines up with the hip (or shoulder) line
        const sx = this.v2.set(1, 0, 0).applyQuaternion(cur);
        const t = this.v3.copy(this.p[IDX(side[1])]).sub(this.p[IDX(side[0])]);
        t.addScaledVector(want, -t.dot(want));
        sx.addScaledVector(want, -sx.dot(want));
        if (t.lengthSq() > 1e-6 && sx.lengthSq() > 1e-6) cur.premultiply(this.q2.setFromUnitVectors(sx.normalize(), t.normalize()));
      }
      setWorldQuat(b, cur);
    }
  }

  /** Pelvis particle (world), for the camera and the sim tether. */
  get pelvis(): THREE.Vector3 { return this.p[IDX('Hips')]; }

  stop(): void { this.active = false; }
}
