import * as THREE from 'three';
import type { Rider } from '../sim/Rider';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';
import { Ragdoll, RAGDOLL_RECOVER } from './Ragdoll';
import { clonePose, defaultMaterials, POSES, SKI_POSES, type Pose, type RiderMaterials } from './RiderModel';
import { buildRig, hangCarriersFromFeet, bendBoard, BONES as BONE_LIST, type RiderRig } from './RiderRig';
import { Gait, type Plant } from './Gait';
import { Spray } from './Spray';
import { LENSES, type LensId } from './Lens';
import { addSnowCover, snowCoverUniforms, type BuryShape } from './SnowCover';
import { BOARD_LAG, LEAD_HIPS, LEAD_UPPER } from './riderView/tuning';
import { wrap, follow, type Follow } from './riderView/math';
import { incline, blendPose, bodyLayer } from './riderView/BodyPose';
import { settleBody } from './riderView/Limbs';
import { boardPose } from './riderView/BoardFlex';
import { setDown, updateSpray } from './riderView/Effects';
import { leaveFoot, updateFoot } from './riderView/FootPose';
export { LEAD_UPPER, LEAD_HIPS, BOARD_LAG } from './riderView/tuning';

/**
 * Skeletal rider (RiderRig.ts) posed from the sim state. Pose tables (neutral, toe/heel carve,
 * tuck, crouch, air, grab, landing, crash, seated) blend by weight and drive the pelvis, spine,
 * head and arms; a physical layer adds g-load compression, balance arms and a spine twist toward
 * the direction of travel; then two-bone IK pins both boots to the bindings every frame so the
 * board and body cannot separate. Skiers also place their hands by IK and aim the poles.
 */

/** Layer the body is also drawn on, so first person can redraw it with a close near plane. */
export const BODY_LAYER = 1;

/**
 * The API: `group`, `mats`, `spray`, `snowCover`, `powderHold`, `discipline`, the BUG-056 tunables
 * (`leadUpper`, `leadHips`, `boardLag`), `footGap`, `onPlant`, `lensId`, the state getters for checks
 * (`leadState`, `buryState`, `gaitState`) and the methods. The other fields are the pose state the
 * world/riderView/ modules share between frames (FEAT-165): internal, public only because TypeScript
 * has no module-private members.
 */
