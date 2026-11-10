/** FEAT-067 on foot: strapping in and out, walking, climbing and slipping (split from sim/Rider.ts, FEAT-165) */
import type { Rider } from '../Rider';
import type { SnowState } from '../SnowConditions';
import type { Input } from './types';
import { BACK, BODY_L, CLIMB_MAX, CLIMB_UP, CRAWL, CRAWL_MAX, D2R, G, JOG, MANTLE_PROBE, MANTLE_TIME, SPRINT, STAMINA, STAMINA_RESUME, STEP_TIME, STEP_UP, STRAP_TIME, UNSTRAP_TIME, WALK } from './tuning';
import { groundAt, collide } from './Collision';

/**
 * How far a boot sinks (m): 70% of the snow depth under the rider (FEAT-053), at least 4 mm. It
 * follows the day's conditions: deeper after a storm, a few cm in chop and slush, almost nothing
 * on ice or rock. Drives the walking speed, the boot height and the print depth.
 */
export function bootSink(snow: SnowState): number {
  return Math.max(0.004, snow.depth * 0.7);
}

/** Unstrapping or strapping in: stand where you are while the bindings are worked. */
export function strapStep(r: Rider, dt: number, ground: number): void {
  const f = Math.exp(-dt * 8);
  r.vx *= f; r.vy *= f;
  r.x += r.vx * dt; r.y += r.vy * dt;
  r.z = ground; r.vz = 0; r.onGround = true;
  r.speed = Math.hypot(r.vx, r.vy);
  r.edge = 0; r.turnRadius = Infinity; r.turnRate = 0; r.carveAcc = 0; r.lateralG = 0; r.skid = 0; r.jumpCharge = 0; r.landingShock = 0;
  r.sink = bootSink(r.snow);
  r.squareBoard();
  r.strapT += dt;
  if (r.strapState === 'off' && r.strapT >= UNSTRAP_TIME) {
    r.strapState = 'none'; r.onFoot = true; r.strapT = 0;
    r.stamina = STAMINA; r.tired = false;
    r.walkVx = r.vx; r.walkVy = r.vy; r.slideVx = r.slideVy = 0;
  } else if (r.strapState === 'on' && r.strapT >= STRAP_TIME) {
    r.strapState = 'none'; r.onFoot = false; r.strapT = 0;
    r.vx = r.vy = 0; r.speed = 0;
    // FEAT-139: strapped in the normal stance; goofy is drawn turned round, so the heading turns
    // round under it and the rider on screen stays put
    r.switch = false;
    if (r.toeSign < 0) { r.heading += Math.PI; r.squareBoard(); }
  }
}

/**
 * On foot (FEAT-067). Steer turns, tuck walks forward, brake walks backward slowly, grab (Shift)
 * sprints for a few seconds of stamina, jump hops. Speed falls with the uphill grade and with how
 * far the boots sink; slopes over CLIMB_MAX cannot be climbed (you slide back), and past
 * SLIP_SLOPE you slip down whatever you do. Same colliders as riding.
 */
