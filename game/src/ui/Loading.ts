/**
 * BUG-063: the loading screen shown while a session warms up (terrain, trees, rocks, shaders).
 * Plain DOM over the canvas, so it costs nothing to draw while the world builds behind it.
 */
export class LoadingScreen {
  private readonly el: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private shown = 0;

  constructor(title: string) {
    this.el = document.createElement('div');
    this.el.id = 'loading';
    this.el.innerHTML = `<div class="panel"><div class="eyebrow">Loading</div><div class="title"></div>` +
      `<div class="track"><div class="fill"></div></div><div class="label">Starting...</div></div>`;
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
