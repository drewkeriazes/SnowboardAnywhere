/** The rider's riding pose: the pose blend, the press, the balance arms and the physical layer (split from world/RiderView.ts, FEAT-165) */
import type { RiderView } from '../RiderView';
import { EDGE_FULL, type Rider } from '../../sim/Rider';
import { lerpPose, clonePose, copyPose, type Pose } from '../RiderModel';
import { carveLean, LEAN_HARD, LEAN_MAX } from '../carveLean';
import { BAL_ROLL, BODY_RESPONSE, BUMP_ACC, CORR_KICK, CORR_W, CORR_ZETA, DEEP_FROM, FLAIL_BAL, FLAIL_BASE, FLAIL_BUMP, FLAIL_ELBOW, FLAIL_HOLD, FLAIL_RAMP, FLAIL_SPEED, FLAIL_SWING, FLAIL_VMAX, HIP_YAW_SHARE, LEAD_BLEND, POP_LIFT, POP_T, SKI_HIP_TWIST, YAW_LEAD_CAP } from './tuning';
import { d2r, smooth, wrap, follow } from './math';

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

/**
 * FEAT-125: snowboard press (ollie or nollie load). The upper body rolls over the loaded end and the
 * head, torso and pelvis offsets add to the current pose; the arms blend to the press's balance
 * pose. Returns the pelvis roll added (rad), which the head later takes back out. Writes into the
 * target's own arrays (rebuilt every frame from clonePose / lerpPose, never the shared tables).
 */
