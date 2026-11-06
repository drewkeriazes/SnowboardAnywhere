import type { Pack } from '../pack/Pack';
import type { Collider } from './Collider';
import { Rng } from './Rng';

export interface Input {
  steer: number; // -1 left .. +1 right
  tuck: boolean;
  brake: boolean;
  jumpHeld: boolean;
  jumpReleased: boolean;
  grab: boolean;
}

export interface SurfaceInfo {
  rock: number;
  scree: number;
  groomed: number;
  canopy: number;
}

const G = 9.81;
const STEP = 1 / 120;
const D2R = Math.PI / 180;
/** board angle to the direction of travel in a full hockey stop */
const STOP_GAMMA = 84 * D2R;
/** seconds to swing the board across, and back on release */
const SWING_IN = 0.25, SWING_OUT = 0.3;
/** hard cap on braking deceleration from the snow cut (m/s^2): the paper's 60 degree edge case */
const BRAKE_MAX = 14;
/** below this speed (m/s) a released brake leaves the board across the hill (a standing stop) */
const PARK_SPEED = 1;
/** skis below this speed at brake start snowplough instead of turning across */
const PLOUGH_SPEED = 5;

/** wrap an angle to -PI..PI */
function wrap(a: number): number { return Math.atan2(Math.sin(a), Math.cos(a)); }

export type Discipline = 'board' | 'ski';
/** Feel constants per discipline. Skis: snappier at low speed, two edges so a bit more grip at
 *  moderate edge angles but a lower hard-carve limit, a snowplough brake, and no fakie flip. */
const FEEL: Record<Discipline, { steerSlow: number; steerTuck: number; steerSpeedK: number; gripEdgeK: number; gripSpeedK: number; brake: number; fakie: boolean; aero: number; aeroTuck: number }> = {
  board: { steerSlow: 1.9, steerTuck: 0.9, steerSpeedK: 25, gripEdgeK: 14, gripSpeedK: 0.12, brake: 0.45, fakie: true, aero: 0.0055, aeroTuck: 0.0025 },
  ski: { steerSlow: 2.4, steerTuck: 1.1, steerSpeedK: 20, gripEdgeK: 11, gripSpeedK: 0.16, brake: 0.6, fakie: false, aero: 0.005, aeroTuck: 0.0021 },
};

/**
 * Snowboard rider as a point mass with a board heading. Ground contact is a bilinear
 * heightfield lookup, so terrain collision is exact at the data resolution.
 *
 * Edge model: the board can only generate lateral force up to a grip limit that depends on
 * edge angle (how hard you steer) and speed. Below the limit the velocity turns with the board
 * (a carve). Above it the board skids: the velocity lags the heading and energy is shed.
 *
 * Brake model (FEAT-065, after Komissarov's snow-cutting model of side-slipping and hockey
 * stops): holding brake swings the board yaw across the direction of travel to the angle of
 * attack gamma (about 84 degrees) while the edge angle Psi ramps up. The snow resists with
 * N tan(Psi), and the part of it along the travel direction brakes: a = g cos(alpha) tan(Psi)
 * sin(gamma), on top of the slope's own pull, so more edge than slope slows you. `heading` stays
 * the steering axis; `boardYaw` is the board as drawn and as it marks the snow.
 */
