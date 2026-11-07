import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Rider } from './Rider';
import type { LiftRide } from './LiftRide';
import { RIDE_SPEEDUP, FAST_FORWARD } from './LiftRide';
import type { Lifts, LiftRuntime } from '../world/Lifts';

/**
 * Outrun mode (FEAT-097 to FEAT-101, research in docs/research/outrun-mode.md): a snow monster
 * chases the rider down the mountain. Pure sim, pack coordinates (x east, y north, z up).
 *
 * The monster follows the rider's breadcrumbs (a 4 Hz ring of rider samples) by arc length, so it
 * only ever goes where the rider went: no pathfinding, no stuck cases, any pack. Inside SIGHT m
 * with line of sight (a height march on the terrain) it leaves the trail and charges straight.
 * Speed is a rubber band on the rider's recent average, so riding well keeps you ahead and every
 * crash, stop or walk hands it the gap. On a lift it follows the cable, tower to tower, a fixed
 * gap behind the chair. Reaching the base (the lowest building cluster) is the escape on 'base'
 * runs; 'endless' runs only end when it eats you, with a second monster after SECOND s.
 */
export type Difficulty = 'chill' | 'normal' | 'skifree';
export type Escape = 'endless' | 'base';
export interface OutrunConfig { difficulty: Difficulty; escape: Escape; gentle: boolean }
export type Phase = 'off' | 'countdown' | 'headstart' | 'chase' | 'caught' | 'escaped';
export type MonsterMode = 'trail' | 'direct' | 'lift' | 'wait';

export interface Crumb { x: number; y: number; z: number; s: number; t: number }
export interface MonsterState {
  id: number;
  x: number; y: number; z: number;
  heading: number;
  speed: number;
  mode: MonsterMode;
  /** arc length along the trail (trail mode) */
  along: number;
  /** metres up the lift line (lift mode) */
  liftUp: number;
  lift: LiftRuntime | null;
  /** gap behind the chair on the lift (m), and the climb rate once the rider has unloaded (m/s) */
  liftGap: number;
  liftRate: number;
  sight: boolean;
  sightLost: number;
  /** seconds since the gap was last sampled, the gap then, and seconds left of taking the direct line */
  frustration: number;
  lastDist: number;
  frustrated: number;
  /** horizontal distance to the rider this frame */
  dist: number;
  /** gallop phase 0..1 (a stride), for the view and the footfall sounds */
  phase: number;
  /** true on the frame a foot came down */
  footfall: boolean;
  /** in the air between towers */
  hop: number;
}
export type OutrunEvent =
  | { kind: 'spawn' | 'roar' | 'sight' | 'closecall' | 'caught' | 'escaped' | 'second' | 'boost' | 'footfall' | 'treecrack' | 'wake'; m?: MonsterState; x?: number; y?: number; z?: number };

export interface Best { score: number; time: number; date: string }

const SAMPLE_DT = 0.25;
const MAX_CRUMBS = 600; // 150 s of trail
const SIGHT = 60; // m: charges straight with line of sight inside this
const CATCH = 2.4; // m
const CLOSE_IN = 10, CLOSE_OUT = 25; // m: a close call is inside CLOSE_IN then back past CLOSE_OUT
const FAR = 200; // m: catch-up bonus beyond this
const SECOND = 180; // s: second monster (endless)
const STRIDE = 3.4; // m per gallop stride
const BASE_R = 120; // m around the base cluster that counts as safe
export const BOOST_TIME = 4; // s
export const BOOST_COST = 0.5;

interface Preset { head: number; k0: number; kRate: number; ramp: number; max: number; min: number }
const PRESETS: Record<Difficulty, Preset> = {
  chill: { head: 10, k0: 0.9, kRate: 0.0008, ramp: 0.005, max: 19, min: 5 },
  normal: { head: 7, k0: 1.0, kRate: 0.0015, ramp: 0.012, max: 26, min: 6 },
  skifree: { head: 5, k0: 1.15, kRate: 0.002, ramp: 0.025, max: 32, min: 8 },
};

