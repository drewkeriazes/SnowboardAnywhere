/** The edge model (split from sim/Rider.ts, FEAT-165) */
import type { Rider } from '../Rider';
import type { Input } from './types';
import { ANG_SLOW, CATCH_DIG, CATCH_DRIFT, CATCH_DRIFT_SPAN, CATCH_EDGE, CATCH_FLAT, CATCH_GUARD, CATCH_ROUGH, CATCH_SLIP, CATCH_SLIP_SPAN, CHOP_GAP, CHOP_KICK, CHOP_SPEED, CHOP_YAW, EDGE_EASE, EDGE_SNAP, FALL_CLIMB, FALL_EDGE, FALL_FOLLOW, FALL_LEAD_V, FALL_YAW, FALL_YAW_SPEED, FEEL, type Feel, G, GIN_FIGHT, GRIP_EDGE, GRIP_FLAT_REAL, GROOMED_GRIP, HARD_DRIVE_T, HARD_G, HARD_IN, HARD_MIN_SPEED, HARD_PHI, HARD_PSI, HARD_ROLL, HARD_ROLL_MIN, HARD_ROLL_V, HARD_SKID, HARD_SLACK, HARD_STEER, LEAN_IN, PHI_MAX, PRESS_EDGE, SLIP_HOLD, SLIP_WASH, SQUAT_EDGE, SQUAT_GRIP, STEER_YAW, TUCK_EDGE, WASH_DRAIN, WASH_RATE, WASH_SHARE, WASH_SPAN, WASH_V0 } from './tuning';
import { wrap } from './math';
import type { RideStep } from './Ride';
import { groundAt } from './Collision';

/**
 * FEAT-127 / FEAT-148 / FEAT-134 edge and carve, one on-snow step: the hard carve and its washout, the
 * edge rolling toward the steer, the arc it carves, the fall line, the pivot and the chop. Sets the
 * heading. True when a hard carve washed out (the step ends there).
 */
