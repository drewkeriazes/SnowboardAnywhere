import type { Pack } from '../pack/Pack';
import type { Settings } from '../ui/Settings';
import type { Environment } from './Sky';
import { sunPosition, guessUtcOffset } from './Sun';

/** BUG-084: the hour the snow reads on "Resort default": the pack's sun carries only a direction, no hour */
export const RESORT_DEFAULT_HOUR = 13;

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
  live(s: Pick<Settings, 'timeOfDay'>): boolean { return s.timeOfDay === 'now' || this.timeParam === 'now'; }

  /** the time of day in force: ?time= wins over the setting */
  private mode(s: Pick<Settings, 'timeOfDay'>): 'pack' | 'now' | number { return this.timeParam ?? s.timeOfDay; }

  /** the resort's local clock now (h, 0..24) */
  private nowHour(): number { const now = new Date(); return ((now.getUTCHours() + now.getUTCMinutes() / 60 + this.utcOff) % 24 + 24) % 24; }

  /** BUG-084: the local hour the sun stands at (?time= first, then the setting); RideFrame's snow reads the same hour */
  hour(s: Pick<Settings, 'timeOfDay'>): number {
    const mode = this.mode(s);
    return mode === 'pack' ? RESORT_DEFAULT_HOUR : mode === 'now' ? this.nowHour() : mode;
  }

  apply(s: Pick<Settings, 'timeOfDay' | 'month'>): void {
    const mode = this.mode(s);
    if (mode === 'pack') { this.env.setSun(this.pack.meta.sun.azimuth, this.pack.meta.sun.elevation); return; }
    const date = mode === 'now' ? new Date() : new Date(Date.UTC(new Date().getFullYear(), s.month - 1, 15));
    const p = sunPosition(this.lon, this.lat, date, this.hour(s), this.utcOff);
    this.env.setSun(p.azimuth, Math.max(-5, p.elevation));
  }

  /** on the live clock, move the sun once a minute */
  update(dt: number, s: Pick<Settings, 'timeOfDay' | 'month'>): void {
    if (!this.live(s)) return;
    this.clock += dt;
    if (this.clock > 60) { this.clock = 0; this.apply(s); }
  }
}