export class Rider {
  x = 0; y = 0; z = 0; // position, local metres (z up)
  vx = 0; vy = 0; vz = 0;
  heading = 0; // radians, 0 = north (+y), increasing clockwise (toward +x)
  onGround = true;
  airTime = 0;
  jumpCharge = 0;
  speed = 0;
  edgeAngle = 0; // visual, -1..1
  spin = 0; // extra yaw while airborne
  crashed = 0; // seconds remaining in a crash
  surface: SurfaceInfo = { rock: 0, scree: 0, groomed: 0, canopy: 0 };
  normal: [number, number, number] = [0, 0, 1];
  slopeDeg = 0;
  skid = 0; // 0..1 how much the board is sliding sideways (for spray)
  /** board yaw (same convention as heading): the heading, swung across the travel direction while braking */
  boardYaw = 0;
  /** 0..1 progress of the brake swing */
  brakeAmt = 0;
  /** brake stance: -1 heelside, +1 toeside, 0 not braking */
  brakeSide = 0;
  /** braking deceleration from the snow cut this step (m/s^2) */
  brakeAcc = 0;
  /** 0..1 braking power (deceleration times speed), smoothed, for spray, sound and the track */
  scrape = 0;
  /** signed angle from the travel direction to the board (radians, 0 when nearly stopped) */
  slip = 0;
  private travelYaw = 0;
  /** board angle to travel this brake aims for, fixed when the brake starts (0 = ski snowplough) */
  private brakeGamma = STOP_GAMMA;
  /** lateral acceleration in g, positive toward the board's right-hand side (smoothed, for the rider's lean) */
  lateralG = 0;
  landingShock = 0;
  /** last collision this step: 'ramp' | 'graze' | 'wall' | '' (for sound and effects; cleared each frame) */
  lastHit = '';
  distance = 0;
  maxSpeed = 0;
  discipline: Discipline = 'board';
  /** sim randomness: seeded on reset so the same inputs replay the same run */
  readonly rng = new Rng(1);
  /** physics steps so far, and how many of them sampled a coarser height set than the point has */
  steps = 0;
  coarseSteps = 0;
  private readonly pack: Pack;
  private readonly collider: Collider | null;
  private accum = 0;
  private readonly maskTmp = [0, 0, 0, 0];
  // render interpolation: pose before the last step, pose after it (to spot external moves), and
  // the sim pose stashed while the interpolated one is applied
  private readonly prev = [0, 0, 0, 0, 0];
  private readonly end = [NaN, NaN, NaN, NaN];
  private readonly stash = [0, 0, 0, 0, 0];
  private alpha = 1;
  private posed = false;
  private lastWarn = -Infinity;

  constructor(pack: Pack, collider: Collider | null) {
    this.pack = pack;
    this.collider = collider;
  }

  reset(x: number, y: number, heading: number, seed = 1): void {
    this.x = x; this.y = y; this.z = this.pack.groundHeight(x, y) + 0.5;
    this.vx = this.vy = this.vz = 0;
    this.heading = heading; this.onGround = true; this.airTime = 0; this.jumpCharge = 0;
    this.crashed = 0; this.spin = 0; this.skid = 0; this.distance = 0; this.maxSpeed = 0;
    this.edgeAngle = 0; this.lateralG = 0; this.landingShock = 0;
    this.accum = 0; this.alpha = 1; this.steps = 0; this.coarseSteps = 0;
    this.rng.seed(seed);
    this.squareBoard();
    this.snapPose();
  }

  /** End any brake swing: the board lines up with the heading again. */
  private squareBoard(): void {
    this.boardYaw = this.travelYaw = this.heading;
    this.brakeAmt = 0; this.brakeSide = 0; this.brakeAcc = 0; this.scrape = 0; this.slip = 0;
  }

  /**
   * Advance the sim by real time dt in fixed 1/120 s steps. Catch-up is capped at 0.1 s per call
   * (12 steps), so a tab switch or a long hitch drops time instead of fast-forwarding the run.
   */
  update(dt: number, input: Input): void {
    // moved from outside since the last step (lift, reset, teleport): nothing to interpolate from
    if (this.x !== this.end[0] || this.y !== this.end[1] || this.z !== this.end[2] || this.heading !== this.end[3]) { this.squareBoard(); this.snapPose(); }
    this.accum += Math.min(dt, 0.1);
    while (this.accum >= STEP) {
      this.prev[0] = this.x; this.prev[1] = this.y; this.prev[2] = this.z; this.prev[3] = this.heading; this.prev[4] = this.boardYaw;
      const fb = this.pack.coarseFallbacks;
      this.step(STEP, input);
      this.steps++;
      if (this.pack.coarseFallbacks !== fb) this.onCoarse();
      this.accum -= STEP;
      input.jumpReleased = false; // consume the release edge
    }
    this.end[0] = this.x; this.end[1] = this.y; this.end[2] = this.z; this.end[3] = this.heading;
    this.alpha = this.accum / STEP;
  }

  private snapPose(): void {
    this.prev[0] = this.end[0] = this.x; this.prev[1] = this.end[1] = this.y;
    this.prev[2] = this.end[2] = this.z; this.prev[3] = this.end[3] = this.heading; this.prev[4] = this.boardYaw;
  }

