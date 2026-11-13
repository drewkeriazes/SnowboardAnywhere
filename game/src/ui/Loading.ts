/**
 * BUG-063: the loading screen shown while a session warms up (terrain, trees, rocks, shaders).
 * Plain DOM over the canvas, so it costs nothing to draw while the world builds behind it.
 */
export class LoadingScreen {
  private readonly el: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private shown = 0;

  /** `over` puts it above the menus and the settings screen (FEAT-285's Apply) */
  constructor(title: string, opts: { eyebrow?: string; over?: boolean } = {}) {
    this.el = document.createElement('div');
    this.el.id = 'loading';
    if (opts.over) this.el.classList.add('over');
    this.el.innerHTML = `<div class="panel"><div class="eyebrow"></div><div class="title"></div>` +
      `<div class="track"><div class="fill"></div></div><div class="label">Starting...</div></div>`;
    (this.el.querySelector('.eyebrow') as HTMLDivElement).textContent = opts.eyebrow ?? 'Loading';
    (this.el.querySelector('.title') as HTMLDivElement).textContent = title;
    this.bar = this.el.querySelector('.fill') as HTMLDivElement;
    this.label = this.el.querySelector('.label') as HTMLDivElement;
    document.body.appendChild(this.el);
  }

  /** Wait until the browser has painted the screen, so heavy setup after this runs behind it. */
  painted(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  }

  /** Progress 0..1 (never goes backwards, so streaming new work doesn't make the bar jump back). */
  set(progress: number, text: string): void {
    this.shown = Math.max(this.shown, Math.min(1, progress));
    this.bar.style.width = `${(this.shown * 100).toFixed(1)}%`;
    this.label.textContent = text;
  }

  /** Fade out and remove. */
  hide(): void {
    this.set(1, 'Ready');
    this.el.classList.add('done');
    setTimeout(() => this.el.remove(), 500);
  }
}

/**
 * FEAT-285: resolves once the frame loop runs clean again: `calm` frames in a row each under `frameMs`
 * apart (shader compiles and tree rebuilds land in the first frames after a graphics change), or after
 * `maxMs` whatever the frames do (a hidden tab draws none).
 */
export function framesSettled(frameMs = 50, calm = 3, maxMs = 6000): Promise<void> {
  return new Promise((resolve) => {
    let last = -1, run = 0, done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(finish, maxMs);
    const tick = (t: number) => {
      if (done) return;
      if (last >= 0) run = t - last < frameMs ? run + 1 : 0;
      last = t;
      if (run >= calm) finish(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
