import type { Pack } from '../pack/Pack';
import type { Settings } from '../ui/Settings';
import type { Environment } from './Sky';
import { sunPosition, guessUtcOffset } from './Sun';

/** The sun from the Time of day setting (or ?time=now / ?time=16.5): the pack's own sun, a fixed hour on the 15th of the set month, or the live clock. */
export class SunClock {
  private readonly lon: number;
  private readonly lat: number;
  /** the resort's UTC offset, guessed from its longitude (h) */
  readonly utcOff: number;
  private clock = 0;

  constructor(private readonly env: Environment, private readonly pack: Pack, private readonly timeParam: 'now' | number | null) {
    [this.lon, this.lat] = pack.meta.lonlat;
    this.utcOff = guessUtcOffset(this.lon);
  }

  /** true when the sun follows the real clock */
  live(s: Settings): boolean { return s.timeOfDay === 'now' || this.timeParam === 'now'; }

  apply(s: Settings): void {
    const mode: 'pack' | 'now' | number = this.timeParam ?? s.timeOfDay;
    if (mode === 'pack') { this.env.setSun(this.pack.meta.sun.azimuth, this.pack.meta.sun.elevation); return; }
    let date: Date, hour: number;
    if (mode === 'now') { const now = new Date(); date = now; hour = now.getUTCHours() + now.getUTCMinutes() / 60 + this.utcOff; }
    else { const y = new Date().getFullYear(); date = new Date(Date.UTC(y, s.month - 1, 15)); hour = mode; }
    const p = sunPosition(this.lon, this.lat, date, hour, this.utcOff);
    this.env.setSun(p.azimuth, Math.max(-5, p.elevation));
  }

  /** on the live clock, move the sun once a minute */
  update(dt: number, s: Settings): void {
    if (!this.live(s)) return;
    this.clock += dt;
    if (this.clock > 60) { this.clock = 0; this.apply(s); }
  }
}
