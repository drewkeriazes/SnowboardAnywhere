/** The rider's limbs: FK, leg and arm IK, snow and deck clearance (split from world/RiderView.ts, FEAT-165) */
import * as THREE from 'three';
import type { RiderView } from '../RiderView';
import type { Rider } from '../../sim/Rider';
import { RAGDOLL_RECOVER } from '../Ragdoll';
import type { Pose } from '../RiderModel';
import { pinFeet, twoBone, setWorldQuat, hangCarriersFromFeet, restCarriers, deckY, BONES as BONE_LIST } from '../RiderRig';
import { LEAN_MAX } from '../carveLean';
import { BAL_SHIFT, BOARD_HALF, BODY_RESPONSE, CLEAR_HAND, CLEAR_HIP, CLEAR_KNEE, DECK_CLEAR, DECK_HALF_L, DECK_HALF_W, DEEP_FROM, HAND_DRAG_FROM, HAND_DRAG_FULL, HAND_DRAG_OUT, HAND_DRAG_Y, HEAD_LEVEL, HIP_CLEAR, HIP_SHIFT, PRESS_FLEX, PRESS_REACH, PRESS_TIP, SHIN_TS, THIGH_TS, TIP_SHIFT } from './tuning';
import { d2r, smooth, follow } from './math';
import { balanceArms } from './BodyPose';