export class Outrun {
  phase: Phase = 'off';
  cfg: OutrunConfig = { difficulty: 'normal', escape: 'base', gentle: false };
  /** seconds in the current phase */
  t = 0;
  /** chase clock (s survived) */
  time = 0;
  closeCalls = 0;
  descended = 0;
  score = 0;
  best: Best | null = null;
  isBest = false;
  monsters: MonsterState[] = [];
  /** nearest monster's horizontal distance (Infinity when none) */
  dist = Infinity;
  nearest: MonsterState | null = null;
  adrenaline = 0;
  boostT = 0;
  events: OutrunEvent[] = [];
  /** base cluster centre (x, y) when the pack has one */
  base: [number, number] | null = null;
  /** 'base' asked for but the pack has no buildings: runs endless */
  baseMissing = false;
  private crumbs: Crumb[] = [];
  private sLast = 0;
  private sampleAcc = 0;
  private riderAvg = 0;
  private lastZ = 0;
  private closeState = false;
  private wasAir = false;
  private airStart = 0;
  private nextId = 1;
  private secondDone = false;
  private liftUpLast = 0;
  private wasRiding = false;
  private readonly rng = () => Math.random();

  constructor(private readonly pack: Pack, private readonly lifts: Lifts) {}

  get active(): boolean { return this.phase !== 'off'; }
  get running(): boolean { return this.phase === 'countdown' || this.phase === 'headstart' || this.phase === 'chase'; }
  get boosting(): boolean { return this.boostT > 0; }
  get preset(): Preset { return PRESETS[this.cfg.difficulty]; }
  get headStart(): number { return this.preset.head; }

  /** Start a run from where the rider is. */
  start(cfg: OutrunConfig, rider: Rider): void {
    this.cfg = { ...cfg };
    this.phase = 'countdown'; this.t = 0; this.time = 0;
    this.closeCalls = 0; this.descended = 0; this.score = 0; this.isBest = false;
    this.monsters = []; this.dist = Infinity; this.nearest = null;
    this.adrenaline = 0; this.boostT = 0; this.events = [];
    this.crumbs = []; this.sLast = 0; this.sampleAcc = 0; this.riderAvg = rider.speed;
    this.lastZ = rider.z; this.closeState = false; this.wasAir = false; this.secondDone = false;
    this.wasRiding = false;
    this.base = cfg.escape === 'base' ? this.findBase(rider) : null;
    this.baseMissing = cfg.escape === 'base' && !this.base;
    this.best = this.loadBest();
    this.pushCrumb(rider, 0);
  }

  stop(): void { this.phase = 'off'; this.monsters = []; this.dist = Infinity; this.nearest = null; this.boostT = 0; this.events = []; }

  /** The boost key: burn adrenaline for a few seconds of speed. */
  boost(): boolean {
    if (!this.running || this.boostT > 0 || this.adrenaline < BOOST_COST) return false;
    this.adrenaline -= BOOST_COST; this.boostT = BOOST_TIME;
    this.events.push({ kind: 'boost' });
    return true;
  }

  private bestKey(): string { return `outrun:${this.pack.meta.slug}:${this.cfg.difficulty}:${this.cfg.escape}`; }
  loadBest(): Best | null { try { return JSON.parse(localStorage.getItem(this.bestKey()) ?? 'null'); } catch { return null; } }
  private saveBest(): void {
    if (this.best && this.best.score >= this.score) return;
    this.best = { score: Math.round(this.score), time: this.time, date: new Date().toISOString().slice(0, 10) };
    this.isBest = true;
    try { localStorage.setItem(this.bestKey(), JSON.stringify(this.best)); } catch { /* private mode */ }
  }

