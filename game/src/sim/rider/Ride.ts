/** Riding on the snow, one physics step (split from sim/Rider.ts, FEAT-165) */
import type { Rider } from '../Rider';
import { newSnowState, type SnowState } from '../SnowConditions';
import type { Input } from './types';
import { FAKIE_SPEED, FEEL, type Feel, G, GROOMED_BONUS, HARD_DEEP, HARD_DRAG, PD_NOSE_DRAG, PD_TAIL_EASE, PLANE_SPEED, POWDER_DRAG, PRESS_DRAG, SHRUB_DRAG, SHRUB_DRAG_V, PRESS_GRIP, SINK_DRAG, SINK_NOSE, SINK_NOSE_SPEED, SINK_SPEED, SINK_TAIL, SKATE_ACC, SKATE_MAX, SKATE_PERIOD, SKATE_SLOPE, SQUAT_AERO, SQUAT_GRIP, STAND_EDGE, SWITCH_GRIP } from './tuning';
import { carve, grip } from './EdgeModel';
import { brake } from './Brake';
import { jump, followGround } from './Jumps';
import { rideCollide } from './Collision';

/**
 * The values one on-snow step shares between its phases (carve, brake, grip, drag, glide), in the order
 * the step computes them. One object reused for every step and rider: the phases run one after another
 * and never reenter, so nothing is allocated per step.
 */
export interface RideStep {
  n: [number, number, number]; ax: number; ay: number; hx: number; hy: number; lx: number; ly: number;
  spd: number; F: Feel; rock: number; snow: SnowState; powder: number; deepPow: number; gripBase: number;
  H: number; hardHold: number; bite: number; fall: number; gLat: number; dHeading: number;
  swing: number; plough: number; vAlong: number; latAcc: number;
}
const RS: RideStep = {
  n: [0, 0, 1], ax: 0, ay: 0, hx: 0, hy: 0, lx: 0, ly: 0, spd: 0, F: FEEL.board, rock: 0, snow: newSnowState(), powder: 0, deepPow: 0, gripBase: 0,
  H: 0, hardHold: 0, bite: 0, fall: 0, gLat: 0, dHeading: 0, swing: 0, plough: 0, vAlong: 0, latAcc: 0,
};

/**
 * One physics step riding on the snow: gravity along the slope, then the phases in order (the edge and
 * carve, the brake, the sideways grip, the drag, the push and glide), the jump, following the ground and
 * the collisions.
 */
export function rideStep(r: Rider, dt: number, input: Input, n: [number, number, number], ground: number): void {
  // ---------------------------------------------------------------- on snow
  // gravity projected onto the slope plane: a = g * (slope direction component)
  // slope plane tangent of gravity: g_t = g - (g.n) n where g = (0,0,-G)
  const gn = -G * n[2];
  const ax = -gn * n[0], ay = -gn * n[1]; // (0 - gn*nx, 0 - gn*ny) -> downhill acceleration
  // board heading vector (unit) and its lateral
  const hx = Math.sin(r.heading), hy = Math.cos(r.heading);
  const lx = hy, ly = -hx; // right-hand lateral
  const spd = Math.hypot(r.vx, r.vy);
  const F = FEEL[r.discipline];

  // surface properties (FEAT-053: the snow state blends the day's conditions into the grip,
  // the drag, the turn shape and the jolts)
  const groomed = r.surface.groomed;
  const rock = r.surface.rock;
  const snow = r.snow;
  const powder = Math.min(1, snow.powder + 0.5 * snow.chop + 0.5 * snow.slush); // soft snow the board planes in, so the edge cap is lower
  const deepPow = snow.powder * Math.min(1, snow.depth / HARD_DEEP); // FEAT-148: only deep powder planes a hard carve
  const gripBase = (1.0 + GROOMED_BONUS * groomed - 0.5 * rock) * snow.grip * (1 + SQUAT_GRIP * r.squat) * (1 - PRESS_GRIP * Math.abs(r.lean)) // low centre of mass bites a little more; on a press you can't carve
    * (r.switch ? 1 - SWITCH_GRIP : 1); // FEAT-139: a touch weaker switch
  const c = RS;
  c.n = n; c.ax = ax; c.ay = ay; c.hx = hx; c.hy = hy; c.lx = lx; c.ly = ly; c.spd = spd; c.F = F;
  c.rock = rock; c.snow = snow; c.powder = powder; c.deepPow = deepPow; c.gripBase = gripBase;
  if (carve(r, c, dt, input)) return;
  brake(r, c, dt, input);
  grip(r, c, dt);
  drag(r, c, dt, input);
  glide(r, c, dt, input);
  if (jump(r, dt, input, n, ground)) return;
  followGround(r, dt, spd, n);
  rideCollide(r);
}

