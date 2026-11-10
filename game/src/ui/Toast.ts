/** The short message at the top (now playing, tricks, saves). */
export class Toast {
  private readonly el = document.getElementById('toast')!;
  private timer = 0;

  readonly show = (text: string, ms = 4000): void => {
    this.el.textContent = text;
    this.el.classList.add('show');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.remove('show'), ms);
  };
}