  private onCoarse(): void {
    this.coarseSteps++;
    const now = performance.now();
    if (now - this.lastWarn < 2000) return;
    this.lastWarn = now;
    console.warn(`physics: 1 m terrain not loaded at ${this.x.toFixed(0)}, ${this.y.toFixed(0)}; riding on a coarser set (${this.coarseSteps}/${this.steps} steps so far)`);
  }

  /**
   * Swap in the pose interpolated between the last two physics steps for drawing (call
   * restoreSimPose after). Without it the rider judders when the frame rate does not divide
   * 120 Hz evenly. Big heading jumps (fakie flip, landing snap) are not blended.
   */
  applyRenderPose(): void {
    if (this.posed) return;
    this.posed = true;
    const s = this.stash, p = this.prev, a = this.alpha;
    s[0] = this.x; s[1] = this.y; s[2] = this.z; s[3] = this.heading; s[4] = this.boardYaw;
    if (this.x !== this.end[0] || this.y !== this.end[1] || this.z !== this.end[2] || this.heading !== this.end[3]) return; // moved outside the sim
    this.x = p[0] + (s[0] - p[0]) * a; this.y = p[1] + (s[1] - p[1]) * a; this.z = p[2] + (s[2] - p[2]) * a;
    const dh = s[3] - p[3];
    if (Math.abs(dh) < 1) this.heading = p[3] + dh * a;
    const db = s[4] - p[4];
    if (Math.abs(db) < 1) this.boardYaw = p[4] + db * a;
  }

  restoreSimPose(): void {
    if (!this.posed) return;
    this.posed = false;
    const s = this.stash;
    this.x = s[0]; this.y = s[1]; this.z = s[2]; this.heading = s[3]; this.boardYaw = s[4];
  }

