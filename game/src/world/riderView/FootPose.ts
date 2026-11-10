/** FEAT-067 on foot: unstrapping, the walk, the scramble and carrying the gear (split from world/RiderView.ts, FEAT-165) */
import * as THREE from 'three';
import type { RiderView } from '../RiderView';
import type { Rider } from '../../sim/Rider';
import { lerpPose, clonePose, WALK_POSES } from '../RiderModel';
import { solveLegs, twoBone, setWorldQuat, restCarriers, ANKLE_H, SOLE_FWD } from '../RiderRig';
import { smooth } from './math';
import { applyFK } from './Limbs';
import { footSnow } from './Effects';

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

/** Back on the board: gear to its riding place, poles back in their own hands. */
export function leaveFoot(v: RiderView): void {
  const rig = v.rig;
  rig.board.position.set(0, 0, 0); rig.board.quaternion.identity();
  restCarriers(rig);
  if (rig.rPole && rig.rPole.parent !== rig.bones.RightHand) rig.bones.RightHand.add(rig.rPole);
  if (rig.rPole) rig.rPole.position.set(0, -0.06, 0);
  if (rig.lPole) rig.lPole.position.set(0, -0.06, 0);
  v.footActive = false; v.gaitLive = false;
}

/** Sole centre and boot yaw/pitch -> ankle target and foot orientation (three.js world). */
function footTarget(v: RiderView, x: number, y: number, z: number, yaw: number, pitch: number, outA: THREE.Vector3, outQ: THREE.Quaternion): void {
  const n = v.pack!.groundNormal(x, y) as number[];
  const tilt = v.q.setFromUnitVectors(v.up, v.v1.set(n[0], n[2], -n[1]).normalize());
  outQ.setFromAxisAngle(v.up, -yaw).premultiply(tilt).multiply(v.pq.setFromAxisAngle(v.v2.set(1, 0, 0), pitch));
  outA.set(0, ANKLE_H, SOLE_FWD).applyQuaternion(outQ).add(v.v3.set(x, z, -y));
}

/** Two-bone arm IK to a grip point (world), blended over the FK arm by `w`. */
function handTo(v: RiderView, side: 'Left' | 'Right', grip: THREE.Vector3, w: number): void {
  if (w <= 0) return;
  const B = v.rig.bones;
  const up = B[`${side}Arm`], lo = B[`${side}ForeArm`], end = B[`${side}Hand`];
  v.armSave[0].copy(up.quaternion); v.armSave[1].copy(lo.quaternion);
  // wrist a few cm short of the grip, toward the shoulder (the mitten closes over the edge)
  const sh = up.getWorldPosition(v.v1);
  const target = v.v2.copy(grip).addScaledVector(v.v3.subVectors(sh, grip).normalize(), 0.07);
  const s = side === 'Left' ? -1 : 1;
  const pole = v.v4.set(s * 0.7, -1, 0.4).applyQuaternion(B.Spine2.getWorldQuaternion(v.pq));
  twoBone(up, lo, end, target, pole);
  if (w < 1) {
    up.quaternion.copy(v.armSave[0].slerp(up.quaternion, w));
    lo.quaternion.copy(v.armSave[1].slerp(lo.quaternion, w));
    up.updateMatrixWorld(true);
  }
}

/**
 * Foot mode. `u` runs 0 (strapped in) to 1 (walking, gear carried); the unstrap plays it forward
 * over 0.8 s and the strap-in backward over 1 s: crouch to the bindings (0.08..0.78), front foot
 * steps off (0.38..0.6), back foot (0.5..0.72), the body turns to face forward (0.38..0.75), the
 * hands take the gear (0.55..0.75) and lift it to the carry (0.72..1). At 1 the walk cycle runs.
 */
