/** FEAT-124: the ring that fills while restart is held (styles in hud.css). */
export class RestartRing {
  private readonly el = document.createElement('div');

  constructor() {
    this.el.id = 'restart-ring';
    document.body.appendChild(this.el);
  }

  /** `fill`: how far the hold has got, 0..1; null hides the ring. */
  update(fill: number | null): void {
    this.el.style.display = fill === null ? 'none' : 'block';
    if (fill !== null) this.el.style.setProperty('--hold', `${fill * 360}deg`);
  }

  dispose(): void { this.el.remove(); }
}
