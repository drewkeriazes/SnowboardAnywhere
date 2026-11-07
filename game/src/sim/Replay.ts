import type { Pack } from '../pack/Pack';
import type { Rider } from './Rider';
import type { GhostSample } from './TimeTrial';

/**
 * FEAT-043: the session recording behind the replay viewer and the practice rewind. The rider is
 * sampled at 20 Hz in the time-trial ghost format (t, x, y, z, board yaw, lateral g, edge angle,
 * flags: 1 on the ground, 2 tuck, 4 crashed) plus what the pose needs (heading, velocity, lean,
 * flip, squat, jump charge). The last 20 minutes are kept.
 */
export interface ReplaySample extends GhostSample { hd: number; vx: number; vy: number; vz: number; ln: number; fl: number; sq: number; jc: number; on: number }

const DT = 0.05, MAX = 24000;
/** the rider fields a sample drives (saved and put back around a replay or rewind frame) */
const FIELDS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'heading', 'boardYaw', 'onGround', 'lateralG', 'edgeAngle', 'lean', 'flip', 'squat', 'jumpCharge', 'crashed', 'speed', 'onFoot'] as const;
type Field = typeof FIELDS[number];

export class Replay {
  readonly samples: ReplaySample[] = [];
  /** session time recorded so far (s) */
  t = 0;
  private acc = DT;
  private readonly saved: Partial<Record<Field, number | boolean>> = {};
  private readonly savedN: [number, number, number] = [0, 0, 1];
  private overlaid = false;
  private readonly cur: ReplaySample = { t: 0, x: 0, y: 0, z: 0, h: 0, lg: 0, e: 0, f: 0, hd: 0, vx: 0, vy: 0, vz: 0, ln: 0, fl: 0, sq: 0, jc: 0, on: 0 };

  record(dt: number, r: Rider, tuck: boolean): void {
    this.t += dt; this.acc += dt;
    if (this.acc < DT) return;
    this.acc = 0;
    const f = (r.onGround ? 1 : 0) | (tuck ? 2 : 0) | (r.crashed > 0 ? 4 : 0);
    this.samples.push({ t: this.t, x: r.x, y: r.y, z: r.z, h: r.boardYaw, lg: r.lateralG, e: r.edgeAngle, f, hd: r.heading, vx: r.vx, vy: r.vy, vz: r.vz, ln: r.lean, fl: r.flip, sq: r.squat, jc: r.jumpCharge, on: r.onFoot ? 1 : 0 });
    if (this.samples.length > MAX + 1200) this.samples.splice(0, 1200);
  }

  get start(): number { return this.samples.length ? this.samples[0].t : 0; }
  get end(): number { return this.samples.length ? this.samples[this.samples.length - 1].t : 0; }

  private index(t: number): number {
    let lo = 0, hi = this.samples.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.samples[m].t <= t) lo = m; else hi = m - 1; }
    return lo;
  }

  /** The recorded state at time t, interpolated (headings take the short way round). */
  at(t: number): ReplaySample | null {
    const s = this.samples;
    if (!s.length) return null;
    const i = this.index(t), a = s[i], b = s[Math.min(s.length - 1, i + 1)];
    // a gap (a lift ride, a reset) is not interpolated across: hold the last sample
    const k = b.t > a.t && b.t - a.t < 0.5 ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
    const L = (u: number, v: number) => u + (v - u) * k;
    const A = (u: number, v: number) => { let d = v - u; d = Math.atan2(Math.sin(d), Math.cos(d)); return Math.abs(d) < 1 ? u + d * k : (k < 0.5 ? u : v); };
    const c = this.cur;
    c.t = t; c.x = L(a.x, b.x); c.y = L(a.y, b.y); c.z = L(a.z, b.z); c.h = A(a.h, b.h); c.hd = A(a.hd, b.hd);
    c.lg = L(a.lg, b.lg); c.e = L(a.e, b.e); c.vx = L(a.vx, b.vx); c.vy = L(a.vy, b.vy); c.vz = L(a.vz, b.vz);
    c.ln = L(a.ln, b.ln); c.fl = L(a.fl, b.fl); c.sq = L(a.sq, b.sq); c.jc = L(a.jc, b.jc); c.f = k < 0.5 ? a.f : b.f; c.on = k < 0.5 ? a.on : b.on;
    return c;
  }

  /** The latest sample at or before t with the rider on the snow, not crashed and not mid-air (rewind target). */
  goodGround(t: number): ReplaySample | null {
    for (let i = this.index(t); i >= 0; i--) { const s = this.samples[i]; if ((s.f & 1) && !(s.f & 4) && Math.abs(s.fl) < 0.01) return s; }
    return null;
  }

  /** Drop everything after t (rewound: the run carries on from there). */
  truncate(t: number): void {
    const i = this.index(t);
    this.samples.length = Math.min(this.samples.length, i + 1);
    this.t = t; this.acc = DT;
  }

  /** Show a recorded state on the rider for this frame (`restore` puts the sim state back). */
  overlay(r: Rider, s: ReplaySample, pack: Pack): void {
    const R = r as unknown as Record<Field, number | boolean>;
    if (!this.overlaid) { for (const k of FIELDS) this.saved[k] = R[k]; this.savedN[0] = r.normal[0]; this.savedN[1] = r.normal[1]; this.savedN[2] = r.normal[2]; this.overlaid = true; }
    r.x = s.x; r.y = s.y; r.z = s.z; r.vx = s.vx; r.vy = s.vy; r.vz = s.vz; r.heading = s.hd; r.boardYaw = s.h;
    r.onGround = !!(s.f & 1); r.lateralG = s.lg; r.edgeAngle = s.e; r.lean = s.ln; r.flip = s.fl; r.squat = s.sq; r.jumpCharge = s.jc;
    r.crashed = s.f & 4 ? 0.5 : 0; r.speed = Math.hypot(s.vx, s.vy); r.onFoot = !!s.on;
    const n = pack.groundNormal(s.x, s.y);
    r.normal[0] = n[0]; r.normal[1] = n[1]; r.normal[2] = n[2];
  }

  restore(r: Rider): void {
    if (!this.overlaid) return;
    const R = r as unknown as Record<Field, number | boolean>;
    for (const k of FIELDS) R[k] = this.saved[k] as never;
    r.normal[0] = this.savedN[0]; r.normal[1] = this.savedN[1]; r.normal[2] = this.savedN[2];
    this.overlaid = false;
  }
}
