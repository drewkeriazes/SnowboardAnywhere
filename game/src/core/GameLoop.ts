/**
 * FEAT-160: the frame loop. requestAnimationFrame, the frame cap (FEAT-062, FEAT-284) and the headless hooks the
 * test tools drive (window.__step, window.__shot). It knows nothing about snowboarding: each frame it
 * hands the session a dt. The rider's own 1/120 s fixed steps and interpolation live in sim/Rider.ts.
 */
export interface LoopHooks {
  /** every display frame, before the cap decides whether this one is drawn */
  everyFrame(): void;
  /** one drawn frame; `stepped` is true under window.__step (an exact dt from a test tool) */
  tick(dt: number, stepped: boolean): void;
  /** the frame cap in frames per second; 0 draws at the display's rate */
  targetFps(): number;
}

/** the longest frame the sim is given (s): a stall or a background tab must not throw the rider across the map */
const MAX_DT = 0.1;

export class GameLoop {
  private running = false;
  private last = performance.now();
  /** with the cap on, the next frame's deadline (ms); otherwise the last frame's time */
  private lastDraw = 0;
  /** headless only: exact frame dt for __step, so scripted runs replay step for step */
  private fixedDt: number | null = null;

  constructor(private readonly headless: boolean, private readonly hooks: LoopHooks) {}

  /** Start ticking. Headless: install __step and __shot and run one frame; otherwise hand over to requestAnimationFrame. */
  start(canvas: HTMLCanvasElement): void {
    this.running = true;
    this.last = performance.now();
    if (this.headless) {
      (window as any).__step = (n: number, dtOverride = 1 / 60) => { this.fixedDt = dtOverride; for (let i = 0; i < n; i++) this.frame(); this.fixedDt = null; this.last = performance.now(); };
      (window as any).__shot = () => { this.last = performance.now() - 1000 / 60; this.frame(); return canvas.toDataURL('image/png'); };
      this.frame();
    } else {
      requestAnimationFrame(this.frame);
    }
  }

  stop(): void { this.running = false; }

  private readonly frame = (): void => {
    if (!this.running) return;
    this.hooks.everyFrame();
    const now = performance.now();
    // FEAT-062, FEAT-284: a frame cap below the refresh rate skips display frames against a running deadline, so the
    // average hits the cap even when the refresh rate does not divide evenly (75, 100, 144 Hz). The slack (up to 4 ms)
    // absorbs timer jitter, so a 60 cap on a 60 Hz display never drops a frame.
    const target = this.hooks.targetFps();
    const capped = !this.headless && !this.fixedDt && target > 0;
    const interval = capped ? 1000 / target : 0;
    if (capped && now < this.lastDraw - Math.min(4, interval / 4)) { requestAnimationFrame(this.frame); return; }
    // lastDraw holds the next deadline; reset it to now if we fell more than a frame behind
    this.lastDraw = capped ? (now - this.lastDraw > interval ? now : this.lastDraw) + interval : now;
    const dt = this.fixedDt ?? Math.min(MAX_DT, (now - this.last) / 1000);
    this.last = now;
    this.hooks.tick(dt, this.fixedDt !== null);
    if (!this.headless) requestAnimationFrame(this.frame);
  };
}
