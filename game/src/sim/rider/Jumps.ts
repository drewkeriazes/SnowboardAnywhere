/** Jumps, the air and leaving the snow (split from sim/Rider.ts, FEAT-165) */
import type { Rider } from '../Rider';
import type { Input } from './types';
import { FLIP_DECAY, FLIP_EASE, FLIP_RATE, G, HARD_IN, LIP_BEND0, LIP_BEND1, LIP_FLEX, LIP_LIFT, LIP_PRELOAD, LIP_RISE, LIP_SAMPLES, LIP_SPAN, OLLIE_PITCH, OLLIE_POP, SQUAT_POP, SQUAT_SPRING_WINDOW, TAKEOFF_LIFT } from './tuning';
import { poseBoard } from './Brake';
import { endPress } from './Press';
import { land } from './Tricks';
import { groundAt } from './Collision';

/** One step in the air: gravity, spin and flip control, then the landing when the ground comes up. */
export function airStep(r: Rider, dt: number, input: Input): void {
  r.lateralG *= Math.exp(-dt * 4);
  // the board squares up quickly once off the snow
  r.brakeAmt = Math.max(0, r.brakeAmt - dt / 0.15);
  r.brakeAcc = 0; r.scrape *= Math.exp(-dt * 10); r.slip = 0;
  r.edge *= Math.exp(-dt * 5); r.edgeTarget = 0; r.brakePsi *= Math.exp(-dt * 8); r.turnRadius = Infinity; r.turnRate = 0; r.carveAcc = 0; // off the snow the board rolls back flat
  if (r.brakeAmt === 0) r.brakeSide = 0;
  r.hardCarve = Math.max(0, r.hardCarve - dt / HARD_IN); r.hardDrive = 0; r.carveShort = 0; // FEAT-148
  r.vz -= G * dt;
  // air control: spin with steer, slight drift
  r.spin += input.steer * 3.5 * dt;
  r.heading += input.steer * 3.5 * dt;
  // FEAT-110: Up/W pitches forward (front flip), Down/S back (backflip); the rate builds while
  // held and carries on a little after letting go, like real momentum
  const want = (input.tuck ? 1 : 0) - (input.brake ? 1 : 0);
  if (want !== 0) r.flipRate += (want * FLIP_RATE - r.flipRate) * Math.min(1, dt * FLIP_EASE);
  else r.flipRate *= Math.exp(-dt * FLIP_DECAY);
  r.flip += r.flipRate * dt;
  r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
  r.travelYaw += input.steer * 3.5 * dt; // spin carries the swung board round with it
  poseBoard(r);
  r.airTime += dt;
  const g2 = groundAt(r, r.x, r.y, r.z);
  if (r.z <= g2) {
    land(r, g2, input);
  }
  r.speed = Math.hypot(r.vx, r.vy, r.vz);
}

/** Hold to charge, release to pop (impulse along the normal plus the slope direction). True when it popped. */
export function jump(r: Rider, dt: number, input: Input, n: [number, number, number], ground: number): boolean {
  if (input.jumpHeld) r.jumpCharge = Math.min(1, r.jumpCharge + dt * 1.6);
  if (input.jumpReleased && r.jumpCharge > 0.1) {
    // jumping from a deep squat, or within SQUAT_SPRING_WINDOW of standing up from one: a bigger pop
    const spring = r.squat >= 0.6 || r.squatUp < SQUAT_SPRING_WINDOW ? SQUAT_POP : 1;
    // FEAT-112: popped off a loaded tail (ollie) or nose (nollie): the board's spring
    const flex = Math.abs(r.lean) > 0.5 ? OLLIE_POP : 1;
    const pop = (2.5 + 4.5 * r.jumpCharge) * spring * flex;
    r.vx += n[0] * pop; r.vy += n[1] * pop; r.vz = n[2] * pop + Math.max(0, -(r.vx * n[0] + r.vy * n[1]));
    r.onGround = false; r.airTime = 0; r.spin = 0; r.flip = 0; r.flipRate = 0; r.jumpCharge = 0;
    if (flex > 1) r.flipRate = r.lean * OLLIE_PITCH; // an ollie leaves you rotating back a little, a nollie forward
    if (r.pressing) endPress(r, 'clean'); // FEAT-140: popped out of a press (W / S flip again at once)
    r.z = ground + 0.05;
    return true;
  }
  if (!input.jumpHeld) r.jumpCharge = Math.max(0, r.jumpCharge - dt * 3);
  return false;
}

/** Follow the ground after a step on the snow, and leave it over a convex rollover at speed (`spd` the speed
 *  before the step, `n` the ground normal it started on). */
