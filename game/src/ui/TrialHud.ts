import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { TimeTrial, TrialEvent } from '../sim/TimeTrial';
import type { Settings } from './Settings';

/** a trial time: 42.17, or 1:02.50 past a minute */
const fmt = (t: number) => { const m = Math.floor(t / 60), sec = t - m * 60; return m > 0 ? `${m}:${sec.toFixed(2).padStart(5, '0')}` : `${sec.toFixed(2)}`; };

/** The time trial panel (course, clock, distance to go, splits) and the edge arrow toward the finish. */
export class TrialHud {
  private readonly el = document.getElementById('trial')!;
  private readonly arrow = document.getElementById('finish-arrow')!;
  private splitMsg = '';
  private splitTimer = 0;
  private readonly v = new THREE.Vector3();

  constructor(private readonly settings: Settings) {}

  private distStr(m: number): string {
    return this.settings.units === 'metric' ? (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`) : (m >= 1609 ? `${(m / 1609.34).toFixed(2)} mi` : `${(m * 3.28084).toFixed(0)} ft`);
  }

  /** The split line for a trial event; `candidates` is how many courses start at the armed gate. */
  onEvent(e: TrialEvent, candidates: number): void {
    if (e.kind === 'armed') {
      this.splitMsg = candidates > 1 ? `<span class="dim">${candidates} courses start here: follow the one you want</span>` : `<span class="dim">Ride through the gate to start</span>`;
      this.splitTimer = 99;
    }
    else if (e.kind === 'start') { this.splitMsg = e.best ? `Ghost: ${fmt(e.best.time)}` : 'No ghost yet: set the time'; this.splitTimer = 3; }
    else if (e.kind === 'split') { this.splitMsg = e.delta === null ? `Split ${e.index + 1}: ${fmt(e.time)}` : `<span class="${e.delta <= 0 ? 'ahead' : 'behind'}">${e.delta <= 0 ? '' : '+'}${e.delta.toFixed(2)}</span>`; this.splitTimer = 3; }
    else if (e.kind === 'finish') { this.splitMsg = e.isBest ? `<span class="ahead">New best ${fmt(e.time)}</span>` : `Finished ${fmt(e.time)} <span class="dim">(best ${fmt(e.best!.time)})</span>`; this.splitTimer = 6; }
    else if (e.kind === 'cancel') { this.splitMsg = `<span class="behind">${e.reason}</span>`; this.splitTimer = 3; }
  }

  update(dt: number, trial: TimeTrial, pack: Pack, camera: THREE.Camera): void {
    const active = trial.state !== 'idle' ? trial.course : null;
    // edge arrow toward the finish when it is off-screen or behind
    if (active) {
      const f = active.finish;
      const v = this.v.set(f[0], pack.groundHeight(f[0], f[1]) + 6, -f[1]).project(camera);
      const behind = v.z > 1;
      const onScreen = !behind && Math.abs(v.x) < 0.92 && Math.abs(v.y) < 0.9;
      const distTo = Math.max(0, active.length - trial.along);
      if (!onScreen) {
        let ax = behind ? -v.x : v.x, ay = behind ? -v.y : v.y;
        const m = Math.max(Math.abs(ax), Math.abs(ay)) || 1; ax /= m; ay /= m;
        const sx = (ax * 0.88 + 1) / 2 * window.innerWidth, sy = (1 - (ay * 0.85)) / 2 * window.innerHeight;
        this.arrow.style.display = 'block';
        this.arrow.style.left = `${sx}px`; this.arrow.style.top = `${sy}px`;
        (this.arrow.firstElementChild as HTMLElement).style.transform = `rotate(${Math.atan2(ax, ay)}rad)`;
        this.arrow.lastElementChild!.textContent = `${this.distStr(distTo)}`;
      } else this.arrow.style.display = 'none';
    } else this.arrow.style.display = 'none';
    this.splitTimer -= dt;
    if (trial.state === 'running' || trial.state === 'armed' || this.splitTimer > 0) {
      const head = trial.course ? `<div class="name">${trial.course.name}</div>` : '';
      const clock = trial.state === 'running' ? `<div class="clock">${fmt(trial.time)}</div>` : '';
      const best = trial.course && trial.best ? `<div class="dim">Best ${fmt(trial.best.time)}</div>` : '';
      const prog = trial.state === 'running' && trial.course
        ? `<div class="togo">${this.distStr(Math.max(0, trial.course.length - trial.along))} to the finish</div><div class="bar"><div style="width:${Math.min(100, trial.along / trial.course.length * 100).toFixed(1)}%"></div></div>`
        : '';
      const oob = trial.state === 'running' && trial.outside > 0 ? `<div class="split behind">Out of bounds: back in ${trial.graceLeft.toFixed(1)} s</div>` : '';
      const headArmed = trial.state === 'armed' && trial.candidates.length > 1 ? `<div class="name">${trial.candidates.map((e) => e.c.name).slice(0, 4).join(' &middot; ')}</div>` : head;
      this.el.innerHTML = headArmed + clock + prog + oob + best + (this.splitTimer > 0 ? `<div class="split">${this.splitMsg}</div>` : '');
      this.el.classList.add('show');
    } else this.el.classList.remove('show');
  }

  hide(): void { this.el.classList.remove('show'); this.arrow.style.display = 'none'; }
}
