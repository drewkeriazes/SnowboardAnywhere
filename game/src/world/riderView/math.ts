
export const d2r = Math.PI / 180;
export const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** a second-order follow: position and rate */
export interface Follow { x: number; v: number }
/** BUG-056: critically damped follow of `target`: no overshoot, and a steady ramp is tracked `lag` s behind */
export function follow(f: Follow, target: number, lag: number, dt: number): void {
  if (lag < 0.005) { f.x = target; f.v = 0; return; }
  const w = 2 / lag, n = Math.min(40, Math.ceil(dt * w / 0.5)), h = dt / n;
  for (let i = 0; i < n; i++) { f.v += (w * w * (target - f.x) - 2 * w * f.v) * h; f.x += f.v * h; }
}
