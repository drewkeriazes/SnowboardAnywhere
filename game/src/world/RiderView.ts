import * as THREE from 'three';
import type { Rider } from '../sim/Rider';
import type { Pack } from '../pack/Pack';
import { lerpPose, clonePose, defaultMaterials, POSES, SKI_POSES, WALK_POSES, type Pose, type RiderMaterials } from './RiderModel';
import { buildRig, pinFeet, solveLegs, twoBone, setWorldQuat, hangCarriersFromFeet, restCarriers, ANKLE_H, SOLE_FWD, type RiderRig } from './RiderRig';
import { Gait, type Plant } from './Gait';

const d2r = Math.PI / 180;
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * How the gear is carried on foot, in the chest (Spine2) frame: x right, y up, z back.
 * Snowboard: at the rider's right side (not across the front), diagonal with the nose forward and
 * up at about 45 degrees, base against the body and bindings facing out; the right hand holds the
 * upper edge by the front binding with the arm nearly straight, the left arm swings free. Skis:
 * together, bases touching, on the right shoulder with the tips forward and a little down, the
 * right hand holding them in front.
 */
function carryBasis(nose: THREE.Vector3, deckOut: THREE.Vector3): THREE.Quaternion {
  // board local: -Z nose, +Y deck (bindings side)
  const z = nose.clone().normalize().negate();
  const y = deckOut.clone().addScaledVector(z, -deckOut.dot(z)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
const CARRY = {
  board: {
    q: carryBasis(new THREE.Vector3(0, 1, -1), new THREE.Vector3(1, 0, 0)),
    // beside the right leg, clear of the thigh; the tail stays about 20 cm off the snow
    pos: new THREE.Vector3(0.3, -0.55, -0.05),
    lGrip: null as THREE.Vector3 | null,
    /** grip in board-local coords: the upper edge (-X) by the front binding */
    rGrip: new THREE.Vector3(-0.135, 0.01, -0.28),
    /** scrambling: flatter (nose forward) and higher, so the tail stays off the slope */
    crawlQ: carryBasis(new THREE.Vector3(0, 0.35, -1), new THREE.Vector3(1, 0, 0)) as THREE.Quaternion | null,
    crawlLift: 0.3,
  },
  ski: {
    // tips forward and down; the ski width runs vertical (edge on the shoulder), the bases face sideways
    q: (() => {
      const z = new THREE.Vector3(0, 0.3, 1).normalize(); // local +Z (tails) back and up
      const y = new THREE.Vector3(1, 0, 0);
      const x = new THREE.Vector3().crossVectors(y, z);
      return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    })(),
    pos: new THREE.Vector3(0.2, 0.22, 0), // balance point (lower edge under the bindings) on top of the shoulder
    balance: new THREE.Vector3(0.05, 0, 0.05),
    lGrip: null as THREE.Vector3 | null,
    rGrip: new THREE.Vector3(0.04, 0, -0.38),
    crawlQ: null as THREE.Quaternion | null,
    crawlLift: 0,
  },
};

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
  // ---- on foot (FEAT-067)
  private pack: Pack | null = null;
  private gait: Gait | null = null;
  /** foot mode was drawn last frame (the board is off the bindings or the gear is carried) */
  private footActive = false;
  private gaitLive = false;
  private prevStep = [0, 0];
  /** 0..1 blend into the all-fours scramble (FEAT-068) */
  private crawl = 0;
  /** each foot plant on the snow (step-offs and the walk cycle): bootprints and footsteps */
  onPlant: ((p: Plant) => void) | null = null;
  private readonly fq = [new THREE.Quaternion(), new THREE.Quaternion()];
  private readonly fa = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly aq = [new THREE.Quaternion(), new THREE.Quaternion()];
  private readonly aa = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly m1 = new THREE.Matrix4();
  private readonly m2 = new THREE.Matrix4();
  private readonly cq = new THREE.Quaternion();
  private readonly cp = new THREE.Vector3();
  private readonly armSave = [new THREE.Quaternion(), new THREE.Quaternion()];
  private readonly restQ = new THREE.Quaternion();
  private readonly flipQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  private readonly up = new THREE.Vector3(0, 1, 0);

  /** Terrain for foot placement (on foot). */
  setPack(pack: Pack): void {
    this.pack = pack;
    this.gait = new Gait((x, y) => pack.groundHeight(x, y));
    this.gait.onPlant = (p) => this.onPlant?.(p);
  }

  /** Gait phase and smoothed speed, for checks. */
  get gaitState(): { phase: number; speed: number; feet: { x: number; y: number; z: number; planted: boolean }[] } | null {
    const g = this.gait;
    return g ? { phase: g.phase, speed: g.speed, feet: g.feet.map((f) => ({ x: f.x, y: f.y, z: f.z, planted: f.planted })) } : null;
  }

  constructor() {
    this.mats = defaultMaterials();
    this.group.add(this.lean);
    this.rig = this.mount('board');

    const n = 1200;
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
    this.footActive = false; this.gaitLive = false;
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
    // on foot, or stepping on or off the board
    const u = seated ? 0 : r.footU;
    if (u > 0 && this.pack && this.gait) {
      this.updateFoot(r, dt, u);
      this.updateSpray(r, dt, this.tmpF, this.tmpR, false);
      return;
    }
    if (this.footActive) this.leaveFoot();
    this.group.position.set(r.x, r.z, -r.y);
    // ---- orientation: board forward along its yaw (the heading, swung across the travel direction
    // while braking), up along the ground normal (toward world up in the air)
    const yaw = seated ? r.heading : r.boardYaw;
    const n = this.tmpN.set(r.normal[0], r.normal[2], -r.normal[1]);
    if (!r.onGround) n.lerp(this.v1.set(0, 1, 0), 0.7).normalize();
    const f = this.tmpF.set(Math.sin(yaw), 0, -Math.cos(yaw));
    f.addScaledVector(n, -f.dot(n)).normalize();
    const right = this.tmpR.crossVectors(f, n).normalize();
    this.rot.makeBasis(right, n, this.v1.copy(f).negate());
    this.q.setFromRotationMatrix(this.rot);
    this.group.quaternion.slerp(this.q, Math.min(1, dt * 12));
    // ---- inclination: lean into the turn until lateral acceleration balances gravity,
    // phi = atan(a_lat / g), capped at 40 degrees. lateralG > 0 = toward the board's right (toe side).
    // Braking, the board lies across the travel direction, so the braking deceleration is lateral
    // to it: the rider leans back into the hill onto the trailing edge (heelside -, toeside +).
    const brakeG = r.brakeSide * r.brakeAcc / 9.81;
    const latG = r.lateralG * (1 - r.brakeAmt) + brakeG;
    const phi = r.onGround && !seated ? Math.max(-0.7, Math.min(0.7, Math.atan(latG * 0.8))) : 0;
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
      // braking stance: sitting back on the heel edge or kneeling into the toe edge
      const b = r.brakeSide !== 0 ? r.brakeAmt : 0;
      const edge = Math.max(-1, Math.min(1, r.edgeAngle * (1 - b) + r.brakeSide * b));
      if (edge > 0) lerpPose(t, t, P.carveToe, Math.min(1, edge * 1.2)); else if (edge < 0) lerpPose(t, t, P.carveHeel, Math.min(1, -edge * 1.2));
      if (tuck) lerpPose(t, t, P.tuck, 0.85);
      if (r.jumpCharge > 0) lerpPose(t, t, P.crouch, Math.min(1, r.jumpCharge));
      if (r.landingShock > 0) lerpPose(t, t, P.land, Math.min(1, r.landingShock * 1.5));
      // knees bent and hips low in proportion to how hard the edge is biting
      const bite = b * Math.min(1, r.brakeAcc / 8);
      if (bite > 0) { lerpPose(t, t, P.crouch, 0.45 * bite); t.hipsY -= 0.05 * bite; }
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
      // the upper body keeps facing the direction of travel when the board slips sideways (a
      // skid, or a hockey stop where the board is across and the shoulders stay down the hill)
      let slip = 0;
      if (r.onGround && r.speed > 2) {
        slip = Math.atan2(r.vx, r.vy) - yaw;
        slip = Math.atan2(Math.sin(slip), Math.cos(slip));
        if (Math.abs(slip) > Math.PI / 2) slip = 0; // backwards: no twist
      }
      this.twist += (Math.max(-1.05, Math.min(1.05, -slip * 0.7)) - this.twist) * Math.min(1, dt * 6);
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
    this.updateSpray(r, dt, f, right, true);
  }

  /**
   * Snow spray when skidding, and a sheet of it off the cutting edge when braking: thrown ahead of
   * the board along the travel direction (downhill in a hockey stop), spread along its length.
   * `emitting` false only moves the particles already in the air.
   */
  private updateSpray(r: Rider, dt: number, f: THREE.Vector3, right: THREE.Vector3, emitting: boolean): void {
    const pos = this.sprayPos, vel = this.sprayVel, life = this.sprayLife;
    const emit = emitting && r.onGround ? Math.floor((r.skid * 10 + (r.speed > 8 ? 1 : 0)) * 1.0) : 0;
    const sheet = emitting && r.onGround && r.speed > 1 ? Math.floor(r.scrape * 18) : 0;
    let emitted = 0, sheeted = 0;
    const g = this.group.position;
    const sp = Math.max(1e-3, r.speed), dirX = r.vx / sp, dirZ = -r.vy / sp; // travel direction (three.js)
    for (let i = 0; i < life.length; i++) {
      if (life[i] <= 0) {
        if (sheeted < sheet) {
          sheeted++;
          life[i] = 0.45 + Math.random() * 0.5;
          const along = (Math.random() - 0.5) * 1.5;
          pos[i * 3] = g.x + f.x * along + dirX * 0.2; pos[i * 3 + 1] = g.y + 0.05; pos[i * 3 + 2] = g.z + f.z * along + dirZ * 0.2;
          // the board's own velocity plus a throw: the spray flies on ahead as the rider slows
          const throwV = sp * (0.9 + 0.5 * Math.random()) + 1;
          vel[i * 3] = dirX * throwV + (Math.random() - 0.5) * 1.5;
          vel[i * 3 + 1] = (1.2 + 2.8 * Math.random()) * (0.5 + 0.5 * r.scrape);
          vel[i * 3 + 2] = dirZ * throwV + (Math.random() - 0.5) * 1.5;
        } else if (emitted < emit) {
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

  // ---------------------------------------------------------------- on foot (FEAT-067)

  /** Back on the board: gear to its riding place, poles back in their own hands. */
  private leaveFoot(): void {
    const rig = this.rig;
    rig.board.position.set(0, 0, 0); rig.board.quaternion.identity();
    restCarriers(rig);
    if (rig.rPole && rig.rPole.parent !== rig.bones.RightHand) rig.bones.RightHand.add(rig.rPole);
    if (rig.rPole) rig.rPole.position.set(0, -0.06, 0);
    if (rig.lPole) rig.lPole.position.set(0, -0.06, 0);
    this.footActive = false; this.gaitLive = false;
  }

  /** Sole centre and boot yaw/pitch -> ankle target and foot orientation (three.js world). */
  private footTarget(x: number, y: number, z: number, yaw: number, pitch: number, outA: THREE.Vector3, outQ: THREE.Quaternion): void {
    const n = this.pack!.groundNormal(x, y) as number[];
    const tilt = this.q.setFromUnitVectors(this.up, this.v1.set(n[0], n[2], -n[1]).normalize());
    outQ.setFromAxisAngle(this.up, -yaw).premultiply(tilt).multiply(this.pq.setFromAxisAngle(this.v2.set(1, 0, 0), pitch));
    outA.set(0, ANKLE_H, SOLE_FWD).applyQuaternion(outQ).add(this.v3.set(x, z, -y));
  }

  /** Two-bone arm IK to a grip point (world), blended over the FK arm by `w`. */
  private handTo(side: 'Left' | 'Right', grip: THREE.Vector3, w: number): void {
    if (w <= 0) return;
    const B = this.rig.bones;
    const up = B[`${side}Arm`], lo = B[`${side}ForeArm`], end = B[`${side}Hand`];
    this.armSave[0].copy(up.quaternion); this.armSave[1].copy(lo.quaternion);
    // wrist a few cm short of the grip, toward the shoulder (the mitten closes over the edge)
    const sh = up.getWorldPosition(this.v1);
    const target = this.v2.copy(grip).addScaledVector(this.v3.subVectors(sh, grip).normalize(), 0.07);
    const s = side === 'Left' ? -1 : 1;
    const pole = this.v4.set(s * 0.7, -1, 0.4).applyQuaternion(B.Spine2.getWorldQuaternion(this.pq));
    twoBone(up, lo, end, target, pole);
    if (w < 1) {
      up.quaternion.copy(this.armSave[0].slerp(up.quaternion, w));
      lo.quaternion.copy(this.armSave[1].slerp(lo.quaternion, w));
      up.updateMatrixWorld(true);
    }
  }

  /**
   * Foot mode. `u` runs 0 (strapped in) to 1 (walking, gear carried); the unstrap plays it forward
   * over 0.8 s and the strap-in backward over 1 s: crouch to the bindings (0.08..0.78), front foot
   * steps off (0.38..0.6), back foot (0.5..0.72), the body turns to face forward (0.38..0.75), the
   * hands take the gear (0.55..0.75) and lift it to the carry (0.72..1). At 1 the walk cycle runs.
   */
  private updateFoot(r: Rider, dt: number, u: number): void {
    const rig = this.rig, B = rig.bones, gait = this.gait!, pack = this.pack!;
    const ski = this.discipline === 'ski';
    if (!this.footActive) { this.footActive = true; this.gaitLive = false; this.prevStep[0] = this.prevStep[1] = u >= 1 ? 1 : 0; }
    this.group.position.set(r.x, r.z, -r.y);
    // stands upright when walking; on the board's slope frame until the gear leaves the snow
    const lift = smooth(0.72, 1, u);
    const n = this.tmpN.set(r.normal[0], r.normal[2], -r.normal[1]).lerp(this.up, lift).normalize();
    const f = this.tmpF.set(Math.sin(r.heading), 0, -Math.cos(r.heading));
    f.addScaledVector(n, -f.dot(n)).normalize();
    const right = this.tmpR.crossVectors(f, n).normalize();
    this.rot.makeBasis(right, n, this.v1.copy(f).negate());
    this.q.setFromRotationMatrix(this.rot);
    this.group.quaternion.slerp(this.q, Math.min(1, dt * 12));
    this.leanAngle = 0; this.twist = 0;
    this.lean.position.set(0, 0, 0); this.lean.rotation.set(0, 0, 0);

    // ---- gait (pack coords): runs once fully on foot; until then the feet's standing spots follow the body
    const nz = Math.max(0.2, r.normal[2]);
    const hx = Math.sin(r.heading), hy = Math.cos(r.heading);
    const grade = -(r.normal[0] * hx + r.normal[1] * hy) / nz;
    const fall = Math.hypot(r.normal[0], r.normal[1]);
    // slipping or kicking up steep snow smears the print downhill
    const smearAmt = fall > 0.02 ? 0.12 * smooth(25, 40, r.slopeDeg) + 0.15 * Math.min(1, r.slideSpeed / 2) : 0;
    const gin = { x: r.x, y: r.y, z: r.z, heading: r.heading, vx: r.vx, vy: r.vy, onGround: r.onGround, sink: r.sink,
      smearX: fall > 0.02 ? (r.normal[0] / fall) * smearAmt : 0, smearY: fall > 0.02 ? (r.normal[1] / fall) * smearAmt : 0 };
    if (u >= 1) {
      if (!this.gaitLive) { gait.reset(gin); this.gaitLive = true; }
      gait.update(dt, gin);
    } else { gait.reset(gin); this.gaitLive = false; }

    // ---- pose: board stance (or ski stance) -> walk/sprint, with a crouch bump to reach the bindings
    const t = this.target;
    const stand = smooth(0.38, 0.75, u);
    const sprint = smooth(1.6, 3.4, gait.speed);
    Object.assign(t, clonePose(this.poses.neutral));
    this.crawl += ((r.crawling ? 1 : 0) - this.crawl) * Math.min(1, dt * 5);
    const walk = lerpPose(clonePose(WALK_POSES.walk), WALK_POSES.walk, WALK_POSES.sprint, sprint);
    if (this.crawl > 0.001) lerpPose(walk, walk, WALK_POSES.crawl, this.crawl);
    lerpPose(t, t, walk, stand);
    const crouch = u > 0.08 && u < 0.78 ? Math.sin(Math.PI * (u - 0.08) / 0.7) : 0;
    t.hipsY -= 0.3 * crouch + 0.6 * r.sink * stand;
    t.hipsRot = [t.hipsRot[0] + 0.35 * crouch, t.hipsRot[1], t.hipsRot[2]];
    t.torso = [t.torso[0] + 0.5 * crouch + 0.4 * Math.max(0, Math.min(0.8, grade)) * stand * Math.min(1, gait.speed), t.torso[1], t.torso[2]];
    t.lShoulder = [t.lShoulder[0] + 0.9 * crouch, t.lShoulder[1], t.lShoulder[2] * (1 - crouch * 0.7)];
    t.rShoulder = [t.rShoulder[0] + 0.9 * crouch, t.rShoulder[1], t.rShoulder[2] * (1 - crouch * 0.7)];
    lerpPose(this.pose, this.pose, t, Math.min(1, dt * 12));
    // the walk cycle on top (not smoothed): hips bob, pelvis and shoulders counter-rotate, free arm swings
    const p = this.pose, save = clonePose(p);
    const a = smooth(0.85, 1, u) * Math.min(1, gait.speed / 1.2);
    const ph = gait.phase * Math.PI * 2;
    p.hipsY += -(0.018 + 0.012 * Math.min(4, gait.speed)) * Math.cos(2 * ph) * a + Math.sin(performance.now() / 1000 * 2.1) * 0.004;
    p.hipsRot = [p.hipsRot[0], p.hipsRot[1] - 0.1 * Math.cos(ph) * a, p.hipsRot[2] + 0.04 * Math.sin(ph) * a];
    p.torso = [p.torso[0], p.torso[1] + 0.12 * Math.cos(ph) * a, p.torso[2]];
    const swing = (0.3 + 0.5 * sprint) * a;
    p.lShoulder = [p.lShoulder[0] - swing * Math.cos(ph), p.lShoulder[1], p.lShoulder[2]];
    p.rShoulder = [p.rShoulder[0] + swing * Math.cos(ph), p.rShoulder[1], p.rShoulder[2]];
    this.applyFK(p, 0);
    Object.assign(p, save);

    // ---- gear on the snow until it is lifted: binding anchors give the feet's start (or end) spots
    const carry = ski ? CARRY.ski : CARRY.board;
    if (lift <= 0) { rig.board.position.set(0, 0, 0); rig.board.quaternion.identity(); restCarriers(rig); }
    this.group.updateMatrixWorld(true);
    const lf = smooth(0.38, 0.6, u), rf = smooth(0.5, 0.72, u);
    if (lf < 1 || rf < 1) {
      rig.anchors.l.getWorldPosition(this.aa[0]); rig.anchors.r.getWorldPosition(this.aa[1]);
      rig.anchors.l.getWorldQuaternion(this.aq[0]); rig.anchors.r.getWorldQuaternion(this.aq[1]);
    }
    for (let i = 0; i < 2; i++) {
      const ft = gait.feet[i];
      this.footTarget(ft.x, ft.y, ft.z, ft.yaw, ft.pitch, this.fa[i], this.fq[i]);
      const k = i === 0 ? lf : rf;
      if (k < 1) {
        // stepping between the binding and the snow beside the board, with a little lift
        this.fa[i].lerpVectors(this.aa[i], this.fa[i], k).addScaledVector(this.up, 0.12 * Math.sin(Math.PI * k));
        this.restQ.copy(this.fq[i]);
        this.fq[i].copy(this.aq[i]).slerp(this.restQ, k);
      }
      // a print where each boot comes down beside the board on the way off
      if (r.strapState === 'off' && this.prevStep[i] < 1 && k >= 1) {
        this.onPlant?.({ side: i as 0 | 1, x: ft.x, y: ft.y, yaw: ft.yaw, speed: 0, kick: 0, smearX: gin.smearX, smearY: gin.smearY });
      }
      this.prevStep[i] = k;
    }
    // knees point along the feet, splayed out a touch
    const fwd = this.v1.set(0, 0, -1).applyQuaternion(this.group.quaternion);
    const lp = this.v3.copy(fwd).addScaledVector(right, -0.15);
    const rp = this.v4.copy(fwd).addScaledVector(right, 0.15);
    this.footGap = solveLegs(rig, this.fa[0], this.fa[1], this.fq[0], this.fq[1], lp, rp, u >= 1 ? 0.25 : Infinity);

    // ---- gear: snow pose (identity under lean) blended to the carry, which rides on the chest
    if (lift > 0) {
      const chest = B.Spine2;
      chest.updateMatrixWorld(true);
      // the carry rides on the chest; bent over in a scramble it keeps the body's upright frame
      // (at the chest) so the gear does not tip into the slope
      const refQ = chest.getWorldQuaternion(this.restQ).slerp(this.group.quaternion, this.crawl);
      this.m2.compose(chest.getWorldPosition(this.v4), refQ, this.v2.set(1, 1, 1));
      // a little swing with the stride
      const sway = this.cq.copy(carry.q);
      if (carry.crawlQ && this.crawl > 0) sway.slerp(carry.crawlQ, this.crawl);
      sway.premultiply(this.q.setFromAxisAngle(this.up, 0.06 * Math.sin(ph) * a));
      this.cp.copy(carry.pos);
      this.cp.y += carry.crawlLift * this.crawl;
      if (ski) this.cp.sub(this.v1.copy(CARRY.ski.balance).applyQuaternion(sway));
      this.m1.compose(this.cp, sway, this.v2.set(1, 1, 1)).premultiply(this.m2);
      this.m2.copy(this.lean.matrixWorld).invert().multiply(this.m1);
      this.m2.decompose(this.v3, this.restQ, this.v4);
      rig.board.position.set(0, 0, 0).lerp(this.v3, lift);
      rig.board.quaternion.identity().slerp(this.restQ, lift);
      if (ski) {
        // skis come together, bases touching
        for (let i = 0; i < rig.carriers.length; i++) {
          const c = rig.carriers[i];
          c.rest.decompose(c.obj.position, c.obj.quaternion, c.obj.scale);
          c.obj.position.lerp(this.v1.set(0, 0, 0), lift);
          if (i === 1) c.obj.quaternion.slerp(this.flipQ, lift);
        }
      }
      rig.board.updateMatrixWorld(true);
    }

    // ---- hands: take hold of the gear (from the snow at 0.55, carried after that)
    const hold = smooth(0.55, 0.75, u);
    if (carry.lGrip) this.handTo('Left', rig.board.localToWorld(this.cp.copy(carry.lGrip)), hold);
    this.handTo('Right', rig.board.localToWorld(this.cp.copy(carry.rGrip)), hold);
    // scrambling: the free (left) hand goes to the snow ahead, lifting in step with the feet
    if (this.crawl > 0.02) {
      const hx = Math.sin(r.heading), hy = Math.cos(r.heading), lx = -Math.cos(r.heading), ly = Math.sin(r.heading);
      const reach = 0.5 + 0.15 * Math.cos(ph);
      const px = r.x + hx * reach + lx * 0.25, py = r.y + hy * reach + ly * 0.25;
      const gz = pack.groundHeight(px, py);
      if (!Number.isNaN(gz)) this.handTo('Left', this.cp.set(px, gz + 0.04 + 0.08 * Math.max(0, Math.sin(ph)), -py), this.crawl * hold);
    }
    // skier: both poles in the free (left) hand, hanging down and back
    if (ski && rig.lPole && rig.rPole) {
      if (hold > 0.5 && rig.rPole.parent !== B.LeftHand) { B.LeftHand.add(rig.rPole); }
      if (rig.rPole.parent === B.LeftHand) { rig.lPole.position.set(-0.012, -0.06, 0); rig.rPole.position.set(0.012, -0.06, 0); }
      for (const [s, grip] of [[-1, rig.lPole], [1, rig.rPole]] as const) {
        const dir = this.v2.set(s * 0.04, -1, 0.35).applyQuaternion(this.group.quaternion).normalize();
        setWorldQuat(grip, this.q.setFromUnitVectors(this.v3.set(0, -1, 0), dir));
      }
    }
  }
}
