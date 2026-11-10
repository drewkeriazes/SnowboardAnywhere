/** Jumps, the air and leaving the snow (split from sim/Rider.ts, FEAT-165) */
import type { Rider } from '../Rider';
import type { Input } from './types';
import { FLIP_DECAY, FLIP_EASE, FLIP_RATE, G, HARD_IN, OLLIE_PITCH, OLLIE_POP, SQUAT_POP, SQUAT_SPRING_WINDOW } from './tuning';
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

/** Follow the ground after a step on the snow, and leave it over a convex rollover at speed (`spd` the speed before the step). */
export function followGround(r: Rider, dt: number, spd: number): void {
  const pack = r.pack;
  // follow the ground; detect leaving it (convex rollovers at speed)
  const g2 = groundAt(r, r.x, r.y, r.z);
  const n2 = pack.groundNormal(r.x, r.y, undefined, r.z) as number[];
  // vertical velocity implied by following the surface
  const vzSurf = -(r.vx * n2[0] + r.vy * n2[1]) / Math.max(0.2, n2[2]);
  const ballistic = r.vz - G * dt;
  // FEAT-059: the 1.5 m/s margin absorbs 1 m DEM noise on open snow, but it also swallows every mogul
  // (a 0.7 m bump at 20 m/s drops away at about 10 g). On a bump field the legs absorb only about 2 g.
  const lift = 1.5 - 1.3 * Math.min(1, r.surface.moguls / 0.4);
  if (ballistic > vzSurf + lift && spd > 6) {
    // the ground drops away faster than we fall: airborne
    r.onGround = false; r.airTime = 0; r.spin = 0; r.flip = 0; r.flipRate = 0;
    r.z = Math.max(r.z, g2 + 0.02);
    r.vz = vzSurf; // start with the surface's vertical speed
  } else {
    r.z = g2;
    r.vz = vzSurf;
  }
  r.speed = Math.hypot(r.vx, r.vy);
  r.maxSpeed = Math.max(r.maxSpeed, r.speed);
  r.distance += spd * dt;
  r.landingShock = Math.max(0, r.landingShock - dt * 3);
}