export function updateFoot(v: RiderView, r: Rider, dt: number, u: number): void {
  const rig = v.rig, B = rig.bones, gait = v.gait!, pack = v.pack!;
  const ski = v.discipline === 'ski';
  if (!v.footActive) { v.footActive = true; v.gaitLive = false; v.prevStep[0] = v.prevStep[1] = u >= 1 ? 1 : 0; }
  v.group.position.set(r.x, r.z, -r.y);
  const deep = footSnow(v, r, dt);
  // stands upright when walking; on the board's slope frame until the gear leaves the snow
  const lift = smooth(0.72, 1, u);
  const n = v.tmpN.set(r.normal[0], r.normal[2], -r.normal[1]).lerp(v.up, lift).normalize();
  const f = v.tmpF.set(Math.sin(r.heading), 0, -Math.cos(r.heading));
  f.addScaledVector(n, -f.dot(n)).normalize();
  const right = v.tmpR.crossVectors(f, n).normalize();
  v.rot.makeBasis(right, n, v.v1.copy(f).negate());
  v.q.setFromRotationMatrix(v.rot);
  v.group.quaternion.slerp(v.q, Math.min(1, dt * 12));
  v.baseQ.copy(v.group.quaternion); // FEAT-110: keep the riding base in step, no swing when strapping back in
  for (const f of [v.leanF, v.rollF, v.yawLeadF, v.edgeUpperF, v.edgeHipsF, v.hipZF, v.balF, v.tipF]) { f.x = 0; f.v = 0; }
  v.twist = 0; v.visLive = false; // BUG-056: the follows snap when strapping back in
  v.lean.position.set(0, 0, 0); v.lean.rotation.set(0, 0, 0);

  // ---- gait (pack coords): runs once fully on foot; until then the feet's standing spots follow the body
  const nz = Math.max(0.2, r.normal[2]);
  const hx = Math.sin(r.heading), hy = Math.cos(r.heading);
  const grade = -(r.normal[0] * hx + r.normal[1] * hy) / nz;
  const fall = Math.hypot(r.normal[0], r.normal[1]);
  // slipping or kicking up steep snow smears the print downhill
  const smearAmt = fall > 0.02 ? 0.12 * smooth(25, 40, r.slopeDeg) + 0.15 * Math.min(1, r.slideSpeed / 2) : 0;
  // FEAT-152: in deep powder the soles sit down by the whole boot sink (0.6 of it in shallower snow)
  const soleShare = 0.6 + 0.4 * deep;
  const gin = { x: r.x, y: r.y, z: r.z, heading: r.heading, vx: r.vx, vy: r.vy, onGround: r.onGround, sink: r.sink, soleShare, sliding: r.slipping,
    smearX: fall > 0.02 ? (r.normal[0] / fall) * smearAmt : 0, smearY: fall > 0.02 ? (r.normal[1] / fall) * smearAmt : 0 };
  if (u >= 1) {
    if (!v.gaitLive) { gait.reset(gin); v.gaitLive = true; }
    gait.update(dt, gin);
  } else { gait.reset(gin); v.gaitLive = false; }

  // ---- pose: board stance (or ski stance) -> walk/sprint, with a crouch bump to reach the bindings
  const t = v.target;
  const stand = smooth(0.38, 0.75, u);
  const sprint = smooth(1.6, 3.4, gait.speed);
  Object.assign(t, clonePose(v.poses.neutral));
  v.crawl += ((r.crawling ? 1 : 0) - v.crawl) * Math.min(1, dt * 5);
  v.shoulder += ((r.sprinting && !r.crawling && !ski ? 1 : 0) - v.shoulder) * Math.min(1, dt * 4);
  v.slip += ((r.slipping ? 1 : 0) - v.slip) * Math.min(1, dt * 8);
  const walk = lerpPose(clonePose(WALK_POSES.walk), WALK_POSES.walk, WALK_POSES.sprint, sprint);
  if (v.crawl > 0.001) lerpPose(walk, walk, WALK_POSES.crawl, v.crawl);
  lerpPose(t, t, walk, stand);
  const crouch = u > 0.08 && u < 0.78 ? Math.sin(Math.PI * (u - 0.08) / 0.7) : 0;
  t.hipsY -= 0.3 * crouch + soleShare * r.sink * stand + 0.12 * v.slip; // sitting into a slip
  if (r.squat > 0) { t.hipsY -= 0.45 * r.squat; t.hipsRot = [t.hipsRot[0] + 0.3 * r.squat, t.hipsRot[1], t.hipsRot[2]]; t.torso = [t.torso[0] + 0.35 * r.squat, t.torso[1], t.torso[2]]; } // on foot: hunker down (FEAT-111)
  // BUG-045 mantle: reach up to the edge, pull the knees up through the middle, then stand
  if (r.mantle > 0) {
    const reach = Math.max(0, 1 - r.mantle / 0.5), knee = Math.sin(Math.PI * r.mantle);
    t.hipsY -= 0.35 * knee; t.torso = [t.torso[0] + 0.5 * knee, t.torso[1], t.torso[2]];
    t.lShoulder = [t.lShoulder[0] + 2.2 * reach + 0.8 * knee, t.lShoulder[1], t.lShoulder[2] * 0.4];
    t.rShoulder = [t.rShoulder[0] + 2.2 * reach + 0.8 * knee, t.rShoulder[1], t.rShoulder[2] * 0.4];
  }
  t.hipsRot = [t.hipsRot[0] + 0.35 * crouch, t.hipsRot[1], t.hipsRot[2]];
  t.torso = [t.torso[0] + 0.5 * crouch - 0.25 * v.slip + 0.4 * Math.max(0, Math.min(0.8, grade)) * stand * Math.min(1, gait.speed), t.torso[1], t.torso[2]];
  t.lShoulder = [t.lShoulder[0] + 0.9 * crouch, t.lShoulder[1], t.lShoulder[2] * (1 - crouch * 0.7)];
  t.rShoulder = [t.rShoulder[0] + 0.9 * crouch, t.rShoulder[1], t.rShoulder[2] * (1 - crouch * 0.7)];
  lerpPose(v.pose, v.pose, t, Math.min(1, dt * 12));
  // the walk cycle on top (not smoothed): hips bob, pelvis and shoulders counter-rotate, free arm swings
  const p = v.pose, save = clonePose(p);
  const a = smooth(0.85, 1, u) * Math.min(1, gait.speed / 1.2);
  const ph = gait.phase * Math.PI * 2;
  p.hipsY += -(0.018 + 0.012 * Math.min(4, gait.speed)) * Math.cos(2 * ph) * a + Math.sin(performance.now() / 1000 * 2.1) * 0.004;
  p.hipsRot = [p.hipsRot[0], p.hipsRot[1] - 0.1 * Math.cos(ph) * a, p.hipsRot[2] + 0.04 * Math.sin(ph) * a];
  p.torso = [p.torso[0], p.torso[1] + 0.12 * Math.cos(ph) * a, p.torso[2]];
  const swing = (0.3 + 0.5 * sprint) * a;
  p.lShoulder = [p.lShoulder[0] - swing * Math.cos(ph), p.lShoulder[1], p.lShoulder[2]];
  p.rShoulder = [p.rShoulder[0] + swing * Math.cos(ph), p.rShoulder[1], p.rShoulder[2]];
  applyFK(v, p, 0);
  Object.assign(p, save);

  // ---- gear on the snow until it is lifted: binding anchors give the feet's start (or end) spots
  const carry = ski ? CARRY.ski : CARRY.board;
  if (lift <= 0) { rig.board.position.set(0, 0, 0); rig.board.quaternion.identity(); restCarriers(rig); }
  v.group.updateMatrixWorld(true);
  const lf = smooth(0.38, 0.6, u), rf = smooth(0.5, 0.72, u);
  if (lf < 1 || rf < 1) {
    rig.anchors.l.getWorldPosition(v.aa[0]); rig.anchors.r.getWorldPosition(v.aa[1]);
    rig.anchors.l.getWorldQuaternion(v.aq[0]); rig.anchors.r.getWorldQuaternion(v.aq[1]);
  }
  for (let i = 0; i < 2; i++) {
    const ft = gait.feet[i];
    footTarget(v, ft.x, ft.y, ft.z, ft.yaw, ft.pitch, v.fa[i], v.fq[i]);
    const k = i === 0 ? lf : rf;
    if (k < 1) {
      // stepping between the binding and the snow beside the board, with a little lift
      v.fa[i].lerpVectors(v.aa[i], v.fa[i], k).addScaledVector(v.up, 0.12 * Math.sin(Math.PI * k));
      v.restQ.copy(v.fq[i]);
      v.fq[i].copy(v.aq[i]).slerp(v.restQ, k);
    }
    // a print where each boot comes down beside the board on the way off
    if (r.strapState === 'off' && v.prevStep[i] < 1 && k >= 1) {
      v.onPlant?.({ side: i as 0 | 1, x: ft.x, y: ft.y, yaw: ft.yaw, speed: 0, kick: 0, smearX: gin.smearX, smearY: gin.smearY });
    }
    v.prevStep[i] = k;
  }
  // knees point along the feet, splayed out a touch
  const fwd = v.v1.set(0, 0, -1).applyQuaternion(v.group.quaternion);
  const lp = v.v3.copy(fwd).addScaledVector(right, -0.15);
  const rp = v.v4.copy(fwd).addScaledVector(right, 0.15);
  v.footGap = solveLegs(rig, v.fa[0], v.fa[1], v.fq[0], v.fq[1], lp, rp, u >= 1 ? 0.25 : Infinity);

  // ---- gear: snow pose (identity under lean) blended to the carry, which rides on the chest
  if (lift > 0) {
    const chest = B.Spine2;
    chest.updateMatrixWorld(true);
    // the carry rides on the chest; bent over in a scramble it keeps the body's upright frame
    // (at the chest) so the gear does not tip into the slope
    const refQ = chest.getWorldQuaternion(v.restQ).slerp(v.group.quaternion, v.crawl);
    v.m2.compose(chest.getWorldPosition(v.v4), refQ, v.v2.set(1, 1, 1));
    // a little swing with the stride
    const sway = v.cq.copy(carry.q);
    if (carry.crawlQ && v.crawl > 0) sway.slerp(carry.crawlQ, v.crawl);
    sway.premultiply(v.q.setFromAxisAngle(v.up, 0.06 * Math.sin(ph) * a));
    v.cp.copy(carry.pos);
    v.cp.y += carry.crawlLift * v.crawl;
    if (!ski && v.shoulder > 0.001) {
      // FEAT-082: up onto the shoulder while sprinting (a smaller stride sway up there)
      sway.slerp(v.q.copy(CARRY.board.shoulderQ).premultiply(v.q2.setFromAxisAngle(v.up, 0.03 * Math.sin(ph) * a)), v.shoulder);
      v.cp.lerp(CARRY.board.shoulderPos, v.shoulder);
    }
    if (ski) v.cp.sub(v.v1.copy(CARRY.ski.balance).applyQuaternion(sway));
    v.m1.compose(v.cp, sway, v.v2.set(1, 1, 1)).premultiply(v.m2);
    v.m2.copy(v.lean.matrixWorld).invert().multiply(v.m1);
    v.m2.decompose(v.v3, v.restQ, v.v4);
    rig.board.position.set(0, 0, 0).lerp(v.v3, lift);
    rig.board.quaternion.identity().slerp(v.restQ, lift);
    if (ski) {
      // skis come together, bases touching
      for (let i = 0; i < rig.carriers.length; i++) {
        const c = rig.carriers[i];
        c.rest.decompose(c.obj.position, c.obj.quaternion, c.obj.scale);
        c.obj.position.lerp(v.v1.set(0, 0, 0), lift);
        if (i === 1) c.obj.quaternion.slerp(v.flipQ, lift);
      }
    }
    rig.board.updateMatrixWorld(true);
  }

  // ---- hands: take hold of the gear (from the snow at 0.55, carried after that)
  const hold = smooth(0.55, 0.75, u);
  if (carry.lGrip) handTo(v, 'Left', rig.board.localToWorld(v.cp.copy(carry.lGrip)), hold);
  handTo(v, 'Right', rig.board.localToWorld(ski ? v.cp.copy(carry.rGrip) : v.cp.copy(carry.rGrip).lerp(CARRY.board.shoulderGrip, v.shoulder)), hold);
  // scrambling: the free (left) hand goes to the snow ahead, lifting in step with the feet
  if (v.crawl > 0.02) {
    const hx = Math.sin(r.heading), hy = Math.cos(r.heading), lx = -Math.cos(r.heading), ly = Math.sin(r.heading);
    const reach = 0.5 + 0.15 * Math.cos(ph);
    const px = r.x + hx * reach + lx * 0.25, py = r.y + hy * reach + ly * 0.25;
    const gz = pack.groundHeight(px, py);
    if (!Number.isNaN(gz)) handTo(v, 'Left', v.cp.set(px, gz + 0.04 + 0.08 * Math.max(0, Math.sin(ph)), -py), v.crawl * hold);
  }
  // skier: both poles in the free (left) hand, hanging down and back
  if (ski && rig.lPole && rig.rPole) {
    if (hold > 0.5 && rig.rPole.parent !== B.LeftHand) { B.LeftHand.add(rig.rPole); }
    if (rig.rPole.parent === B.LeftHand) { rig.lPole.position.set(-0.012, -0.06, 0); rig.rPole.position.set(0.012, -0.06, 0); }
    for (const [s, grip] of [[-1, rig.lPole], [1, rig.rPole]] as const) {
      const dir = v.v2.set(s * 0.04, -1, 0.35).applyQuaternion(v.group.quaternion).normalize();
      setWorldQuat(grip, v.q.setFromUnitVectors(v.v3.set(0, -1, 0), dir));
    }
  }
}