export class RiderView {
  readonly group = new THREE.Group();
  fp = false;
  readonly mats: RiderMaterials;
  rig: RiderRig;
  /** roll pivot at the board's engaged edge; the board and the body are both children */
  readonly lean = new THREE.Group();
  poses: Record<string, Pose> = POSES;
  discipline: 'board' | 'ski' = 'board';
  /** FEAT-139: the rig is built goofy (follows the rider's `goofy`, rebuilt when it changes) */
  private goofy = false;
  /** FEAT-139: -1 while the board and body are drawn turned round, at the physics yaw + PI (riding
   *  switch, or goofy, not both). The rig's right (toe) side and nose are then the heading's left and
   *  tail, so every sideways and fore-aft physics value is negated into the rig's frame. */
  fl = 1;
  /** BUG-056 tunables (s): how far ahead the head and shoulders and the hips pose, how far behind the board is drawn */
  leadUpper = LEAD_UPPER; leadHips = LEAD_HIPS; boardLag = BOARD_LAG;
  /** FEAT-127 / BUG-056: the board's roll onto its edge as drawn (rad, + = toe / right edge) and its
   *  yaw, each a critically damped follow of the physics value; the roll it follows; whether the
   *  rider was on the snow last frame (a landing snaps the follow); the shoulders' turn ahead of the
   *  drawn board (rad); and the predicted edges the upper body and the hips posed for (share of full) */
  readonly rollF: Follow = { x: 0, v: 0 };
  readonly yawF: Follow = { x: 0, v: 0 };
  rollPhys = 0; private prevGround = true; visLive = false;
  readonly leanF: Follow = { x: 0, v: 0 };
  readonly yawLeadF: Follow = { x: 0, v: 0 };
  readonly edgeUpperF: Follow = { x: 0, v: 0 };
  readonly edgeHipsF: Follow = { x: 0, v: 0 };
  readonly hipZF: Follow = { x: 0, v: 0 };
  /** FEAT-140: the press balance in the rig's frame, followed at body speed, for the hips' slide */
  readonly balF: Follow = { x: 0, v: 0 };
  /** FEAT-140: the board's tip up on its loaded end (rad), followed */
  readonly tipF: Follow = { x: 0, v: 0 };
  get leanAngle(): number { return this.leanF.x; }
  get yawLead(): number { return this.yawLeadF.x; }
  get edgeUpper(): number { return this.edgeUpperF.x; }
  get edgeHips(): number { return this.edgeHipsF.x; }
  /** FEAT-118: board bend (0 flat .. 1 full load), its rate, and which end is loaded (-1 tail, +1 nose) */
  flex = 0; flexV = 0; flexDir = -1;
  twist = 0;
  /** FEAT-125: the press's pelvis roll (smoothed, rad), seconds the press has been held, the arm
   *  correction spring and its rate, wobble amplitude, a bump measure, the pop upswing (1 at takeoff
   *  down to 0), how loaded the board was on the last ground frame, and a clock for the wobble */
  pressRoll = 0; holdT = 0; corr = 0; corrV = 0; flailAmp = 0;
  bump = 0; prevVz = 0; prevLean = 0; popT = 0; load = 0; wasGround = true; clock = 0;
  readonly headQ = new THREE.Quaternion();
  /** the smoothed pose's arm angles, kept while the balance layer is drawn on top of them */
  readonly armKeep = new Float64Array(6);
  wasSeated = false;
  /** worst ankle-to-binding distance after the last solve (m); 0 means the boots are on the bindings */
  footGap = 0;
  readonly pose: Pose = clonePose(POSES.neutral);
  readonly target: Pose = clonePose(POSES.neutral);
  /** BUG-056: the riding pose built for the hips' shorter lead; its pelvis fields go into `target` */
  readonly hipsTarget: Pose = clonePose(POSES.neutral);
  /** FEAT-044: GPU powder spray (wisps on groomers, hanging clouds in powder, a burst on landing) */
  readonly spray = new Spray();
  readonly tmpN = new THREE.Vector3();
  readonly tmpF = new THREE.Vector3();
  readonly tmpR = new THREE.Vector3();
  readonly rot = new THREE.Matrix4();
  readonly q = new THREE.Quaternion();
  readonly q2 = new THREE.Quaternion();
  /** FEAT-110: the board orientation before the flip is applied, and the flip itself */
  readonly baseQ = new THREE.Quaternion();
  private readonly airFlipQ = new THREE.Quaternion();
  private readonly flipAxis = new THREE.Vector3(1, 0, 0);
  readonly pivot = new THREE.Vector3();
  readonly pq = new THREE.Quaternion();
  readonly v1 = new THREE.Vector3();
  readonly v2 = new THREE.Vector3();
  readonly v3 = new THREE.Vector3();
  readonly v4 = new THREE.Vector3();
  // ---- on foot (FEAT-067)
  pack: Pack | null = null;
  /** FEAT-046: crash tumble, and the blend back to the animated pose after it (s left) */
  private ragdoll: Ragdoll | null = null;
  recoverT = 0;
  readonly recoverQ = BONE_LIST.map(() => new THREE.Quaternion());
  readonly recoverHips = new THREE.Vector3();
  gait: Gait | null = null;
  /** foot mode was drawn last frame (the board is off the bindings or the gear is carried) */
  footActive = false;
  gaitLive = false;
  prevStep = [0, 0];
  /** 0..1 blend into the all-fours scramble (FEAT-068) */
  crawl = 0;
  /** FEAT-082: board carried on the shoulder (0 at the side .. 1 on the shoulder), eased in while sprinting */
  shoulder = 0;
  /** 0..1 blend into a slip: sitting back as the boots skid */
  slip = 0;
  /** each foot plant on the snow (step-offs and the walk cycle): bootprints and footsteps */
  onPlant: ((p: Plant) => void) | null = null;
  readonly fq = [new THREE.Quaternion(), new THREE.Quaternion()];
  readonly fa = [new THREE.Vector3(), new THREE.Vector3()];
  readonly aq = [new THREE.Quaternion(), new THREE.Quaternion()];
  readonly aa = [new THREE.Vector3(), new THREE.Vector3()];
  readonly m1 = new THREE.Matrix4();
  readonly m2 = new THREE.Matrix4();
  /** FEAT-126: world to the riding frame (the snow plane is y = 0) */
  readonly invG = new THREE.Matrix4();
  /** BUG-066: the board's inverse world matrix and scratch points for the deck clearance (the leg pass keeps v1 to v4) */
  readonly invB = new THREE.Matrix4();
  readonly dA = new THREE.Vector3(); readonly dK = new THREE.Vector3(); readonly dH = new THREE.Vector3();
  readonly cq = new THREE.Quaternion();
  readonly cp = new THREE.Vector3();
  readonly armSave = [new THREE.Quaternion(), new THREE.Quaternion()];
  readonly restQ = new THREE.Quaternion();
  readonly flipQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly xAxis = new THREE.Vector3(1, 0, 0);
  /** FEAT-152: how far the board is drawn down into deep powder (m, along the snow normal) and its
   *  nose-up pitch (rad), both eased; the snow cover's surface and strength for this rider's materials;
   *  the untouched snow surface under the board (three.js) the spray leaves from */
  bury = 0;
  readonly shape: BuryShape = { sink: 0, pitch: 0, tail: 0, nose: 0 }; buryPitch = 0; footCover = 0;
  readonly snowCover = snowCoverUniforms();
  readonly surf = new THREE.Vector3();
  /** FEAT-152: the sag held ahead of the buried board (`Deform.setDeformHold`): centre and travel
   *  direction (three.js x, z) and strength 0..1. Only the player's view passes it on (main.ts). */
  readonly powderHold = { x: 0, z: 0, fx: 0, fz: -1, k: 0 };

