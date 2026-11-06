import * as THREE from 'three';
import type { Rider } from '../sim/Rider';
import { buildRider, applyPose, lerpPose, clonePose, POSES, SKI_POSES, type Joints, type Pose, type RiderMaterials } from './RiderModel';

/**
 * Articulated rider (RiderModel.ts) posed from the sim state: neutral, toe/heel carve, tuck,
 * crouch (jump charge), air and grab, landing compression, crash tumble, seated on a chair.
 * Poses blend by weight each frame and the result is smoothed, so transitions read as motion.
 */
/** Soft round particle: radial alpha falloff on a small canvas. */
function sprayTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class RiderView {
  readonly group = new THREE.Group();
  readonly mats: RiderMaterials;
  private joints: Joints;
  private body: THREE.Group;
  private root: THREE.Group;
  private poses: Record<string, Pose> = POSES;
  discipline: 'board' | 'ski' = 'board';
  private leanAngle = 0;
  private readonly pose: Pose = clonePose(POSES.neutral);
  private readonly target: Pose = clonePose(POSES.neutral);
  private readonly scratch: Pose = clonePose(POSES.neutral);
  private readonly spray: THREE.Points;
  private readonly sprayPos: Float32Array;
  private readonly sprayVel: Float32Array;
  private readonly sprayLife: Float32Array;
  private readonly tmpN = new THREE.Vector3();
  private readonly tmpF = new THREE.Vector3();
  private readonly tmpR = new THREE.Vector3();
  private readonly rot = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();

  constructor() {
    const built = buildRider();
    this.mats = built.mats;
    this.joints = built.joints;
    this.body = built.joints.hips;
    this.root = built.root;
    this.group.add(built.root);
    applyPose(this.joints, this.pose);

    const n = 400;
    this.sprayPos = new Float32Array(n * 3);
    this.sprayVel = new Float32Array(n * 3);
    this.sprayLife = new Float32Array(n);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.sprayPos, 3));
    this.spray = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.28, map: sprayTexture(), transparent: true, opacity: 0.75, depthWrite: false, alphaTest: 0.05 }));
    this.spray.frustumCulled = false;
  }

  get sprayObject(): THREE.Points {
    return this.spray;
  }

  /** Swap between snowboard and skis (rebuilds the model with the same materials). */
  setDiscipline(d: 'board' | 'ski'): void {
    if (d === this.discipline) return;
    this.discipline = d;
    const fp = !this.body.visible;
    this.group.remove(this.root);
    const built = buildRider(this.mats, d);
    this.joints = built.joints; this.body = built.joints.hips; this.root = built.root;
    this.group.add(built.root);
    this.poses = d === 'ski' ? SKI_POSES : POSES;
    Object.assign(this.pose, clonePose(this.poses.neutral));
    this.body.visible = !fp;
  }

  /** Apply outfit colours (hex strings) to the material slots. */
  setOutfit(o: { jacket: string; pants: string; helmet: string; board: string; gloves: string }): void {
    this.mats.jacket.color.set(o.jacket); this.mats.pants.color.set(o.pants); this.mats.helmet.color.set(o.helmet);
    this.mats.board.color.set(o.board); this.mats.gloves.color.set(o.gloves);
  }

  /** Hide the body (keep the board) for first person. */
  setFirstPerson(fp: boolean): void { this.body.visible = !fp; }

  update(r: Rider, dt: number, tuck: boolean, grab = false, seated = false): void {
    this.group.position.set(r.x, r.z, -r.y);
    // ---- pose blend
    const t = this.target;
    const P = this.poses;
    Object.assign(t, clonePose(P.neutral));
    if (seated) { lerpPose(t, t, P.seated, 1); }
    else if (r.crashed > 0) { lerpPose(t, t, P.crash, 1); }
    else if (!r.onGround) { lerpPose(t, t, grab ? P.grab : P.air, 1); }
    else {
      const edge = Math.max(-1, Math.min(1, r.edgeAngle));
      if (edge > 0) lerpPose(t, t, P.carveToe, Math.min(1, edge * 1.2)); else if (edge < 0) lerpPose(t, t, P.carveHeel, Math.min(1, -edge * 1.2));
      if (tuck) lerpPose(t, t, P.tuck, 0.85);
      if (r.jumpCharge > 0) lerpPose(t, t, P.crouch, Math.min(1, r.jumpCharge));
      if (r.landingShock > 0) lerpPose(t, t, P.land, Math.min(1, r.landingShock * 1.5));
    }
    lerpPose(this.pose, this.pose, t, Math.min(1, dt * (r.crashed > 0 ? 6 : 10)));
    applyPose(this.joints, this.pose);
    // idle breathing / balance wobble so a standing rider is not frozen
    const now = performance.now() / 1000;
    this.joints.torso.rotation.x += Math.sin(now * 1.3) * 0.015;
    this.joints.hips.position.y += Math.sin(now * 2.1) * 0.004;
    // orientation: board forward along heading, up along the ground normal (blend to world up in the air)
    const n = this.tmpN.set(r.normal[0], r.normal[2], -r.normal[1]);
    if (!r.onGround) n.lerp(new THREE.Vector3(0, 1, 0), 0.7).normalize();
    const f = this.tmpF.set(Math.sin(r.heading), 0, -Math.cos(r.heading));
    // make f orthogonal to n
    f.sub(n.clone().multiplyScalar(f.dot(n))).normalize();
    const right = this.tmpR.crossVectors(f, n).normalize();
    this.rot.makeBasis(right, n, f.clone().negate());
    this.q.setFromRotationMatrix(this.rot);
    this.group.quaternion.slerp(this.q, Math.min(1, dt * 12));
    // ---- carving physics for the picture
    // inclination: the body leans into the turn until lateral acceleration balances gravity,
    // phi = atan(a_lat / g), capped at about 50 degrees. lateralG > 0 = turning toward the
    // board's right-hand side (the toe side in a regular stance).
    const phi = r.onGround && !seated ? Math.max(-0.7, Math.min(0.7, Math.atan(r.lateralG * 0.8))) : 0; // cap 40 degrees
    this.leanAngle += (phi - this.leanAngle) * Math.min(1, dt * 8);
    const L = this.joints.lean, B = this.joints.board;
    // the board and the rider roll together about the engaged edge (0.13 m off centre) so the
    // edge stays in the snow and the feet stay on the board; angulation (body leaning more than
    // the board) comes from the carve poses bending at the waist and knees
    const side = Math.abs(this.leanAngle) > 0.03 ? Math.sign(this.leanAngle) : 0;
    L.position.set(side * 0.13, 0, 0);
    B.position.set(-side * 0.13, 0, 0);
    this.joints.hips.position.x = -side * 0.13;
    // rotation about the forward (Z) axis: positive lateralG tips +Y toward +X (the right), a negative Z rotation
    L.rotation.set(0, 0, -this.leanAngle);
    B.rotation.set(0, 0, 0);

    // snow spray when skidding or braking hard
    const pos = this.sprayPos, vel = this.sprayVel, life = this.sprayLife;
    const emit = r.onGround ? Math.floor((r.skid * 10 + (r.speed > 8 ? 1 : 0)) * 1.0) : 0;
    let emitted = 0;
    const g = this.group.position;
    for (let i = 0; i < life.length; i++) {
      if (life[i] <= 0) {
        if (emitted < emit) {
          emitted++;
          life[i] = 0.5 + Math.random() * 0.4;
          pos[i * 3] = g.x + (Math.random() - 0.5) * 0.6; pos[i * 3 + 1] = g.y + 0.1; pos[i * 3 + 2] = g.z + (Math.random() - 0.5) * 0.6;
          const side = Math.sign(r.edgeAngle || 1) * -1;
          vel[i * 3] = right.x * side * (2 + Math.random() * 3) + (Math.random() - 0.5) * 2;
          vel[i * 3 + 1] = 2 + Math.random() * 3 * r.skid;
          vel[i * 3 + 2] = right.z * side * (2 + Math.random() * 3) + (Math.random() - 0.5) * 2;
        } else {
          pos[i * 3 + 1] = -10000;
        }
        continue;
      }
      life[i] -= dt;
      vel[i * 3 + 1] -= 9.81 * dt;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
    }
    (this.spray.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}
