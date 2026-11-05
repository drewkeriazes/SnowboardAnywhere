import { renderPanel, type Settings } from './Settings';

export type PauseAction = 'resume' | 'restart' | 'map' | 'quit';

/** Esc overlay: resume, restart at spawn, open the map, settings, quit to the main menu. */
export class PauseMenu {
  readonly el: HTMLDivElement;
  open = false;
  onAction: ((a: PauseAction) => void) | null = null;
  private readonly panel: HTMLElement;

  constructor(settings: Settings, onChange: (s: Settings, what: string) => void) {
    this.el = document.createElement('div');
    this.el.id = 'pause';
    this.el.innerHTML = `
      <div class="panel">
        <div class="eyebrow">Paused</div>
        <button data-a="resume" class="primary">Resume</button>
        <button data-a="restart">Restart at spawn</button>
        <button data-a="map">Open map</button>
        <button data-a="settings">Settings</button>
        <div class="settings hidden"></div>
        <button data-a="quit" class="ghost">Quit to main menu</button>
      </div>`;
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
    this.panel = this.el.querySelector('.settings') as HTMLElement;
    renderPanel(this.panel, settings, onChange);
    this.el.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.a === 'settings') { this.panel.classList.toggle('hidden'); return; }
      this.hide();
      this.onAction?.(b.dataset.a as PauseAction);
    }));
  }

  show(): void { this.open = true; this.el.style.display = 'flex'; if (document.pointerLockElement) document.exitPointerLock(); }
  hide(): void { this.open = false; this.el.style.display = 'none'; this.panel.classList.add('hidden'); }
  toggle(): void { this.open ? this.hide() : this.show(); }
  destroy(): void { this.el.remove(); }
}
