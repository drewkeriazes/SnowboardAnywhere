/**
 * Procedural walk and run cycle for the on-foot rider (FEAT-067), in pack coordinates (x east,
 * y north, z up). Each foot is either planted (fixed in the world while the body moves over it) or
 * swinging along an arc to a landing spot predicted from the body's velocity. A phase clock sets
 * the cadence from speed: the stride lengthens and the stance share (duty) shrinks as you go
 * faster, so a sprint has a flight phase. Standing still, a foot that ends up too far from where it
 * should be (turning on the spot, a slip) takes a short adjusting step.
 *
 * Every landing calls `onPlant` with the sole centre and heading: that is where the bootprint goes,
 * exactly under the foot the IK then pins there.
 */
export interface GaitInput {
  x: number; y: number; z: number;
  heading: number;
  vx: number; vy: number;
  onGround: boolean;
  /** slipping down the snow: both feet stay down and skid with the body (no steps, no prints) */
  sliding?: boolean;
  /** boot sink (m) */
  sink: number;
  /** FEAT-152: the share of the sink the sole sits down by (0.6 by default; all of it in deep powder) */
  soleShare?: number;
  /** smear for prints laid this frame (m, pack x/y): downhill when slipping or climbing steep snow */
  smearX: number; smearY: number;
}

export interface Plant { side: 0 | 1; x: number; y: number; yaw: number; speed: number; kick: number; smearX: number; smearY: number }

export interface Foot {
  /** sole centre (pack coords) and the boot's yaw (heading convention), pitch (+ = toe up) */
  x: number; y: number; z: number; yaw: number; pitch: number;
  planted: boolean;
  /** seconds since it was planted */
  t: number;
  /** swing progress 0..1, rate per second, start pose, and whether it is an adjusting step */
  s: number; rate: number; sx: number; sy: number; sz: number; syaw: number; adjust: boolean;
}

/** half the distance between the feet across the body (m) */
export const HALF_STANCE = 0.11;
/** toes turned out a little (rad) */
const TOE_OUT = 0.07;
/** adjusting step length of time (s) */
const ADJUST_TIME = 0.3;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const mkFoot = (): Foot => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, planted: true, t: 0, s: 0, rate: 0, sx: 0, sy: 0, sz: 0, syaw: 0, adjust: false });

export class Gait {
  readonly feet: [Foot, Foot] = [mkFoot(), mkFoot()];
  /** cycle phase 0..1: the left foot lands at 0, the right at 0.5 */
  phase = 0;
  /** smoothed horizontal speed (m/s) */
  speed = 0;
  /** stance share of the cycle at the current speed */
  duty = 0.64;
  onPlant: ((p: Plant) => void) | null = null;
  private airborne = false;
  private wasMoving = false;
  private readonly rest = { x: 0, y: 0, yaw: 0 };

  constructor(private readonly ground: (x: number, y: number) => number) {}

  /** where foot i stands when still: beside the body, toes out a little */
  private restPose(i: number, g: GaitInput): { x: number; y: number; yaw: number } {
    const side = i === 0 ? -1 : 1;
    const rx = Math.cos(g.heading), ry = -Math.sin(g.heading);
    this.rest.x = g.x + rx * side * HALF_STANCE; this.rest.y = g.y + ry * side * HALF_STANCE;
    this.rest.yaw = g.heading + side * TOE_OUT;
    return this.rest;
  }

  private soleZ(x: number, y: number, g: GaitInput): number { return this.ground(x, y) - g.sink * (g.soleShare ?? 0.6); }

