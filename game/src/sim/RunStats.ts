import type { Pack } from '../pack/Pack';
import type { Rider } from './Rider';

/**
 * FEAT-055: what you just rode. Per run: time, top speed, distance, vertical descended, longest air,
 * biggest drop, max lateral g, the named runs ridden (nearest mapped run line) and the line itself.
 * A run starts when the rider gets going on the board and ends when they board a lift or stop for
 * a few seconds after a real descent; the summary goes to `onRunEnd`. Session totals (vertical,
 * runs, lifts) are kept per day in local storage, and personal bests (fastest time, top speed) per
 * named run.
 */
export interface RunSummary {
  names: string[];
  time: number; topSpeed: number; distance: number; vertical: number;
  maxAir: number; maxDrop: number; maxG: number;
  /** the line, pack x / y every couple of seconds */
  line: [number, number][];
  /** new personal bests on the first named run */
  pbTime: boolean; pbSpeed: boolean;
  /** today's totals after this run */
  day: DayTotals;
}
export interface DayTotals { date: string; vertical: number; runs: number; lifts: number }

/** a run needs this much descent (m) to count when it ends at a stop */
const MIN_VERT = 60;
/** stopped this long (s) ends the run */
const STOP_END = 4;
/** a mapped run line within this distance (m) is the run you're on */
const RUN_NEAR = 25;
const DAY_KEY = 'session-day', PB_KEY = 'run-pbs';

interface RunLine { name: string; pts: number[][]; x0: number; y0: number; x1: number; y1: number }

export class RunStats {
  active = false;
  time = 0; topSpeed = 0; distance = 0; vertical = 0; maxAir = 0; maxDrop = 0; maxG = 0;
  /** the named run under the rider right now ('' off-piste) */
  current = '';
  private names: string[] = [];
  private line: [number, number][] = [];
  private lineT = 0; private nameT = 0; private stillT = 0;
  private lastZ = NaN; private wasGround = true; private takeoffZ = 0; private wasLift = false;
  private readonly runs: RunLine[] = [];
  day: DayTotals;
  onRunEnd: ((s: RunSummary) => void) | null = null;

  constructor(pack: Pack) {
    for (const r of pack.features.runs ?? []) {
      if (!r.name || r.points.length < 2) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of r.points) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      this.runs.push({ name: r.name, pts: r.points, x0: x0 - RUN_NEAR, y0: y0 - RUN_NEAR, x1: x1 + RUN_NEAR, y1: y1 + RUN_NEAR });
    }
    this.day = loadDay();
  }

  /** The named run line nearest (x, y) within RUN_NEAR, or ''. */
  runAt(x: number, y: number): string {
    let best = RUN_NEAR * RUN_NEAR, name = '';
    for (const r of this.runs) {
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
      const p = r.pts;
      for (let i = 1; i < p.length; i++) {
        const ax = p[i - 1][0], ay = p[i - 1][1], dx = p[i][0] - ax, dy = p[i][1] - ay;
        const l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
        const ex = ax + dx * t - x, ey = ay + dy * t - y, d = ex * ex + ey * ey;
        if (d < best) { best = d; name = r.name; }
      }
    }
    return name;
  }

  /** Call once a frame after the sim. `onLift`: riding a lift this frame. */
  update(dt: number, r: Rider, onLift: boolean): void {
    if (onLift && !this.wasLift) { this.day.lifts++; saveDay(this.day); if (this.active) this.end(); }
    this.wasLift = onLift;
    if (onLift || r.onFoot) { this.lastZ = r.z; this.wasGround = true; return; }
    const spd = Math.hypot(r.vx, r.vy);
    if (!this.active) {
      if (spd > 3 && r.onGround) this.start(r);
      else { this.lastZ = r.z; return; }
    }
    this.time += dt;
    this.topSpeed = Math.max(this.topSpeed, spd);
    this.distance += spd * dt;
    if (Number.isFinite(this.lastZ) && r.z < this.lastZ && this.lastZ - r.z < 20) this.vertical += this.lastZ - r.z; // a reset or teleport is not vertical
    this.lastZ = r.z;
    if (r.onGround) this.maxG = Math.max(this.maxG, Math.abs(r.lateralG));
    // air and drops
    if (this.wasGround && !r.onGround) this.takeoffZ = r.z;
    if (!r.onGround) this.maxAir = Math.max(this.maxAir, r.airTime);
    if (!this.wasGround && r.onGround) this.maxDrop = Math.max(this.maxDrop, this.takeoffZ - r.z);
    this.wasGround = r.onGround;
    // the line and the run names
    this.lineT -= dt;
    if (this.lineT <= 0) { this.lineT = 2; this.line.push([r.x, r.y]); }
    this.nameT -= dt;
    if (this.nameT <= 0) {
      this.nameT = 0.5;
      this.current = this.runAt(r.x, r.y);
      // each run name is listed once, so a revisit (A, B, A) shows as "A → B"
      if (this.current && !this.names.includes(this.current)) this.names.push(this.current);
    }
    // stopped after a real descent: the run is over
    this.stillT = spd < 0.5 ? this.stillT + dt : 0;
    if (this.stillT > STOP_END) { if (this.vertical >= MIN_VERT) this.end(); else this.reset(); }
  }

  private start(r: Rider): void {
    this.reset();
    this.active = true; this.lastZ = r.z; this.wasGround = r.onGround;
    this.line.push([r.x, r.y]);
  }

  private reset(): void {
    this.active = false; this.time = 0; this.topSpeed = 0; this.distance = 0; this.vertical = 0;
    this.maxAir = 0; this.maxDrop = 0; this.maxG = 0; this.names = []; this.line = []; this.lineT = 0; this.nameT = 0; this.stillT = 0;
  }

  /** Close the run (a restart counts only if it was a real run). */
  end(): void {
    if (!this.active) return;
    if (this.vertical < MIN_VERT) { this.reset(); return; }
    this.day = loadDay();
    this.day.vertical += this.vertical; this.day.runs++;
    saveDay(this.day);
    let pbTime = false, pbSpeed = false;
    const first = this.names[0];
    if (first) {
      const pbs = loadPbs(), pb = pbs[first];
      pbTime = !!pb && this.time < pb.time; pbSpeed = !!pb && this.topSpeed > pb.speed;
      pbs[first] = { time: pb ? Math.min(pb.time, this.time) : this.time, speed: pb ? Math.max(pb.speed, this.topSpeed) : this.topSpeed };
      savePbs(pbs);
    }
    const s: RunSummary = { names: [...this.names], time: this.time, topSpeed: this.topSpeed, distance: this.distance, vertical: this.vertical, maxAir: this.maxAir, maxDrop: this.maxDrop, maxG: this.maxG, line: [...this.line], pbTime, pbSpeed, day: { ...this.day } };
    this.reset();
    this.onRunEnd?.(s);
  }
}

function today(): string { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function loadDay(): DayTotals {
  try { const d = JSON.parse(localStorage.getItem(DAY_KEY) ?? 'null'); if (d && d.date === today()) return d; } catch { /* private mode */ }
  return { date: today(), vertical: 0, runs: 0, lifts: 0 };
}
function saveDay(d: DayTotals): void { try { localStorage.setItem(DAY_KEY, JSON.stringify(d)); } catch { /* private mode */ } }
function loadPbs(): Record<string, { time: number; speed: number }> { try { return JSON.parse(localStorage.getItem(PB_KEY) ?? '{}') ?? {}; } catch { return {}; } }
function savePbs(p: Record<string, { time: number; speed: number }>): void { try { localStorage.setItem(PB_KEY, JSON.stringify(p)); } catch { /* private mode */ } }
