import * as THREE from 'three';
import type { Rider } from '../sim/Rider';
import { lerpPose, clonePose, defaultMaterials, POSES, SKI_POSES, type Pose, type RiderMaterials } from './RiderModel';
import { buildRig, pinFeet, twoBone, setWorldQuat, hangCarriersFromFeet, restCarriers, type RiderRig } from './RiderRig';

const d2r = Math.PI / 180;

/**
 * Skeletal rider (RiderRig.ts) posed from the sim state. Pose tables (neutral, toe/heel carve,
 * tuck, crouch, air, grab, landing, crash, seated) blend by weight and drive the pelvis, spine,
 * head and arms; a physical layer adds g-load compression, balance arms and a spine twist toward
 * the direction of travel; then two-bone IK pins both boots to the bindings every frame so the
 * board and body cannot separate. Skiers also place their hands by IK and aim the poles.
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

/** Layer the body is also drawn on, so first person can redraw it with a close near plane. */
export const BODY_LAYER = 1;

export class RiderView {
  readonly group = new THREE.Group();
  private fp = false;
  readonly mats: RiderMaterials;
  private rig: RiderRig;
  /** roll pivot at the board's engaged edge; the board and the body are both children */
  private readonly lean = new THREE.Group();
  private poses: Record<string, Pose> = POSES;
  discipline: 'board' | 'ski' = 'board';
  private leanAngle = 0;
  private twist = 0;
  private wasSeated = false;
  /** worst ankle-to-binding distance after the last solve (m); 0 means the boots are on the bindings */
  footGap = 0;
  private readonly pose: Pose = clonePose(POSES.neutral);
  private readonly target: Pose = clonePose(POSES.neutral);
  private readonly spray: THREE.Points;
  private readonly sprayPos: Float32Array;
  private readonly sprayVel: Float32Array;
  private readonly sprayLife: Float32Array;
  private readonly tmpN = new THREE.Vector3();
  private readonly tmpF = new THREE.Vector3();
  private readonly tmpR = new THREE.Vector3();
  private readonly rot = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pq = new THREE.Quaternion();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly v4 = new THREE.Vector3();

  constructor() {
    this.mats = defaultMaterials();
    this.group.add(this.lean);
    this.rig = this.mount('board');

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

  private mount(d: 'board' | 'ski'): RiderRig {
    const rig = buildRig(this.mats, d);
    this.lean.add(rig.board, rig.body);
    for (const o of [rig.body, rig.board]) o.traverse((m) => m.layers.enable(BODY_LAYER));
    return rig;
  }

  /** Swap between snowboard and skis (rebuilds the rig with the same materials). */
  setDiscipline(d: 'board' | 'ski'): void {
    if (d === this.discipline) return;
    this.discipline = d;
    this.lean.remove(this.rig.board, this.rig.body);
    for (const o of [this.rig.body, this.rig.board]) o.traverse((m) => { if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).geometry.dispose(); });
    this.rig = this.mount(d);
    this.poses = d === 'ski' ? SKI_POSES : POSES;
    Object.assign(this.pose, clonePose(this.poses.neutral));
    this.wasSeated = false;
    this.setFirstPerson(this.fp);
  }

  /** Apply outfit colours (hex strings) to the material slots. */
  setOutfit(o: { jacket: string; pants: string; helmet: string; board: string; gloves: string }): void {
    this.mats.jacket.color.set(o.jacket); this.mats.pants.color.set(o.pants); this.mats.helmet.color.set(o.helmet);
    this.mats.board.color.set(o.board); this.mats.gloves.color.set(o.gloves);
  }

  /**
   * First person: hide the head and the torso (within a few tens of cm of the eye, so they would
   * fill the view or be seen from inside); arms, legs, boots and the board stay in view. The arms
   * are also lowered toward the sides (see update) so they do not hang across the view.
   */
  setFirstPerson(fp: boolean): void {
    this.fp = fp;
    for (const m of [...this.rig.headParts, ...this.rig.coreParts]) m.visible = !fp;
  }

  /** World position of the eyes (three.js frame), from the posed head, for the first-person camera. */
  eye(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return out.set(0, 0.1, -0.02).applyMatrix4(this.rig.bones.Head.matrixWorld);
  }