  /** FEAT-152: how deep the board is drawn into the snow (m), for checks */
  get buryState(): { sink: number; pitch: number; cover: number } {
    return { sink: this.bury, pitch: this.buryPitch, cover: this.snowCover.uSnowCoverK.value };
  }

  /** Terrain for foot placement (on foot). */
  setPack(pack: Pack, collider: Collider | null = null): void {
    this.pack = pack;
    this.ragdoll = new Ragdoll(pack, collider);
    this.gait = new Gait((x, y) => pack.groundHeight(x, y));
    this.gait.onPlant = (p) => this.onPlant?.(p);
  }

  /** Gait phase and smoothed speed, for checks. */
  get gaitState(): { phase: number; speed: number; feet: { x: number; y: number; z: number; planted: boolean }[] } | null {
    const g = this.gait;
    return g ? { phase: g.phase, speed: g.speed, feet: g.feet.map((f) => ({ x: f.x, y: f.y, z: f.z, planted: f.planted })) } : null;
  }

  /** BUG-056: the lead / lag chain this frame, for checks (rad): the board as drawn and the physics
   *  roll it follows, the body's inclination, the shoulders' turn ahead, and the edges the upper body
   *  and the hips posed for (share of full) */
  get leadState(): { boardRoll: number; physRoll: number; lean: number; yawLead: number; edgeUpper: number; edgeHips: number } {
    return { boardRoll: this.rollF.x, physRoll: this.rollPhys, lean: this.leanAngle, yawLead: this.yawLead, edgeUpper: this.edgeUpper, edgeHips: this.edgeHips };
  }

  constructor() {
    this.mats = defaultMaterials();
    for (const m of Object.values(this.mats)) addSnowCover(m, this.snowCover); // FEAT-152
    this.group.name = 'rider'; this.lean.name = 'rider lean';
    this.group.add(this.lean);
    this.rig = this.mount('board');
  }

  get sprayObject(): THREE.Points {
    return this.spray.points;
  }

  private mount(d: 'board' | 'ski'): RiderRig {
    const rig = buildRig(this.mats, d, d === 'board' && this.goofy);
    this.lean.add(rig.board, rig.body);
    for (const o of [rig.body, rig.board]) o.traverse((m) => m.layers.enable(BODY_LAYER));
    return rig;
  }

  /** Swap between snowboard and skis (rebuilds the rig with the same materials). */
  setDiscipline(d: 'board' | 'ski'): void {
    if (d === this.discipline) return;
    this.discipline = d;
    this.rebuild();
  }

  /** FEAT-139: regular or goofy stance (rebuilds the board with its nose and bindings turned round). */
  setStance(goofy: boolean): void {
    if (goofy === this.goofy) return;
    this.goofy = goofy;
    if (this.discipline === 'board') this.rebuild();
  }

