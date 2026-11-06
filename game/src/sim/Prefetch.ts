import type { Pack } from '../pack/Pack';

/** seconds of travel to load ahead of the rider */
export const LOOK_AHEAD_S = 3;
/** half-width of the square kept loaded around the rider and around the look-ahead corridor (m) */
const AROUND = 400;
const CORRIDOR = 250;
/** frame-to-frame moves faster than this are teleports (reset, map pick, lift skip), not travel */
const TELEPORT_MS = 120;

/**
 * Requests fine terrain and mask tiles ahead of the rider along the direction of travel
 * (speed x LOOK_AHEAD_S), so fast runs never reach ground whose 1 m tiles are still in flight.
 * Velocity comes from the frame-to-frame motion, so it also covers lift rides. While on a lift
 * the unloading point is kept loaded too, ready for the drop at the top (or a skip to it).
 */
export class Prefetch {
  /** look-ahead point (pack metres); vegetation and rocks stream around it as well as the rider */
  ax = 0; ay = 0;
  private lx = NaN; private ly = NaN;
  private vx = 0; private vy = 0;

  update(pack: Pack, x: number, y: number, dt: number, liftTop: readonly number[] | null): void {
    if (dt > 0 && !Number.isNaN(this.lx)) {
      const mx = (x - this.lx) / dt, my = (y - this.ly) / dt;
      if (Math.hypot(mx, my) > TELEPORT_MS) { this.vx = 0; this.vy = 0; }
      else { const k = Math.min(1, dt * 4); this.vx += (mx - this.vx) * k; this.vy += (my - this.vy) * k; }
    }
    this.lx = x; this.ly = y;
    this.ax = x + this.vx * LOOK_AHEAD_S; this.ay = y + this.vy * LOOK_AHEAD_S;
    const box = (x0: number, y0: number, x1: number, y1: number) => { pack.fine?.request(x0, y0, x1, y1); pack.mask?.request(x0, y0, x1, y1); };
    box(x - AROUND, y - AROUND, x + AROUND, y + AROUND);
    // corridor from the rider to the look-ahead point
    box(Math.min(x, this.ax) - CORRIDOR, Math.min(y, this.ay) - CORRIDOR, Math.max(x, this.ax) + CORRIDOR, Math.max(y, this.ay) + CORRIDOR);
    if (liftTop) box(liftTop[0] - AROUND, liftTop[1] - AROUND, liftTop[0] + AROUND, liftTop[1] + AROUND);
  }
}
