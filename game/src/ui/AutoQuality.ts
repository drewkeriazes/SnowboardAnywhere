/**
 * FEAT-062: adaptive quality to hold the target frame rate. A smoothed frame rate is checked twice a
 * second. Below 92 % of the target for 2 s, it steps down one level (cheapest visual loss first);
 * steps never come closer than 3 s apart. It only tries a step back up after 8 s at the target, and
 * if that step makes it drop again within 10 s, the wait before the next try doubles (up to 2 min),
 * so it settles instead of thrashing. Pure logic: main applies the level.
 */
export interface QualityLevel {
  /** render resolution as a share of the setting */
  res: number;
  /** cloud ray-march steps one preset lower */
  cloudsDown: boolean;
  /** tree density as a share of the setting */
  trees: number;
  /** falling snow particles as a share */
  snow: number;
}

/** cumulative levels, the cheapest visual loss first */
export const LEVELS: QualityLevel[] = [
  { res: 1, cloudsDown: false, trees: 1, snow: 1 },
  { res: 0.85, cloudsDown: false, trees: 1, snow: 1 },
  { res: 0.75, cloudsDown: true, trees: 1, snow: 1 },
  { res: 0.75, cloudsDown: true, trees: 0.7, snow: 0.6 },
  { res: 0.65, cloudsDown: true, trees: 0.5, snow: 0.4 },
];

const CHECK = 0.5, DOWN_AFTER = 2, UP_AFTER = 8, COOLDOWN = 3, RELAPSE = 10, BACKOFF_MAX = 120;

export class AutoQuality {
  level = 0;
  /** smoothed frames per second */
  fps = 60;
  private t = 0; private low = 0; private good = 0; private sinceChange = 99;
  private upWait = UP_AFTER; private lastUpAt = -99; private clock = 0;

  /** Feed one frame. Returns true when the level changed. `target` 0 means off. */
  frame(dt: number, target: number): boolean {
    if (!(dt > 0) || dt > 0.5) return false; // a tab switch or a hitch is not a measurement
    this.clock += dt;
    this.fps += (1 / dt - this.fps) * Math.min(1, dt * 2); // about a 0.5 s average
    this.sinceChange += dt;
    this.t += dt;
    if (this.t < CHECK) return false;
    const step = this.t; this.t = 0;
    if (target <= 0) { if (this.level !== 0) { this.level = 0; return true; } return false; }
    if (this.fps < target * 0.92) { this.low += step; this.good = 0; }
    else { this.good += this.fps >= target * 0.97 ? step : 0; this.low = 0; }
    if (this.low >= DOWN_AFTER && this.sinceChange >= COOLDOWN && this.level < LEVELS.length - 1) {
      // dropped soon after a step up: that level was too much, so wait longer before trying again
      if (this.clock - this.lastUpAt < RELAPSE) this.upWait = Math.min(BACKOFF_MAX, this.upWait * 2);
      this.level++; this.low = 0; this.good = 0; this.sinceChange = 0;
      return true;
    }
    if (this.good >= this.upWait && this.sinceChange >= COOLDOWN && this.level > 0) {
      this.level--; this.good = 0; this.sinceChange = 0; this.lastUpAt = this.clock;
      return true;
    }
    return false;
  }

  get current(): QualityLevel { return LEVELS[this.level]; }

  /** What is reduced, for the HUD ('' at full quality). */
  describe(): string {
    if (this.level === 0) return '';
    const q = this.current, parts = [`res ${Math.round(q.res * 100)}%`];
    if (q.cloudsDown) parts.push('clouds lower');
    if (q.trees < 1) parts.push(`trees ${Math.round(q.trees * 100)}%`);
    if (q.snow < 1) parts.push(`snowfall ${Math.round(q.snow * 100)}%`);
    return `auto quality -${this.level}: ${parts.join(', ')}`;
  }
}