  private step(dt: number, input: Input): void {
    const pack = this.pack;
    const n = pack.groundNormal(this.x, this.y, this.normal, this.z) as [number, number, number];
    const ground = pack.groundHeight(this.x, this.y, this.z);
    this.slopeDeg = Math.acos(Math.min(1, n[2])) * 57.2958;
    if (pack.mask) {
      const m = pack.mask.sample(this.x, this.y, this.maskTmp);
      this.surface.rock = m[0]; this.surface.scree = m[1]; this.surface.groomed = m[2]; this.surface.canopy = m[3];
    }
    if (this.crashed > 0) {
      this.crashed -= dt;
      // tumble: slide to a stop
      const f = Math.exp(-dt * 2.5);
      this.vx *= f; this.vy *= f;
      this.x += this.vx * dt; this.y += this.vy * dt;
      this.z = pack.groundHeight(this.x, this.y, this.z);
      this.vz = 0;
      this.speed = Math.hypot(this.vx, this.vy);
      this.squareBoard();
      return;
    }

    // ---------------------------------------------------------------- airborne
    if (!this.onGround) {
      this.lateralG *= Math.exp(-dt * 4);
      // the board squares up quickly once off the snow
      this.brakeAmt = Math.max(0, this.brakeAmt - dt / 0.15);
      this.brakeAcc = 0; this.scrape *= Math.exp(-dt * 10); this.slip = 0;
      if (this.brakeAmt === 0) this.brakeSide = 0;
      this.vz -= G * dt;
      // air control: spin with steer, slight drift
      this.spin += input.steer * 3.5 * dt;
      this.heading += input.steer * 3.5 * dt;
      this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
      this.travelYaw += input.steer * 3.5 * dt; // spin carries the swung board round with it
      this.poseBoard();
      this.airTime += dt;
      const g2 = pack.groundHeight(this.x, this.y, this.z);
      if (this.z <= g2) {
        this.land(g2, input);
      }
      this.speed = Math.hypot(this.vx, this.vy, this.vz);
      return;
    }

    // ---------------------------------------------------------------- on snow
    // gravity projected onto the slope plane: a = g * (slope direction component)
    // slope plane tangent of gravity: g_t = g - (g.n) n where g = (0,0,-G)
    const gn = -G * n[2];
    let ax = -gn * n[0], ay = -gn * n[1]; // (0 - gn*nx, 0 - gn*ny) -> downhill acceleration
    // board heading vector (unit) and its lateral
    const hx = Math.sin(this.heading), hy = Math.cos(this.heading);
    const lx = hy, ly = -hx; // right-hand lateral
    // steering: rotate heading. Faster = less yaw rate (long carves) but more lateral force
    const spd = Math.hypot(this.vx, this.vy);
    const F = FEEL[this.discipline];
    const steerRate = (input.tuck ? F.steerTuck : F.steerSlow) * (1 / (1 + spd / F.steerSpeedK));
    const dHeading = input.steer * steerRate * dt;
    this.heading += dHeading;
    this.edgeAngle += ((input.steer * (input.tuck ? 0.5 : 1)) - this.edgeAngle) * Math.min(1, dt * 8);

    // surface properties
    const groomed = this.surface.groomed;
    const rock = this.surface.rock;
    const powder = Math.max(0, 1 - groomed) * (this.surface.canopy > 0.3 ? 1 : 0.6);
    const gripBase = 1.0 + 0.4 * groomed - 0.5 * rock;

    // brake: swing the board across the direction of travel (a hockey stop). Steer picks the
    // stance (right = toeside, left = heelside); otherwise the edge already engaged, else heelside.
    // Toeside rotates the board clockwise from the travel direction, which leaves the heel edge
    // leading and the toe edge trailing (the uphill edge, cutting the snow); heelside the reverse.
    if (spd > 0.5) this.travelYaw = Math.atan2(this.vx, this.vy);
    else this.travelYaw += dHeading; // stopped: steering turns the board where it stands
    if (input.brake) {
      if (this.brakeSide === 0) {
        this.brakeSide = input.steer > 0.1 ? 1 : input.steer < -0.1 ? -1 : this.edgeAngle > 0.3 ? 1 : -1;
        this.brakeGamma = this.discipline === 'ski' && spd < PLOUGH_SPEED ? 0 : STOP_GAMMA;
      }
      this.brakeAmt = Math.min(1, this.brakeAmt + dt / SWING_IN);
    } else if (this.brakeAmt > 0) {
      if (spd < PARK_SPEED && this.brakeGamma > 0) {
        // released while (nearly) stopped: stay standing across the hill
        this.heading = this.boardYaw;
        this.squareBoard();
      } else {
        this.brakeAmt = Math.max(0, this.brakeAmt - dt / SWING_OUT);
        if (this.brakeAmt === 0) this.brakeSide = 0;
      }
    }
    const swing = this.poseBoard();
    this.slip = spd > 0.5 ? wrap(this.boardYaw - Math.atan2(this.vx, this.vy)) : 0;
    // snow cut: a = g cos(alpha) tan(Psi) sin(gamma). The edge angle Psi ramps with the swing and
    // rises with the slope (riders tip further on steeper pitches) so a brake can hold anywhere
    // up to about 55 degrees. Skis below PLOUGH_SPEED snowplough with a flat drag instead.
    let brakeAcc = 0;
    if (swing > 0) {
      if (this.brakeGamma > 0) {
        const psiMax = Math.min(68, Math.max(45, this.slopeDeg + 12));
        const psi = (15 + (psiMax - 15) * swing) * D2R;
        const sinG = spd > 0.5 ? Math.abs(Math.sin(this.slip)) : Math.sin(this.brakeGamma) * swing;
        brakeAcc = Math.min(BRAKE_MAX, G * n[2] * Math.tan(psi) * sinG * (1 - 0.4 * rock));
      } else brakeAcc = F.brake * G * swing;
    }
    this.brakeAcc = brakeAcc;
    this.scrape += (Math.min(1, (brakeAcc * spd) / 50) - this.scrape) * Math.min(1, dt * 10);

    // decompose velocity along/across the board
    const vAlong = this.vx * hx + this.vy * hy;
    const vLat = this.vx * lx + this.vy * ly;
    // lateral grip force: proportional to edge angle and speed, limited
    const maxLat = gripBase * (6 + 0.9 * Math.abs(this.edgeAngle) * F.gripEdgeK + F.gripSpeedK * spd);
    // wanted: kill lateral velocity (carve) within a short time
    let latAcc = -vLat / Math.max(0.04, 0.12 - 0.08 * Math.abs(this.edgeAngle));
    const skidding = Math.abs(latAcc) > maxLat;
    if (skidding) latAcc = Math.sign(latAcc) * maxLat;
    this.skid += (((skidding ? Math.min(1, Math.abs(vLat) / 6) : 0)) - this.skid) * Math.min(1, dt * 10);
    ax += latAcc * lx; ay += latAcc * ly;
    this.lateralG += ((latAcc / G) - this.lateralG) * Math.min(1, dt * 12);

    // drag: aerodynamic + snow. Tuck lowers aero, powder adds speed-scaled drag, skidding scrubs speed
    const aero = (input.tuck ? F.aeroTuck : F.aero) * spd * spd;
    const snowDrag = 0.015 * G * (1 - 0.5 * groomed) + powder * 0.004 * spd + 0.35 * this.skid * G;
    const dragAcc = aero + snowDrag + brakeAcc;
    if (spd > 0.01) {
      const d = Math.min(dragAcc * dt, spd);
      ax -= (this.vx / spd) * (d / dt); ay -= (this.vy / spd) * (d / dt);
    }
    // push on the flat when tucking below 3 m/s (skating)
    if (input.tuck && spd < 3 && this.slopeDeg < 8) {
      ax += hx * 2.0; ay += hy * 2.0;
    }
    // standing on the uphill edge: nearly stopped with the board across the fall line (within
    // about 50 degrees of it) the edge holds, so the rider stands still instead of creeping down.
    // Turning the board toward the fall line or tucking lets it run again.
    const fall = Math.hypot(n[0], n[1]);
    if (spd < 0.3 && !input.tuck && fall > 0.03 && this.slopeDeg < 55) {
      const across = Math.abs(Math.sin(this.boardYaw - Math.atan2(n[0], n[1])));
      if (across > 0.75) { this.vx = this.vy = 0; ax = ay = 0; }
    }
    // backwards riding is unstable: if moving against heading fast, flip heading (fakie)
    if (F.fakie && vAlong < -4) this.heading += Math.PI;
    else if (!F.fakie && vAlong < -1 && spd > 2) { this.vx *= 0.97; this.vy *= 0.97; } // skis sliding backwards scrub speed

    this.vx += ax * dt; this.vy += ay * dt;
    this.x += this.vx * dt; this.y += this.vy * dt;

    // jump: hold to charge, release to pop (impulse along the normal plus the slope direction)
    if (input.jumpHeld) this.jumpCharge = Math.min(1, this.jumpCharge + dt * 1.6);
    if (input.jumpReleased && this.jumpCharge > 0.1) {
      const pop = 2.5 + 4.5 * this.jumpCharge;
      this.vx += n[0] * pop; this.vy += n[1] * pop; this.vz = n[2] * pop + Math.max(0, -(this.vx * n[0] + this.vy * n[1]));
      this.onGround = false; this.airTime = 0; this.spin = 0; this.jumpCharge = 0;
      this.z = ground + 0.05;
      return;
    }
    if (!input.jumpHeld) this.jumpCharge = Math.max(0, this.jumpCharge - dt * 3);

    // follow the ground; detect leaving it (convex rollovers at speed)
    const g2 = pack.groundHeight(this.x, this.y, this.z);
    const n2 = pack.groundNormal(this.x, this.y, undefined, this.z) as number[];
    // vertical velocity implied by following the surface
    const vzSurf = -(this.vx * n2[0] + this.vy * n2[1]) / Math.max(0.2, n2[2]);
    const ballistic = this.vz - G * dt;
    if (ballistic > vzSurf + 1.5 && spd > 6) {
      // the ground drops away faster than we fall: airborne
      this.onGround = false; this.airTime = 0; this.spin = 0;
      this.z = Math.max(this.z, g2 + 0.02);
      this.vz = vzSurf; // start with the surface's vertical speed
    } else {
      this.z = g2;
      this.vz = vzSurf;
    }
    this.speed = Math.hypot(this.vx, this.vy);
    this.maxSpeed = Math.max(this.maxSpeed, this.speed);
    this.distance += spd * dt;
    this.landingShock = Math.max(0, this.landingShock - dt * 3);

    // collisions with trees and rocks
    if (this.collider) {
      const hit = this.collider.resolve(this.x, this.y, this.z, 0.4);
      if (hit) {
        // started inside a building: always take the pushed-out position, even when already moving out
        if (hit.inside) { this.x = hit.x; this.y = hit.y; }
        const vn = this.vx * hit.nx + this.vy * hit.ny; // negative = moving into the obstacle
        const spdNow = Math.hypot(this.vx, this.vy) || 1;
        const headOn = -vn / spdNow; // 1 = straight into it, 0 = grazing
        if (vn < 0) {
          if (hit.kind === 1) {
            // rampable rock: ride up and over it. Launch angle from how square the hit is.
            this.lastHit = 'ramp';
            const h = Math.max(0.3, hit.top - this.z);
            const launch = Math.min(0.9, 0.25 + 0.9 * headOn) * Math.min(1, h / 1.5);
            this.vz = Math.max(this.vz, spdNow * launch * 0.5 + 1.5);
            this.vx *= 1 - 0.12 * headOn; this.vy *= 1 - 0.12 * headOn;
            this.onGround = false; this.airTime = 0; this.spin = 0;
            this.z = Math.max(this.z, hit.top - 0.3);
            this.landingShock = 0.3;
          } else if (headOn < 0.5) {
            // glancing hit on a tree or wall: slide along it, lose a little speed
            this.lastHit = 'graze';
            this.x = hit.x; this.y = hit.y;
            this.vx -= vn * hit.nx; this.vy -= vn * hit.ny;
            this.vx *= 0.85; this.vy *= 0.85;
            this.landingShock = 0.25;
          } else {
            // square hit: bounce off; fast square hits crash
            this.lastHit = 'wall';
            this.x = hit.x; this.y = hit.y;
            if (-vn > 7) this.crashed = 1.2;
            this.vx -= 1.4 * vn * hit.nx; this.vy -= 1.4 * vn * hit.ny;
            this.vx *= 0.6; this.vy *= 0.6;
          }
        }
      }
    }
  }