  /** FK from the blended pose: pelvis, spine, head and arms. Leg angles only stand when seated. */
  private applyFK(p: Pose, xOff: number): void {
    const B = this.rig.bones;
    B.Hips.position.set(xOff, p.hipsY, 0);
    // pitch convention in the tables: positive = bend toward the face; +X rotation tips +Y toward
    // +Z (the back), so pitches are negated. The waist bend spreads over three spine bones.
    B.Hips.rotation.set(-p.hipsRot[0], p.hipsRot[1], p.hipsRot[2]);
    for (const [b, k] of [[B.Spine, 0.4], [B.Spine1, 0.3], [B.Spine2, 0.3]] as const) b.rotation.set(-p.torso[0] * k, p.torso[1] * k, p.torso[2] * k);
    B.Neck.rotation.set(-p.head[0] * 0.4, p.head[1] * 0.4, p.head[2] * 0.4);
    B.Head.rotation.set(-p.head[0] * 0.6, p.head[1] * 0.6, p.head[2] * 0.6);
    B.LeftArm.rotation.set(p.lShoulder[0], p.lShoulder[1], p.lShoulder[2]);
    B.RightArm.rotation.set(p.rShoulder[0], p.rShoulder[1], p.rShoulder[2]);
    B.LeftForeArm.rotation.set(p.lElbow * d2r, 0, 0);
    B.RightForeArm.rotation.set(p.rElbow * d2r, 0, 0);
    B.LeftUpLeg.rotation.set(p.lHip[0], p.lHip[1], p.lHip[2]);
    B.RightUpLeg.rotation.set(p.rHip[0], p.rHip[1], p.rHip[2]);
    B.LeftLeg.rotation.set(-p.lKnee * d2r, 0, 0);
    B.RightLeg.rotation.set(-p.rKnee * d2r, 0, 0);
    // feet level with the pelvis (hip pitch minus knee bend)
    B.LeftFoot.rotation.set(-p.lHip[0] + p.lKnee * d2r, 0, 0);
    B.RightFoot.rotation.set(-p.rHip[0] + p.rKnee * d2r, 0, 0);
  }

  /** Skier: hands placed by IK in the chest frame, poles aimed at a plant point beside the boots. */
  private skiHands(r: Rider, tuck: boolean, free: boolean): void {
    const rig = this.rig, B = rig.bones;
    const chest = B.Spine2;
    if (free) {
      const tk = tuck ? 1 : Math.min(1, r.jumpCharge + r.landingShock), air = r.onGround ? 0 : 1;
      for (const [side, up, lo, end] of [[-1, B.LeftArm, B.LeftForeArm, B.LeftHand], [1, B.RightArm, B.RightForeArm, B.RightHand]] as const) {
        // chest-frame target: neutral at the waist, tuck in front of the knees, air out to the side
        const t = this.v1.set(side * 0.26, -0.25, -0.28);
        t.lerp(this.v2.set(side * 0.14, -0.15, -0.38), tk * (1 - air));
        t.lerp(this.v2.set(side * 0.38, -0.2, -0.15), air);
        if (this.fp) { t.y += 0.1; t.z -= 0.08; }
        chest.localToWorld(t);
        // elbows out and back
        const pole = this.v2.set(side * 0.7, -0.3, 0.6).applyQuaternion(chest.getWorldQuaternion(this.pq));
        twoBone(up, lo, end, t, pole);
      }
    }
    for (const [side, grip] of [[-1, rig.lPole], [1, rig.rPole]] as const) {
      if (!grip) continue;
      const g = grip.getWorldPosition(this.v1);
      const dir = free
        ? rig.board.localToWorld(this.v2.set(side * 0.34, r.onGround ? 0 : -0.3, r.onGround ? 0.3 : 0.55)).sub(g).normalize()
        : this.v2.set(0, -1, 0.3).normalize();
      setWorldQuat(grip, this.q.setFromUnitVectors(this.v3.set(0, -1, 0), dir));
    }
  }

