/** FEAT-288: crashing and the crash slide (was the flat speed decay in sim/Rider.ts) */
import type { Rider } from '../Rider';
import { groundAt } from './Collision';
import {
  CRASH_ARREST, CRASH_ARREST_T, CRASH_ASSIST_MU, CRASH_DRAG, CRASH_LOSS, CRASH_MAX, CRASH_MU_SLIDE, CRASH_MU_SNOW,
  CRASH_MU_TUMBLE, CRASH_TUMBLE_EASE, CRASH_TUMBLE_T, CRASH_UP_SPEED, G, TAKEOFF_LIFT,
  CRASH_DROP,
} from './tuning';

/**
 * Start a crash: down for at least `minTime` s, the speed cut once by `loss` (CRASH_LOSS: a landing
 * slam, a caught edge, a washout, a press slam; 0 for a trunk or wall hit, which has bounced already).
 */
export function startCrash(r: Rider, minTime: number, loss = CRASH_LOSS): void {
  if (r.crashed <= 0) {
    r.crashT = 0; r.crashAir = false;
    r.vx *= 1 - loss; r.vy *= 1 - loss;
    r.speed = Math.hypot(r.vx, r.vy);
  }
  r.crashed = Math.max(r.crashed, minTime);
}

/** body-on-snow friction now: tumbling, then sliding, by the snow here and the fall line setting */
export function crashMu(r: Rider): number {
  const s = r.snow;
  const w = s.groomed + s.powder + s.chop + s.ice + s.slush + s.rock;
  const snow = w > 0 ? (s.groomed * CRASH_MU_SNOW.groomed + s.powder * CRASH_MU_SNOW.powder + s.chop * CRASH_MU_SNOW.chop
    + s.ice * CRASH_MU_SNOW.ice + s.slush * CRASH_MU_SNOW.slush + s.rock * CRASH_MU_SNOW.rock) / w : 1;
  const tumble = Math.min(1, Math.max(0, 1 - (r.crashT - CRASH_TUMBLE_T) / CRASH_TUMBLE_EASE));
  const assist = 1 + CRASH_ASSIST_MU * (1 - Math.min(1, Math.max(0, r.fallLine)));
  return (CRASH_MU_SLIDE + (CRASH_MU_TUMBLE - CRASH_MU_SLIDE) * tumble) * snow * assist;
}

/**
 * One crashed step. Along the snow the body slides: gravity down the fall line, Coulomb friction mu g
 * cos(slope) against the slide (never past a stop, so it can't push the body uphill) and a little
 * drag k v^2. Off a drop it falls (the ground left behind faster than it falls, as followGround
 * judges a takeoff) and lands again. Trunks, rocks and walls still stop it. The crash ends once the
 * minimum time is up and the body is down to CRASH_UP_SPEED on the snow, or at CRASH_MAX.
 */
export function crashStep(r: Rider, dt: number, n: readonly number[]): void {
  const first = r.crashT === 0;
  r.crashT += dt;
  r.crashed -= dt;
  r.hardCarve = r.hardDrive = r.carveShort = r.washout = 0;
  if (r.crashAir) {
    r.vz -= G * dt;
    r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
    const g = groundAt(r, r.x, r.y, r.z);
    if (r.z <= g) {
      // landed: the snow takes the speed into it, and a share of the slide with it
      const n2 = r.pack.groundNormal(r.x, r.y, undefined, r.z) as number[];
      const vn = r.vx * n2[0] + r.vy * n2[1] + r.vz * n2[2];
      if (vn < 0) { r.vx -= vn * n2[0]; r.vy -= vn * n2[1]; }
      const keep = Math.max(0, 1 - 0.03 * Math.max(0, -vn));
      r.vx *= keep; r.vy *= keep;
      r.z = g; r.crashAir = false;
      r.vz = -(r.vx * n2[0] + r.vy * n2[1]) / Math.max(0.2, n2[2]);
    }
  } else {
    const mu = r.crashMu = crashMu(r);
    // gravity along the slope (horizontal part, as the ride step takes it) and the friction against the slide
    const gx = G * n[2] * n[0], gy = G * n[2] * n[1];
    let vx = r.vx + gx * dt, vy = r.vy + gy * dt;
    const spd = Math.hypot(vx, vy);
    const arrest = r.crashT > CRASH_ARREST_T ? CRASH_ARREST * Math.min(1, r.crashT - CRASH_ARREST_T) : 0;
    const dec = (mu * G * n[2] + CRASH_DRAG * spd * spd + arrest) * dt;
    const k = spd > 1e-6 ? Math.max(0, spd - dec) / spd : 0;
    vx *= k; vy *= k;
    r.vx = vx; r.vy = vy;
    r.x += vx * dt; r.y += vy * dt;
    // follow the snow, or leave it where it drops away faster than the body falls
    const g2 = groundAt(r, r.x, r.y, r.z);
    const n2 = r.pack.groundNormal(r.x, r.y, undefined, r.z) as number[];
    const vzSurf = -(vx * n2[0] + vy * n2[1]) / Math.max(0.2, n2[2]);
    const ballistic = r.vz - G * dt;
    // a rollover too sharp to follow at this speed, or a step down (a cliff, a wall's top) deeper than the fall this step
    const rollover = ballistic > vzSurf + TAKEOFF_LIFT && spd > 3;
    const drop = g2 < r.z + ballistic * dt - CRASH_DROP;
    if (!first && (rollover || drop)) {
      r.crashAir = true;
      r.vz = ballistic;
      r.z = Math.max(r.z + r.vz * dt, g2 + 0.02);
    } else { r.z = g2; r.vz = vzSurf; }
  }
  // trunks, rocks and walls: push out and take the speed into them, and most of the rest on a square hit
  if (r.collider) {
    const hit = r.collider.resolve(r.x, r.y, r.z, 0.4);
    if (hit) {
      r.x = hit.x; r.y = hit.y;
      const vn = r.vx * hit.nx + r.vy * hit.ny;
      if (vn < 0) {
        const spd = Math.hypot(r.vx, r.vy) || 1;
        const headOn = -vn / spd;
        r.vx -= vn * hit.nx; r.vy -= vn * hit.ny;
        r.vx *= 1 - 0.8 * headOn; r.vy *= 1 - 0.8 * headOn;
        if (-vn > 3) { r.lastHit = 'wall'; r.hitSpeed = Math.max(r.hitSpeed, -vn); }
      }
    }
  }
  r.speed = Math.hypot(r.vx, r.vy);
  r.squareBoard();
  const capped = r.crashT >= CRASH_MAX;
  if (r.crashed > 0) return;
  if ((r.speed < CRASH_UP_SPEED && !r.crashAir) || (capped && !r.crashAir)) {
    if (capped) { r.vx = r.vy = 0; r.speed = 0; }
    r.crashed = 0; r.crashFall = 0; r.crashSide = 0;
  } else r.crashed = 1e-3; // still sliding (or falling): stay down
}