export function carve(r: Rider, c: RideStep, dt: number, input: Input): boolean {
  const { n, ax, ay, hx, hy, lx, ly, spd, F, snow, powder, deepPow, gripBase } = c;
  // ---- FEAT-148 hard carve: the squat key held while steering drives the edge in (eased over HARD_IN)
  const hardWant = !!input.squat && Math.abs(input.steer) > HARD_STEER && !input.brake && r.brakeAmt === 0 && !r.pressing && spd > HARD_MIN_SPEED;
  r.hardCarve = hardWant ? Math.min(1, r.hardCarve + dt / HARD_IN) : Math.max(0, r.hardCarve - dt / HARD_IN);
  const H = r.hardCarve;

  // ---- FEAT-127 edge and carve. Steer sets a target edge angle up to what can be held here; the
  // edge rolls toward it at F.roll, quicker through the flat while it changes sides (BUG-053), so
  // edge to edge takes about 0.3 s. A brake takes the edge over.
  const want = input.steer * edgeCap(r, input, F, powder, spd, deepPow) * (1 - r.brakeAmt);
  r.edgeTarget = want;
  const roll = rollRate(r, F, spd) * dt * (want * r.edge < 0 ? EDGE_SNAP : 1);
  r.edge += Math.max(-roll, Math.min(roll, (want - r.edge) * Math.min(1, dt * EDGE_EASE)));
  const psi = Math.abs(r.edge);
  // the board bent on edge carves an arc of R = Rsc cos(psi), and the rider balances it with
  // tan(phi) = v^2 / (g R), phi being the body's inclination (the edge less the angulation). Slow,
  // the sidecut's arc sets the turn; fast, the arc opens out to the radius the lean can hold.
  // Either way more edge is a tighter turn. The lean balances the edge's load, so on a slope the
  // pull of the fall line helps the turn into it (gIn > 0) and fights it climbing across (gIn < 0,
  // kept at GIN_FIGHT so the end of a turn across the hill is not its weakest part).
  // FEAT-148: a hard carve lets the body lean further (HARD_PHI)
  const phiMax = PHI_MAX + (HARD_PHI - PHI_MAX) * H;
  const gInRaw = (ax * lx + ay * ly) * Math.sign(r.edge);
  const gIn = gInRaw < 0 ? gInRaw * GIN_FIGHT : gInRaw;
  // FEAT-053: soft snow does not hold the sidecut's arc, so the turns come round wider and slower (snow.turn < 1)
  let aLat = balance(psi, spd, snow.turn, F, phiMax, n[2], gIn);
  // FEAT-148: the press asks for the turn of the target edge, driven in over HARD_DRIVE_T once the edge
  // is on the steer's side; the edge only holds the turn its real angle balances (aLat above), and the
  // snow no more than HARD_G g times its grip (gripBase is GROOMED_GRIP on groomed corduroy, plus the squat's bite).
  // Asking more than it holds slides the tail out (a skid); far more at speed, for long, washes out.
  let hardHold = 0;
  r.carveShort = 0;
  if (H > 0) {
    r.hardDrive = r.edge * want > 0 ? Math.min(1, r.hardDrive + dt / HARD_DRIVE_T) : 0;
    const psiAsk = psi + Math.max(0, Math.abs(want) - psi) * r.hardDrive;
    const aAsk = Math.min(HARD_G * G, balance(psiAsk, spd, snow.turn, F, phiMax, n[2], gIn));
    // the snow's grip scales what the edge holds as well as the ceiling: chop and ice let go sooner (1 on corduroy)
    hardHold = Math.min(aLat * Math.min(1, snow.grip), HARD_G * G * gripBase / (GROOMED_GRIP * (1 + SQUAT_GRIP * r.squat)));
    r.carveShort = H * Math.max(0, aAsk - hardHold) / G;
    aLat += (aAsk - aLat) * H;
    // the washout meter: deep powder lets the board plane instead (a deep surfy turn); tracked-out chop and ice do not
    const fast = Math.max(0, (spd - WASH_V0) / WASH_SPAN) * (1 - deepPow);
    const over = (aAsk > 0.5 ? H * Math.max(0, aAsk - hardHold) / aAsk : 0) - WASH_SHARE;
    r.washout = over > 0 && fast > 0 ? r.washout + over * fast * WASH_RATE * dt : Math.max(0, r.washout - WASH_DRAIN * dt);
    if (r.washout >= 1) {
      // the edge lets go: down on the inside of the turn, on the butt heelside or the hip toeside
      const side = Math.sign(r.edge) || 1;
      r.crashed = 1.3; r.crashSide = side; r.crashFall = 0;
      r.onWashout?.(side * r.toeSign);
      r.hardCarve = r.hardDrive = r.carveShort = r.washout = 0;
      r.edge *= 0.3; r.edgeTarget = 0;
      // the tumble starts sliding at once (as the crash branch does from the next step)
      r.x += r.vx * dt; r.y += r.vy * dt;
      r.z = groundAt(r, r.x, r.y, r.z); r.vz = 0;
      r.speed = Math.hypot(r.vx, r.vy);
      return true;
    }
  } else { r.hardDrive = 0; r.washout = Math.max(0, r.washout - WASH_DRAIN * dt); }
  r.carveAcc = aLat;
  // more than the snow holds and the tail slides out: once the board slips past its line the
  // arc lets go of the heading, so the skid settles at a slip angle instead of spinning out
  let hold = 1;
  if (spd > 0.5 && psi > 0) {
    const ahead = wrap(r.heading - Math.atan2(r.vx, r.vy)) * Math.sign(r.edge);
    if (ahead > SLIP_HOLD && ahead < Math.PI / 2) hold = Math.max(0, 1 - (ahead - SLIP_HOLD) / SLIP_WASH);
  }
  const carveRate = spd > 0.1 ? Math.sign(r.edge) * (aLat / spd) * hold : 0;
  // how far the edge's grip is in (the flat base holds little sideways)
  const bite = Math.min(1, psi / GRIP_EDGE);
  // the fall line (FEAT-134): the slope's pull across the heading (+ = downhill is to the right)
  // and the yaw a flat or lightly edged board takes toward it, quicker on steep pitches and when
  // slow, not while the brake has the board swung
  const fall = Math.hypot(n[0], n[1]);
  const gLat = ax * lx + ay * ly;
  let fallRate = 0;
  if (r.fallLine > 0 && spd > 0.3 && psi < FALL_EDGE) {
    const toFall = wrap(Math.atan2(n[0], n[1]) - r.heading);
    const flat = (1 - psi / FALL_EDGE) ** 2 * (1 - r.brakeAmt) * r.fallLine;
    const vA = r.vx * hx + r.vy * hy;
    // the leading end: the nose riding forward, the tail sliding back before the switch turn-round
    const lead = Math.max(-1, Math.min(1, vA / FALL_LEAD_V));
    // pointed up the hill the leading end does not come round: the board slows, stops and slides
    // back tail first into switch; full across the hill, gone by about 135 deg from the fall line
    const down = Math.cos(toFall) * (Math.sign(vA) || 1);
    const climb = down >= 0 ? 1 : Math.max(0, 1 + down / FALL_CLIMB);
    // a flat board follows its slide: the leading end turns toward where the board is going, as
    // gravity bends the slide down the hill. Sliding straight sideways (a flat board let go across
    // the hill from a stand) it does not turn at all: it side-slips, and the downhill edge may catch
    fallRate = FALL_FOLLOW * ((r.vx * lx + r.vy * ly) / spd) * lead * climb * flat;
    // and the weight over the leading foot drops that end a little, less at speed
    if (fall > 0.03) fallRate += FALL_YAW * fall * Math.sin(toFall) * lead * climb * flat / (1 + spd / FALL_YAW_SPEED);
  }
  // slow or flat: a pivot (a skidded turn) straight from the steer, gone by F.pivotFade; from about
  // there on a small steer yaw (STEER_YAW) keeps the board coming round through an edge change.
  // Neither while the board is swung across for a brake: the steer works the brake then (FEAT-133).
  const steerFade = Math.max(0, Math.min(1, spd / F.pivotFade - 0.5));
  // FEAT-148: a hard carve turns on its edge alone (the steer yaw would pull it past the snow's hold)
  let pivotRate = input.steer * ((input.tuck ? F.pivotTuck : F.pivot) * Math.max(0, 1 - spd / F.pivotFade) + STEER_YAW * steerFade * (1 - H)) * (1 - r.brakeAmt);
  // standing on the uphill edge the hill is in the way, so at a crawl the pivot into it is cut: the
  // steer holds the edge instead of spinning the board (FEAT-134); pivoting downhill still runs.
  // Whole for Assisted too, which also needs the edge held to stand
  if (r.fallLine > 0 && spd < 1 && fall > 0.03 && input.steer * gLat < 0) pivotRate *= spd;
  const turnRate = carveRate + pivotRate + fallRate;
  // FEAT-053 chop: tracked-out snow rattles the board, a small random jolt to the heading and a
  // sideways kick every CHOP_GAP s or so, bigger with speed; from the seeded rng so replays match
  if (snow.jolt > 0.05 && spd > 2 && r.brakeAmt === 0) {
    r.chopT -= dt;
    if (r.chopT <= 0) {
      r.chopT = CHOP_GAP * (0.5 + r.rng.next());
      const amp = snow.jolt * Math.min(1, spd / CHOP_SPEED);
      const r1 = r.rng.next() * 2 - 1, r2 = r.rng.next() * 2 - 1;
      r.heading += CHOP_YAW * amp * r1;
      r.vx += lx * CHOP_KICK * amp * r2; r.vy += ly * CHOP_KICK * amp * r2;
      r.chop = Math.min(1, r.chop + amp * (0.4 + 0.6 * Math.abs(r1)));
    }
  } else r.chopT = 0;
  r.turnRate = turnRate;
  r.turnRadius = Math.abs(turnRate) > 1e-3 ? spd / Math.abs(turnRate) : Infinity;
  const dHeading = turnRate * dt;
  r.heading += dHeading;
  c.H = H; c.hardHold = hardHold; c.bite = bite; c.fall = fall; c.gLat = gLat; c.dHeading = dHeading;
  return false;
}