  private rebuild(): void {
    const d = this.discipline;
    this.lean.remove(this.rig.board, this.rig.body);
    for (const o of [this.rig.body, this.rig.board]) o.traverse((m) => { if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).geometry.dispose(); });
    this.rig = this.mount(d);
    this.poses = d === 'ski' ? SKI_POSES : POSES;
    Object.assign(this.pose, clonePose(this.poses.neutral));
    this.flex = 0; this.flexV = 0;
    this.visLive = false; // BUG-056: the follows snap on the next frame
    this.wasSeated = false;
    this.footActive = false; this.gaitLive = false;
    this.setFirstPerson(this.fp);
  }

  /** Apply outfit colours (hex strings) to the material slots. */
  setOutfit(o: { jacket: string; pants: string; helmet: string; board: string; gloves: string }): void {
    this.mats.jacket.color.set(o.jacket); this.mats.pants.color.set(o.pants); this.mats.helmet.color.set(o.helmet);
    this.mats.board.color.set(o.board); this.mats.gloves.color.set(o.gloves);
  }

  /** FEAT-130: the goggle lens the rider wears (matches the first-person lens) */
  lensId: LensId = 'off';
  setLens(id: LensId): void {
    this.lensId = id;
    const L = LENSES[id], g = this.mats.goggles;
    g.color.set(L.swatch);
    // mirrors shine; plain tints show their colour; Off keeps the classic orange mirror
    g.metalness = id === 'off' ? 0.4 : id === 'clear' ? 0.1 : L.mirror ? 0.6 : 0.3;
    g.roughness = id === 'off' ? 0.2 : L.mirror ? 0.12 : 0.18;
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

  /** World position of a bone (three.js frame) after the last update. */
  boneWorld(name: 'Hips' | 'Spine' | 'Spine1' | 'Spine2' | 'Head', out: THREE.Vector3): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return this.rig.bones[name].getWorldPosition(out);
  }

  /**
   * Outrun eat sequence (FEAT-100): show only the top half (the legs collapse into the hips and
   * the board hides), only the legs (the torso, arms and head collapse into the hips), or all of
   * it again. No mesh cutting: the bones at the seam are scaled to nothing.
   */
  splitPart(part: 'top' | 'legs' | 'whole'): void {
    const B = this.rig.bones, tiny = 0.001;
    const legs = part === 'top' ? tiny : 1, torso = part === 'legs' ? tiny : 1;
    B.LeftUpLeg.scale.setScalar(legs); B.RightUpLeg.scale.setScalar(legs);
    B.Spine.scale.setScalar(torso);
    this.rig.board.visible = part !== 'top';
    for (const m of [...this.rig.headParts, ...this.rig.coreParts]) m.visible = part !== 'legs' && !this.fp;
  }

  /** World position of the eyes (three.js frame), from the posed head, for the first-person camera. */
  eye(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return out.set(0, 0.1, -0.02).applyMatrix4(this.rig.bones.Head.matrixWorld);
  }

  update(r: Rider, dt: number, tuck: boolean, grab = false, seated = false): void {
    this.setStance(!!r.goofy); // FEAT-139: the ghost and a replay carry their own stance
    // FEAT-139: riding switch or goofy (not both) the rig is drawn turned round; seated and on foot never
    const fl = this.fl = this.discipline === 'board' && !seated && !!r.switch !== !!r.goofy ? -1 : 1;
    // on foot, or stepping on or off the board
    const u = seated ? 0 : r.footU;
    if (u > 0 && this.pack && this.gait) {
      if (this.flex !== 0) { this.flex = 0; this.flexV = 0; bendBoard(this.rig, 0, this.flexDir); } // FEAT-118: flat when carried
      updateFoot(this, r, dt, u);
      updateSpray(this, r, dt, this.tmpF, this.tmpR, false);
      return;
    }
    if (this.footActive) leaveFoot(this);
    this.group.position.set(r.x, r.z, -r.y);
    // ---- orientation: board forward along its yaw (the heading, swung across the travel direction
    // while braking), up along the ground normal (toward world up in the air)
    const yaw = seated ? r.heading : r.boardYaw + (fl < 0 ? Math.PI : 0);
    // BUG-056: the board as drawn follows the physics yaw boardLag behind, so the body (posed ahead,
    // below) visibly turns first. Landings, crashes, the chair and a jump in state (a reset or a
    // teleport) snap it: the board meets the snow when it meets it.
    const snap = !this.visLive || seated || r.crashed > 0 || (r.onGround && !this.prevGround) || Math.abs(wrap(yaw - this.yawF.x)) > 1;
    this.prevGround = r.onGround; this.visLive = true;
    if (snap) { this.yawF.x = yaw; this.yawF.v = 0; } else follow(this.yawF, this.yawF.x + wrap(yaw - this.yawF.x), this.boardLag, dt);
    const visYaw = this.yawF.x;
    const n = this.tmpN.set(r.normal[0], r.normal[2], -r.normal[1]);
    if (!r.onGround) n.lerp(this.v1.set(0, 1, 0), 0.7).normalize();
    const f = this.tmpF.set(Math.sin(visYaw), 0, -Math.cos(visYaw));
    f.addScaledVector(n, -f.dot(n)).normalize();
    const right = this.tmpR.crossVectors(f, n).normalize();
    this.rot.makeBasis(right, n, this.v1.copy(f).negate());
    this.q.setFromRotationMatrix(this.rot);
    this.baseQ.slerp(this.q, Math.min(1, dt * 30)); // only smooths the ground normal now; the yaw lag is the follow above
    this.group.quaternion.copy(this.baseQ);
    setDown(this, r, dt, seated, fl, n, f);
    // FEAT-110: the flip pitches the rider and board about the board's own side axis, through a point
    // 0.7 m up (about the hips); a front flip (+) puts the nose down
    if (!r.onGround && r.flip !== 0) {
      this.airFlipQ.setFromAxisAngle(this.flipAxis, -r.flip * fl); // the physics flip is about the heading's side axis
      this.group.quaternion.multiply(this.airFlipQ);
      this.pivot.set(0, 0.7, 0).applyQuaternion(this.baseQ);
      this.group.position.add(this.pivot).sub(this.v1.set(0, 0.7, 0).applyQuaternion(this.group.quaternion));
    }
    const live = incline(this, r, dt, seated, fl);
    const pv = boardPose(this, r, dt, seated, fl, snap, live);

    // ---- FEAT-046: a crash is a ragdoll tumble; the body is pulled toward the sim's slide so it
    // gets up where the rider is, then blends back to the animated pose over RAGDOLL_RECOVER
    if (this.ragdoll && r.crashed > 0 && !seated) {
      if (!this.ragdoll.active) { this.group.updateMatrixWorld(true); this.ragdoll.start(this.rig, this.v1.set(r.vx, r.vz, -r.vy), r.crashFall ? this.v2.set(Math.sin(r.heading) * r.crashFall, 0, -Math.cos(r.heading) * r.crashFall) : r.crashSide ? this.v2.set(Math.cos(r.heading) * r.crashSide, 0, Math.sin(r.heading) * r.crashSide) : null); } // FEAT-140: a press slam falls over its loaded end; FEAT-148: a washout to the inside of the turn
      this.group.updateMatrixWorld(true);
      this.ragdoll.step(dt, this.v2.set(r.x, r.z, -r.y), r.crashMu); // FEAT-288: the sim's snow friction
      this.ragdoll.apply(this.rig);
      hangCarriersFromFeet(this.rig); // the board stays strapped to the feet
      this.wasSeated = true; // so the carriers go back on the next normal frame
      updateSpray(this, r, dt, f, right, false);
      return;
    }
    if (this.ragdoll?.active) {
      this.ragdoll.stop();
      BONE_LIST.forEach((b, i) => this.recoverQ[i].copy(this.rig.bones[b].quaternion));
      this.recoverHips.copy(this.rig.bones.Hips.position);
      this.recoverT = RAGDOLL_RECOVER;
    }

    // ---- pose blend from rider state (riderView/BodyPose.ts), the physical layer on top, then the limbs (riderView/Limbs.ts)
    const pressRoll = blendPose(this, r, dt, tuck, grab, seated, fl);
    const free = !seated && r.crashed <= 0;
    bodyLayer(this, r, dt, free, yaw, pressRoll);
    settleBody(this, r, dt, tuck, seated, free, fl, pv);
    updateSpray(this, r, dt, f, right, true);
  }
}
