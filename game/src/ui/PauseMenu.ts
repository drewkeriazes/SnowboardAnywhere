import { renderPanel, saveSettings, type Settings } from './Settings';

export type PauseAction = 'resume' | 'restart' | 'map' | 'quit' | 'outrunStart' | 'outrunStop';

/** Esc overlay: resume, restart at spawn, open the map, Outrun (FEAT-097), settings, quit to the main menu. */
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
        <button data-a="outrun">Outrun</button>
        <div class="settings outrun hidden">
          <div class="hint">A snow monster chases you down the mountain. Stay ahead, or get eaten.</div>
          <div class="row"><label>Difficulty</label><select data-r="difficulty"><option value="chill">Chill (10 s head start)</option><option value="normal">Normal (7 s)</option><option value="skifree">SkiFree (5 s, only the boost saves you)</option></select></div>
          <div class="row"><label>Escape</label><select data-r="escape"><option value="base">Reach the base</option><option value="endless">Endless (a second one at 3 min)</option></select></div>
          <div class="row"><label>Gentle</label><input type="checkbox" data-r="gentle"><span class="dim">swallowed whole, no rip</span></div>
          <button data-a="outrunStart" class="primary">Start the chase</button>
          <button data-a="outrunStop" class="ghost hidden">Stop Outrun</button>
        </div>
        <button data-a="settings">Settings</button>
        <div class="settings hidden"></div>
        <button data-a="quit" class="ghost">Quit to main menu</button>
      </div>`;
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
    this.panel = this.el.querySelector('.settings:not(.outrun)') as HTMLElement;
    this.outrunPanel = this.el.querySelector('.settings.outrun') as HTMLElement;
    renderPanel(this.panel, settings, onChange);
    const o = settings.outrun;
    this.outrunPanel.querySelectorAll<HTMLSelectElement | HTMLInputElement>('[data-r]').forEach((el) => {
      const k = el.dataset.r as keyof typeof o;
      if (el instanceof HTMLInputElement) el.checked = !!o[k]; else el.value = String(o[k]);
      el.addEventListener('input', () => {
        if (el instanceof HTMLInputElement) o.gentle = el.checked;
        else if (k === 'difficulty') o.difficulty = el.value as typeof o.difficulty;
        else o.escape = el.value as typeof o.escape;
        saveSettings(settings);
      });
    });
    this.el.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.a === 'settings') { this.panel.classList.toggle('hidden'); this.outrunPanel.classList.add('hidden'); return; }
      if (b.dataset.a === 'outrun') { this.outrunPanel.classList.toggle('hidden'); this.panel.classList.add('hidden'); return; }
      this.hide();
      this.onAction?.(b.dataset.a as PauseAction);
    }));
  }

  private readonly outrunPanel: HTMLElement;
  /** Swap the Outrun panel's button between Start and Stop. */
  setOutrunRunning(on: boolean): void {
    (this.el.querySelector('[data-a="outrunStart"]') as HTMLElement).classList.toggle('hidden', on);
    (this.el.querySelector('[data-a="outrunStop"]') as HTMLElement).classList.toggle('hidden', !on);
  }

  show(): void { this.open = true; this.el.style.display = 'flex'; if (document.pointerLockElement) document.exitPointerLock(); }
  hide(): void { this.open = false; this.el.style.display = 'none'; this.panel.classList.add('hidden'); this.outrunPanel.classList.add('hidden'); }
  toggle(): void { this.open ? this.hide() : this.show(); }
  destroy(): void { this.el.remove(); }
}