  update(r: Rider, dt: number, tuck: boolean, grab = false, seated = false): void {
    this.group.position.set(r.x, r.z, -r.y);
    // ---- orientation: board forward along heading, up along the ground normal (toward world up in the air)
    const n = this.tmpN.set(r.normal[0], r.normal[2], -r.normal[1]);
    if (!r.onGround) n.lerp(this.v1.set(0, 1, 0), 0.7).normalize();
    const f = this.tmpF.set(Math.sin(r.heading), 0, -Math.cos(r.heading));
    f.addScaledVector(n, -f.dot(n)).normalize();
    const right = this.tmpR.crossVectors(f, n).normalize();
    this.rot.makeBasis(right, n, this.v1.copy(f).negate());
    this.q.setFromRotationMatrix(this.rot);
    this.group.quaternion.slerp(this.q, Math.min(1, dt * 12));
    // ---- inclination: lean into the turn until lateral acceleration balances gravity,
    // phi = atan(a_lat / g), capped at 40 degrees. lateralG > 0 = toward the board's right (toe side).
    const phi = r.onGround && !seated ? Math.max(-0.7, Math.min(0.7, Math.atan(r.lateralG * 0.8))) : 0;
    this.leanAngle += (phi - this.leanAngle) * Math.min(1, dt * 8);
    // the board and the rider roll together about the engaged edge (0.13 m off centre) so the edge
    // stays in the snow; angulation comes from the carve poses bending at the waist
    const side = Math.abs(this.leanAngle) > 0.03 ? Math.sign(this.leanAngle) : 0;
    this.lean.position.set(side * 0.13, 0, 0);
    this.lean.rotation.set(0, 0, -this.leanAngle); // positive lateralG tips +Y toward +X
    this.rig.board.position.set(-side * 0.13, 0, 0);

    // ---- pose blend from rider state
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
    // ---- physical layer on top of the poses
    const free = !seated && r.crashed <= 0;
    if (free) {
      const g = Math.min(1, Math.abs(r.lateralG));
      if (r.onGround) t.hipsY -= 0.07 * g; // turn load compresses the legs
      // arms out for balance with the turn load and in the air
      // (capped at 80 degrees so a carve's leading arm stays below the shoulder)
      const bal = 0.2 * g + (r.onGround ? 0 : 0.15), cap = 80 * d2r;
      t.lShoulder = [t.lShoulder[0], t.lShoulder[1], Math.max(Math.min(t.lShoulder[2], -cap), t.lShoulder[2] - bal)];
      t.rShoulder = [t.rShoulder[0], t.rShoulder[1], Math.min(Math.max(t.rShoulder[2], cap), t.rShoulder[2] + bal)];
      // the upper body turns toward the direction of travel when the board slips sideways
      let slip = 0;
      if (r.onGround && r.speed > 2) {
        slip = Math.atan2(r.vx, r.vy) - r.heading;
        slip = Math.atan2(Math.sin(slip), Math.cos(slip));
        if (Math.abs(slip) > Math.PI / 2) slip = 0; // backwards: no twist
      }
      this.twist += (Math.max(-0.5, Math.min(0.5, -slip * 0.6)) - this.twist) * Math.min(1, dt * 6);
    } else this.twist *= Math.max(0, 1 - dt * 6);
    t.torso = [t.torso[0], t.torso[1] + this.twist, t.torso[2]];
    if (this.fp) {
      // first person: arms closer to the sides so the front arm is not held level across the view
      t.lShoulder = [t.lShoulder[0], t.lShoulder[1], t.lShoulder[2] * 0.35];
      t.rShoulder = [t.rShoulder[0], t.rShoulder[1], t.rShoulder[2] * 0.35];
    }
    lerpPose(this.pose, this.pose, t, Math.min(1, dt * (r.crashed > 0 ? 6 : 10)));
    // idle breathing and balance wobble so a standing rider is not frozen
    const now = performance.now() / 1000;
    const p = this.pose;
    const hy = p.hipsY, tx = p.torso[0];
    p.hipsY += Math.sin(now * 2.1) * 0.004; p.torso[0] += Math.sin(now * 1.3) * 0.015;
    this.applyFK(p, -side * 0.13);
    p.hipsY = hy; p.torso[0] = tx;

    // ---- legs: boots pinned to the bindings, or on a chair the board hangs from the feet
    const rig = this.rig;
    this.group.updateMatrixWorld(true);
    if (seated) {
      hangCarriersFromFeet(rig);
      this.wasSeated = true;
      this.footGap = 0;
    } else {
      if (this.wasSeated) { restCarriers(rig); this.wasSeated = false; }
      // knees point where the pelvis faces (the toe edge for a snowboarder, the tips for a skier);
      // a snowboarder's knees also bow a little toward each other
      const fwd = this.v1.set(0, 0, -1).applyQuaternion(rig.bones.Hips.getWorldQuaternion(this.pq));
      const nose = this.v2.set(0, 0, -1).applyQuaternion(this.lean.getWorldQuaternion(this.pq));
      const k = this.discipline === 'board' ? 0.25 : 0;
      const lp = this.v3.copy(fwd).addScaledVector(nose, -k);
      const rp = this.v4.copy(fwd).addScaledVector(nose, k);
      this.footGap = pinFeet(rig, lp, rp);
    }
    if (this.discipline === 'ski') this.skiHands(r, tuck, free);

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
