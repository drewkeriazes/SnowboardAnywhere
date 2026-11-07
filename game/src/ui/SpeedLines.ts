/**
 * FEAT-045: faint speed lines at high speed. Thin streaks fly outward from the edges of the view
 * (the middle stays clear), fading in from LINES_FROM to LINES_FULL m/s (about 40 to 60 mph). A 2D
 * canvas over the game, drawn only while visible.
 */
const LINES_FROM = 18, LINES_FULL = 27, N = 48;

export class SpeedLines {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly lines = Array.from({ length: N }, () => ({ a: 0, r: 0, len: 0, v: 0 }));
  private shown = false;
  enabled = true;

  constructor(parent: HTMLElement) {
    this.canvas.className = 'speed-lines';
    this.canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:4';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    for (const l of this.lines) this.spawn(l, Math.random());
  }

  private spawn(l: { a: number; r: number; len: number; v: number }, r = 0): void {
    l.a = Math.random() * Math.PI * 2; l.r = 0.42 + r * 0.5; l.len = 0.05 + Math.random() * 0.1; l.v = 0.9 + Math.random() * 0.8;
  }

  /** `speed` in m/s; `active` false hides it (menus, free fly, on a lift). */
  update(speed: number, dt: number, active: boolean): void {
    const k = this.enabled && active ? Math.max(0, Math.min(1, (speed - LINES_FROM) / (LINES_FULL - LINES_FROM))) : 0;
    const ctx = this.ctx;
    if (!ctx) return;
    if (k <= 0) { if (this.shown) { ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this.shown = false; } return; }
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.hypot(cx, cy);
    ctx.lineCap = 'round';
    for (const l of this.lines) {
      l.r += l.v * dt * (0.6 + speed / 30);
      if (l.r > 1.05) this.spawn(l);
      const c = Math.cos(l.a), s = Math.sin(l.a), r0 = l.r * R, r1 = (l.r + l.len * (0.5 + k)) * R;
      const al = 0.3 * k * Math.min(1, (l.r - 0.42) * 6), lw = 1 + 1.5 * l.len * 10 * k;
      // a thin dark edge under a white core, so the streak reads over bright snow and over sky
      ctx.beginPath(); ctx.moveTo(cx + c * r0, cy + s * r0); ctx.lineTo(cx + c * r1, cy + s * r1);
      ctx.strokeStyle = `rgba(40,52,70,${(0.45 * al).toFixed(3)})`; ctx.lineWidth = lw + 1.5; ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${al.toFixed(3)})`; ctx.lineWidth = lw; ctx.stroke();
    }
    this.shown = true;
  }

  dispose(): void { this.canvas.remove(); }
}
