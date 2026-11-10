import * as THREE from 'three';
import { EDGE_FULL, PRESS_RANGE, type Rider } from '../sim/Rider';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';
import { Ragdoll, RAGDOLL_RECOVER } from './Ragdoll';
import { lerpPose, clonePose, copyPose, defaultMaterials, POSES, SKI_POSES, WALK_POSES, type Pose, type RiderMaterials } from './RiderModel';
import { buildRig, pinFeet, solveLegs, twoBone, setWorldQuat, hangCarriersFromFeet, restCarriers, bendBoard, deckY, BONES as BONE_LIST, ANKLE_H, SOLE_FWD, type RiderRig } from './RiderRig';
import { Gait, type Plant } from './Gait';
import { carveLean, LEAN_HARD, LEAN_MAX } from './carveLean';
import { Spray } from './Spray';
import { LENSES, type LensId } from './Lens';

/** FEAT-112: half the skis' length (where they pivot) and the most they tip up on a full lean (rad) */
const BOARD_HALF = 0.72, LEAN_TIP = 18 * Math.PI / 180;
/** FEAT-127: the board's roll pivots on its engaged edge, this far off centre (m); each ski on its own edge */
const EDGE_OFF = 0.13, SKI_EDGE_OFF = 0.05, EDGE_PIVOT_ROLL = 0.15;
/** FEAT-118: board flex spring: natural frequency (rad/s, about 0.3 s a cycle) and damping ratio
 *  (0.45 overshoots about 20 %, so a full load snaps past flat to about -0.15 on the pop) */
const FLEX_W = 21, FLEX_ZETA = 0.45;
/** FEAT-140: a held press bends the board this much (share of full flex, the free tip about 22 cm up;
 *  0.6 before), the bend follows the balance by this share at the edge (deeper toward the loaded
 *  end, flatter toward the other), and never past BEND_MAX (the mesh's bounding sphere allows ~1.18) */
const PRESS_BEND = 0.8, BAL_BEND = 0.5, BEND_MAX = 1.15;
/** FEAT-140: deep in a press the whole board also tips up on its loaded tip, like a real tail press
 *  at the extreme (35 deg or more with the bend): the tip at the edge of the balance toward the
 *  loaded end (rad; half of it centred, none toward the other end), its response (s), and how far the
 *  hips move on toward the loaded end at the full tip (m) */
const PRESS_TIP = 32 * Math.PI / 180, TIP_RESPONSE = 0.12, TIP_SHIFT = 0.1;
/** BUG-047: the hip joint stays this far above the deck under it (the glutes hang 0.1 to 0.15 m below
 *  the joint). FEAT-125: on a full press the hips move this far toward the loaded end (m), reached
 *  at this much bend (a full lean without a charge bends the board 0.6) */
const HIP_CLEAR = 0.2, HIP_SHIFT = 0.3, PRESS_FLEX = 0.6;
/** FEAT-125: on a full press the leg over the unloaded end reaches this share of its length (knee
 *  about 20 deg), and the head takes this share of the pelvis roll back out so it stays up */
const PRESS_REACH = 0.975, HEAD_LEVEL = 0.8;
/** FEAT-125 balance arms: wobble amplitude on a press (rad) at first and after holding it FLAIL_RAMP s,
 *  and the correction swing when the lean changes: spring frequency (rad/s), damping, kick per unit lean */
const FLAIL_BASE = 0.04, FLAIL_HOLD = 0.13, FLAIL_RAMP = 2.5, CORR_W = 11, CORR_ZETA = 0.35, CORR_KICK = 5;
/** FEAT-125 wobble growth: share added per m/s of speed (up to FLAIL_VMAX m/s), share added at full
 *  bumps, and the vertical acceleration counted as full bumps (m/s^2, about 1.5 g) */
const FLAIL_SPEED = 0.04, FLAIL_VMAX = 15, FLAIL_BUMP = 1.5, BUMP_ACC = 15;
/** FEAT-140: the wobble added as the press balance runs out to either end (share at the end), the
 *  extra pelvis roll toward the end it runs to (rad per unit of balance, about 23 deg; the head takes
 *  most of it back out), and how far the hips slide along the board toward that end (m per unit).
 *  The balance runs to PRESS_RANGE units, so at the edge the body leans PRESS_RANGE times as far. */
const FLAIL_BAL = 1.6, BAL_ROLL = 0.4 * PRESS_RANGE, BAL_SHIFT = 0.14 * PRESS_RANGE;
/** FEAT-125 wobble shape: the fore-aft swing as a share of the up-down wave, and the elbow's bend
 *  (deg) per rad of wave (each elbow follows the other arm's wave, so the two never move in step) */
const FLAIL_SWING = 0.6, FLAIL_ELBOW = 40;
type Wave = readonly (readonly [number, number, number])[];
/** FEAT-125 wobble waves, each a sum of sines normalised to +-1: rows are [weight, frequency rad/s,
 *  phase rad]. Out-of-phase and off-harmonic so the two arms never repeat together. */
const WOBBLE: Record<'lOut' | 'rOut' | 'lSwing' | 'rSwing', Wave> = {
  lOut: [[1, 2.3, 0], [0.6, 3.7, 1.1], [0.3, 6.1, 2.3]],
  rOut: [[1, 2.9, 2.0], [0.6, 4.3, 0.4], [0.3, 5.3, 4.1]],
  lSwing: [[1, 1.7, 0.7], [0.5, 3.1, 2.9]],
  rSwing: [[1, 2.1, 3.3], [0.5, 3.9, 1.7]],
};
function wave(rows: Wave, t: number): number {
  let s = 0, w = 0;
  for (const [a, f, ph] of rows) { s += a * Math.sin(f * t + ph); w += a; }
  return s / w;
}
type V3 = [number, number, number];
/** FEAT-125: a += k (q - n), in place (a pose offset from neutral) */
function addOffset(a: V3, q: V3, n: V3, k: number): void { a[0] += k * (q[0] - n[0]); a[1] += k * (q[1] - n[1]); a[2] += k * (q[2] - n[2]); }
/** FEAT-125: a moves k of the way to q, in place */
function mixTo(a: V3, q: V3, k: number): void { a[0] += k * (q[0] - a[0]); a[1] += k * (q[1] - a[1]); a[2] += k * (q[2] - a[2]); }
/** FEAT-125: the arms' upswing on the pop: length (s) and extra lift at its peak (rad) */
const POP_T = 0.4, POP_LIFT = 0.45;
/** BUG-034: share of a skier's counter-rotation taken by the pelvis (the rest is the chest) */
const SKI_HIP_TWIST = 0.35;
/** FEAT-126: lean (rad) where the deep carve pose starts blending in; it is all in at LEAN_MAX */
const DEEP_FROM = 0.3;
/** FEAT-126: least height above the snow on a lean (m): the knee joints (the knee pad is about 5 cm
 *  round), the hip joint (the glutes hang 0.1 to 0.15 m below it) and the wrists */
const CLEAR_KNEE = 0.06, CLEAR_HIP = 0.17, CLEAR_HAND = 0.05;
/** FEAT-148: in a hard carve the inside hand reaches down and drags on the snow once the lean passes
 *  HAND_DRAG_FROM (rad), all the way by HAND_DRAG_FULL, this high (m), a little out toward the inside */