  /**
   * The base area: 150 m grid cells with 5 or more buildings, within 250 m of a lift's bottom
   * station (where the resort loads) and within 150 m of height of the lowest such cluster (so
   * mid-mountain lift bases do not count); of those, the nearest to the rider. Without any, the
   * lowest cluster in the pack.
   */
  private findBase(rider: Rider): [number, number] | null {
    const cells = new Map<string, { n: number; x: number; y: number; z: number }>();
    for (const b of this.pack.features.buildings) {
      if (!b.points.length) continue;
      let cx = 0, cy = 0;
      for (const p of b.points) { cx += p[0]; cy += p[1]; }
      cx /= b.points.length; cy /= b.points.length;
      const k = `${Math.floor(cx / 150)},${Math.floor(cy / 150)}`;
      const c = cells.get(k) ?? { n: 0, x: 0, y: 0, z: 0 };
      c.n++; c.x += cx; c.y += cy; c.z += b.zBase;
      cells.set(k, c);
    }
    const clusters = [...cells.values()].filter((c) => c.n >= 5).map((c) => ({ x: c.x / c.n, y: c.y / c.n, z: c.z / c.n }));
    if (!clusters.length) return null;
    const bottoms = this.pack.features.lifts.map((l) => l.stations.reduce((a, b) => (b[2] < a[2] ? b : a)));
    const bases = clusters.filter((c) => bottoms.some((b) => Math.hypot(b[0] - c.x, b[1] - c.y) < 250));
    let best: typeof clusters[number];
    if (bases.length) {
      const lowest = Math.min(...bases.map((c) => c.z));
      best = bases.filter((c) => c.z < lowest + 150).reduce((a, b) => (Math.hypot(b.x - rider.x, b.y - rider.y) < Math.hypot(a.x - rider.x, a.y - rider.y) ? b : a));
    } else best = clusters.reduce((a, b) => (b.z < a.z ? b : a));
    return [best.x, best.y];
  }