  /**
   * Set boardYaw from the heading and the brake swing: eased from the heading toward the stop
   * angle off the travel direction. Returns the eased swing (0..1).
   */
  private poseBoard(): number {
    const a = this.brakeAmt;
    const e = a * a * (3 - 2 * a);
    if (e === 0 || this.brakeSide === 0) { this.boardYaw = this.heading; return 0; }
    const target = this.travelYaw + this.brakeSide * this.brakeGamma;
    this.boardYaw = this.heading + wrap(target - this.heading) * e;
    return e;
  }

  private land(ground: number, input: Input): void {
    const n = this.pack.groundNormal(this.x, this.y, undefined, this.z) as number[];
    this.z = ground;
    this.onGround = true;
    // impact normal to the surface
    const vn = this.vx * n[0] + this.vy * n[1] + this.vz * n[2];
    // remove normal component (inelastic), keep tangential
    this.vx -= vn * n[0]; this.vy -= vn * n[1]; this.vz -= vn * n[2];
    const impact = Math.max(0, -vn);
    // misaligned landing (board not along the velocity) or heavy impact costs speed; very heavy = crash
    const hx = Math.sin(this.heading), hy = Math.cos(this.heading);
    const spd = Math.hypot(this.vx, this.vy);
    const align = spd > 0.5 ? Math.abs((this.vx * hx + this.vy * hy) / spd) : 1;
    const spinOff = Math.abs(((this.spin % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI); // distance from facing forward/backward
    const clean = align > 0.6 || spinOff < 0.6;
    const penalty = (clean ? 0.08 : 0.5) + impact * (clean ? 0.012 : 0.03);
    this.vx *= Math.max(0, 1 - penalty); this.vy *= Math.max(0, 1 - penalty);
    this.landingShock = Math.min(1, impact / 12);
    if (impact > 16 || (!clean && impact > 8 && !input.grab)) this.crashed = 1.3;
    if (!clean) this.heading = Math.atan2(this.vx, this.vy); // the board snaps to the direction of travel
    this.spin = 0;
    this.airTime = 0;
  }
}
