import { saveSettings, type Settings } from './Settings';
import { closeSettings, openSettings, type Credit } from './SettingsOverlay';
import { closeScreen, lastInputKind, openScreen, Screen } from './MenuNav';
import { renderHints, type Hint } from './HintBar';

export type PauseAction = 'resume' | 'restart' | 'map' | 'quit' | 'outrunStart' | 'outrunStop';

/** Esc overlay: resume, restart at spawn, open the map, Outrun (FEAT-097), settings, quit to the main menu. */
export class PauseMenu {
  readonly el: HTMLDivElement;
  open = false;
  onAction: ((a: PauseAction) => void) | null = null;

  constructor(private readonly settings: Settings, private readonly onChange: (s: Settings, what: string) => void, private readonly extras: { fps?: () => number; credits?: () => Credit[] } = {}) {
    this.el = document.createElement('div');
    this.el.id = 'pause';
    this.el.innerHTML = `
      <div class="panel">
        <div class="eyebrow">Paused</div>
        <button data-a="resume" class="primary" data-pad-back>Resume</button>
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
        <div class="ds-connect" style="display:none"><button data-ds-connect>Turn on DualSense rumble and lightbar</button><div class="hint ds-status">Click it with the mouse and pick the controller (once: it reconnects by itself after that).</div></div>
        <button data-a="settings">Settings</button>
        <button data-a="quit" class="ghost">Quit to main menu</button>
        <div class="hintbar"></div>
      </div>`;
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
    this.outrunPanel = this.el.querySelector('.settings.outrun') as HTMLElement;
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
      if (b.dataset.a === 'settings') { this.openSettings(); return; }
      if (b.dataset.a === 'outrun') { this.outrunPanel.classList.toggle('hidden'); this.afterToggle(b, this.outrunPanel); return; }
      this.hide();
      this.onAction?.(b.dataset.a as PauseAction);
    }));
    this.hintEl = this.el.querySelector('.hintbar') as HTMLElement;
    this.screen = new Screen(this.el, {
      primary: () => this.el.querySelector<HTMLElement>('button[data-a="resume"]'),
      onBack: () => {
        if (this.outrunOpen()) { this.outrunPanel.classList.add('hidden'); this.afterToggle(this.el.querySelector<HTMLElement>('button[data-a="outrun"]')!, this.outrunPanel); return; }
        this.hide();
        this.onAction?.('resume');
      },
      onInputKind: () => this.showHints(),
    });
  }

  private readonly outrunPanel: HTMLElement;
  /** FEAT-128: keyboard and gamepad navigation (B / Esc closes an open section, then resumes) */
  private readonly screen: Screen;
  private readonly hintEl: HTMLElement;
  private outrunOpen(): boolean { return !this.outrunPanel.classList.contains('hidden'); }
  private showHints(): void {
    const h: Hint[] = [['select', 'Select'], ['move', 'Move'], ['back', this.outrunOpen() ? 'Close' : 'Resume']];
    renderHints(this.hintEl, h, lastInputKind());
  }
  /** after a section opens or closes: focus into it, or back on its button */
  private afterToggle(btn: HTMLElement, section: HTMLElement): void {
    if (section.classList.contains('hidden')) this.screen.focus(btn);
    else this.screen.focus(section.querySelector<HTMLElement>('select, button'));
    this.showHints();
  }
  /** FEAT-128: the settings screen over the live game (dimmed, Peek to see it, the fps readout) */
  private openSettings(): void {
    openSettings(this.settings, { overGame: true, onChange: this.onChange, fps: this.extras.fps, credits: this.extras.credits });
  }
  /** Swap the Outrun panel's button between Start and Stop. */
  setOutrunRunning(on: boolean): void {
    (this.el.querySelector('[data-a="outrunStart"]') as HTMLElement).classList.toggle('hidden', on);
    (this.el.querySelector('[data-a="outrunStop"]') as HTMLElement).classList.toggle('hidden', !on);
  }

  show(): void { this.open = true; this.el.style.display = 'flex'; if (document.pointerLockElement) document.exitPointerLock(); openScreen(this.screen); this.showHints(); }
  hide(): void { this.open = false; this.el.style.display = 'none'; closeSettings(); this.outrunPanel.classList.add('hidden'); closeScreen(this.screen); }
  toggle(): void { this.open ? this.hide() : this.show(); }
  destroy(): void { closeScreen(this.screen); this.el.remove(); }
}