const HAND_DRAG_FROM = 0.95, HAND_DRAG_FULL = 1.15, HAND_DRAG_Y = 0.02, HAND_DRAG_OUT = 0.08;
/** BUG-066: the leg bones' least distance above the deck (m) where they pass over the board (the knee is
 *  about 6.5 cm round the bone, so about 5 cm of skin clear), the board's half width plus a limb's
 *  reach over it, and where along the shin (from the ankle) and the thigh (from the knee) it is tested */
const DECK_CLEAR = 0.115, DECK_HALF_W = 0.13 + 0.05, DECK_HALF_L = 0.8;
const SHIN_TS = [0.35, 0.55, 0.75, 1], THIGH_TS = [0.25, 0.5, 0.75];

const d2r = Math.PI / 180;
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** BUG-056 lead / lag chain (s), visual only. The head and shoulders pose for where the rider will
 *  be LEAD_UPPER ahead (the steer's target edge and the heading the turn rate is taking them to),
 *  the hips and the body's inclination LEAD_HIPS ahead (the crossover), the knees and ankles ride the
 *  board, and the board as drawn follows the physics yaw and edge BOARD_LAG behind (a critically
 *  damped follow), so every turn reads look, shoulders, hips cross, knees roll, then the board tips.
 *  Physics, collision and the tracks keep the true board state. Live-tunable on the view
 *  (`leadUpper`, `leadHips`, `boardLag`; the ?debug HUD has sliders). */
export const LEAD_UPPER = 0.2, LEAD_HIPS = 0.12, BOARD_LAG = 0.08;
/** BUG-056: how far the edge must be moving (rad ahead of the physics edge over the hips' lead) for
 *  the inclination to lean fully for the predicted edge instead of the measured lateral g, the most
 *  the shoulders turn ahead of the drawn board (rad), and the pelvis's share of that turn on a snowboard */
const LEAD_BLEND = 0.2, YAW_LEAD_CAP = 0.5, HIP_YAW_SHARE = 0.5;
/** BUG-056: the body's own response time (s): every lead signal (the edges the poses are built for,
 *  the inclination, the shoulders' turn, the hips over a press) is a critically damped follow of its
 *  prediction with this lag, so a new steer moves the body at a human speed, ahead of the board but
 *  never snapping to it (the prediction itself jumps the moment the input changes) */
const BODY_RESPONSE = 0.09;
/** a second-order follow: position and rate */
interface Follow { x: number; v: number }
/** BUG-056: critically damped follow of `target`: no overshoot, and a steady ramp is tracked `lag` s behind */
function follow(f: Follow, target: number, lag: number, dt: number): void {
  if (lag < 0.005) { f.x = target; f.v = 0; return; }
  const w = 2 / lag, n = Math.min(40, Math.ceil(dt * w / 0.5)), h = dt / n;
  for (let i = 0; i < n; i++) { f.v += (w * w * (target - f.x) - 2 * w * f.v) * h; f.x += f.v * h; }
}

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
    /** FEAT-082 sprinting: the board up on the right shoulder, on its edge, nose forward and up, the
     *  middle balanced just behind the shoulder; the right hand reaches forward to the lower edge */
    shoulderQ: carryBasis(new THREE.Vector3(0, 0.45, -1), new THREE.Vector3(1, 0.3, 0)),
    shoulderPos: new THREE.Vector3(0.2, 0.1, 0.12),
    shoulderGrip: new THREE.Vector3(0.135, 0, -0.42),
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
  /** FEAT-139: the rig is built goofy (follows the rider's `goofy`, rebuilt when it changes) */
  private goofy = false;
  /** FEAT-139: -1 while the board and body are drawn turned round, at the physics yaw + PI (riding
   *  switch, or goofy, not both). The rig's right (toe) side and nose are then the heading's left and
   *  tail, so every sideways and fore-aft physics value is negated into the rig's frame. */
  private fl = 1;
  /** BUG-056 tunables (s): how far ahead the head and shoulders and the hips pose, how far behind the board is drawn */
  leadUpper = LEAD_UPPER; leadHips = LEAD_HIPS; boardLag = BOARD_LAG;
  /** FEAT-127 / BUG-056: the board's roll onto its edge as drawn (rad, + = toe / right edge) and its
   *  yaw, each a critically damped follow of the physics value; the roll it follows; whether the
   *  rider was on the snow last frame (a landing snaps the follow); the shoulders' turn ahead of the
   *  drawn board (rad); and the predicted edges the upper body and the hips posed for (share of full) */
  private readonly rollF: Follow = { x: 0, v: 0 };
  private readonly yawF: Follow = { x: 0, v: 0 };
  private rollPhys = 0; private prevGround = true; private visLive = false;
  private readonly leanF: Follow = { x: 0, v: 0 };
  private readonly yawLeadF: Follow = { x: 0, v: 0 };
  private readonly edgeUpperF: Follow = { x: 0, v: 0 };
  private readonly edgeHipsF: Follow = { x: 0, v: 0 };
  private readonly hipZF: Follow = { x: 0, v: 0 };
  /** FEAT-140: the press balance in the rig's frame, followed at body speed, for the hips' slide */
  private readonly balF: Follow = { x: 0, v: 0 };
  /** FEAT-140: the board's tip up on its loaded end (rad), followed */
  private readonly tipF: Follow = { x: 0, v: 0 };
  private get leanAngle(): number { return this.leanF.x; }
  private get yawLead(): number { return this.yawLeadF.x; }
  private get edgeUpper(): number { return this.edgeUpperF.x; }
  private get edgeHips(): number { return this.edgeHipsF.x; }
  /** FEAT-118: board bend (0 flat .. 1 full load), its rate, and which end is loaded (-1 tail, +1 nose) */
  private flex = 0; private flexV = 0; private flexDir = -1;
  private twist = 0;
  /** FEAT-125: the press's pelvis roll (smoothed, rad), seconds the press has been held, the arm
   *  correction spring and its rate, wobble amplitude, a bump measure, the pop upswing (1 at takeoff
   *  down to 0), how loaded the board was on the last ground frame, and a clock for the wobble */
  private pressRoll = 0; private holdT = 0; private corr = 0; private corrV = 0; private flailAmp = 0;
  private bump = 0; private prevVz = 0; private prevLean = 0; private popT = 0; private load = 0; private wasGround = true; private clock = 0;
  private readonly headQ = new THREE.Quaternion();
  /** the smoothed pose's arm angles, kept while the balance layer is drawn on top of them */
  private readonly armKeep = new Float64Array(6);
  private wasSeated = false;
  /** worst ankle-to-binding distance after the last solve (m); 0 means the boots are on the bindings */
  footGap = 0;
  private readonly pose: Pose = clonePose(POSES.neutral);
  private readonly target: Pose = clonePose(POSES.neutral);
  /** BUG-056: the riding pose built for the hips' shorter lead; its pelvis fields go into `target` */
  private readonly hipsTarget: Pose = clonePose(POSES.neutral);
  /** FEAT-044: GPU powder spray (wisps on groomers, hanging clouds in powder, a burst on landing) */
  readonly spray = new Spray();
  private readonly tmpN = new THREE.Vector3();
  private readonly tmpF = new THREE.Vector3();
  private readonly tmpR = new THREE.Vector3();
  private readonly rot = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  /** FEAT-110: the board orientation before the flip is applied, and the flip itself */
  private readonly baseQ = new THREE.Quaternion();
  private readonly airFlipQ = new THREE.Quaternion();
  private readonly flipAxis = new THREE.Vector3(1, 0, 0);
  private readonly pivot = new THREE.Vector3();
  private readonly pq = new THREE.Quaternion();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly v4 = new THREE.Vector3();
  // ---- on foot (FEAT-067)
  private pack: Pack | null = null;
  /** FEAT-046: crash tumble, and the blend back to the animated pose after it (s left) */
  private ragdoll: Ragdoll | null = null;
  private recoverT = 0;
  private readonly recoverQ = BONE_LIST.map(() => new THREE.Quaternion());
  private readonly recoverHips = new THREE.Vector3();
  private gait: Gait | null = null;
  /** foot mode was drawn last frame (the board is off the bindings or the gear is carried) */
  private footActive = false;
  private gaitLive = false;
  private prevStep = [0, 0];
  /** 0..1 blend into the all-fours scramble (FEAT-068) */
  private crawl = 0;
  /** FEAT-082: board carried on the shoulder (0 at the side .. 1 on the shoulder), eased in while sprinting */
  private shoulder = 0;
  /** 0..1 blend into a slip: sitting back as the boots skid */
  private slip = 0;
  /** each foot plant on the snow (step-offs and the walk cycle): bootprints and footsteps */
  onPlant: ((p: Plant) => void) | null = null;
  private readonly fq = [new THREE.Quaternion(), new THREE.Quaternion()];
  private readonly fa = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly aq = [new THREE.Quaternion(), new THREE.Quaternion()];
  private readonly aa = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly m1 = new THREE.Matrix4();
  private readonly m2 = new THREE.Matrix4();
  /** FEAT-126: world to the riding frame (the snow plane is y = 0) */
  private readonly invG = new THREE.Matrix4();
  /** BUG-066: the board's inverse world matrix and scratch points for the deck clearance (the leg pass keeps v1 to v4) */
  private readonly invB = new THREE.Matrix4();
  private readonly dA = new THREE.Vector3(); private readonly dK = new THREE.Vector3(); private readonly dH = new THREE.Vector3();
  private readonly cq = new THREE.Quaternion();
  private readonly cp = new THREE.Vector3();
  private readonly armSave = [new THREE.Quaternion(), new THREE.Quaternion()];
  private readonly restQ = new THREE.Quaternion();
  private readonly flipQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  private readonly up = new THREE.Vector3(0, 1, 0);

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

  /** FK from the blended pose: pelvis, spine, head and arms. Leg angles only stand when seated. */
  private applyFK(p: Pose, xOff: number, zOff = 0): void {
    const B = this.rig.bones;
    B.Hips.position.set(xOff, p.hipsY, zOff);
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

  /** Height of a bone above the snow under the board (m): the board's base plane, y = 0 in the group frame. */
  private snowHeight(b: THREE.Bone): number {
    return b.getWorldPosition(this.v1).applyMatrix4(this.invG).y;
  }

  /** FEAT-126: how far the hips must rise (m, along the snow normal) for the knees and the seat to clear the snow. */
  private snowDeficit(): number {
    const B = this.rig.bones;
    this.invG.copy(this.group.matrixWorld).invert();
    const knee = CLEAR_KNEE - Math.min(this.snowHeight(B.LeftLeg), this.snowHeight(B.RightLeg));
    return Math.max(0, CLEAR_HIP - this.snowHeight(B.Hips), 2 * knee);
  }

  /**
   * BUG-066: how far the hips must rise (m, up the body) for the shins, knees and thighs to clear the deck
   * where they pass over the board. The deck is tested in the board's own frame, so it holds with the
   * board rolled further over than the body (the angulation of a hard carve) and tipped in a press.
   */
  private deckDeficit(): number {
    const B = this.rig.bones;
    this.invB.copy(this.rig.board.matrixWorld).invert();
    let need = 0;
    for (const [ankle, knee, hip] of [[B.LeftFoot, B.LeftLeg, B.LeftUpLeg], [B.RightFoot, B.RightLeg, B.RightUpLeg]] as const) {
      const a = ankle.getWorldPosition(this.dA).applyMatrix4(this.invB);
      const k = knee.getWorldPosition(this.dK).applyMatrix4(this.invB);
      const h = hip.getWorldPosition(this.dH).applyMatrix4(this.invB);
      const test = (p: THREE.Vector3, q: THREE.Vector3, ts: readonly number[]) => {
        for (const t of ts) {
          const x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t, z = p.z + (q.z - p.z) * t;
          if (Math.abs(x) > DECK_HALF_W || Math.abs(z) > DECK_HALF_L) continue;
          need = Math.max(need, deckY(this.rig, z) + 0.022 + DECK_CLEAR - y);
        }
      };
      test(a, k, SHIN_TS); test(k, h, THIGH_TS);
    }
    return need;
  }

  /**
   * FEAT-126: a hand that would dip into the snow on a deep lean rests on it instead (a light drag touch).
   * FEAT-148: in a hard carve (`hard` 0..1) the inside hand, the one nearer the snow, reaches down to it
   * and drags: toeside the forearm and hand, heelside the hand beside the hip.
   */
  private handsAboveSnow(hard: number): void {
    const B = this.rig.bones;
    this.invG.copy(this.group.matrixWorld).invert();
    const chestQ = B.Spine2.getWorldQuaternion(this.pq);
    const drag = hard * smooth(HAND_DRAG_FROM, HAND_DRAG_FULL, Math.abs(this.leanAngle));
    const yL = B.LeftHand.getWorldPosition(this.v1).applyMatrix4(this.invG).y, yR = B.RightHand.getWorldPosition(this.v1).applyMatrix4(this.invG).y;
    const inside = yL < yR ? -1 : 1;
    for (const [s, up, lo, end] of [[-1, B.LeftArm, B.LeftForeArm, B.LeftHand], [1, B.RightArm, B.RightForeArm, B.RightHand]] as const) {
      const local = end.getWorldPosition(this.v1).applyMatrix4(this.invG);
      const w = s === inside ? drag : 0;
      if (local.y >= CLEAR_HAND && w <= 0) continue;
      local.y = Math.max(CLEAR_HAND, local.y) + (HAND_DRAG_Y - Math.max(CLEAR_HAND, local.y)) * w;
      local.x += Math.sign(this.leanAngle) * HAND_DRAG_OUT * w;
      const target = local.applyMatrix4(this.group.matrixWorld);
      // elbows out and back, as when holding the gear
      twoBone(up, lo, end, target, this.v2.set(s * 0.7, -1, 0.4).applyQuaternion(chestQ));
    }
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

  /**
   * FEAT-125: snowboard press (ollie or nollie load). The upper body rolls over the loaded end and the
   * head, torso and pelvis offsets add to the current pose; the arms blend to the press's balance
   * pose. Returns the pelvis roll added (rad), which the head later takes back out. Writes into the
   * target's own arrays (rebuilt every frame from clonePose / lerpPose, never the shared tables).
   */
  private pressPose(t: Pose, lean: number): number {
    const P = this.poses, Q = lean < 0 ? P.pressTail : P.pressNose, N = P.neutral;
    const k = smooth(0.05, 0.9, Math.abs(lean));
    addOffset(t.hipsRot, Q.hipsRot, N.hipsRot, k); addOffset(t.torso, Q.torso, N.torso, k); addOffset(t.head, Q.head, N.head, k);
    mixTo(t.lShoulder, Q.lShoulder, k); mixTo(t.rShoulder, Q.rShoulder, k);
    t.lElbow += k * (Q.lElbow - t.lElbow); t.rElbow += k * (Q.rElbow - t.rElbow);
    return k * (Q.hipsRot[2] - N.hipsRot[2]);
  }

  /**
   * FEAT-125 balance on top of the smoothed pose (the caller restores the arm angles after FK): a
   * small out-of-phase wave per arm while pressing that grows the longer the press is held and with
   * speed and bumps, a quick swing when the lean changes, and both arms swinging up on the pop.
   */
  private balanceArms(r: Rider, dt: number, free: boolean): void {
    const h = Math.min(dt, 0.05), p = this.pose;
    this.clock += h;
    const La = Math.abs(r.lean), ground = free && r.onGround;
    // the pop: leaving the snow with the board loaded
    if (this.wasGround && !r.onGround && free && this.load > 0.3) this.popT = 1;
    this.wasGround = r.onGround;
    this.load = r.onGround ? Math.max(La, Math.min(1, r.jumpCharge)) : 0;
    this.popT = Math.max(0, this.popT - h / POP_T);
    this.holdT = ground && La > 0.3 ? this.holdT + h : Math.max(0, this.holdT - 3 * h);
    // bumps: vertical acceleration through the board, as a share of BUMP_ACC
    const az = h > 0 && ground ? Math.abs(r.vz - this.prevVz) / h : 0;
    this.prevVz = r.vz;
    this.bump += (Math.min(1, az / BUMP_ACC) - this.bump) * Math.min(1, h * 4);
    // correction: the lean's change kicks a damped spring (arms swing against the body's throw)
    const lean = this.fl * r.lean; // FEAT-139: in the rig's frame, so turning round is no kick
    const dL = free ? lean - this.prevLean : 0;
    this.prevLean = lean;
    this.corrV += CORR_KICK * dL - (CORR_W * CORR_W * this.corr + 2 * CORR_ZETA * CORR_W * this.corrV) * h;
    this.corr += this.corrV * h;
    const amp = ground ? smooth(0.2, 0.8, La) * (FLAIL_BASE + FLAIL_HOLD * Math.min(1, this.holdT / FLAIL_RAMP)) * (1 + FLAIL_SPEED * Math.min(FLAIL_VMAX, r.speed) + FLAIL_BUMP * this.bump + (r.pressing ? FLAIL_BAL * smooth(0.2, 1, Math.abs(r.pressBalance)) : 0)) : 0;
    this.flailAmp += (amp - this.flailAmp) * Math.min(1, h * 6);
    const fp = this.fp ? 0.35 : 1, A = this.flailAmp * fp, c = this.clock;
    const wl = wave(WOBBLE.lOut, c), wr = wave(WOBBLE.rOut, c), sl = wave(WOBBLE.lSwing, c), sr = wave(WOBBLE.rSwing, c);
    const pop = this.popT > 0 ? Math.sin(Math.PI * Math.sqrt(1 - this.popT)) * POP_LIFT * fp : 0;
    const lift = Math.abs(this.corr) * 0.5 * fp + pop;
    // abduction is - for the left arm and + for the right; x swings the arm forward (+) or back
    p.lShoulder[2] -= A * wl + lift; p.rShoulder[2] += A * wr + lift;
    p.lShoulder[0] += FLAIL_SWING * A * sl - this.corr * fp; p.rShoulder[0] += FLAIL_SWING * A * sr - this.corr * fp;
    p.lElbow += FLAIL_ELBOW * A * wr; p.rElbow += FLAIL_ELBOW * A * wl;
  }

  /**
   * FEAT-125: on a press, raise the hips so the leg over the unloaded end reaches nearly straight
   * (the hips already sit over the loaded end, whose leg the IK then bends deep). Less in a squat or
   * a charge, which keep both knees bent. Runs after FK and before the feet are pinned.
   */
  private pressLegs(r: Rider): void {
    const w = Math.max(0, Math.min(1, this.flex / PRESS_FLEX)) * (1 - 0.8 * r.squat) * (1 - 0.5 * Math.min(1, r.jumpCharge));
    if (w < 0.01) return;
    const rig = this.rig, B = rig.bones;
    const tail = this.flexDir < 0; // tail loaded: the front (left, nose side) leg reaches
    const up = tail ? B.LeftUpLeg : B.RightUpLeg, anchor = tail ? rig.anchors.l : rig.anchors.r;
    const s = rig.body.worldToLocal(up.getWorldPosition(this.v1));
    const a = rig.body.worldToLocal(anchor.getWorldPosition(this.v2));
    const reach = B.LeftLeg.position.length() + B.LeftFoot.position.length();
    const dx = a.x - s.x, dz = a.z - s.z, dy = s.y - a.y;
    const c0 = Math.hypot(dx, dy, dz), c = c0 + (PRESS_REACH * reach - c0) * w;
    const r2 = c * c - dx * dx - dz * dz;
    if (r2 <= 0) return;
    B.Hips.position.y += Math.sqrt(r2) - dy;
    B.Hips.updateMatrixWorld(true);
  }

  /**
   * The riding pose on the snow for an edge (share of full, the brake side while braking) and a
   * press lean: carve, deep carve, tuck, charge, squat, press, skating, landing and the brake's
   * crouch, blended into `t`. Returns the press's pelvis roll (rad), which the head takes back out.
   */
  private ridingPose(t: Pose, r: Rider, tuck: boolean, b: number, edge: number, lean: number): number {
    const P = this.poses;
    let pressRoll = 0;
    // braking stance: sitting back on the heel edge or kneeling into the toe edge
    if (edge > 0) lerpPose(t, t, P.carveToe, Math.min(1, edge * 1.2)); else if (edge < 0) lerpPose(t, t, P.carveHeel, Math.min(1, -edge * 1.2));
    // FEAT-126: the harder the lean, the lower and more bent: light turns stay relaxed and tall,
    // a full-lean carve drops into the deep pose on the side the body leans to
    const deep = smooth(DEEP_FROM, LEAN_MAX, Math.abs(this.leanAngle)) * (1 - b);
    if (deep > 0) lerpPose(t, t, this.leanAngle > 0 ? P.carveToeDeep : P.carveHeelDeep, deep);
    if (tuck) lerpPose(t, t, P.tuck, 0.85);
    if (r.jumpCharge > 0) lerpPose(t, t, P.crouch, Math.min(1, r.jumpCharge));
    // FEAT-111: deeper than tuck or charge, wins over both. BUG-066: not in a hard carve (the same key),
    // which keeps the deep carve stance above as one long line instead of folding onto the board
    const squat = r.squat * (1 - r.hardCarve);
    if (squat > 0) lerpPose(t, t, P.squat, squat);
    // FEAT-085 skating: knees bent, chest over the front foot, bobbing down into each push
    // FEAT-112: hips over the loaded end, the chest leaning with them
    // BUG-047: no extra drop when already squatting or charged (that put the seat through the deck)
    // FEAT-125: a snowboarder leans the whole upper body over the loaded end with the arms up to balance
    if (Math.abs(lean) > 0.01) {
      if (this.discipline === 'board') {
        pressRoll = this.pressPose(t, lean);
        // FEAT-140: the pelvis rolls on toward the end the balance is running to (the head takes it back out)
        if (r.pressing) { const lr = BAL_ROLL * this.fl * r.pressBalance; t.hipsRot[2] += lr; pressRoll += lr; }
      }
      else t.torso = [t.torso[0] + 0.3 * lean, t.torso[1], t.torso[2]];
      t.hipsY -= 0.06 * Math.abs(lean) * (1 - Math.min(1, Math.max(r.squat, r.jumpCharge)));
    }
    if (r.skating) { const push = Math.max(0, Math.cos(r.skatePhase * Math.PI * 2)); lerpPose(t, t, P.crouch, 0.35 + 0.25 * push); t.torso = [t.torso[0] + 0.25 * push, t.torso[1], t.torso[2]]; }
    if (r.landingShock > 0) lerpPose(t, t, P.land, Math.min(1, r.landingShock * 1.5));
    // knees bent and hips low in proportion to how hard the edge is biting
    const bite = b * Math.min(1, r.brakeAcc / 8);
    if (bite > 0) { lerpPose(t, t, P.crouch, 0.45 * bite); t.hipsY -= 0.05 * bite; }
    return pressRoll;
  }

  update(r: Rider, dt: number, tuck: boolean, grab = false, seated = false): void {
    this.setStance(!!r.goofy); // FEAT-139: the ghost and a replay carry their own stance
    // FEAT-139: riding switch or goofy (not both) the rig is drawn turned round; seated and on foot never
    const fl = this.fl = this.discipline === 'board' && !seated && !!r.switch !== !!r.goofy ? -1 : 1;
    // on foot, or stepping on or off the board
    const u = seated ? 0 : r.footU;
    if (u > 0 && this.pack && this.gait) {
      if (this.flex !== 0) { this.flex = 0; this.flexV = 0; bendBoard(this.rig, 0, this.flexDir); } // FEAT-118: flat when carried
      this.updateFoot(r, dt, u);
      this.updateSpray(r, dt, this.tmpF, this.tmpR, false);
      return;
    }
    if (this.footActive) this.leaveFoot();
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
    // FEAT-110: the flip pitches the rider and board about the board's own side axis, through a point
    // 0.7 m up (about the hips); a front flip (+) puts the nose down
    if (!r.onGround && r.flip !== 0) {
      this.airFlipQ.setFromAxisAngle(this.flipAxis, -r.flip * fl); // the physics flip is about the heading's side axis
      this.group.quaternion.multiply(this.airFlipQ);
      this.pivot.set(0, 0.7, 0).applyQuaternion(this.baseQ);
      this.group.position.add(this.pivot).sub(this.v1.set(0, 0.7, 0).applyQuaternion(this.group.quaternion));
    }
    // ---- inclination: lean into the turn until lateral acceleration balances gravity,
    // phi = atan(a_lat / g), capped at 60 degrees (FEAT-126). lateralG > 0 = toward the board's right
    // (toe side). Braking, the board lies across the travel direction, so the braking deceleration
    // is lateral to it: the rider leans back into the hill onto the trailing edge (heelside -, toeside +).
    // FEAT-139: in the rig's frame (fl), so toe and heel are the rider's own whichever way round they ride
    const brakeG = fl * r.brakeSide * r.brakeAcc / 9.81;
    const latG = fl * r.lateralG * (1 - r.brakeAmt) + brakeG;
    // BUG-056: the body commits into the turn ahead of the edge: while the steer is moving the edge,
    // the inclination leans for the balance angle of the edge leadHips from now (the measured lateral g
    // still points the old way), blending back to the measured lean once the edge holds, so the hips
    // cross the board first
    const live = r.onGround && !seated && r.crashed <= 0;
    const edgeAhead = live ? r.predictEdge(this.leadHips) - r.edge : 0;
    const k = Math.min(1, Math.abs(edgeAhead) / LEAD_BLEND) * (1 - r.brakeAmt);
    // FEAT-148: a hard carve lays the body over further, toward the snow
    const leanMax = LEAN_MAX + (LEAN_HARD - LEAN_MAX) * (live ? r.hardCarve : 0);
    const measured = carveLean(latG, leanMax);
    const phi = r.onGround && !seated ? Math.max(-leanMax, Math.min(leanMax, measured + (fl * r.predictIncline(this.leadHips) - measured) * k)) : 0;
    follow(this.leanF, phi, BODY_RESPONSE, dt);
    // FEAT-127: the board rolls onto the sim's real edge angle (the brake's snow cut while braking),
    // further over than the body: the knees and hips make up the difference (angulation).
    // BUG-056: drawn boardLag behind the physics edge (the same snap rules as the yaw), and never
    // rolled further onto the engaged edge than the physics has it, so the lag cannot bury it.
    const bk = r.brakeSide !== 0 ? r.brakeAmt : 0;
    const rollT = live ? fl * (r.edgeAngle * EDGE_FULL * (1 - bk) + r.brakeSide * (r.brakePsi ?? 0) * bk) : 0;
    this.rollPhys = rollT;
    if (snap) { this.rollF.x = rollT; this.rollF.v = 0; } else follow(this.rollF, rollT, this.boardLag, dt);
    // easing off the edge the drawn board may not trail behind the physics (it would be rolled further than
    // the edge is), so there it catches up with a quarter of the lag: still a smooth follow, no snap
    if (live && this.rollF.x * rollT >= 0 && Math.abs(this.rollF.x) > Math.abs(rollT)) follow(this.rollF, rollT, this.boardLag / 4, dt);
    // the board and the rider roll together about the engaged edge so it stays in the snow, then the
    // board rolls on by `ex` about that same edge. The pivot slides out from the middle of the base
    // to the edge (EDGE_OFF) over the first EDGE_PIVOT_ROLL of roll, so an edge change never pops.
    const pv = EDGE_OFF * Math.max(-1, Math.min(1, this.rollF.x / EDGE_PIVOT_ROLL));
    const ex = this.rollF.x - this.leanAngle;
    this.lean.position.set(pv, 0, 0);
    this.lean.rotation.set(0, 0, -this.leanAngle); // positive lateralG tips +Y toward +X
    if (this.discipline === 'board') this.rig.board.position.set(-pv * Math.cos(ex), pv * Math.sin(ex), 0);
    else { this.rig.board.position.set(-pv, 0, 0); if (!seated) this.rollSkis(ex, pv / EDGE_OFF); }
    // FEAT-112: the board tips up about its loaded end, up to 18 deg: nose up on a lean back (ollie,
    // tail press), tail up on a lean forward (nollie, nose press). The feet ride the bindings with it.
    const L = fl * (r.lean ?? 0); // FEAT-139: the heading's nose is the rig's tail riding turned round
    if (this.discipline === 'board') {
      // FEAT-118: the snowboard bends instead: tail flat, arched from the back foot, nose up.
      // The load grows with the lean and the jump charge and lets go in the air (the pop).
      this.rig.board.rotation.set(0, 0, -ex);
      let target = seated || !r.onGround ? 0 : Math.abs(L) * (0.6 + 0.4 * Math.min(1, r.jumpCharge));
      // FEAT-140: a balanced press bends deeper, and deeper still as the balance runs to the loaded end
      // (flatter toward the other end; a jump charge still adds its load on top)
      if (r.pressing && r.onGround && !seated) target = Math.min(BEND_MAX, Math.abs(L) * (PRESS_BEND * (1 + BAL_BEND * r.pressBalance * r.pressDir) + 0.4 * Math.min(1, r.jumpCharge)));
      // BUG-048: a lean to the other end first lets the board come back to flat, and only then bends it
      // the other way (switching while still bent swapped nose-up for tail-up in one frame)
      if (Math.abs(L) > 0.01 && Math.sign(L) !== this.flexDir) {
        if (Math.abs(this.flex) < 0.05) this.flexDir = Math.sign(L);
        else target = 0;
      }
      const h = Math.min(dt, 0.05);
      this.flexV += (FLEX_W * FLEX_W * (target - this.flex) - 2 * FLEX_ZETA * FLEX_W * this.flexV) * h;
      this.flex += this.flexV * h;
      bendBoard(this.rig, this.flex, this.flexDir);
      // FEAT-140: deep in a press the whole board tips up about its loaded tip, which stays on the snow
      const deep = Math.max(0, Math.min(1, 0.5 + 0.5 * r.pressBalance * r.pressDir));
      // (in the air, a held press key tips it half way: set up to land into the press)
      const tipTo = seated ? 0 : r.pressing && r.onGround ? Math.abs(L) * PRESS_TIP * deep : !r.onGround && r.crashed <= 0 ? Math.abs(L) * PRESS_TIP * 0.5 : 0;
      follow(this.tipF, tipTo, TIP_RESPONSE, dt);
      if (this.tipF.x > 1e-3) {
        const sz = this.flexDir < 0 ? 1 : -1, end = sz * BOARD_HALF; // the loaded end's local z (+z the tail)
        this.rig.board.rotation.set(sz * this.tipF.x, 0, -ex); // +x lifts the nose (-z)
        this.pivot.set(0, 0, end);
        this.rig.board.position.add(this.pivot).sub(this.v2.set(0, 0, end).applyQuaternion(this.rig.board.quaternion));
      }
    } else if (Math.abs(L) > 0.01 && !seated) {
      const end = L < 0 ? BOARD_HALF : -BOARD_HALF; // the end that stays down (local -Z is the nose)
      this.rig.board.rotation.set((L < 0 ? 1 : -1) * Math.abs(L) * LEAN_TIP, 0, 0);
      this.pivot.set(0, 0, end);
      this.rig.board.position.add(this.pivot).sub(this.v2.set(0, 0, end).applyQuaternion(this.rig.board.quaternion));
    } else this.rig.board.rotation.set(0, 0, 0);

    // ---- FEAT-046: a crash is a ragdoll tumble; the body is pulled toward the sim's slide so it
    // gets up where the rider is, then blends back to the animated pose over RAGDOLL_RECOVER
    if (this.ragdoll && r.crashed > 0 && !seated) {
      if (!this.ragdoll.active) { this.group.updateMatrixWorld(true); this.ragdoll.start(this.rig, this.v1.set(r.vx, r.vz, -r.vy), r.crashFall ? this.v2.set(Math.sin(r.heading) * r.crashFall, 0, -Math.cos(r.heading) * r.crashFall) : r.crashSide ? this.v2.set(Math.cos(r.heading) * r.crashSide, 0, Math.sin(r.heading) * r.crashSide) : null); } // FEAT-140: a press slam falls over its loaded end; FEAT-148: a washout to the inside of the turn
      this.group.updateMatrixWorld(true);
      this.ragdoll.step(dt, this.v2.set(r.x, r.z, -r.y));
      this.ragdoll.apply(this.rig);
      hangCarriersFromFeet(this.rig); // the board stays strapped to the feet
      this.wasSeated = true; // so the carriers go back on the next normal frame
      this.updateSpray(r, dt, f, right, false);
      return;
    }
    if (this.ragdoll?.active) {
      this.ragdoll.stop();
      BONE_LIST.forEach((b, i) => this.recoverQ[i].copy(this.rig.bones[b].quaternion));
      this.recoverHips.copy(this.rig.bones.Hips.position);
      this.recoverT = RAGDOLL_RECOVER;
    }

    // ---- pose blend from rider state
    const t = this.target;
    const P = this.poses;
    let pressRoll = 0;
    Object.assign(t, clonePose(P.neutral));
    if (seated) { lerpPose(t, t, P.seated, 1); }
    else if (r.crashed > 0) { lerpPose(t, t, P.crash, 1); }
    else if (!r.onGround) {
      lerpPose(t, t, grab ? P.grab : P.air, 1);
      if (r.squat > 0) lerpPose(t, t, P.squat, 0.7 * r.squat); // tucked up tight in the air
      if (Math.abs(r.flipRate) > 1) lerpPose(t, t, P.tuck, Math.min(0.85, Math.abs(r.flipRate) / 10)); // FEAT-110: balled up mid-flip, opening as it slows
    }
    else {
      // BUG-056: the riding pose is built for where the rider is going, not where the board is: the
      // head, shoulders and arms for the edge and lean leadUpper ahead, the pelvis for leadHips ahead
      const b = r.brakeSide !== 0 ? r.brakeAmt : 0;
      const edgeFor = (lead: number) => Math.max(-1, Math.min(1, fl * (r.predictEdge(lead) / EDGE_FULL * (1 - b) + r.brakeSide * b)));
      follow(this.edgeUpperF, edgeFor(this.leadUpper), BODY_RESPONSE, dt); follow(this.edgeHipsF, edgeFor(this.leadHips), BODY_RESPONSE, dt);
      pressRoll = this.ridingPose(t, r, tuck, b, this.edgeUpper, fl * r.predictLean(this.leadUpper));
      const h = this.hipsTarget;
      copyPose(h, P.neutral);
      this.ridingPose(h, r, tuck, b, this.edgeHips, fl * r.predictLean(this.leadHips));
      t.hipsY = h.hipsY; t.hipsRot = h.hipsRot; t.lHip = h.lHip; t.rHip = h.rHip; t.lKnee = h.lKnee; t.rKnee = h.rKnee;
    }
    // FEAT-139: the poses turn the chest and head toward the rig's nose. Drawn turned round (riding
    // switch, or goofy) that end trails, so the rider looks the other way along the board instead:
    // over the rig's tail, where they are going. The pose blend below eases the turn after a 180.
    if (fl < 0 && !seated && r.crashed <= 0) { t.torso = [t.torso[0], -t.torso[1], t.torso[2]]; t.head = [t.head[0], -t.head[1], t.head[2]]; }
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
        const a = Math.abs(slip);
        if (this.discipline === 'ski') {
          // past 90 deg hold the cap, then fade to no twist by 135 deg (really backwards), so an
          // overshooting hockey stop does not pop the chest back
          if (a > Math.PI / 2) slip = Math.sign(slip) * (Math.PI / 2) * Math.max(0, 1 - (a - Math.PI / 2) / (Math.PI / 4));
        } else if (a > Math.PI / 2) slip = 0; // backwards: no twist
      }
      // BUG-034: a skier's hockey stop keeps the chest square to the fall line while the skis go 84 deg
      // across, so skis take the full slip (to 90 deg) and split it between the pelvis and the chest;
      // the snowboarder keeps 70 % up to 60 deg, all in the chest, on top of the side-on stance
      const ski = this.discipline === 'ski';
      const k = ski ? 1 : 0.7, twistCap = ski ? Math.PI / 2 : 1.05;
      this.twist += (Math.max(-twistCap, Math.min(twistCap, -slip * k)) - this.twist) * Math.min(1, dt * 6);
    } else this.twist *= Math.max(0, 1 - dt * 6);
    // BUG-056: the shoulders turn into the turn ahead of the drawn board: the lag the board carries plus
    // the heading the turn rate reaches leadUpper from now (pack yaw is clockwise, three.js yaw the reverse).
    // Not the swing of a brake: there the shoulders stay down the hill (the slip twist above) and the
    // board swings across under them.
    const ahead = free && r.onGround ? wrap(yaw - this.yawF.x) * (1 - r.brakeAmt) + r.turnRate * this.leadUpper : 0;
    follow(this.yawLeadF, Math.max(-YAW_LEAD_CAP, Math.min(YAW_LEAD_CAP, ahead)), BODY_RESPONSE, dt);
    const hipShare = this.discipline === 'ski' ? SKI_HIP_TWIST : 0;
    const hipYaw = this.discipline === 'ski' ? SKI_HIP_TWIST : HIP_YAW_SHARE;
    t.hipsRot = [t.hipsRot[0], t.hipsRot[1] + this.twist * hipShare - this.yawLead * hipYaw, t.hipsRot[2]];
    t.torso = [t.torso[0], t.torso[1] + this.twist * (1 - hipShare) - this.yawLead * (1 - hipYaw), t.torso[2]];
    if (this.fp) {
      // first person: arms closer to the sides so the front arm is not held level across the view
      t.lShoulder = [t.lShoulder[0], t.lShoulder[1], t.lShoulder[2] * 0.35];
      t.rShoulder = [t.rShoulder[0], t.rShoulder[1], t.rShoulder[2] * 0.35];
    }
    lerpPose(this.pose, this.pose, t, Math.min(1, dt * (r.crashed > 0 ? 6 : 10)));
    this.pressRoll += (pressRoll - this.pressRoll) * Math.min(1, dt * 10);
    // idle breathing and balance wobble so a standing rider is not frozen
    const now = performance.now() / 1000;
    const p = this.pose;
    const hy = p.hipsY, tx = p.torso[0];
    const arms = this.armKeep;
    arms[0] = p.lShoulder[0]; arms[1] = p.lShoulder[2]; arms[2] = p.rShoulder[0]; arms[3] = p.rShoulder[2]; arms[4] = p.lElbow; arms[5] = p.rElbow;
    p.hipsY += Math.sin(now * 2.1) * 0.004; p.torso[0] += Math.sin(now * 1.3) * 0.015;
    if (this.discipline === 'board') this.balanceArms(r, dt, free);
    // BUG-047: the hips sit over the loaded end and never below the deck under them
    let hipZ = 0;
    if (this.discipline === 'board' && !seated) {
      // BUG-056: on a press the hips move over the loaded end ahead of the bend (a full lean bends it 0.6)
      const leanH = free && r.onGround ? fl * r.predictLean(this.leadHips) : 0;
      const ahead = Math.sign(leanH) === this.flexDir ? 0.6 * Math.abs(leanH) : 0;
      follow(this.hipZF, Math.max(0, Math.min(1, Math.max(this.flex, ahead) / PRESS_FLEX)), BODY_RESPONSE, dt);
      hipZ = -this.flexDir * HIP_SHIFT * this.hipZF.x;
      // FEAT-140: the hips slide on toward the end the press balance is running to (+ balance: the nose, -z)
      follow(this.balF, free && r.pressing ? fl * r.pressBalance : 0, BODY_RESPONSE, dt);
      hipZ -= BAL_SHIFT * this.balF.x;
      hipZ -= this.flexDir * TIP_SHIFT * Math.max(0, this.tipF.x) / PRESS_TIP; // FEAT-140: on over the tipped board's loaded end
      // FEAT-140: a tipped board's deck rises from the loaded tip toward the hips
      const tipRise = Math.max(0, BOARD_HALF + this.flexDir * hipZ) * Math.sin(Math.max(0, this.tipF.x)); // the hips' distance from the loaded tip
      const floor = deckY(this.rig, hipZ) + 0.022 + HIP_CLEAR + tipRise;
      if (p.hipsY < floor) p.hipsY = floor;
    }
    this.applyFK(p, -pv, hipZ);

    // ---- legs: boots pinned to the bindings, or on a chair the board hangs from the feet
    const rig = this.rig;
    this.group.updateMatrixWorld(true);
    // FEAT-126: on a deep lean the snow can come within reach of the inside knee and the hips
    const nearSnow = free && r.onGround && Math.abs(this.leanAngle) > DEEP_FROM;
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
      // FEAT-126: on a deep toeside lean the toe edge faces the snow, so both knees drive toward the
      // nose instead (parallel to the snow), keeping the deep bend without the knees going in
      const toeIn = this.discipline === 'board' && this.leanAngle > 0 ? 2.5 * smooth(DEEP_FROM, LEAN_MAX, this.leanAngle) : 0;
      const lp = this.v3.copy(fwd).addScaledVector(nose, toeIn - k);
      const rp = this.v4.copy(fwd).addScaledVector(nose, toeIn + k);
      const press = this.discipline === 'board' && free;
      if (press) this.pressLegs(r);
      this.footGap = pinFeet(rig, lp, rp);
      // FEAT-126: raise the hips until the knees and the seat clear the snow, then solve the legs again.
      // A knee sits about halfway between the hips and the boot, so it rises about half as far.
      // BUG-066: and the legs clear the deck (a hard carve's angulation tips the board toward the shins)
      const deckCheck = this.discipline === 'board' && free && r.onGround;
      if (nearSnow || deckCheck) {
        for (let it = 0; it < 4; it++) {
          const lift = Math.max(nearSnow ? this.snowDeficit() / Math.max(0.4, Math.cos(this.leanAngle)) : 0, deckCheck ? this.deckDeficit() : 0);
          if (lift < 0.003) break;
          p.hipsY += lift;
          this.applyFK(p, -pv, hipZ);
          if (press) this.pressLegs(r);
          this.footGap = pinFeet(rig, lp, rp);
        }
      }
    }
    p.hipsY = hy; p.torso[0] = tx;
    p.lShoulder[0] = arms[0]; p.lShoulder[2] = arms[1]; p.rShoulder[0] = arms[2]; p.rShoulder[2] = arms[3]; p.lElbow = arms[4]; p.rElbow = arms[5];
    // FEAT-125: the head takes most of the press's pelvis roll back out, so it stays up and looks ahead
    // (after the legs, since the FEAT-126 snow clearance can run the FK again)
    if (Math.abs(this.pressRoll) > 1e-3) {
      this.group.updateMatrixWorld(true);
      const ql = this.lean.getWorldQuaternion(this.pq);
      // the roll tips the body toward -Z (the nose) for a positive angle, which is -angle about the rider's X
      this.headQ.setFromAxisAngle(this.v1.set(1, 0, 0), HEAD_LEVEL * this.pressRoll).premultiply(ql).multiply(this.q.copy(ql).invert());
      setWorldQuat(this.rig.bones.Head, this.headQ.multiply(this.rig.bones.Head.getWorldQuaternion(this.q)));
    }
    if (this.discipline === 'ski') this.skiHands(r, tuck, free);
    if (nearSnow) this.handsAboveSnow(r.hardCarve);
    if (this.recoverT > 0) {
      // FEAT-046: ease from the last ragdoll pose into the animated one
      this.recoverT = Math.max(0, this.recoverT - dt);
      const k = 1 - this.recoverT / RAGDOLL_RECOVER, e = k * k * (3 - 2 * k);
      // recoverQ / recoverHips stay fixed at the crash-end pose; only the animated target moves
      BONE_LIST.forEach((b, i) => { const bone = this.rig.bones[b]; bone.quaternion.copy(this.q.copy(this.recoverQ[i]).slerp(bone.quaternion, e)); });
      this.rig.bones.Hips.position.lerpVectors(this.recoverHips, this.rig.bones.Hips.position, e);
      this.rig.body.updateMatrixWorld(true);
    }
    this.updateSpray(r, dt, f, right, true);
  }

  /** FEAT-127: roll each ski by `ex` past the body's lean, about its own edge on the turn's side (`side` -1..1) */
  private rollSkis(ex: number, side: number): void {
    for (const c of this.rig.carriers) {
      const x0 = c.rest.elements[12], e = side * SKI_EDGE_OFF;
      c.obj.rotation.set(0, 0, -ex);
      c.obj.position.set(x0 + e - e * Math.cos(ex), e * Math.sin(ex), 0);
    }
  }

  /**
   * Snow spray (FEAT-044, `Spray.ts`): wisps off the engaged edge and a sheet thrown ahead of the
   * board when braking on a groomer, hanging clouds in powder, a burst on landing. `emitting` false
   * only advances the clock (on foot, crashed, on a lift).
   */
  private updateSpray(r: Rider, dt: number, f: THREE.Vector3, right: THREE.Vector3, emitting: boolean): void {
    this.spray.update(r, dt, this.group.position, f, right, this.fl, emitting);
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
    this.baseQ.copy(this.group.quaternion); // FEAT-110: keep the riding base in step, no swing when strapping back in
    for (const f of [this.leanF, this.rollF, this.yawLeadF, this.edgeUpperF, this.edgeHipsF, this.hipZF, this.balF, this.tipF]) { f.x = 0; f.v = 0; }
    this.twist = 0; this.visLive = false; // BUG-056: the follows snap when strapping back in
    this.lean.position.set(0, 0, 0); this.lean.rotation.set(0, 0, 0);

    // ---- gait (pack coords): runs once fully on foot; until then the feet's standing spots follow the body
    const nz = Math.max(0.2, r.normal[2]);
    const hx = Math.sin(r.heading), hy = Math.cos(r.heading);
    const grade = -(r.normal[0] * hx + r.normal[1] * hy) / nz;
    const fall = Math.hypot(r.normal[0], r.normal[1]);
    // slipping or kicking up steep snow smears the print downhill
    const smearAmt = fall > 0.02 ? 0.12 * smooth(25, 40, r.slopeDeg) + 0.15 * Math.min(1, r.slideSpeed / 2) : 0;
    const gin = { x: r.x, y: r.y, z: r.z, heading: r.heading, vx: r.vx, vy: r.vy, onGround: r.onGround, sink: r.sink, sliding: r.slipping,
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
    this.shoulder += ((r.sprinting && !r.crawling && !ski ? 1 : 0) - this.shoulder) * Math.min(1, dt * 4);
    this.slip += ((r.slipping ? 1 : 0) - this.slip) * Math.min(1, dt * 8);
    const walk = lerpPose(clonePose(WALK_POSES.walk), WALK_POSES.walk, WALK_POSES.sprint, sprint);
    if (this.crawl > 0.001) lerpPose(walk, walk, WALK_POSES.crawl, this.crawl);
    lerpPose(t, t, walk, stand);
    const crouch = u > 0.08 && u < 0.78 ? Math.sin(Math.PI * (u - 0.08) / 0.7) : 0;
    t.hipsY -= 0.3 * crouch + 0.6 * r.sink * stand + 0.12 * this.slip; // sitting into a slip
    if (r.squat > 0) { t.hipsY -= 0.45 * r.squat; t.hipsRot = [t.hipsRot[0] + 0.3 * r.squat, t.hipsRot[1], t.hipsRot[2]]; t.torso = [t.torso[0] + 0.35 * r.squat, t.torso[1], t.torso[2]]; } // on foot: hunker down (FEAT-111)
    // BUG-045 mantle: reach up to the edge, pull the knees up through the middle, then stand
    if (r.mantle > 0) {
      const reach = Math.max(0, 1 - r.mantle / 0.5), knee = Math.sin(Math.PI * r.mantle);
      t.hipsY -= 0.35 * knee; t.torso = [t.torso[0] + 0.5 * knee, t.torso[1], t.torso[2]];
      t.lShoulder = [t.lShoulder[0] + 2.2 * reach + 0.8 * knee, t.lShoulder[1], t.lShoulder[2] * 0.4];
      t.rShoulder = [t.rShoulder[0] + 2.2 * reach + 0.8 * knee, t.rShoulder[1], t.rShoulder[2] * 0.4];
    }
    t.hipsRot = [t.hipsRot[0] + 0.35 * crouch, t.hipsRot[1], t.hipsRot[2]];
    t.torso = [t.torso[0] + 0.5 * crouch - 0.25 * this.slip + 0.4 * Math.max(0, Math.min(0.8, grade)) * stand * Math.min(1, gait.speed), t.torso[1], t.torso[2]];
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
      if (!ski && this.shoulder > 0.001) {
        // FEAT-082: up onto the shoulder while sprinting (a smaller stride sway up there)
        sway.slerp(this.q.copy(CARRY.board.shoulderQ).premultiply(this.q2.setFromAxisAngle(this.up, 0.03 * Math.sin(ph) * a)), this.shoulder);
        this.cp.lerp(CARRY.board.shoulderPos, this.shoulder);
      }
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
    this.handTo('Right', rig.board.localToWorld(ski ? this.cp.copy(carry.rGrip) : this.cp.copy(carry.rGrip).lerp(CARRY.board.shoulderGrip, this.shoulder)), hold);
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
