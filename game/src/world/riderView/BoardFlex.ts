/** The board as drawn (split from world/RiderView.ts, FEAT-165) */
import type { RiderView } from '../RiderView';
import { EDGE_FULL, type Rider } from '../../sim/Rider';
import { bendBoard } from '../RiderRig';
import { BAL_BEND, BEND_MAX, BOARD_HALF, EDGE_OFF, EDGE_PIVOT_ROLL, FLEX_W, FLEX_ZETA, LEAN_TIP, PRESS_BEND, PRESS_TIP, SKI_EDGE_OFF, TIP_RESPONSE } from './tuning';
import { follow } from './math';

/**
 * The board as drawn on the snow: its roll onto the edge (FEAT-127, a lagged follow, BUG-056), the pivot
 * about the engaged edge, the snowboard's flex (FEAT-118) and press tip (FEAT-140) or the skis' tip-up
 * (FEAT-112). Returns the edge pivot's offset (m), which the hips follow.
 */
export function boardPose(v: RiderView, r: Rider, dt: number, seated: boolean, fl: number, snap: boolean, live: boolean): number {
  // FEAT-127: the board rolls onto the sim's real edge angle (the brake's snow cut while braking),
  // further over than the body: the knees and hips make up the difference (angulation).
  // BUG-056: drawn boardLag behind the physics edge (the same snap rules as the yaw), and never
  // rolled further onto the engaged edge than the physics has it, so the lag cannot bury it.
  const bk = r.brakeSide !== 0 ? r.brakeAmt : 0;
  const rollT = live ? fl * (r.edgeAngle * EDGE_FULL * (1 - bk) + r.brakeSide * (r.brakePsi ?? 0) * bk) : 0;
  v.rollPhys = rollT;
  if (snap) { v.rollF.x = rollT; v.rollF.v = 0; } else follow(v.rollF, rollT, v.boardLag, dt);
  // easing off the edge the drawn board may not trail behind the physics (it would be rolled further than
  // the edge is), so there it catches up with a quarter of the lag: still a smooth follow, no snap
  if (live && v.rollF.x * rollT >= 0 && Math.abs(v.rollF.x) > Math.abs(rollT)) follow(v.rollF, rollT, v.boardLag / 4, dt);
  // the board and the rider roll together about the engaged edge so it stays in the snow, then the
  // board rolls on by `ex` about that same edge. The pivot slides out from the middle of the base
  // to the edge (EDGE_OFF) over the first EDGE_PIVOT_ROLL of roll, so an edge change never pops.
  const pv = EDGE_OFF * Math.max(-1, Math.min(1, v.rollF.x / EDGE_PIVOT_ROLL));
  const ex = v.rollF.x - v.leanAngle;
  v.lean.position.set(pv, 0, 0);
  v.lean.rotation.set(0, 0, -v.leanAngle); // positive lateralG tips +Y toward +X
  if (v.discipline === 'board') v.rig.board.position.set(-pv * Math.cos(ex), pv * Math.sin(ex), 0);
  else { v.rig.board.position.set(-pv, 0, 0); if (!seated) rollSkis(v, ex, pv / EDGE_OFF); }
  // FEAT-112: the board tips up about its loaded end, up to 18 deg: nose up on a lean back (ollie,
  // tail press), tail up on a lean forward (nollie, nose press). The feet ride the bindings with it.
  const L = fl * (r.lean ?? 0); // FEAT-139: the heading's nose is the rig's tail riding turned round
  if (v.discipline === 'board') {
    // FEAT-118: the snowboard bends instead: tail flat, arched from the back foot, nose up.
    // The load grows with the lean and the jump charge and lets go in the air (the pop).
    v.rig.board.rotation.set(0, 0, -ex);
    let target = seated || !r.onGround ? 0 : Math.abs(L) * (0.6 + 0.4 * Math.min(1, r.jumpCharge));
    // FEAT-140: a balanced press bends deeper, and deeper still as the balance runs to the loaded end
    // (flatter toward the other end; a jump charge still adds its load on top)
    if (r.pressing && r.onGround && !seated) target = Math.min(BEND_MAX, Math.abs(L) * (PRESS_BEND * (1 + BAL_BEND * r.pressBalance * r.pressDir) + 0.4 * Math.min(1, r.jumpCharge)));
    // BUG-048: a lean to the other end first lets the board come back to flat, and only then bends it
    // the other way (switching while still bent swapped nose-up for tail-up in one frame)
    if (Math.abs(L) > 0.01 && Math.sign(L) !== v.flexDir) {
      if (Math.abs(v.flex) < 0.05) v.flexDir = Math.sign(L);
      else target = 0;
    }
    const h = Math.min(dt, 0.05);
    v.flexV += (FLEX_W * FLEX_W * (target - v.flex) - 2 * FLEX_ZETA * FLEX_W * v.flexV) * h;
    v.flex += v.flexV * h;
    bendBoard(v.rig, v.flex, v.flexDir);
    // FEAT-140: deep in a press the whole board tips up about its loaded tip, which stays on the snow
    const deep = Math.max(0, Math.min(1, 0.5 + 0.5 * r.pressBalance * r.pressDir));
    // (in the air, a held press key tips it half way: set up to land into the press)
    const tipTo = seated ? 0 : r.pressing && r.onGround ? Math.abs(L) * PRESS_TIP * deep : !r.onGround && r.crashed <= 0 ? Math.abs(L) * PRESS_TIP * 0.5 : 0;
    follow(v.tipF, tipTo, TIP_RESPONSE, dt);
    if (v.tipF.x > 1e-3) {
      const sz = v.flexDir < 0 ? 1 : -1, end = sz * BOARD_HALF; // the loaded end's local z (+z the tail)
      v.rig.board.rotation.set(sz * v.tipF.x, 0, -ex); // +x lifts the nose (-z)
      v.pivot.set(0, 0, end);
      v.rig.board.position.add(v.pivot).sub(v.v2.set(0, 0, end).applyQuaternion(v.rig.board.quaternion));
    }
  } else if (Math.abs(L) > 0.01 && !seated) {
    const end = L < 0 ? BOARD_HALF : -BOARD_HALF; // the end that stays down (local -Z is the nose)
    v.rig.board.rotation.set((L < 0 ? 1 : -1) * Math.abs(L) * LEAN_TIP, 0, 0);
    v.pivot.set(0, 0, end);
    v.rig.board.position.add(v.pivot).sub(v.v2.set(0, 0, end).applyQuaternion(v.rig.board.quaternion));
  } else v.rig.board.rotation.set(0, 0, 0);
  return pv;
}

/** FEAT-127: roll each ski by `ex` past the body's lean, about its own edge on the turn's side (`side` -1..1) */
function rollSkis(v: RiderView, ex: number, side: number): void {
  for (const c of v.rig.carriers) {
    const x0 = c.rest.elements[12], e = side * SKI_EDGE_OFF;
    c.obj.rotation.set(0, 0, -ex);
    c.obj.position.set(x0 + e - e * Math.cos(ex), e * Math.sin(ex), 0);
  }
}
