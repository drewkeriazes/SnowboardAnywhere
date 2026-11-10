/** The brake (split from sim/Rider.ts, FEAT-165) */
import type { Rider } from '../Rider';
import type { Input } from './types';
import { BRAKE_MAX, BRAKE_MOD_IN, BRAKE_TRENCH, BRAKE_TRENCH_T, D2R, G, GAMMA_HARD, GAMMA_SOFT, HEAD_FOLLOW, PARK_SPEED, PLOUGH_SPEED, PSI_DIG, PSI_SOFT, STOP_GAMMA, SWING_IN, SWING_OUT } from './tuning';
import { wrap } from './math';
import type { RideStep } from './Ride';

/**
 * FEAT-065 / FEAT-133 brake, one on-snow step: swing the board across the direction of travel (a hockey
 * stop), the steer working the swing and the edge, and the snow cut that brakes and turns the rider.
 */
export function brake(r: Rider, c: RideStep, dt: number, input: Input): void {
  const { n, spd, F, rock, dHeading } = c;
  let { ax, ay } = c;
  // brake: swing the board across the direction of travel (a hockey stop). Steer picks the
  // side (right = the heading's right-hand edge: toeside riding regular, heelside switch or goofy);
  // otherwise the edge already engaged, else heelside (FEAT-139: whichever side the heel is on).
  // brakeSide +1 rotates the board clockwise from the travel direction, which leaves the left-hand
  // edge leading and the right-hand edge trailing (the uphill edge, cutting the snow); -1 the reverse.
  if (spd > 0.5) r.travelYaw = Math.atan2(r.vx, r.vy);
  else r.travelYaw += dHeading; // stopped: steering turns the board where it stands
  if (input.brake) {
    if (r.brakeSide === 0) {
      r.brakeSide = input.steer > 0.1 ? 1 : input.steer < -0.1 ? -1 : r.edgeAngle * r.toeSign > 0.3 ? r.toeSign : -r.toeSign;
      r.brakeGamma = r.discipline === 'ski' && spd < PLOUGH_SPEED ? 0 : STOP_GAMMA;
      r.brakeMod = 0;
    }
    r.brakeAmt = Math.min(1, r.brakeAmt + dt / SWING_IN);
  } else if (r.brakeAmt > 0) {
    if (spd < PARK_SPEED && r.brakeGamma > 0) {
      // released while (nearly) stopped: stay standing across the hill
      r.heading = r.boardYaw;
      r.squareBoard();
    } else {
      r.brakeAmt = Math.max(0, r.brakeAmt - dt / SWING_OUT);
      if (r.brakeAmt === 0) r.brakeSide = 0;
    }
  }
  // FEAT-133: steer works the brake while it is held: toward the brake side digs the edge in and
  // squares the board up (a harder stop), away lets the edge off and opens the swing (a skidded
  // turn, a drift down the fall line); eased so nothing snaps
  const modWant = input.brake && r.brakeSide !== 0 && r.brakeGamma > 0 ? Math.max(-1, Math.min(1, input.steer * r.brakeSide)) : 0;
  r.brakeMod += (modWant - r.brakeMod) * Math.min(1, dt / BRAKE_MOD_IN);
  const swing = poseBoard(r);
  r.slip = spd > 0.5 ? wrap(r.boardYaw - Math.atan2(r.vx, r.vy)) : 0;
  // while the board is swung the steering axis follows the direction of travel, so the carve grip
  // below does not fight the edge's push and the board rides off on its new line when the brake lets go
  if (swing > 0 && spd > 0.5) r.heading += wrap(r.travelYaw - r.heading) * Math.min(1, dt * HEAD_FOLLOW) * swing;
  // snow cut (FEAT-133): the edge resists the board's slide across itself with up to
  // a = g cos(alpha) tan(Psi), pushing at right angles to the board. Psi ramps with the swing and
  // rises with the slope (riders tip further on steeper pitches) so a brake can hold anywhere up
  // to about 55 degrees, and the steer digs it in or lets it off. The push against the direction
  // of travel is the braking, a = g cos(alpha) tan(Psi) sin(gamma); the push across it turns the
  // rider toward the edge. The dug-in edge also drags along its own length (BRAKE_TRENCH of the
  // cut), so the slide settles instead of running on along the board. On a steep pitch a soft edge
  // cannot hold the slope's pull across the board and the rider side-slips. Skis below PLOUGH_SPEED
  // snowplough with a flat drag instead.
  let brakeAcc = 0, plough = 0;
  r.brakePsi = 0;
  if (swing > 0) {
    if (r.brakeGamma > 0) {
      const cutMax = Math.min(68, Math.max(45, r.slopeDeg + 12)) * D2R;
      let cut = 15 * D2R + (cutMax - 15 * D2R) * swing;
      cut += r.brakeMod > 0 ? (Math.min(68 * D2R, cutMax + PSI_DIG) - cut) * r.brakeMod : (Math.max(cut, PSI_SOFT) - PSI_SOFT) * r.brakeMod;
      const bx = Math.cos(r.boardYaw), by = -Math.sin(r.boardYaw); // the board's right-hand side
      const fx = Math.sin(r.boardYaw), fy = Math.cos(r.boardYaw); // along the board
      const nvx = r.vx + ax * dt, nvy = r.vy + ay * dt; // after this step's gravity, so a dug-in edge holds on a slope
      const aMax = Math.min(BRAKE_MAX, G * n[2] * Math.tan(cut)) * (1 - 0.4 * rock);
      const aB = -Math.max(-aMax, Math.min(aMax, (nvx * bx + nvy * by) / dt));
      const aF = -Math.max(-aMax * BRAKE_TRENCH, Math.min(aMax * BRAKE_TRENCH, (nvx * fx + nvy * fy) / BRAKE_TRENCH_T)) * swing;
      ax += aB * bx + aF * fx; ay += aB * by + aF * fy;
      // the deceleration along the travel direction, for spray, sound, the track and the lean;
      // standing on the brake it reads the cut's full hold so the stance stays dug in
      brakeAcc = spd > 0.5 ? -(aB * (bx * r.vx + by * r.vy) + aF * (fx * r.vx + fy * r.vy)) / spd : aMax * Math.sin(r.brakeGamma) * swing;
      r.brakePsi = cut;
    } else plough = F.brake * G * swing;
  }
  r.brakeAcc = brakeAcc;
  r.scrape += (Math.min(1, (brakeAcc * spd) / 50) - r.scrape) * Math.min(1, dt * 10);
  c.ax = ax; c.ay = ay; c.swing = swing; c.plough = plough;
}

/**
 * Set boardYaw from the heading and the brake swing: eased from the heading toward the stop
 * angle off the travel direction. Returns the eased swing (0..1).
 */
export function poseBoard(r: Rider): number {
  const a = r.brakeAmt;
  const e = a * a * (3 - 2 * a);
  if (e === 0 || r.brakeSide === 0) { r.boardYaw = r.heading; return 0; }
  const target = r.travelYaw + r.brakeSide * stopAngle(r);
  r.boardYaw = r.heading + wrap(target - r.heading) * e;
  return e;
}

/** FEAT-133: the board angle to travel this brake is swinging to: the stop angle, squared up toward
 *  GAMMA_HARD steering into the edge or opened out toward GAMMA_SOFT steering away (0 = snowplough) */
function stopAngle(r: Rider): number {
  if (r.brakeGamma <= 0) return 0;
  const m = r.brakeMod;
  return m >= 0 ? STOP_GAMMA + (GAMMA_HARD - STOP_GAMMA) * m : STOP_GAMMA + (STOP_GAMMA - GAMMA_SOFT) * m;
}