/** The sideways grip, the skid and the edge catch (FEAT-127 / FEAT-134), one on-snow step. */
export function grip(r: Rider, c: RideStep, dt: number): void {
  const { hx, hy, lx, ly, spd, F, snow, gripBase, H, hardHold, bite, swing } = c;
  let { ax, ay } = c;
  // decompose velocity along/across the board
  const vAlong = r.vx * hx + r.vy * hy;
  const vLat = r.vx * lx + r.vy * ly;
  // lateral grip: the most sideways force the snow holds (FEAT-127), a little on the flat base and
  // the rest as the edge rolls in; less off the groomers and on rock and scree (icy, scraped).
  // Swung across for a brake the board is not under the heading, so the edge's push above takes
  // over from it (FEAT-133). With the fall line on (FEAT-134) the flat base holds only a waxed
  // base's friction, so across a slope the board side-slips until an edge is in; a full edge
  // holds the same as before, the edge making up what the base lost.
  const gripFlat = F.gripFlat - (F.gripFlat - GRIP_FLAT_REAL) * r.fallLine;
  let maxLat = G * gripBase * (gripFlat + (F.gripFlat + F.gripEdge - gripFlat) * bite);
  // FEAT-148: a hard carve holds what its edge balances (up to HARD_G), never less than the flat base
  if (H > 0) maxLat += (Math.max(G * gripBase * gripFlat, hardHold * HARD_SLACK) - maxLat) * H;
  // wanted: kill lateral velocity (carve) within a short time
  let latAcc = -vLat / Math.max(0.04, 0.12 - 0.08 * bite);
  const skidding = Math.abs(latAcc) > maxLat;
  if (skidding) latAcc = Math.sign(latAcc) * maxLat;
  latAcc *= 1 - swing;
  r.skid += (Math.max(skidding ? Math.min(1, Math.abs(vLat) / 6) : 0, Math.min(1, r.carveShort / HARD_SKID)) - r.skid) * Math.min(1, dt * 10);
  // the edge catch (FEAT-134, realistic only): the board sliding sideways toward an edge that meets
  // the snow. The snow stops that edge and the rider goes over it, the way the board was sliding
  // (crashSide, so the ragdoll falls that way). A carve never slides sideways enough to qualify
  r.catchRisk = 0;
  if (r.fallLine >= 1 && r.crashed <= 0 && r.brakeAmt === 0 && spd > 0.5) {
    const slipA = Math.asin(Math.min(1, Math.abs(vLat) / spd));
    const exposed = Math.min(1, Math.max(0, (Math.abs(vLat) - CATCH_DRIFT) / CATCH_DRIFT_SPAN)) * Math.min(1, Math.max(0, (slipA - CATCH_SLIP) / CATCH_SLIP_SPAN));
    if (exposed > 0) {
      const lead = r.edge * Math.sign(vLat); // + the leading edge is in, - the trailing edge
      const dig = Math.min(1, Math.max(0, lead / CATCH_EDGE));
      const bare = (1 - dig) * (1 - Math.min(1, Math.max(0, -lead / CATCH_GUARD)));
      const rough = CATCH_ROUGH + snow.jolt + Math.min(1, r.surface.moguls / 0.4);
      r.catchRisk = (CATCH_DIG * dig + CATCH_FLAT * bare * rough) * exposed;
      if (r.rng.next() < r.catchRisk * dt) { r.crashed = 1.3; r.crashSide = Math.sign(vLat); r.crashFall = 0; r.lastHit = 'catch'; }
    }
  }
  ax += latAcc * lx; ay += latAcc * ly;
  r.lateralG += ((latAcc / G) - r.lateralG) * Math.min(1, dt * 12);
  c.ax = ax; c.ay = ay; c.vAlong = vAlong; c.latAcc = latAcc;
}

