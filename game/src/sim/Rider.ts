import type { Pack } from '../pack/Pack';
import type { Collider } from './Collider';

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
  /** lateral acceleration in g, positive toward the board's right-hand side (smoothed, for the rider's lean) */
  lateralG = 0;
  landingShock = 0;
  /** last collision this step: 'ramp' | 'graze' | 'wall' | '' (for sound and effects; cleared each frame) */
  lastHit = '';
  distance = 0;
  maxSpeed = 0;
  discipline: Discipline = 'board';
  private readonly pack: Pack;
  private readonly collider: Collider | null;
  private accum = 0;
  private readonly maskTmp = [0, 0, 0, 0];

  constructor(pack: Pack, collider: Collider | null) {
    this.pack = pack;
    this.collider = collider;
  }

  reset(x: number, y: number, heading: number): void {
    this.x = x; this.y = y; this.z = this.pack.groundHeight(x, y) + 0.5;
    this.vx = this.vy = this.vz = 0;
    this.heading = heading; this.onGround = true; this.airTime = 0; this.jumpCharge = 0;
    this.crashed = 0; this.spin = 0; this.skid = 0; this.distance = 0; this.maxSpeed = 0;
  }

  update(dt: number, input: Input): void {
    this.accum += Math.min(dt, 0.1);
    while (this.accum >= STEP) {
      this.step(STEP, input);
      this.accum -= STEP;
      input.jumpReleased = false; // consume the release edge
    }
  }

  private step(dt: number, input: Input): void {
    const pack = this.pack;
    const n = pack.groundNormal(this.x, this.y, this.normal) as [number, number, number];
    const ground = pack.groundHeight(this.x, this.y);
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
      this.z = pack.groundHeight(this.x, this.y);
      this.vz = 0;
      this.speed = Math.hypot(this.vx, this.vy);
      return;
    }

    // ---------------------------------------------------------------- airborne
    if (!this.onGround) {
      this.lateralG *= Math.exp(-dt * 4);
      this.vz -= G * dt;
      // air control: spin with steer, slight drift
      this.spin += input.steer * 3.5 * dt;
      this.heading += input.steer * 3.5 * dt;
      this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
      this.airTime += dt;
      const g2 = pack.groundHeight(this.x, this.y);
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
    this.heading += input.steer * steerRate * dt;
    this.edgeAngle += ((input.steer * (input.tuck ? 0.5 : 1)) - this.edgeAngle) * Math.min(1, dt * 8);

    // surface properties
    const groomed = this.surface.groomed;
    const rock = this.surface.rock;
    const powder = Math.max(0, 1 - groomed) * (this.surface.canopy > 0.3 ? 1 : 0.6);
    const gripBase = 1.0 + 0.4 * groomed - 0.5 * rock;

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
    const brake = input.brake ? F.brake * G : 0;
    const dragAcc = aero + snowDrag + brake;
    if (spd > 0.01) {
      const d = Math.min(dragAcc * dt, spd);
      ax -= (this.vx / spd) * (d / dt); ay -= (this.vy / spd) * (d / dt);
    }
    // push on the flat when tucking below 3 m/s (skating)
    if (input.tuck && spd < 3 && this.slopeDeg < 8) {
      ax += hx * 2.0; ay += hy * 2.0;
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
    const g2 = pack.groundHeight(this.x, this.y);
    const n2 = pack.groundNormal(this.x, this.y) as number[];
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

  private land(ground: number, input: Input): void {
    const n = this.pack.groundNormal(this.x, this.y) as number[];
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