function pressPose(v: RiderView, t: Pose, lean: number): number {
  const P = v.poses, Q = lean < 0 ? P.pressTail : P.pressNose, N = P.neutral;
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
export function balanceArms(v: RiderView, r: Rider, dt: number, free: boolean): void {
  const h = Math.min(dt, 0.05), p = v.pose;
  v.clock += h;
  const La = Math.abs(r.lean), ground = free && r.onGround;
  // the pop: leaving the snow with the board loaded
  if (v.wasGround && !r.onGround && free && v.load > 0.3) v.popT = 1;
  v.wasGround = r.onGround;
  v.load = r.onGround ? Math.max(La, Math.min(1, r.jumpCharge)) : 0;
  v.popT = Math.max(0, v.popT - h / POP_T);
  v.holdT = ground && La > 0.3 ? v.holdT + h : Math.max(0, v.holdT - 3 * h);
  // bumps: vertical acceleration through the board, as a share of BUMP_ACC
  const az = h > 0 && ground ? Math.abs(r.vz - v.prevVz) / h : 0;
  v.prevVz = r.vz;
  v.bump += (Math.min(1, az / BUMP_ACC) - v.bump) * Math.min(1, h * 4);
  // correction: the lean's change kicks a damped spring (arms swing against the body's throw)
  const lean = v.fl * r.lean; // FEAT-139: in the rig's frame, so turning round is no kick
  const dL = free ? lean - v.prevLean : 0;
  v.prevLean = lean;
  v.corrV += CORR_KICK * dL - (CORR_W * CORR_W * v.corr + 2 * CORR_ZETA * CORR_W * v.corrV) * h;
  v.corr += v.corrV * h;
  const amp = ground ? smooth(0.2, 0.8, La) * (FLAIL_BASE + FLAIL_HOLD * Math.min(1, v.holdT / FLAIL_RAMP)) * (1 + FLAIL_SPEED * Math.min(FLAIL_VMAX, r.speed) + FLAIL_BUMP * v.bump + (r.pressing ? FLAIL_BAL * smooth(0.2, 1, Math.abs(r.pressBalance)) : 0)) : 0;
  v.flailAmp += (amp - v.flailAmp) * Math.min(1, h * 6);
  const fp = v.fp ? 0.35 : 1, A = v.flailAmp * fp, c = v.clock;
  const wl = wave(WOBBLE.lOut, c), wr = wave(WOBBLE.rOut, c), sl = wave(WOBBLE.lSwing, c), sr = wave(WOBBLE.rSwing, c);
  const pop = v.popT > 0 ? Math.sin(Math.PI * Math.sqrt(1 - v.popT)) * POP_LIFT * fp : 0;
  const lift = Math.abs(v.corr) * 0.5 * fp + pop;
  // abduction is - for the left arm and + for the right; x swings the arm forward (+) or back
  p.lShoulder[2] -= A * wl + lift; p.rShoulder[2] += A * wr + lift;
  p.lShoulder[0] += FLAIL_SWING * A * sl - v.corr * fp; p.rShoulder[0] += FLAIL_SWING * A * sr - v.corr * fp;
  p.lElbow += FLAIL_ELBOW * A * wr; p.rElbow += FLAIL_ELBOW * A * wl;
}

/**
 * The riding pose on the snow for an edge (share of full, the brake side while braking) and a
 * press lean: carve, deep carve, tuck, charge, squat, press, skating, landing and the brake's
 * crouch, blended into `t`. Returns the press's pelvis roll (rad), which the head takes back out.
 */
function ridingPose(v: RiderView, t: Pose, r: Rider, tuck: boolean, b: number, edge: number, lean: number): number {
  const P = v.poses;
  let pressRoll = 0;
  // braking stance: sitting back on the heel edge or kneeling into the toe edge
  if (edge > 0) lerpPose(t, t, P.carveToe, Math.min(1, edge * 1.2)); else if (edge < 0) lerpPose(t, t, P.carveHeel, Math.min(1, -edge * 1.2));
  // FEAT-126: the harder the lean, the lower and more bent: light turns stay relaxed and tall,
  // a full-lean carve drops into the deep pose on the side the body leans to
  const deep = smooth(DEEP_FROM, LEAN_MAX, Math.abs(v.leanAngle)) * (1 - b);
  if (deep > 0) lerpPose(t, t, v.leanAngle > 0 ? P.carveToeDeep : P.carveHeelDeep, deep);
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
    if (v.discipline === 'board') {
      pressRoll = pressPose(v, t, lean);
      // FEAT-140: the pelvis rolls on toward the end the balance is running to (the head takes it back out)
      if (r.pressing) { const lr = BAL_ROLL * v.fl * r.pressBalance; t.hipsRot[2] += lr; pressRoll += lr; }
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

/**
 * The body's inclination into the turn (rad, followed at body speed). True when the rider is live on the
 * snow (not seated, not crashed), which the board roll needs too.
 */
export function incline(v: RiderView, r: Rider, dt: number, seated: boolean, fl: number): boolean {
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
  const edgeAhead = live ? r.predictEdge(v.leadHips) - r.edge : 0;
  const k = Math.min(1, Math.abs(edgeAhead) / LEAD_BLEND) * (1 - r.brakeAmt);
  // FEAT-148: a hard carve lays the body over further, toward the snow
  const leanMax = LEAN_MAX + (LEAN_HARD - LEAN_MAX) * (live ? r.hardCarve : 0);
  const measured = carveLean(latG, leanMax);
  const phi = r.onGround && !seated ? Math.max(-leanMax, Math.min(leanMax, measured + (fl * r.predictIncline(v.leadHips) - measured) * k)) : 0;
  follow(v.leanF, phi, BODY_RESPONSE, dt);
  return live;
}

/** The pose blend from the rider state into `v.target`. Returns the press's pelvis roll (rad), which the head takes back out. */
export function blendPose(v: RiderView, r: Rider, dt: number, tuck: boolean, grab: boolean, seated: boolean, fl: number): number {
  const t = v.target;
  const P = v.poses;
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
    follow(v.edgeUpperF, edgeFor(v.leadUpper), BODY_RESPONSE, dt); follow(v.edgeHipsF, edgeFor(v.leadHips), BODY_RESPONSE, dt);
    pressRoll = ridingPose(v, t, r, tuck, b, v.edgeUpper, fl * r.predictLean(v.leadUpper));
    const h = v.hipsTarget;
    copyPose(h, P.neutral);
    ridingPose(v, h, r, tuck, b, v.edgeHips, fl * r.predictLean(v.leadHips));
    t.hipsY = h.hipsY; t.hipsRot = h.hipsRot; t.lHip = h.lHip; t.rHip = h.rHip; t.lKnee = h.lKnee; t.rKnee = h.rKnee;
  }
  // FEAT-139: the poses turn the chest and head toward the rig's nose. Drawn turned round (riding
  // switch, or goofy) that end trails, so the rider looks the other way along the board instead:
  // over the rig's tail, where they are going. The pose blend below eases the turn after a 180.
  if (fl < 0 && !seated && r.crashed <= 0) { t.torso = [t.torso[0], -t.torso[1], t.torso[2]]; t.head = [t.head[0], -t.head[1], t.head[2]]; }
  return pressRoll;
}

/** The physical layer on top of the poses (turn load, balance arms, the slip twist, the shoulders' lead), eased into `v.pose`. */
export function bodyLayer(v: RiderView, r: Rider, dt: number, free: boolean, yaw: number, pressRoll: number): void {
  const t = v.target;
  // ---- physical layer on top of the poses
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
      if (v.discipline === 'ski') {
        // past 90 deg hold the cap, then fade to no twist by 135 deg (really backwards), so an
        // overshooting hockey stop does not pop the chest back
        if (a > Math.PI / 2) slip = Math.sign(slip) * (Math.PI / 2) * Math.max(0, 1 - (a - Math.PI / 2) / (Math.PI / 4));
      } else if (a > Math.PI / 2) slip = 0; // backwards: no twist
    }
    // BUG-034: a skier's hockey stop keeps the chest square to the fall line while the skis go 84 deg
    // across, so skis take the full slip (to 90 deg) and split it between the pelvis and the chest;
    // the snowboarder keeps 70 % up to 60 deg, all in the chest, on top of the side-on stance
    const ski = v.discipline === 'ski';
    const k = ski ? 1 : 0.7, twistCap = ski ? Math.PI / 2 : 1.05;
    v.twist += (Math.max(-twistCap, Math.min(twistCap, -slip * k)) - v.twist) * Math.min(1, dt * 6);
  } else v.twist *= Math.max(0, 1 - dt * 6);
  // BUG-056: the shoulders turn into the turn ahead of the drawn board: the lag the board carries plus
  // the heading the turn rate reaches leadUpper from now (pack yaw is clockwise, three.js yaw the reverse).
  // Not the swing of a brake: there the shoulders stay down the hill (the slip twist above) and the
  // board swings across under them.
  const ahead = free && r.onGround ? wrap(yaw - v.yawF.x) * (1 - r.brakeAmt) + r.turnRate * v.leadUpper : 0;
  follow(v.yawLeadF, Math.max(-YAW_LEAD_CAP, Math.min(YAW_LEAD_CAP, ahead)), BODY_RESPONSE, dt);
  const hipShare = v.discipline === 'ski' ? SKI_HIP_TWIST : 0;
  const hipYaw = v.discipline === 'ski' ? SKI_HIP_TWIST : HIP_YAW_SHARE;
  t.hipsRot = [t.hipsRot[0], t.hipsRot[1] + v.twist * hipShare - v.yawLead * hipYaw, t.hipsRot[2]];
  t.torso = [t.torso[0], t.torso[1] + v.twist * (1 - hipShare) - v.yawLead * (1 - hipYaw), t.torso[2]];
  if (v.fp) {
    // first person: arms closer to the sides so the front arm is not held level across the view
    t.lShoulder = [t.lShoulder[0], t.lShoulder[1], t.lShoulder[2] * 0.35];
    t.rShoulder = [t.rShoulder[0], t.rShoulder[1], t.rShoulder[2] * 0.35];
  }
  lerpPose(v.pose, v.pose, t, Math.min(1, dt * (r.crashed > 0 ? 6 : 10)));
  v.pressRoll += (pressRoll - v.pressRoll) * Math.min(1, dt * 10);
}