  // ---------------------------------------------------------------- breadcrumbs
  private pushCrumb(r: Rider, t: number): void {
    const last = this.crumbs[this.crumbs.length - 1];
    const d = last ? Math.hypot(r.x - last.x, r.y - last.y) : 0;
    if (last && d < 0.3) return; // standing still: no new crumb
    this.sLast += d;
    this.crumbs.push({ x: r.x, y: r.y, z: r.z, s: this.sLast, t });
    if (this.crumbs.length > MAX_CRUMBS) this.crumbs.shift();
  }
  get trailLength(): number { return this.sLast; }
  get trailStart(): number { return this.crumbs.length ? this.crumbs[0].s : 0; }
  /** Point on the trail at arc length s (clamped). */
  private trailAt(s: number, out: { x: number; y: number; z: number }): void {
    const c = this.crumbs;
    if (c.length === 0) return;
    if (s <= c[0].s) { out.x = c[0].x; out.y = c[0].y; out.z = c[0].z; return; }
    const n = c.length;
    if (s >= c[n - 1].s) { out.x = c[n - 1].x; out.y = c[n - 1].y; out.z = c[n - 1].z; return; }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid].s <= s) lo = mid; else hi = mid; }
    const a = c[lo], b = c[hi], u = (s - a.s) / Math.max(1e-6, b.s - a.s);
    out.x = a.x + (b.x - a.x) * u; out.y = a.y + (b.y - a.y) * u; out.z = a.z + (b.z - a.z) * u;
  }
  /** Arc length of the trail point nearest (x, y). */
  private nearestAlong(x: number, y: number): number {
    let best = Infinity, s = this.trailStart;
    for (const c of this.crumbs) { const d = Math.hypot(c.x - x, c.y - y); if (d < best) { best = d; s = c.s; } }
    return s;
  }

  /** Line of sight between two points: 2 m march, the line must stay above the ground. */
  private lineOfSight(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const L = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(L / 2));
    for (let i = 1; i < n; i++) {
      const u = i / n;
      const x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * u, z = z0 + (z1 - z0) * u;
      const g = this.pack.groundHeight(x, y);
      if (!Number.isNaN(g) && g + 0.6 > z) return false;
    }
    return true;
  }

  private ground(x: number, y: number, fallback: number): number { const g = this.pack.groundHeight(x, y); return Number.isNaN(g) ? fallback : g; }

  // ---------------------------------------------------------------- spawning
  private spawn(back: number): MonsterState {
    const p = { x: 0, y: 0, z: 0 };
    const avail = this.sLast - this.trailStart;
    let along: number;
    if (avail >= back) { along = this.sLast - back; this.trailAt(along, p); }
    else {
      // short trail (started from a standstill): the oldest crumb, then straight uphill for the rest
      along = this.trailStart; this.trailAt(along, p);
      const n = this.pack.groundNormal(p.x, p.y) as number[];
      const h = Math.hypot(n[0], n[1]);
      const ux = h > 0.02 ? -n[0] / h : 0, uy = h > 0.02 ? -n[1] / h : 1;
      const extra = back - avail;
      p.x += ux * extra; p.y += uy * extra;
      p.z = this.ground(p.x, p.y, p.z);
      // the uphill stretch becomes trail so the monster walks it down
      const c0 = this.crumbs[0];
      this.crumbs.unshift({ x: p.x, y: p.y, z: p.z, s: c0.s - extra, t: c0.t });
      along = c0.s - extra;
    }
    const m: MonsterState = {
      id: this.nextId++, x: p.x, y: p.y, z: this.ground(p.x, p.y, p.z), heading: 0, speed: 0, mode: 'trail', along,
      liftUp: 0, lift: null, liftGap: 0, liftRate: 0, sight: false, sightLost: 99, frustration: 0, lastDist: Infinity, frustrated: 0, dist: Infinity, phase: this.rng(), footfall: false, hop: 0,
    };
    this.monsters.push(m);
    this.events.push({ kind: 'spawn', m, x: m.x, y: m.y, z: m.z });
    return m;
  }

  // ---------------------------------------------------------------- per frame
  /** `ride` is the lift ride when the rider is on a lift (physics skipped), else null. */
  update(dt: number, rider: Rider, ride: LiftRide | null): void {
    this.events.length = 0;
    if (!this.active) return;
    this.t += dt;
    const P = this.preset;
    if (this.phase === 'countdown') { if (this.t >= 3) { this.phase = 'headstart'; this.t = 0; } return; }
    const riding = !!ride?.riding;
    // breadcrumbs (not on a lift: the monster rides the cable instead)
    this.sampleAcc += dt;
    if (!riding && this.sampleAcc >= SAMPLE_DT) { this.sampleAcc = 0; this.pushCrumb(rider, this.time); }
    if (this.wasRiding && !riding) { this.crumbs = []; this.pushCrumb(rider, this.time); }
    // rider's 5 s average speed (exponential), only while actually moving on the snow
    const k = Math.min(1, dt / 5);
    const rs = riding ? rider.speed * RIDE_SPEEDUP : rider.speed;
    this.riderAvg += (rs - this.riderAvg) * k;
    if (this.phase === 'headstart') {
      if (this.t >= P.head) { this.phase = 'chase'; this.t = 0; this.spawn(150 + this.rng() * 100); this.events.push({ kind: 'wake' }); }
      this.wasRiding = riding;
      return;
    }
    if (this.phase === 'caught' || this.phase === 'escaped') { this.wasRiding = riding; return; }
    // ---- chase
    this.time += dt;
    this.boostT = Math.max(0, this.boostT - dt);
    const drop = this.lastZ - rider.z; if (drop > 0 && drop < 50) this.descended += drop; this.lastZ = rider.z;
    // adrenaline: carving fast, clean landings, spins
    if (rider.onGround && rider.speed > 15 && Math.abs(rider.edgeAngle) > 0.4 && !riding) this.adrenaline = Math.min(1, this.adrenaline + 0.05 * dt);
    if (!rider.onGround && !riding) { if (!this.wasAir) this.airStart = this.time; }
    else if (this.wasAir && !riding) {
      const air = this.time - this.airStart;
      if (air > 0.5 && rider.crashed <= 0 && rider.landingShock < 0.35) this.adrenaline = Math.min(1, this.adrenaline + 0.1 + (Math.abs(rider.spin) > 2.5 ? 0.2 : 0));
    }
    this.wasAir = !rider.onGround;
    // the speed law
    const kt = P.k0 + P.kRate * this.time;
    const ramp = P.ramp * this.time;
    let nearest = Infinity, near: MonsterState | null = null;
    for (const m of this.monsters) {
      m.footfall = false;
      const d = Math.hypot(rider.x - m.x, rider.y - m.y);
      m.dist = d;
      if (m.mode === 'wait') continue;
      let speed = Math.max(P.min, Math.min(P.max, this.riderAvg * kt + ramp));
      if (d > FAR) speed += Math.min(4, (d - FAR) / 50);
      if (d < CLOSE_OUT) speed -= 2;
      m.speed += (speed - m.speed) * Math.min(1, dt * 2);
      // frustration: the gap has not moved 5 m in 8 s (standing out of reach): take the direct line for a while
      m.frustration += dt;
      if (m.frustration >= 8) { if (Math.abs(d - m.lastDist) < 5 && d > CATCH * 2) m.frustrated = 6; m.lastDist = d; m.frustration = 0; }
      m.frustrated = Math.max(0, m.frustrated - dt);
      if (riding && ride) this.updateLift(m, ride, rider, dt);
      else if (m.mode === 'lift') this.leaveLift(m, rider, dt);
      else this.updateGround(m, rider, d, dt);
      // gallop phase
      const strideRate = m.mode === 'lift' ? 0 : Math.max(0.3, m.speed / STRIDE);
      const before = m.phase;
      m.phase = (m.phase + strideRate * dt) % 1;
      // two footfalls a stride (the fore pair and the hind pair)
      if (m.mode !== 'lift' && (Math.floor(before * 2) !== Math.floor(m.phase * 2) || m.phase < before)) { m.footfall = true; this.events.push({ kind: 'footfall', m, x: m.x, y: m.y, z: m.z }); }
      if (d < nearest) { nearest = d; near = m; }
      // caught: close, roughly at the same height, not sitting on a chair above it
      const dz = Math.abs(rider.z - m.z);
      if (d < CATCH && dz < 4 && !riding) { this.caught(m); return; }
    }
    this.dist = nearest; this.nearest = near;
    // close calls
    if (nearest < CLOSE_IN) this.closeState = true;
    else if (this.closeState && nearest > CLOSE_OUT) { this.closeState = false; this.closeCalls++; this.adrenaline = Math.min(1, this.adrenaline + 0.25); this.events.push({ kind: 'closecall', m: near ?? undefined }); }
    this.score = this.time + this.descended / 10 + 50 * this.closeCalls;
    // the second one
    if (this.cfg.escape === 'endless' && !this.secondDone && this.time > SECOND) { this.secondDone = true; this.spawn(250); this.events.push({ kind: 'second' }); }
    // the base
    if (this.base && Math.hypot(rider.x - this.base[0], rider.y - this.base[1]) < BASE_R) {
      this.phase = 'escaped'; this.t = 0;
      for (const m of this.monsters) { m.mode = 'wait'; m.speed = 0; }
      this.saveBest();
      this.events.push({ kind: 'escaped' });
    }
    this.wasRiding = riding;
  }

  private caught(m: MonsterState): void {
    this.phase = 'caught'; this.t = 0; this.boostT = 0;
    for (const o of this.monsters) { o.mode = 'wait'; o.speed = 0; }
    this.dist = m.dist; this.nearest = m;
    this.saveBest();
    this.events.push({ kind: 'caught', m });
  }

  private updateGround(m: MonsterState, rider: Rider, d: number, dt: number): void {
    const p = { x: 0, y: 0, z: 0 };
    // line of sight inside SIGHT m, or a frustrated monster, charges straight
    const sight = d < SIGHT && this.lineOfSight(m.x, m.y, m.z + 1.8, rider.x, rider.y, rider.z + 1);
    if (sight && !m.sight && m.sightLost > 2) this.events.push({ kind: 'sight', m });
    m.sight = sight;
    m.sightLost = sight ? 0 : m.sightLost + dt;
    const direct = sight || m.frustrated > 0;
    if (direct) {
      if (m.mode === 'trail') m.mode = 'direct';
      const dx = rider.x - m.x, dy = rider.y - m.y, L = Math.hypot(dx, dy) || 1;
      const step = Math.min(L, m.speed * dt);
      m.x += dx / L * step; m.y += dy / L * step;
      m.heading = Math.atan2(dx, dy);
      m.z = this.ground(m.x, m.y, m.z);
    } else {
      if (m.mode === 'direct') {
        // back onto the trail at the nearest point behind the rider
        if (m.sightLost > 1) { m.mode = 'trail'; m.along = this.nearestAlong(m.x, m.y); }
        else {
          const dx = rider.x - m.x, dy = rider.y - m.y, L = Math.hypot(dx, dy) || 1;
          const step = Math.min(L, m.speed * dt);
          m.x += dx / L * step; m.y += dy / L * step; m.z = this.ground(m.x, m.y, m.z);
          return;
        }
      }
      m.along = Math.min(this.sLast, m.along + m.speed * dt);
      this.trailAt(m.along, p);
      // past the last crumb: straight at the rider's live position
      if (m.along >= this.sLast - 0.01) {
        const dx = rider.x - p.x, dy = rider.y - p.y, L = Math.hypot(dx, dy) || 1;
        const step = Math.min(L, m.speed * dt);
        p.x += dx / L * step; p.y += dy / L * step;
      }
      const hx = p.x - m.x, hy = p.y - m.y;
      if (Math.hypot(hx, hy) > 0.05) m.heading = Math.atan2(hx, hy);
      m.x = p.x; m.y = p.y;
      m.z = this.ground(m.x, m.y, p.z);
    }
  }

  /** On a lift: run to the bottom terminal, then follow the cable a fixed gap behind the chair. */
  private updateLift(m: MonsterState, ride: LiftRide, rider: Rider, dt: number): void {
    const l = ride.lift!;
    if (m.mode !== 'lift') {
      // reach the loading point first (the trail ends there)
      const bx = l.bottom[0], by = l.bottom[1];
      const d = Math.hypot(bx - m.x, by - m.y);
      if (d > 6) {
        if (m.mode === 'trail' && m.along < this.sLast - 1) { const p = { x: 0, y: 0, z: 0 }; m.along = Math.min(this.sLast, m.along + m.speed * dt); this.trailAt(m.along, p); m.heading = Math.atan2(p.x - m.x, p.y - m.y) || m.heading; m.x = p.x; m.y = p.y; m.z = this.ground(m.x, m.y, p.z); }
        else { const step = Math.min(d, m.speed * dt); m.x += (bx - m.x) / d * step; m.y += (by - m.y) / d * step; m.heading = Math.atan2(bx - m.x, by - m.y); m.z = this.ground(m.x, m.y, m.z); }
        return;
      }
      m.mode = 'lift'; m.lift = l; m.liftRate = 0;
      m.liftGap = Math.max(25, Math.min(150, Math.hypot(rider.x - m.x, rider.y - m.y)));
      m.liftUp = Math.max(0, ride.up - m.liftGap);
      this.liftUpLast = ride.up;
      this.events.push({ kind: 'roar', m });
    }
    // keep the gap: move as fast as the chair (fast-forward included)
    const want = Math.max(0, ride.up - m.liftGap);
    const rate = l.speed * RIDE_SPEEDUP * (ride.fast ? FAST_FORWARD : 1);
    m.liftUp = Math.min(want, m.liftUp + rate * dt * 1.2);
    this.liftUpLast = ride.up;
    this.placeOnLift(m);
  }

  /**
   * The rider has unloaded: finish the climb, tower to tower, fast enough to reach the top about
   * one and a half head starts later, then drop onto the new trail at the top.
   */
  private leaveLift(m: MonsterState, rider: Rider, dt: number): void {
    const l = m.lift!;
    const len = this.lifts.rideLength(l);
    if (m.liftRate <= 0) m.liftRate = Math.max(l.speed * RIDE_SPEEDUP * 2, (len - m.liftUp) / (this.preset.head * 1.5));
    m.liftUp += m.liftRate * dt;
    if (m.liftUp < len) { this.placeOnLift(m); return; }
    m.mode = 'trail'; m.lift = null; m.hop = 0;
    m.along = this.trailStart;
    const p = { x: 0, y: 0, z: 0 }; this.trailAt(m.along, p);
    m.x = p.x; m.y = p.y; m.z = this.ground(p.x, p.y, p.z);
    m.heading = Math.atan2(rider.x - m.x, rider.y - m.y);
    this.events.push({ kind: 'roar', m });
  }

  private readonly seat = new THREE.Vector3();
  private placeOnLift(m: MonsterState): void {
    const l = m.lift!;
    const s = this.lifts.seatAt(l, m.liftUp, this.seat);
    const nx = s.x, ny = -s.z;
    const hx = nx - m.x, hy = ny - m.y;
    if (Math.hypot(hx, hy) > 0.05) m.heading = Math.atan2(hx, hy);
    m.x = nx; m.y = ny;
    // hops between towers: a bounce whose period is the tower spacing
    const towers = l.towerUp;
    let prev = 0, next = l.length;
    for (const t of towers) { if (t <= m.liftUp) prev = t; else { next = t; break; } }
    const u = (m.liftUp - prev) / Math.max(1, next - prev);
    const wasHop = m.hop;
    m.hop = Math.sin(u * Math.PI);
    if (wasHop > 0.1 && m.hop <= 0.1 && u < 0.5) { m.footfall = true; this.events.push({ kind: 'footfall', m, x: m.x, y: m.y, z: m.z }); }
    m.z = s.y + l.riderDrop + 1.0 + 4 * m.hop;
  }
}