  /** Both feet planted beside the body (start, teleport, the end of a transition). */
  reset(g: GaitInput): void {
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i], r = this.restPose(i, g);
      f.x = r.x; f.y = r.y; f.z = this.soleZ(r.x, r.y, g); f.yaw = r.yaw; f.pitch = 0;
      f.planted = true; f.t = 0; f.s = 0; f.adjust = false;
    }
    this.airborne = false; this.wasMoving = false; this.speed = 0;
  }

  private plant(i: number, g: GaitInput): void {
    const f = this.feet[i];
    f.planted = true; f.t = 0; f.s = 0; f.pitch = 0; f.adjust = false;
    const kick = Math.max(0, Math.min(1, (this.speed - 2.6) / 1.0));
    this.onPlant?.({ side: i as 0 | 1, x: f.x, y: f.y, yaw: f.yaw, speed: this.speed, kick, smearX: g.smearX, smearY: g.smearY });
  }

  private lift(i: number, rate: number, adjust: boolean): void {
    const f = this.feet[i];
    f.planted = false; f.s = 0; f.rate = rate; f.adjust = adjust;
    f.sx = f.x; f.sy = f.y; f.sz = f.z; f.syaw = f.yaw;
  }

  update(dt: number, g: GaitInput): void {
    const spd = Math.hypot(g.vx, g.vy);
    this.speed += (spd - this.speed) * Math.min(1, dt * 8);
    // in the air: feet tucked under the body; both land together
    if (!g.onGround) {
      this.airborne = true;
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i], r = this.restPose(i, g);
        f.x = r.x; f.y = r.y; f.z = g.z + 0.08; f.yaw = r.yaw; f.pitch = 0; f.planted = false; f.s = 0;
      }
      return;
    }
    if (this.airborne) {
      this.airborne = false;
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i], r = this.restPose(i, g);
        f.x = r.x; f.y = r.y; f.z = this.soleZ(r.x, r.y, g); f.yaw = r.yaw;
        this.plant(i, g);
      }
      return;
    }
    if (g.sliding) {
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i], r = this.restPose(i, g);
        f.x = r.x; f.y = r.y; f.z = this.soleZ(r.x, r.y, g); f.yaw = r.yaw; f.pitch = 0;
        f.planted = true; f.t = 0; f.s = 0; f.adjust = false;
      }
      this.wasMoving = false;
      return;
    }
    const moving = spd > 0.15;
    const v = Math.min(spd, 5);
    const step = 0.35 + 0.25 * v;
    const duty = this.duty = Math.max(0.36, Math.min(0.66, 0.64 - 0.08 * (v - 1.4)));
    const freq = Math.max(0.4, v / (2 * step)); // cycles per second
    if (moving) {
      // setting off: the foot furthest behind goes first
      if (!this.wasMoving) {
        const back = (i: number) => (this.feet[i].x - g.x) * g.vx + (this.feet[i].y - g.y) * g.vy;
        this.phase = back(0) <= back(1) ? duty : (duty + 0.5) % 1;
      } else this.phase = (this.phase + freq * dt) % 1;
    }
    this.wasMoving = moving;
    const fx = g.vx, fy = g.vy;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i], other = this.feet[1 - i];
      if (f.planted) {
        f.t += dt;
        if (moving) {
          // lift off once this foot's phase is past the end of its stance (a window, not a crossing:
          // the duty shrinks as you speed up), after at least half a stance on the snow
          const q = (this.phase - i * 0.5 + 1) % 1;
          const due = q >= duty && f.t >= 0.5 * duty / freq;
          // left behind (a slip, a hitch, a sudden sprint): step now
          const behind = Math.hypot(f.x - g.x, f.y - g.y) > 0.8;
          if ((due || behind) && (duty < 0.5 || other.planted || behind)) this.lift(i, freq / (1 - duty), false);
        } else if (other.planted) {
          const r = this.restPose(i, g);
          const err = Math.hypot(f.x - r.x, f.y - r.y), yawErr = Math.abs(wrap(f.yaw - r.yaw));
          const r2 = this.restPose(1 - i, g);
          const errO = Math.hypot(other.x - r2.x, other.y - r2.y) + Math.abs(wrap(other.yaw - r2.yaw)) * 0.3;
          if ((err > 0.16 || yawErr > 0.45) && err + yawErr * 0.3 >= errO) this.lift(i, 1 / ADJUST_TIME, true);
        }
        continue;
      }
      // swinging
      if (!moving || f.adjust) f.rate = Math.max(f.rate, 1 / ADJUST_TIME);
      else f.rate = freq / (1 - duty);
      f.s = Math.min(1, f.s + f.rate * dt);
      const r = this.restPose(i, g);
      let tx = r.x, ty = r.y;
      if (moving && !f.adjust) {
        // land where the body will be when the foot comes down, plus the half stance it then rolls over
        const lead = (1 - f.s) / f.rate + duty / (2 * freq);
        let dx = fx * lead, dy = fy * lead;
        const dl = Math.hypot(dx, dy);
        if (dl > 0.95) { dx *= 0.95 / dl; dy *= 0.95 / dl; }
        tx += dx; ty += dy;
      }
      const tyaw = r.yaw;
      const tz = this.soleZ(tx, ty, g);
      const e = f.s * f.s * (3 - 2 * f.s);
      f.x = f.sx + (tx - f.sx) * e; f.y = f.sy + (ty - f.sy) * e;
      const base = Math.max(f.sz + (tz - f.sz) * f.s, this.soleZ(f.x, f.y, g));
      const lift = (f.adjust ? 0.05 : Math.min(0.22, 0.06 + 0.035 * v)) + g.sink * 0.8; // step up out of deep snow
      f.z = base + lift * Math.sin(Math.PI * f.s);
      f.yaw = f.syaw + wrap(tyaw - f.syaw) * e;
      f.pitch = f.adjust ? 0 : -0.35 * Math.sin(2 * Math.PI * f.s) * Math.min(1, v / 1.4);
      if (f.s >= 1) { f.x = tx; f.y = ty; f.z = tz; f.yaw = tyaw; this.plant(i, g); }
    }
  }
}