/** FK from the blended pose: pelvis, spine, head and arms. Leg angles only stand when seated. */
export function applyFK(v: RiderView, p: Pose, xOff: number, zOff = 0): void {
  const B = v.rig.bones;
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
function snowHeight(v: RiderView, b: THREE.Bone): number {
  return b.getWorldPosition(v.v1).applyMatrix4(v.invG).y;
}

/** FEAT-126: how far the hips must rise (m, along the snow normal) for the knees and the seat to clear the snow. */
function snowDeficit(v: RiderView): number {
  const B = v.rig.bones;
  v.invG.copy(v.group.matrixWorld).invert();
  const knee = CLEAR_KNEE - Math.min(snowHeight(v, B.LeftLeg), snowHeight(v, B.RightLeg));
  return Math.max(0, CLEAR_HIP - snowHeight(v, B.Hips), 2 * knee);
}

/**
 * BUG-066: how far the hips must rise (m, up the body) for the shins, knees and thighs to clear the deck
 * where they pass over the board. The deck is tested in the board's own frame, so it holds with the
 * board rolled further over than the body (the angulation of a hard carve) and tipped in a press.
 */
function deckDeficit(v: RiderView): number {
  const B = v.rig.bones;
  v.invB.copy(v.rig.board.matrixWorld).invert();
  let need = 0;
  for (const [ankle, knee, hip] of [[B.LeftFoot, B.LeftLeg, B.LeftUpLeg], [B.RightFoot, B.RightLeg, B.RightUpLeg]] as const) {
    const a = ankle.getWorldPosition(v.dA).applyMatrix4(v.invB);
    const k = knee.getWorldPosition(v.dK).applyMatrix4(v.invB);
    const h = hip.getWorldPosition(v.dH).applyMatrix4(v.invB);
    const test = (p: THREE.Vector3, q: THREE.Vector3, ts: readonly number[]) => {
      for (const t of ts) {
        const x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t, z = p.z + (q.z - p.z) * t;
        if (Math.abs(x) > DECK_HALF_W || Math.abs(z) > DECK_HALF_L) continue;
        need = Math.max(need, deckY(v.rig, z) + 0.022 + DECK_CLEAR - y);
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
function handsAboveSnow(v: RiderView, hard: number): void {
  const B = v.rig.bones;
  v.invG.copy(v.group.matrixWorld).invert();
  const chestQ = B.Spine2.getWorldQuaternion(v.pq);
  const drag = hard * smooth(HAND_DRAG_FROM, HAND_DRAG_FULL, Math.abs(v.leanAngle));
  const yL = B.LeftHand.getWorldPosition(v.v1).applyMatrix4(v.invG).y, yR = B.RightHand.getWorldPosition(v.v1).applyMatrix4(v.invG).y;
  const inside = yL < yR ? -1 : 1;
  for (const [s, up, lo, end] of [[-1, B.LeftArm, B.LeftForeArm, B.LeftHand], [1, B.RightArm, B.RightForeArm, B.RightHand]] as const) {
    const local = end.getWorldPosition(v.v1).applyMatrix4(v.invG);
    const w = s === inside ? drag : 0;
    if (local.y >= CLEAR_HAND && w <= 0) continue;
    local.y = Math.max(CLEAR_HAND, local.y) + (HAND_DRAG_Y - Math.max(CLEAR_HAND, local.y)) * w;
    local.x += Math.sign(v.leanAngle) * HAND_DRAG_OUT * w;
    const target = local.applyMatrix4(v.group.matrixWorld);
    // elbows out and back, as when holding the gear
    twoBone(up, lo, end, target, v.v2.set(s * 0.7, -1, 0.4).applyQuaternion(chestQ));
  }
}

/** Skier: hands placed by IK in the chest frame, poles aimed at a plant point beside the boots. */
function skiHands(v: RiderView, r: Rider, tuck: boolean, free: boolean): void {
  const rig = v.rig, B = rig.bones;
  const chest = B.Spine2;
  if (free) {
    const tk = tuck ? 1 : Math.min(1, r.jumpCharge + r.landingShock), air = r.onGround ? 0 : 1;
    for (const [side, up, lo, end] of [[-1, B.LeftArm, B.LeftForeArm, B.LeftHand], [1, B.RightArm, B.RightForeArm, B.RightHand]] as const) {
      // chest-frame target: neutral at the waist, tuck in front of the knees, air out to the side
      const t = v.v1.set(side * 0.26, -0.25, -0.28);
      t.lerp(v.v2.set(side * 0.14, -0.15, -0.38), tk * (1 - air));
      t.lerp(v.v2.set(side * 0.38, -0.2, -0.15), air);
      if (v.fp) { t.y += 0.1; t.z -= 0.08; }
      chest.localToWorld(t);
      // elbows out and back
      const pole = v.v2.set(side * 0.7, -0.3, 0.6).applyQuaternion(chest.getWorldQuaternion(v.pq));
      twoBone(up, lo, end, t, pole);
    }
  }
  for (const [side, grip] of [[-1, rig.lPole], [1, rig.rPole]] as const) {
    if (!grip) continue;
    const g = grip.getWorldPosition(v.v1);
    const dir = free
      ? rig.board.localToWorld(v.v2.set(side * 0.34, r.onGround ? 0 : -0.3, r.onGround ? 0.3 : 0.55)).sub(g).normalize()
      : v.v2.set(0, -1, 0.3).normalize();
    setWorldQuat(grip, v.q.setFromUnitVectors(v.v3.set(0, -1, 0), dir));
  }
}

/**
 * FEAT-125: on a press, raise the hips so the leg over the unloaded end reaches nearly straight
 * (the hips already sit over the loaded end, whose leg the IK then bends deep). Less in a squat or
 * a charge, which keep both knees bent. Runs after FK and before the feet are pinned.
 */
function pressLegs(v: RiderView, r: Rider): void {
  const w = Math.max(0, Math.min(1, v.flex / PRESS_FLEX)) * (1 - 0.8 * r.squat) * (1 - 0.5 * Math.min(1, r.jumpCharge));
  if (w < 0.01) return;
  const rig = v.rig, B = rig.bones;
  const tail = v.flexDir < 0; // tail loaded: the front (left, nose side) leg reaches
  const up = tail ? B.LeftUpLeg : B.RightUpLeg, anchor = tail ? rig.anchors.l : rig.anchors.r;
  const s = rig.body.worldToLocal(up.getWorldPosition(v.v1));
  const a = rig.body.worldToLocal(anchor.getWorldPosition(v.v2));
  const reach = B.LeftLeg.position.length() + B.LeftFoot.position.length();
  const dx = a.x - s.x, dz = a.z - s.z, dy = s.y - a.y;
  const c0 = Math.hypot(dx, dy, dz), c = c0 + (PRESS_REACH * reach - c0) * w;
  const r2 = c * c - dx * dx - dz * dz;
  if (r2 <= 0) return;
  B.Hips.position.y += Math.sqrt(r2) - dy;
  B.Hips.updateMatrixWorld(true);
}

/**
 * After the pose: the breathing and balance-arm offsets, the hips over a press and above the deck, FK, the
 * legs pinned to the bindings (raised clear of the snow and the deck), then the head, the hands and the
 * blend back from a ragdoll. Kept as one pass: the breathing offsets go on before FK and the legs and come
 * back off after them.
 */
export function settleBody(v: RiderView, r: Rider, dt: number, tuck: boolean, seated: boolean, free: boolean, fl: number, pv: number): void {
  // idle breathing and balance wobble so a standing rider is not frozen
  const now = performance.now() / 1000;
  const p = v.pose;
  const hy = p.hipsY, tx = p.torso[0];
  const arms = v.armKeep;
  arms[0] = p.lShoulder[0]; arms[1] = p.lShoulder[2]; arms[2] = p.rShoulder[0]; arms[3] = p.rShoulder[2]; arms[4] = p.lElbow; arms[5] = p.rElbow;
  p.hipsY += Math.sin(now * 2.1) * 0.004; p.torso[0] += Math.sin(now * 1.3) * 0.015;
  if (v.discipline === 'board') balanceArms(v, r, dt, free);
  // BUG-047: the hips sit over the loaded end and never below the deck under them
  let hipZ = 0;
  if (v.discipline === 'board' && !seated) {
    // BUG-056: on a press the hips move over the loaded end ahead of the bend (a full lean bends it 0.6)
    const leanH = free && r.onGround ? fl * r.predictLean(v.leadHips) : 0;
    const ahead = Math.sign(leanH) === v.flexDir ? 0.6 * Math.abs(leanH) : 0;
    follow(v.hipZF, Math.max(0, Math.min(1, Math.max(v.flex, ahead) / PRESS_FLEX)), BODY_RESPONSE, dt);
    hipZ = -v.flexDir * HIP_SHIFT * v.hipZF.x;
    // FEAT-140: the hips slide on toward the end the press balance is running to (+ balance: the nose, -z)
    follow(v.balF, free && r.pressing ? fl * r.pressBalance : 0, BODY_RESPONSE, dt);
    hipZ -= BAL_SHIFT * v.balF.x;
    hipZ -= v.flexDir * TIP_SHIFT * Math.max(0, v.tipF.x) / PRESS_TIP; // FEAT-140: on over the tipped board's loaded end
    // FEAT-140: a tipped board's deck rises from the loaded tip toward the hips
    const tipRise = Math.max(0, BOARD_HALF + v.flexDir * hipZ) * Math.sin(Math.max(0, v.tipF.x)); // the hips' distance from the loaded tip
    const floor = deckY(v.rig, hipZ) + 0.022 + HIP_CLEAR + tipRise;
    if (p.hipsY < floor) p.hipsY = floor;
  }
  applyFK(v, p, -pv, hipZ);

  // ---- legs: boots pinned to the bindings, or on a chair the board hangs from the feet
  const rig = v.rig;
  v.group.updateMatrixWorld(true);
  // FEAT-126: on a deep lean the snow can come within reach of the inside knee and the hips
  const nearSnow = free && r.onGround && Math.abs(v.leanAngle) > DEEP_FROM;
  if (seated) {
    hangCarriersFromFeet(rig);
    v.wasSeated = true;
    v.footGap = 0;
  } else {
    if (v.wasSeated) { restCarriers(rig); v.wasSeated = false; }
    // knees point where the pelvis faces (the toe edge for a snowboarder, the tips for a skier);
    // a snowboarder's knees also bow a little toward each other
    const fwd = v.v1.set(0, 0, -1).applyQuaternion(rig.bones.Hips.getWorldQuaternion(v.pq));
    const nose = v.v2.set(0, 0, -1).applyQuaternion(v.lean.getWorldQuaternion(v.pq));
    const k = v.discipline === 'board' ? 0.25 : 0;
    // FEAT-126: on a deep toeside lean the toe edge faces the snow, so both knees drive toward the
    // nose instead (parallel to the snow), keeping the deep bend without the knees going in
    const toeIn = v.discipline === 'board' && v.leanAngle > 0 ? 2.5 * smooth(DEEP_FROM, LEAN_MAX, v.leanAngle) : 0;
    const lp = v.v3.copy(fwd).addScaledVector(nose, toeIn - k);
    const rp = v.v4.copy(fwd).addScaledVector(nose, toeIn + k);
    const press = v.discipline === 'board' && free;
    if (press) pressLegs(v, r);
    v.footGap = pinFeet(rig, lp, rp);
    // FEAT-126: raise the hips until the knees and the seat clear the snow, then solve the legs again.
    // A knee sits about halfway between the hips and the boot, so it rises about half as far.
    // BUG-066: and the legs clear the deck (a hard carve's angulation tips the board toward the shins)
    const deckCheck = v.discipline === 'board' && free && r.onGround;
    if (nearSnow || deckCheck) {
      for (let it = 0; it < 4; it++) {
        const lift = Math.max(nearSnow ? snowDeficit(v) / Math.max(0.4, Math.cos(v.leanAngle)) : 0, deckCheck ? deckDeficit(v) : 0);
        if (lift < 0.003) break;
        p.hipsY += lift;
        applyFK(v, p, -pv, hipZ);
        if (press) pressLegs(v, r);
        v.footGap = pinFeet(rig, lp, rp);
      }
    }
  }
  p.hipsY = hy; p.torso[0] = tx;
  p.lShoulder[0] = arms[0]; p.lShoulder[2] = arms[1]; p.rShoulder[0] = arms[2]; p.rShoulder[2] = arms[3]; p.lElbow = arms[4]; p.rElbow = arms[5];
  // FEAT-125: the head takes most of the press's pelvis roll back out, so it stays up and looks ahead
  // (after the legs, since the FEAT-126 snow clearance can run the FK again)
  if (Math.abs(v.pressRoll) > 1e-3) {
    v.group.updateMatrixWorld(true);
    const ql = v.lean.getWorldQuaternion(v.pq);
    // the roll tips the body toward -Z (the nose) for a positive angle, which is -angle about the rider's X
    v.headQ.setFromAxisAngle(v.v1.set(1, 0, 0), HEAD_LEVEL * v.pressRoll).premultiply(ql).multiply(v.q.copy(ql).invert());
    setWorldQuat(v.rig.bones.Head, v.headQ.multiply(v.rig.bones.Head.getWorldQuaternion(v.q)));
  }
  if (v.discipline === 'ski') skiHands(v, r, tuck, free);
  if (nearSnow) handsAboveSnow(v, r.hardCarve);
  if (v.recoverT > 0) {
    // FEAT-046: ease from the last ragdoll pose into the animated one
    v.recoverT = Math.max(0, v.recoverT - dt);
    const k = 1 - v.recoverT / RAGDOLL_RECOVER, e = k * k * (3 - 2 * k);
    // recoverQ / recoverHips stay fixed at the crash-end pose; only the animated target moves
    BONE_LIST.forEach((b, i) => { const bone = v.rig.bones[b]; bone.quaternion.copy(v.q.copy(v.recoverQ[i]).slerp(bone.quaternion, e)); });
    v.rig.bones.Hips.position.lerpVectors(v.recoverHips, v.rig.bones.Hips.position, e);
    v.rig.body.updateMatrixWorld(true);
  }
}