/**
 * BUG-056: where the edge will be `lead` seconds from now if the steer holds: the step's own ease
 * and roll-rate rule integrated forward in 20 ms substeps, so the prediction moves at the physics
 * roll rate and is continuous through the edge change (a closed form with the quicker through-flat
 * limit jumped when the edge crossed zero). Visual only (the rider view's body lead).
 */
export function edgeIn(r: Rider, lead: number): number {
  if (lead <= 0) return r.edge;
  const F = FEEL[r.discipline], want = r.edgeTarget, n = Math.ceil(lead / 0.02), h = lead / n;
  let e = r.edge;
  const rate = rollRate(r, F, Math.hypot(r.vx, r.vy));
  for (let i = 0; i < n; i++) {
    const roll = rate * h * (want * e < 0 ? EDGE_SNAP : 1);
    e += Math.max(-roll, Math.min(roll, (want - e) * Math.min(1, h * EDGE_EASE)));
  }
  return e;
}

/**
 * BUG-056: the inclination (rad, + toward the toe edge) that balances the edge `lead` seconds from
 * now at the current speed: the carve model's arc, R = Rsc cos(psi), opened out to what the lean
 * can hold, with no slope or skid terms. Visual only (the rider view's crossover).
 */
export function inclineIn(r: Rider, lead: number): number {
  const e = edgeIn(r, lead), psi = Math.abs(e), F = FEEL[r.discipline];
  const spd = Math.hypot(r.vx, r.vy);
  const phi = Math.min(PHI_MAX + (HARD_PHI - PHI_MAX) * r.hardCarve, psi * (1 - F.angulation));
  const aLat = Math.min((spd * spd) / (F.sidecut * Math.cos(psi)), G * r.normal[2] * Math.tan(phi));
  return Math.sign(e) * Math.atan(aLat / G);
}