/** The drag, aerodynamic and snow (FEAT-053, FEAT-112, FEAT-148, FEAT-152), one on-snow step. */
function drag(r: Rider, c: RideStep, dt: number, input: Input): void {
  const { spd, F, snow, H, latAcc, plough } = c;
  let { ax, ay } = c;
  // drag: aerodynamic + snow. Tuck lowers aero, skidding scrubs speed (less on ice). FEAT-053: the
  // snow state sets the constant and speed-scaled drag by condition; powder adds speed-scaled drag
  // until the board planes at PLANE_SPEED (float), and slow in powder the nose sinks and digs in
  const aeroK = input.tuck ? F.aeroTuck : F.aero + (F.aeroTuck - F.aero) * SQUAT_AERO * r.squat; // a squat is part way to a tuck
  const deep = Math.min(1, snow.depth / 0.3);
  // FEAT-152: in deep powder a lean forward digs the nose in and a lean back lifts it out
  const pd = snow.powder * deep, fwd = Math.max(0, r.lean), back = Math.max(0, -r.lean);
  const pressDrag = PRESS_DRAG * Math.abs(r.lean) * spd * (1 + PD_NOSE_DRAG * pd * fwd - PD_TAIL_EASE * pd * back);
  const aero = aeroK * spd * spd * (r.boost ? 0.55 : 1) + pressDrag; // FEAT-112: the loaded end digs in
  const sinkSpeed = SINK_SPEED * (1 + SINK_NOSE_SPEED * fwd - SINK_TAIL * back);
  const sinkNow = Math.min(1, pd * Math.max(0, 1 - spd / sinkSpeed) * (1 + SINK_NOSE * fwd - SINK_TAIL * back));
  r.noseSink += (sinkNow - r.noseSink) * Math.min(1, dt * 6);
  const snowDrag = snow.drag0 + snow.drag1 * spd
    + snow.powder * POWDER_DRAG * Math.min(spd, PLANE_SPEED) * (0.6 + 0.6 * deep) + sinkNow * SINK_DRAG * G
    + 0.35 * r.skid * G * snow.skidScrub * (1 + H) // FEAT-148: a hard carve's deep edge scrubs twice as hard
    + HARD_DRAG * H * Math.abs(latAcc) // FEAT-148: the deep edge plows snow
    + r.surface.shrub * (SHRUB_DRAG + SHRUB_DRAG_V * spd); // FEAT-159: brushing through willow or juniper
  const dragAcc = aero + snowDrag + plough;
  if (spd > 0.01) {
    const d = Math.min(dragAcc * dt, spd);
    ax -= (r.vx / spd) * (d / dt); ay -= (r.vy / spd) * (d / dt);
  }
  c.ax = ax; c.ay = ay;
}

/** The tuck push and skating (FEAT-085), standing on the uphill edge, riding switch (FEAT-139), then the velocity and position. */
function glide(r: Rider, c: RideStep, dt: number, input: Input): void {
  const { n, hx, hy, spd, F, fall, gLat, vAlong } = c;
  let { ax, ay } = c;
  // push on the flat when tucking below 3 m/s (skating)
  if (input.tuck && spd < 3 && r.slopeDeg < 8) {
    ax += hx * 2.0; ay += hy * 2.0;
  }
  // FEAT-085: skate with the back foot out: a push stroke every SKATE_PERIOD s along the board's
  // heading, strongest from a standstill and gone by SKATE_MAX; works on the flat and slight uphills
  r.skating = !!input.skate && spd < SKATE_MAX && r.slopeDeg < SKATE_SLOPE && r.crashed <= 0;
  if (r.skating) {
    const before = r.skatePhase;
    r.skatePhase = (r.skatePhase + dt / SKATE_PERIOD) % 1;
    if (r.skatePhase < before) r.onSkateStroke?.();
    const stroke = Math.max(0, Math.cos(r.skatePhase * Math.PI * 2)); // the push, then the glide
    const a = SKATE_ACC * 2.2 * stroke * stroke * (1 - spd / SKATE_MAX);
    ax += hx * a; ay += hy * a;
  } else r.skatePhase = 0;
  // standing on the uphill edge: nearly stopped with the board across the fall line (within
  // about 50 degrees of it) the edge holds, so the rider stands still instead of creeping down.
  // Turning the board toward the fall line or tucking lets it run again. With the fall line
  // realistic (FEAT-134) the edge has to be held, by steering into the hill or by the brake; let
  // go and the board starts to slide. The edge needed scales with the setting: Assisted needs half
  // of STAND_EDGE, and Off stands with no input as before.
  if (spd < 0.3 && !input.tuck && fall > 0.03 && r.slopeDeg < 55) {
    const across = Math.abs(Math.sin(r.boardYaw - Math.atan2(n[0], n[1])));
    const held = r.fallLine <= 0 || -Math.sign(gLat) * r.edge > STAND_EDGE * r.fallLine || r.brakeAmt > 0.5;
    if (across > 0.75 && held) { r.vx = r.vy = 0; ax = ay = 0; }
  }
  // FEAT-139: going backwards along the heading, the steering axis turns round to the direction of
  // travel and the rider is riding switch (or back to the normal stance): drawn the same, tail leading
  if (F.fakie && vAlong < -FAKIE_SPEED && r.brakeAmt === 0) r.turnRound();
  else if (!F.fakie && vAlong < -1 && spd > 2) { r.vx *= 0.97; r.vy *= 0.97; } // skis sliding backwards scrub speed

  r.vx += ax * dt; r.vy += ay * dt;
  r.x += r.vx * dt; r.y += r.vy * dt;
}
