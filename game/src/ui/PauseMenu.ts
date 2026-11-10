import { saveSettings, type Settings } from './Settings';
import { closeSettings, openSettings, type Credit } from './SettingsOverlay';
import { closeScreen, lastInputKind, openScreen, Screen } from './MenuNav';
import { renderHints, type Hint } from './HintBar';
import { optsOf, rowById, type Row } from './SettingsRows';
import { fmtDistance, fmtHeight, fmtSpeed } from './Units';

export type PauseAction = 'resume' | 'restart' | 'map' | 'quit' | 'replay' | 'freeride' | 'trial' | 'outrunStart' | 'outrunStop';
export type PauseMode = { kind: 'free' } | { kind: 'trial'; course: string } | { kind: 'outrun' };
export interface PauseCourse { id: string; name: string; length: number; best: number | null }
/** what the pause menu shows, read from the session each time it opens */
export interface PauseInfo {
  resort: string;
  /** the nearest named run or area ('' when none is near) */
  place: string;
  run: { time: number; distance: number; vertical: number; topSpeed: number } | null;
  day: { runs: number; vertical: number };
  metric: boolean;
  mode: PauseMode;
  /** null when the replay viewer can open, else why not */
  replayBlocked: string | null;
  courses: PauseCourse[];
}

/** the quick toggles: rows from the settings table, changed with left / right in place */
const QUICK = ['camera', 'clouds', 'timeOfDay', 'playlist'];
const QUICK_LABEL: Record<string, string> = { camera: 'Camera', clouds: 'Weather', timeOfDay: 'Time of day', playlist: 'Music' };
const OUTRUN_ROWS = ['outrun.difficulty', 'outrun.escape', 'outrun.gentle'];
const MODES: { id: PauseMode['kind']; label: string }[] = [{ id: 'free', label: 'Free ride' }, { id: 'trial', label: 'Time trial' }, { id: 'outrun', label: 'Outrun' }];
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const clock = (t: number) => { const m = Math.floor(t / 60), s = t - m * 60; return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)} s`; };

/**
 * FEAT-128 pause menu (layout B): one column on the left over the live game, the right half left clear.
 * The place you are and this run's stats on top; Resume, Restart, Map, Mode, Replay, Settings; quick
 * toggles for the camera, weather, time of day and music under them (left / right change them at once);
 * Quit to main menu in the hint bar, pressed twice. Mode opens its own screen: Free ride, a time trial
 * course, or Outrun with its options. B / Esc resumes.
 */
export class PauseMenu {
  readonly el: HTMLDivElement;
  open = false;
  /** a menu action; `arg` is the course id for 'trial' */
  onAction: ((a: PauseAction, arg?: string) => void) | null = null;
  private info: PauseInfo | null = null;
  private readonly screen: Screen;
  private readonly modeScreen: Screen;
  private readonly hintEl: HTMLElement;
  private readonly mainEl: HTMLElement;
  private readonly modeEl: HTMLElement;
  private modeTab: PauseMode['kind'] = 'free';
  private quitArmed = -1e9;

  constructor(private readonly settings: Settings, private readonly onChange: (s: Settings, what: string) => void, private readonly extras: { fps?: () => number; credits?: () => Credit[] } = {}) {
    this.el = document.createElement('div');
    this.el.id = 'pause';
    const pick = (id: string, label: string) => `<div class="qrow" data-q="${id}" data-nav tabindex="-1"><span class="lbl">${label}</span><span class="ctl"><button class="arr" data-d="-1" data-nav="skip" tabindex="-1" aria-label="Previous">&#8249;</button><span class="pv"></span><button class="arr" data-d="1" data-nav="skip" tabindex="-1" aria-label="Next">&#8250;</button></span></div>`;
    this.el.innerHTML = `
      <div class="col">
        <header class="head">
          <div class="eyebrow">Paused &middot; <span class="resort"></span></div>
          <h1 class="place"></h1>
          <div class="stats"></div>
        </header>
        <div class="main">
          <nav class="list">
            <button data-a="resume" class="primary">Resume</button>
            <button data-a="restart">Restart</button>
            <button data-a="map">Map</button>
            <button data-a="mode">Mode<span class="v" data-v="mode"></span></button>
            <button data-a="replay">Replay<span class="v" data-v="replay"></span></button>
            <button data-a="settings">Settings</button>
          </nav>
          <div class="quick"><div class="sh">Quick</div>${QUICK.map((q) => pick(q, QUICK_LABEL[q])).join('')}</div>
          <div class="ds-connect" style="display:none"><button data-ds-connect>Turn on DualSense rumble and lightbar</button><div class="hint ds-status">Click it with the mouse and pick the controller (once: it reconnects by itself after that).</div></div>
        </div>
        <div class="modep" hidden>
          <div class="sh">Mode</div>
          <div class="tabs">${MODES.map((m) => `<button data-m="${m.id}">${m.label}</button>`).join('')}</div>
          <div class="mbody" data-m="free"><p>Ride anywhere. Time trial gates show only if they are on in Settings.</p><button data-go="freeride" class="primary">Free ride</button></div>
          <div class="mbody" data-m="trial"><p>Pick a course: you start just above its start gate.</p><div class="courses"></div></div>
          <div class="mbody" data-m="outrun"><p>A snow monster chases you down the mountain. Stay ahead, or get eaten.</p>${OUTRUN_ROWS.map((r) => pick(r, rowById(r)!.label.replace(/^Outrun /, '').replace(/^./, (c) => c.toUpperCase()))).join('')}
            <button data-go="outrunStart" class="primary">Start the chase</button><button data-go="outrunStop" class="ghost">Stop Outrun</button></div>
        </div>
        <footer class="foot"><div class="hintbar"></div><button class="quit" data-a="quit">Quit to main menu</button></footer>
      </div>`;
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
    this.hintEl = this.el.querySelector('.hintbar')!;
    this.mainEl = this.el.querySelector('.main')!;
    this.modeEl = this.el.querySelector('.modep')!;

    this.el.querySelectorAll<HTMLButtonElement>('.list button[data-a], .foot button[data-a]').forEach((b) => b.addEventListener('click', () => this.press(b.dataset.a!)));
    this.el.querySelectorAll<HTMLElement>('.qrow').forEach((q) => q.addEventListener('click', (e) => {
      const arr = (e.target as HTMLElement).closest<HTMLButtonElement>('button.arr');
      this.cycle(q, arr ? Number(arr.dataset.d) : 1, !arr);
    }));
    this.modeEl.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.addEventListener('click', () => this.showMode(b.dataset.m as PauseMode['kind'], false)));
    this.modeEl.querySelectorAll<HTMLButtonElement>('button[data-go]').forEach((b) => b.addEventListener('click', () => this.go(b.dataset.go as PauseAction)));

    const rowIntent = (s: () => Screen) => (i: string): boolean => {
      const f = s().focused;
      if ((i === 'left' || i === 'right') && f?.matches('.qrow')) { this.cycle(f, i === 'left' ? -1 : 1, false); return true; }
      if (i === 'select' && f?.matches('.qrow')) { this.cycle(f, 1, true); return true; }
      return false;
    };
    this.screen = new Screen(this.el.querySelector('.col')!, {
      primary: () => this.el.querySelector<HTMLElement>('button[data-a="resume"]'),
      onBack: () => this.go('resume'),
      onIntent: (i, down) => down && rowIntent(() => this.screen)(i),
      onInputKind: () => this.hints(),
    });
    this.modeScreen = new Screen(this.modeEl, {
      primary: () => this.modeEl.querySelector<HTMLElement>(`.mbody[data-m="${this.modeTab}"] :is(button:not([hidden]), .qrow)`),
      onBack: () => this.closeMode(),
      onIntent: (i, down) => {
        if (!down) return false;
        if (i === 'prevCat' || i === 'nextCat') { const k = MODES.findIndex((m) => m.id === this.modeTab); this.showMode(MODES[(k + (i === 'nextCat' ? 1 : -1) + MODES.length) % MODES.length].id, true); return true; }
        const f = this.modeScreen.focused;
        if (i === 'select' && f?.matches('.tabs button')) { this.showMode(f.dataset.m as PauseMode['kind'], true); return true; }
        return rowIntent(() => this.modeScreen)(i);
      },
      onInputKind: () => this.hints(),
    });
  }

  // ---------------------------------------------------------------- the menu
  private press(a: string): void {
    if (a === 'settings') { openSettings(this.settings, { overGame: true, onChange: this.onChange, fps: this.extras.fps, credits: this.extras.credits }); return; }
    if (a === 'mode') { this.openMode(); return; }
    if (a === 'replay' && this.info?.replayBlocked) return;
    if (a === 'quit' && performance.now() - this.quitArmed > 3000) {
      // pressed twice: Quit sits in the hint bar so it isn't hit by accident
      this.quitArmed = performance.now(); this.quitLabel(); setTimeout(() => this.quitLabel(), 3100);
      return;
    }
    this.go(a as PauseAction);
  }
  private quitLabel(): void {
    const armed = performance.now() - this.quitArmed < 3000;
    const b = this.el.querySelector<HTMLElement>('.foot .quit')!;
    b.classList.toggle('armed', armed); b.textContent = armed ? 'Press again to quit' : 'Quit to main menu';
  }
  private go(a: PauseAction, arg?: string): void {
    this.hide();
    this.onAction?.(a, arg);
  }

  /** a quick toggle or Outrun option: one step left or right (A / click wraps round) */
  private cycle(q: HTMLElement, d: number, wrap: boolean): void {
    const r = rowById(q.dataset.q!);
    if (!r || !('get' in r)) return;
    if (r.kind === 'toggle') r.set(this.settings, !r.get(this.settings));
    else if ('opts' in r) {
      const opts = optsOf(r, this.settings);
      const i = opts.findIndex(([o]) => String(o) === String(r.get(this.settings)));
      const j = wrap ? (i + d + opts.length) % opts.length : Math.max(0, Math.min(opts.length - 1, i + d));
      if (j === i) return;
      r.set(this.settings, opts[j][0]);
    } else return;
    saveSettings(this.settings);
    this.onChange(this.settings, r.what ?? r.id);
    this.fillRows();
  }
  private fillRows(): void {
    this.el.querySelectorAll<HTMLElement>('.qrow').forEach((q) => {
      const r = rowById(q.dataset.q!) as Row & { get: (s: Settings) => string | number | boolean };
      const v = r.get(this.settings);
      const pv = q.querySelector<HTMLElement>('.pv')!;
      if (r.kind === 'toggle') { pv.textContent = v ? 'On' : 'Off'; return; }
      if (!('opts' in r)) return;
      const opts = optsOf(r, this.settings);
      const i = opts.findIndex(([o]) => String(o) === String(v));
      pv.textContent = i >= 0 ? opts[i][1] : String(v);
    });
  }

  // ---------------------------------------------------------------- Mode
  private openMode(): void {
    this.mainEl.hidden = true;
    this.modeEl.hidden = false;
    this.showMode(this.info?.mode.kind ?? 'free', false);
    openScreen(this.modeScreen);
    this.hints();
  }
  private closeMode(): void {
    if (this.modeEl.hidden) return;
    this.modeEl.hidden = true;
    this.mainEl.hidden = false;
    closeScreen(this.modeScreen); // focus goes back to Mode
    this.hints();
  }
  private showMode(m: PauseMode['kind'], focus: boolean): void {
    this.modeTab = m;
    this.modeEl.querySelectorAll<HTMLElement>('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    this.modeEl.querySelectorAll<HTMLElement>('.mbody').forEach((b) => { b.hidden = b.dataset.m !== m; });
    const outrun = this.info?.mode.kind === 'outrun';
    this.modeEl.querySelector<HTMLElement>('[data-go="outrunStart"]')!.hidden = outrun;
    this.modeEl.querySelector<HTMLElement>('[data-go="outrunStop"]')!.hidden = !outrun;
    if (focus) this.modeScreen.focusPrimary();
    this.hints();
  }
  private drawCourses(): void {
    const host = this.modeEl.querySelector<HTMLElement>('.courses')!;
    const info = this.info!;
    const cur = info.mode.kind === 'trial' ? info.mode.course : '';
    host.innerHTML = info.courses.length
      ? info.courses.map((c) => `<button class="course${c.id === cur ? ' on' : ''}" data-course="${c.id}"><span class="cn">${esc(c.name)}</span><span class="cl">${fmtDistance(c.length, info.metric)}</span><span class="cb">${c.best !== null ? clock(c.best) : 'no time yet'}</span></button>`).join('')
      : `<p class="dim">No courses on this resort.</p>`;
    host.querySelectorAll<HTMLButtonElement>('button[data-course]').forEach((b) => b.addEventListener('click', () => this.go('trial', b.dataset.course)));
  }

  // ---------------------------------------------------------------- show / hide
  private fill(info: PauseInfo): void {
    this.info = info;
    this.el.querySelector('.resort')!.textContent = info.resort;
    this.el.querySelector('.place')!.textContent = info.place || info.resort;
    const m = info.metric;
    const st = (v: string, l: string) => `<span><b>${v}</b>${l}</span>`;
    this.el.querySelector('.stats')!.innerHTML = info.run
      ? st(clock(info.run.time), 'time') + st(fmtDistance(info.run.distance, m), 'distance') + st(fmtHeight(info.run.vertical, m), 'vertical') + st(fmtSpeed(info.run.topSpeed, m), 'top speed')
      : `<span class="dim">No run going.</span>` + (info.day.runs ? st(String(info.day.runs), info.day.runs === 1 ? 'run today' : 'runs today') + st(fmtHeight(info.day.vertical, m), 'vertical today') : '');
    const mode = info.mode;
    const course = mode.kind === 'trial' ? info.courses.find((c) => c.id === mode.course)?.name ?? 'Time trial' : '';
    this.el.querySelector('[data-v="mode"]')!.textContent = mode.kind === 'free' ? 'Free ride' : mode.kind === 'outrun' ? 'Outrun' : course;
    const rep = this.el.querySelector<HTMLButtonElement>('button[data-a="replay"]')!;
    rep.classList.toggle('blocked', !!info.replayBlocked);
    this.el.querySelector('[data-v="replay"]')!.textContent = info.replayBlocked ?? '';
    this.drawCourses();
    this.fillRows();
  }

  private hints(): void {
    const h: Hint[] = [['select', 'Select'], ['move', 'Move'], ['adjust', 'Change']];
    if (!this.modeEl.hidden) h.push(['cat', 'Mode'], ['back', 'Back']); else h.push(['back', 'Resume']);
    renderHints(this.hintEl, h, lastInputKind());
  }

  show(info: PauseInfo): void {
    this.fill(info);
    this.open = true;
    this.quitArmed = -1e9; this.quitLabel();
    this.el.style.display = 'flex';
    document.body.classList.add('paused'); // the HUD and prompts step back behind the menu
    if (document.pointerLockElement) document.exitPointerLock();
    openScreen(this.screen);
    this.hints();
  }
  hide(): void {
    if (!this.open) return;
    this.open = false;
    closeSettings();
    if (!this.modeEl.hidden) { this.modeEl.hidden = true; this.mainEl.hidden = false; closeScreen(this.modeScreen); }
    this.el.style.display = 'none';
    document.body.classList.remove('paused');
    closeScreen(this.screen);
  }
  destroy(): void { this.hide(); this.el.remove(); }
}