export function followGround(r: Rider, dt: number, spd: number, n: readonly number[]): void {
  const pack = r.pack;
  // follow the ground; detect leaving it (convex rollovers at speed)
  const g2 = groundAt(r, r.x, r.y, r.z);
  const n2 = pack.groundNormal(r.x, r.y, undefined, r.z) as number[];
  // vertical velocity implied by following the surface
  const vzSurf = -(r.vx * n2[0] + r.vy * n2[1]) / Math.max(0.2, n2[2]);
  const ballistic = r.vz - G * dt;
  // FEAT-059: the 1.5 m/s margin absorbs 1 m DEM noise on open snow, but it also swallows every mogul
  // (a 0.7 m bump at 20 m/s drops away at about 10 g). On a bump field the legs absorb only about 2 g.
  const bumps = Math.min(1, r.surface.moguls / 0.4);
  let lift = TAKEOFF_LIFT - (TAKEOFF_LIFT - 0.2) * bumps;
  // FEAT-277: a real lip or side hit bends over sharply along the line of travel; there the margin
  // shrinks to what the legs soak up. Only looked at when the ground is falling away at all, and only
  // leaving it climbing at LIP_RISE or more (a lip sends you up). Not on a bump field: there the legs
  // soak up every face (FEAT-059), or a steep bump run throws you to a crash.
  if (bumps < 1 && ballistic > spd * LIP_RISE && ballistic > vzSurf + LIP_LIFT && ballistic <= vzSurf + lift && spd > 6) {
    lift += (LIP_LIFT - lift) * lipShare(r) * (1 - bumps);
  }
  if (ballistic > vzSurf + lift && spd > 6) {
    // the ground drops away faster than we fall: airborne
    r.onGround = false; r.airTime = 0; r.spin = 0; r.flip = 0; r.flipRate = 0;
    r.z = Math.max(r.z, g2 + 0.02);
    // FEAT-277: keep the upward speed carried up the face (it used to be reset to the surface past the
    // lip, so a ramp dropped you off instead of sending you). At most the face's own vertical speed for
    // the velocity now, so a vz left over from a landing's speed loss or a wall bounce can't fling you.
    // On a bump field the legs have soaked up the face, so you leave with the surface's speed as before.
    const vzFace = -(r.vx * n[0] + r.vy * n[1]) / Math.max(0.2, n[2]) - G * dt;
    const keep = Math.max(vzSurf, Math.min(ballistic, vzFace));
    r.vz = vzSurf + (keep - vzSurf) * (1 - bumps);
    // leaving a lip climbing with the board pre-loaded (the jump held, or a press) springs you up a little
    // more; not off bumps, which the legs soak up
    if (bumps < 1 && r.vz > spd * LIP_RISE) {
      const flex = LIP_FLEX * Math.max(0, Math.abs(r.lean) - 0.5) / 0.5;
      r.vz += LIP_PRELOAD * Math.max(r.jumpCharge, flex) * (1 - bumps);
      r.jumpCharge = 0; // the held jump is spent on the lip
    }
  } else {
    r.z = g2;
    r.vz = vzSurf;
  }
  r.speed = Math.hypot(r.vx, r.vy);
  r.maxSpeed = Math.max(r.maxSpeed, r.speed);
  r.distance += spd * dt;
  r.landingShock = Math.max(0, r.landingShock - dt * 3);
}

/** FEAT-277: how much the snow here is a lip, 0 (open snow) to 1: the slope behind the rider minus the
 *  slope ahead, along the line of travel, each a least-squares fit to the terrain at 1 to LIP_SPAN m
 *  (LIP_SAMPLES points). Over that span 1 m elevation noise averages out, while a side hit or kicker
 *  lip stands out. Terrain only, like the surface speed it is compared with. */
function lipShare(r: Rider): number {
  const p = r.pack, h = Math.hypot(r.vx, r.vy), ux = r.vx / h, uy = r.vy / h;
  const h0 = p.groundHeight(r.x, r.y, r.z);
  let back = 0, ahead = 0, kk = 0;
  for (let i = 1; i <= LIP_SAMPLES; i++) {
    const d = LIP_SPAN * i / LIP_SAMPLES;
    back += (h0 - p.groundHeight(r.x - ux * d, r.y - uy * d, r.z)) * d;
    ahead += (p.groundHeight(r.x + ux * d, r.y + uy * d, r.z) - h0) * d;
    kk += d * d;
  }
  const bend = (back - ahead) / kk;
  const t = Math.min(1, Math.max(0, (bend - LIP_BEND0) / (LIP_BEND1 - LIP_BEND0)));
  return t * t * (3 - 2 * t);
}