export function walkStep(r: Rider, dt: number, input: Input, n: [number, number, number], ground: number): void {
  r.sink = bootSink(r.snow);
  r.edge = 0; r.turnRadius = Infinity; r.turnRate = 0; r.carveAcc = 0; r.lateralG = 0; r.skid = 0; r.jumpCharge = 0;
  r.landingShock = Math.max(0, r.landingShock - dt * 3);
  r.squareBoard();
  // hop on the press edge
  const hop = input.jumpHeld && !r.hopHeld;
  r.hopHeld = input.jumpHeld;
  // BUG-045: a mantle in progress: up the wall first, then over the edge, then stand
  if (r.mantle > 0) {
    r.mantle = Math.min(1, r.mantle + dt / MANTLE_TIME);
    const a = r.mantleFrom, b = r.mantleTo, m = r.mantle;
    const up = Math.min(1, m / 0.6), over = Math.max(0, (m - 0.45) / 0.55);
    const ease = (t: number) => t * t * (3 - 2 * t);
    r.x = a[0] + (b[0] - a[0]) * ease(over); r.y = a[1] + (b[1] - a[1]) * ease(over);
    r.z = a[2] + (b[2] - a[2]) * ease(up);
    r.vx = r.vy = r.vz = r.walkVx = r.walkVy = r.slideVx = r.slideVy = 0; r.speed = 0;
    r.onGround = true;
    if (r.mantle >= 1) r.mantle = 0;
    return;
  }
  // BUG-045: a step up onto a low ledge, eased so the camera and board do not pop; the walk
  // velocity is kept so you carry on at the same pace once up
  if (r.stepT > 0) {
    r.stepT = Math.min(1, r.stepT + dt / STEP_TIME);
    const a = r.mantleFrom, b = r.mantleTo, m = r.stepT;
    const up = Math.min(1, m / 0.6), ease = (t: number) => t * t * (3 - 2 * t);
    r.x = a[0] + (b[0] - a[0]) * m; r.y = a[1] + (b[1] - a[1]) * m;
    r.z = a[2] + (b[2] - a[2]) * ease(up);
    r.vz = 0; r.onGround = true;
    r.speed = Math.hypot(r.walkVx, r.walkVy);
    r.distance += r.speed * dt;
    if (r.stepT >= 1) r.stepT = 0;
    return;
  }
  // BUG-045: jump into a chest-high ledge (a deck, platform or low roof) to climb onto it
  if (hop && r.onGround && r.collider) {
    const hx0 = Math.sin(r.heading), hy0 = Math.cos(r.heading);
    const px = r.x + hx0 * MANTLE_PROBE, py = r.y + hy0 * MANTLE_PROBE;
    const top = r.collider.floorAt(px, py, r.z, CLIMB_UP);
    if (top > r.z + STEP_UP * 0.5) {
      r.mantleFrom[0] = r.x; r.mantleFrom[1] = r.y; r.mantleFrom[2] = r.z;
      r.mantleTo[0] = r.x + hx0 * (MANTLE_PROBE + 0.2); r.mantleTo[1] = r.y + hy0 * (MANTLE_PROBE + 0.2); r.mantleTo[2] = top;
      if (r.collider.floorAt(r.mantleTo[0], r.mantleTo[1], r.z, CLIMB_UP) < top) { r.mantleTo[0] = px; r.mantleTo[1] = py; }
      r.mantle = 1e-3;
      return;
    }
  }
  if (!r.onGround) {
    r.vz -= G * dt;
    r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
    r.airTime += dt;
    const g2 = groundAt(r, r.x, r.y, r.z);
    if (r.z <= g2) { r.z = g2; r.vz = 0; r.onGround = true; r.airTime = 0; r.landingShock = 0.3; }
    collide(r, 0.3);
    r.speed = Math.hypot(r.vx, r.vy);
    return;
  }
  r.heading += input.steer * (r.sprinting ? 2.0 : 2.6) * dt;
  const hx = Math.sin(r.heading), hy = Math.cos(r.heading);
  const fwd = input.tuck ? 1 : input.brake ? -1 : 0;
  // stamina: a few seconds of sprint, then a run until it comes back
  const wantSprint = input.grab && fwd > 0;
  if (r.stamina <= 0) r.tired = true;
  if (r.tired && r.stamina >= STAMINA_RESUME) r.tired = false;
  r.sprinting = wantSprint && !r.tired && r.speed > 0.5;
  if (r.sprinting) r.stamina = Math.max(0, r.stamina - dt);
  else r.stamina = Math.min(STAMINA, r.stamina + dt * (fwd === 0 ? 0.8 : 0.45));
  let base = fwd > 0 ? (wantSprint ? (r.tired ? JOG : SPRINT) : WALK) : fwd < 0 ? -BACK : 0;
  base *= 1 - 0.6 * r.squat; // hunkered down (FEAT-111): a slow duck walk
  // grade along the way you are walking, at body scale: rise per metre over BODY_L (+ = uphill)
  const pack = r.pack, dir = base < 0 ? -1 : 1, hl = BODY_L / 2;
  const rise = pack.groundHeight(r.x + hx * hl * dir, r.y + hy * hl * dir) - pack.groundHeight(r.x - hx * hl * dir, r.y - hy * hl * dir);
  const grade = Number.isNaN(rise) ? 0 : rise / BODY_L;
  const steep = Math.atan(Math.max(0, grade)) / D2R;
  r.walkSlopeDeg = Math.atan(grade) / D2R;
  // uphill: about 70% pace up a 20 degree pitch, half pace at 30; downhill a little careful.
  // Past CLIMB_MAX you scramble on all fours, slower as it steepens toward CRAWL_MAX.
  const slopeF = grade > 0 ? Math.max(0.4, 1 - 0.8 * grade) : Math.max(0.7, 1 + 0.6 * grade);
  r.crawling = fwd > 0 && steep >= CLIMB_MAX && steep < CRAWL_MAX;
  if (r.crawling) { base = CRAWL * Math.max(0.3, Math.min(1, (CRAWL_MAX - steep) / 8)); r.sprinting = false; }
  else base *= slopeF;
  const climbingTooSteep = fwd !== 0 && steep >= CRAWL_MAX;
  base *= Math.max(0.4, 1 - 2.2 * r.sink);
  // a slip: the feet go and you slide back down for a moment, not pushing uphill, before you can
  // try again (otherwise you just hover at the CRAWL_MAX line)
  if (climbingTooSteep && r.slipT <= 0) r.slipT = 0.7;
  if (r.slipT > 0) { r.slipT -= dt; base = 0; r.crawling = false; r.sprinting = false; }
  // walk velocity eases toward the target (quicker to stop than to start)
  const tx = hx * base, ty = hy * base;
  const k = 1 - Math.exp(-dt * (base === 0 ? 10 : 6));
  r.walkVx += (tx - r.walkVx) * k; r.walkVy += (ty - r.walkVy) * k;
  // slipping: too steep to climb (and trying to) or to stand on at all, both at body scale
  const fall = Math.hypot(n[0], n[1]);
  let fallDeg = 0;
  if (fall > 0.05) {
    const dx = (n[0] / fall) * hl, dy = (n[1] / fall) * hl; // downhill
    const drop = pack.groundHeight(r.x - dx, r.y - dy) - pack.groundHeight(r.x + dx, r.y + dy);
    fallDeg = Number.isNaN(drop) ? 0 : Math.atan(Math.max(0, drop) / BODY_L) / D2R;
  }
  if ((r.slipT > 0 || fallDeg > CRAWL_MAX) && fall > 0.05) {
    const th = Math.max(steep, fallDeg) * D2R;
    const a = Math.max(2.5, G * (Math.sin(th) - Math.cos(th) * Math.tan(30 * D2R)));
    r.slideVx += (n[0] / fall) * a * dt; r.slideVy += (n[1] / fall) * a * dt;
    const sl = Math.hypot(r.slideVx, r.slideVy);
    if (sl > 5) { r.slideVx *= 5 / sl; r.slideVy *= 5 / sl; }
  } else {
    const f = Math.exp(-dt * 5);
    r.slideVx *= f; r.slideVy *= f;
  }
  r.vx = r.walkVx + r.slideVx; r.vy = r.walkVy + r.slideVy;
  r.x += r.vx * dt; r.y += r.vy * dt;
  r.z = groundAt(r, r.x, r.y, r.z);
  void ground;
  r.vz = 0;
  if (hop) { r.vz = 2.6; r.onGround = false; r.airTime = 0; r.z += 0.02; }
  collide(r, 0.3, true);
  r.speed = Math.hypot(r.vx, r.vy);
  r.distance += r.speed * dt;
  const work = r.sprinting || r.crawling ? 1 : (fwd !== 0 && grade > 0.15 ? Math.min(0.7, grade) : 0) + (r.tired ? 0.4 : 0);
  r.exertion += (Math.min(1, work) - r.exertion) * Math.min(1, dt * (work > r.exertion ? 0.8 : 0.25));
}