/**
 * FEAT-127: the lateral acceleration (m/s^2) a board on edge angle p carves: the sidecut's arc,
 * R = Rsc cos(p), opened out to what the lean (capped at phiMax) balances, scaled by the snow's turn
 * factor, plus the fall line's pull into the turn (gIn); nz is the ground normal's up component.
 */
export function balance(p: number, spd: number, turn: number, F: Feel, phiMax: number, nz: number, gIn: number): number {
  return Math.min((spd * spd * turn) / (F.sidecut * Math.cos(p)), Math.max(0, G * nz * Math.tan(Math.min(phiMax, p * (1 - F.angulation))) * turn + gIn));
}

/** FEAT-148: how fast the edge rolls (rad/s): HARD_ROLL times quicker in a hard carve, slowing past HARD_ROLL_V m/s */
export function rollRate(r: Rider, F: Feel, spd: number): number {
  const H = r.hardCarve;
  if (H <= 0) return F.roll;
  const slow = Math.min(1, HARD_ROLL_V / Math.max(1, spd));
  return F.roll * (1 + (HARD_ROLL * Math.max(HARD_ROLL_MIN, slow * slow) - 1) * H);
}

/** BUG-056: where the press lean will be `lead` seconds from now if the input holds (visual only). */
export function leanIn(r: Rider, lead: number): number {
  return lead <= 0 ? r.lean : r.lean + (r.leanTarget - r.lean) * Math.min(1, lead / LEAN_IN);
}

/**
 * FEAT-127: the highest edge angle the rider can hold here (rad). Lower in powder (the board
 * planes), cut by a tuck and a press, raised a little by a squat. Rock and ice take a full edge
 * but hold little (the grip limit), so a hard carve there washes out. Slow, there is little turn
 * force to lean against, so past what the knees and hips angulate a high edge would tip the
 * rider into the hill: the cap is that plus the lean the sidecut's arc needs.
 */
export function edgeCap(r: Rider, input: Input, F: Feel, powder: number, spd: number, deepPow = powder): number {
  let cap = F.psiMax - (F.psiMax - F.psiPowder) * Math.min(1, powder);
  if (input.tuck) cap *= TUCK_EDGE;
  cap = (cap + SQUAT_EDGE * r.squat) * (1 - PRESS_EDGE * Math.abs(r.lean));
  // FEAT-148: a hard carve drives the edge to HARD_PSI (less in deep powder, where the board planes)
  const hardCap = HARD_PSI - (F.psiMax - F.psiPowder) * Math.min(1, deepPow);
  cap += Math.max(0, hardCap - cap) * r.hardCarve;
  const slow = ANG_SLOW + Math.atan((spd * spd) / (G * F.sidecut * Math.cos(Math.abs(r.edge))));
  return Math.max(0, Math.min(cap, slow));
}
