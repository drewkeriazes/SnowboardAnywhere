import type { Rider } from './Rider';
import { nearestOnCourse, type Course } from './Courses';

/**
 * Time-trial state machine and ghost recording.
 *   idle -> (inside a start gate) armed -> (ride through it, down the course) running
 *   running -> (all checkpoints, reach the finish) finished | (off course 4 s, R, lift) cancelled
 * The best run per course is saved to localStorage with its splits and a 10 Hz ghost track.
 */
export interface GhostSample { t: number; x: number; y: number; z: number; h: number; lg: number; e: number; f: number } // f bits: 1 onGround, 2 tuck, 4 crashed
export interface Best { time: number; splits: number[]; samples: GhostSample[]; date: string }

const START_R = 14; // m around the start point that arms the gate
const CHECK_R = 35; // m to count a checkpoint
const FINISH_R = 25;
const OFF_COURSE = 50; // m from the route
const OFF_TIME = 4; // s off course before DNF
const SAMPLE_DT = 0.1;

export type TrialEvent =
  | { kind: 'armed'; course: Course; best: Best | null }
  | { kind: 'start'; course: Course; best: Best | null }
  | { kind: 'split'; index: number; time: number; delta: number | null }
  | { kind: 'finish'; time: number; best: Best | null; isBest: boolean }
  | { kind: 'cancel'; reason: string };

export class TimeTrial {
  state: 'idle' | 'armed' | 'running' = 'idle';
  course: Course | null = null;
  time = 0;
  best: Best | null = null;
  private next = 0; // next checkpoint index
  private splits: number[] = [];
  private samples: GhostSample[] = [];
  private sampleAcc = 0;
  private offFor = 0;
  private armedDist = 0;
  onEvent: ((e: TrialEvent) => void) | null = null;

  constructor(private readonly packSlug: string, private readonly courses: Course[]) {}

  private key(c: Course): string { return `ghost:${this.packSlug}:${c.id}`; }
  loadBest(c: Course): Best | null {
    try { return JSON.parse(localStorage.getItem(this.key(c)) ?? 'null'); } catch { return null; }
  }
  private saveBest(c: Course, b: Best): void {
    try { localStorage.setItem(this.key(c), JSON.stringify(b)); } catch { /* storage full or private mode */ }
  }

  /** Nearest course start within `maxDist` m. */
  nearestStart(x: number, y: number, maxDist = Infinity): Course | null {
    let best: Course | null = null, bd = maxDist;
    for (const c of this.courses) { const d = Math.hypot(c.start[0] - x, c.start[1] - y); if (d < bd) { bd = d; best = c; } }
    return best;
  }

  cancel(reason: string): void {
    if (this.state === 'idle') return;
    const was = this.state;
    this.state = 'idle'; this.course = null;
    if (was === 'running') this.onEvent?.({ kind: 'cancel', reason });
  }

  update(r: Rider, dt: number, tuck: boolean): void {
    if (this.state === 'idle' || this.state === 'armed') {
      const c = this.nearestStart(r.x, r.y, START_R);
      if (this.state === 'idle') {
        if (c) {
          this.state = 'armed'; this.course = c; this.best = this.loadBest(c);
          this.armedDist = nearestOnCourse(c, r.x, r.y).along;
          this.onEvent?.({ kind: 'armed', course: c, best: this.best });
        }
        return;
      }
      // armed: leaving the gate area down the course starts the clock; leaving any other way disarms
      const course = this.course!;
      const dStart = Math.hypot(course.start[0] - r.x, course.start[1] - r.y);
      if (dStart <= START_R) return;
      const n = nearestOnCourse(course, r.x, r.y);
      if (n.dist < 25 && n.along > this.armedDist + 5 && r.onGround) {
        this.state = 'running'; this.time = 0; this.next = 0; this.splits = []; this.samples = []; this.sampleAcc = SAMPLE_DT; this.offFor = 0;
        this.onEvent?.({ kind: 'start', course, best: this.best });
      } else { this.state = 'idle'; this.course = null; }
      return;
    }
    // running
    const c = this.course!;
    this.time += dt;
    this.sampleAcc += dt;
    if (this.sampleAcc >= SAMPLE_DT) {
      this.sampleAcc = 0;
      const f = (r.onGround ? 1 : 0) | (tuck ? 2 : 0) | (r.crashed > 0 ? 4 : 0);
      this.samples.push({ t: +this.time.toFixed(2), x: +r.x.toFixed(2), y: +r.y.toFixed(2), z: +r.z.toFixed(2), h: +r.heading.toFixed(3), lg: +r.lateralG.toFixed(2), e: +r.edgeAngle.toFixed(2), f });
    }
    const n = nearestOnCourse(c, r.x, r.y);
    this.offFor = n.dist > OFF_COURSE ? this.offFor + dt : 0;
    if (this.offFor > OFF_TIME) { this.cancel('Off course'); return; }
    // checkpoints in order
    while (this.next < c.checkpoints.length) {
      const cp = c.checkpoints[this.next];
      if (n.along >= cp - 5 && n.dist < CHECK_R) {
        this.splits.push(this.time);
        const ref = this.best?.splits[this.next];
        this.onEvent?.({ kind: 'split', index: this.next, time: this.time, delta: ref !== undefined ? this.time - ref : null });
        this.next++;
      } else break;
    }
    if (this.next >= c.checkpoints.length && Math.hypot(c.finish[0] - r.x, c.finish[1] - r.y) < FINISH_R) {
      const isBest = !this.best || this.time < this.best.time;
      const rec: Best = { time: this.time, splits: this.splits, samples: this.samples, date: new Date().toISOString() };
      if (isBest) { this.saveBest(c, rec); }
      const prev = this.best;
      this.state = 'idle'; this.course = null;
      this.onEvent?.({ kind: 'finish', time: rec.time, best: isBest ? rec : prev, isBest });
    }
  }

  /** Ghost pose at the current run time (interpolated), or null. */
  ghostAt(t: number): GhostSample | null {
    const s = this.best?.samples;
    if (!s || s.length < 2 || this.state !== 'running') return null;
    if (t >= s[s.length - 1].t) return s[s.length - 1];
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m].t <= t) lo = m; else hi = m; }
    const a = s[lo], b = s[hi], k = (t - a.t) / Math.max(1e-6, b.t - a.t);
    let dh = b.h - a.h; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI;
    return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, h: a.h + dh * k, lg: a.lg + (b.lg - a.lg) * k, e: a.e + (b.e - a.e) * k, f: k < 0.5 ? a.f : b.f };
  }
}
