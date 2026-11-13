import type { GameAudio } from '../audio/Audio';
import type { AttractShot } from '../world/AttractShots';
import { saveSettings, type Settings } from './Settings';
import { closeSettings, openSettings, settingsOpen, type Credit } from './SettingsOverlay';
import { closeScreen, lastInputKind, openScreen, Screen } from './MenuNav';
import { renderHints, type Hint } from './HintBar';
import { fillResortPicker, packStatus, PREVIEW_BADGE } from './ResortPicker';
import { optsOf, rowById, type Row } from './SettingsRows';
import { fmtDistance, fmtHeight } from './Units';
import type { AccountService } from '../account/Account';
import type { BuildWatch } from './BuildWatch';
import { mountAccountLine } from './AccountLine';
import { fillAccountPanel } from './AccountPanel';
import type { PauseCourse, PauseMode } from './PauseMenu';

/**
 * FEAT-138: on a build from `npm run host`, the address another computer on the home network opens, so it is
 * easy to read off and share. Over plain http (not localhost) some browsers (Firefox) hide controllers, so it says how to get them.
 */
function hostedLine(): string {
  const pc = import.meta.env.VITE_HOST_NAME as string | undefined;
  if (!pc) return '';
  const pads = window.isSecureContext ? '' : `<br>Controller not seen? Run <code>npm run host -- --https</code> on ${pc}`;
  return `<div class="hosted">Hosted from ${pc} &middot; ${location.host}${pads}</div>`;
}

/** FEAT-261: the build's version (`npm run package -- --version X.Y.Z`), small in the corner so a rider can say what they are on */
function versionLine(): string {
  const v = import.meta.env.VITE_GAME_VERSION as string | undefined;
  return `<div class="version">${v && v !== 'dev' ? `v${v}` : 'dev build'}</div>`;
}

export interface MenuChoice { action: 'ride' | 'map'; mode: PauseMode }
export interface MainMenuOpts {
  slug: string;
  resortName: string;
  shot: AttractShot;
  /** counted from the pack (world/AttractShots.ts resortNumbers) */
  numbers: { runs: number; lifts: number; top: number | null; vertical: number | null };
  /** the still rendered from the shot's pose, shown until the live view is ready ('' when there is none) */
  still: string;
  resorts: { slug: string; name: string }[];
  audio: GameAudio;
  settings: Settings;
  credits: () => Credit[];
  /** FEAT-273: the corner line (Playing as guest / Sign in with GitHub, or the name); never gates RIDE */
  account: AccountService;
  /** FEAT-247: the page's build watcher, for the resort picker's build progress */
  builds?: BuildWatch;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const clock = (t: number) => { const m = Math.floor(t / 60), s = t - m * 60; return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)} s`; };
const OUTRUN_ROWS = ['outrun.difficulty', 'outrun.escape', 'outrun.gentle'];
const MODE_LABEL: Record<PauseMode['kind'], string> = { free: 'Free ride', trial: 'Time trial', outrun: 'Outrun' };

/**
 * FEAT-128 main menu (layout B), a state inside the session: full screen over the live backdrop shot
 * (`world/AttractShots.ts`) with ghosts riding a line, the place as the title, one big RIDE, a card row
 * (the resort, then Free ride, Time trial, Outrun, then Change resort) and Settings, Controls and Credits in
 * the corner. It shows at once over the shot's still while the session loads behind it; RIDE pressed early
 * waits for the load. The session (`main.ts`) sets `onChoice`, `onSettingsChange` and `onResetStart`.
 */
export class MainMenu {
  readonly el: HTMLDivElement;
  onChoice: ((c: MenuChoice) => void) | null = null;
  /** applies a settings change (the session's applySettings once it exists; the audio before) */
  onSettingsChange: (s: Settings, what: string) => void;
  onResetStart: (() => void) | null = null;
  private mode: PauseMode = { kind: 'free' };
  private courses: PauseCourse[] = [];
  private metric = false;
  private ready = false;
  /** RIDE or the map pressed while loading (the mode is read when it goes) */
  private waiting: MenuChoice['action'] | null = null;
  private shown = false;
  private readonly screen: Screen;
  private readonly sub: Screen;
  private readonly hintEl: HTMLElement;
  private readonly pop: HTMLElement;
  private popKind: 'trial' | 'outrun' | 'resort' | 'account' | null = null;
  /** FEAT-274: the account panel's unsubscribe while it is open */
  private popOff: (() => void) | null = null;
  private readonly unmountAccount: () => void;

  constructor(private readonly o: MainMenuOpts) {
    const s = o.settings;
    this.onSettingsChange = (st) => { o.audio.setVolumes(st.mute ? 0 : st.sfx, st.mute ? 0 : st.music); o.audio.setSource(st.musicSource); o.audio.setPlaylist(st.playlist); };
    this.metric = s.units === 'metric';
    const n = o.numbers, m = this.metric;
    const elev = o.shot.elev ? `Elev. ${fmtHeight(o.shot.elev.m, m)} ${o.shot.elev.where}` : '';
    const facts = [elev, n.runs ? `${n.runs} runs` : '', n.lifts ? `${n.lifts} lifts` : '', n.vertical ? `${fmtHeight(n.vertical, m)} vertical` : ''].filter(Boolean).join(' · ');
    this.el = document.createElement('div');
    this.el.id = 'menu';
    this.el.innerHTML = `
      ${o.still ? `<img class="still" alt="" src="${esc(o.still)}">` : ''}
      <div class="shade"></div>
      <header class="title">
        ${o.shot.region ? `<div class="region">${esc(o.shot.region)}</div>` : ''}
        <h1>${esc(o.shot.place)}</h1>
        ${facts ? `<div class="facts">${esc(facts)}</div>` : ''}
      </header>
      <section class="go">
        <div class="ride-row"><button data-a="ride" class="primary ride">Ride</button><button data-a="map" class="link">or drop in from the map</button></div>
        <div class="start"><span class="where"></span><button class="link" data-reset hidden>reset to resort start</button></div>
        <div class="ds-connect" style="display:none"><button data-ds-connect class="link">Turn on DualSense rumble and lightbar</button><div class="hint ds-status">Click it with the mouse and pick the controller (once: it reconnects by itself after that).</div></div>
      </section>
      <nav class="corner"><div class="account" hidden></div><button data-a="settings" class="link">Settings</button><button data-a="controls" class="link">Controls</button><button data-a="credits" class="link">Credits</button></nav>
      <div class="cards">
        <div class="card resort" data-card="resort">
          <div class="cname">${esc(o.resortName)}</div>
          <div class="cmeta">${[n.top ? `top ${fmtHeight(n.top, m)}` : '', n.vertical ? `${fmtHeight(n.vertical, m)} vertical` : '', n.runs ? `${n.runs} runs` : '', n.lifts ? `${n.lifts} lifts` : ''].filter(Boolean).join(' · ')}</div>
          <div class="seg"><button data-d="board">Snowboard</button><button data-d="ski">Skis</button></div>
        </div>
        <div class="gap"></div>
        <button class="card mode" data-mode="free"><span class="cname">Free ride</span><span class="cmeta">Ride anywhere on the mountain.</span></button>
        <button class="card mode" data-mode="trial"><span class="cname">Time trial</span><span class="cmeta" data-trial-meta>Race a real run against your best.</span></button>
        <button class="card mode" data-mode="outrun"><span class="cname">Outrun</span><span class="cmeta" data-outrun-meta></span></button>
        <button class="card change" data-a="resort"><span class="cname">Change resort</span><span class="cmeta">${o.resorts.length} built</span></button>
      </div>
      <div class="pop" hidden></div>
      <footer class="foot"><div class="hintbar"></div><div class="sound">Click or press any key for sound</div>${hostedLine()}${versionLine()}</footer>
      <div class="loadbar"><div class="fill"></div><span class="label">Loading</span></div>`;
    this.el.style.display = 'none'; // show() puts it up
    document.body.appendChild(this.el);
    this.hintEl = this.el.querySelector('.hintbar')!;
    this.pop = this.el.querySelector('.pop')!;
    // FEAT-248: a preview pack (did not pass the DATA-022 gate) says so by its name
    void packStatus(o.slug).then((st) => { if (st === 'preview') this.el.querySelector('[data-card="resort"] .cname')?.insertAdjacentHTML('beforeend', PREVIEW_BADGE); });
    const still = this.el.querySelector<HTMLImageElement>('.still');
    still?.addEventListener('error', () => still.remove()); // no still: the dark gradient

    // sound: browsers allow audio after a click, tap or key press (a controller button doesn't count)
    const unlock = () => {
      if (o.audio.started) return;
      o.audio.start(); o.audio.setVolumes(s.mute ? 0 : s.sfx, s.mute ? 0 : s.music);
      this.el.querySelector<HTMLElement>('.sound')!.hidden = true;
    };
    this.el.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', () => { if (this.shown) unlock(); }, true);
    if (o.audio.started) this.el.querySelector<HTMLElement>('.sound')!.hidden = true;

    this.el.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => b.addEventListener('click', () => this.press(b.dataset.a!)));
    this.el.querySelectorAll<HTMLButtonElement>('button[data-mode]').forEach((b) => b.addEventListener('click', () => this.pickMode(b.dataset.mode as PauseMode['kind'])));
    this.el.querySelectorAll<HTMLButtonElement>('button[data-d]').forEach((b) => b.addEventListener('click', () => this.setDiscipline(b.dataset.d as 'board' | 'ski')));
    this.el.querySelector('button[data-reset]')!.addEventListener('click', () => this.onResetStart?.());

    this.screen = new Screen(this.el, {
      primary: () => this.el.querySelector<HTMLElement>('button.ride'),
      onIntent: (i, down) => {
        if (down && i === 'discipline') { this.setDiscipline(s.discipline === 'board' ? 'ski' : 'board'); return true; }
        return false;
      },
      onInputKind: () => this.hints(),
    });
    // the pop-up panels over the card row: a course list, Outrun's options, the resort list
    this.sub = new Screen(this.pop, {
      primary: () => this.pop.querySelector<HTMLElement>('.on, button, .qrow'),
      onBack: () => this.closePop(),
      onIntent: (i, down) => {
        if (!down) return false;
        const f = this.sub.focused;
        if ((i === 'left' || i === 'right') && f?.matches('.qrow')) { this.cycle(f, i === 'left' ? -1 : 1, false); return true; }
        if (i === 'select' && f?.matches('.qrow')) { this.cycle(f, 1, true); return true; }
        // FEAT-274: Enter in the account panel's email or password field presses its button
        if (i === 'select' && f instanceof HTMLInputElement && f.dataset.submit) { this.pop.querySelector<HTMLButtonElement>(`button[data-act="${f.dataset.submit}"]`)?.click(); return true; }
        return false;
      },
      onInputKind: () => this.hints(),
    });
    this.unmountAccount = mountAccountLine(this.el.querySelector<HTMLElement>('.corner .account')!, o.account, () => this.openPop('account'));
    this.syncDiscipline();
    this.drawModes();
  }

  // ---------------------------------------------------------------- session hooks
  /** The load behind the menu, 0..1 (a slim bar in the corner). */
  setProgress(f: number, label: string): void {
    this.el.querySelector<HTMLElement>('.loadbar .fill')!.style.width = `${Math.round(f * 100)}%`;
    this.el.querySelector<HTMLElement>('.loadbar .label')!.textContent = label;
  }
  /** The session is ready: the still crossfades into the live view, a RIDE pressed early goes now. */
  setReady(): void {
    this.ready = true;
    this.el.classList.add('live');
    this.el.querySelector<HTMLElement>('.ride')!.textContent = 'Ride';
    const w = this.waiting; this.waiting = null;
    if (w) this.choose({ action: w, mode: this.mode });
  }
  get isReady(): boolean { return this.ready; }
  /** Where RIDE starts (BUG-037): the resort start, or a map drop-in with "reset to resort start". */
  setStart(label: string, custom: boolean): void {
    this.el.querySelector('.start .where')!.textContent = custom ? 'Continues at your map drop-in' : label;
    this.el.querySelector<HTMLElement>('button[data-reset]')!.hidden = !custom;
  }
  /** The time trial courses (with your best on each) and the units. */
  setCourses(c: PauseCourse[], metric: boolean): void { this.courses = c; this.metric = metric; this.drawModes(); }
  get isShown(): boolean { return this.shown; }

  show(): void {
    if (this.shown) return;
    this.shown = true;
    this.el.style.display = '';
    document.body.classList.add('in-menu');
    openScreen(this.screen);
    this.syncDiscipline();
    this.drawModes();
    this.hints();
  }
  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    closeSettings();
    this.closePop();
    closeScreen(this.screen);
    this.el.style.display = 'none';
    document.body.classList.remove('in-menu');
  }

  // ---------------------------------------------------------------- choices
  private press(a: string): void {
    if (a === 'settings') { this.openSettings(); return; }
    if (a === 'controls') { this.openSettings('controls'); return; }
    if (a === 'credits') { this.openSettings('credits'); return; }
    if (a === 'resort') { this.openPop('resort'); return; }
    this.choose({ action: a as 'ride' | 'map', mode: this.mode });
  }
  private choose(c: MenuChoice): void {
    if (!this.ready) {
      // pressed while loading: says so and goes as soon as the session is ready
      this.waiting = c.action;
      this.el.querySelector<HTMLElement>('.ride')!.textContent = 'Loading...';
      return;
    }
    this.hide();
    this.onChoice?.(c);
  }
  private openSettings(cat?: 'controls' | 'credits'): void {
    openSettings(this.o.settings, { overGame: false, cat, credits: this.o.credits, onChange: (s, what) => { this.onSettingsChange(s, what); this.syncDiscipline(); } });
  }
  private setDiscipline(d: 'board' | 'ski'): void {
    this.o.settings.discipline = d;
    saveSettings(this.o.settings);
    this.onSettingsChange(this.o.settings, 'discipline');
    this.syncDiscipline();
  }
  private syncDiscipline(): void {
    this.el.querySelectorAll<HTMLButtonElement>('button[data-d]').forEach((x) => x.classList.toggle('on', x.dataset.d === this.o.settings.discipline));
  }

  /** a mode card: Free ride picks at once, Time trial and Outrun open their panel */
  private pickMode(k: PauseMode['kind']): void {
    if (k === 'free') { this.mode = { kind: 'free' }; this.drawModes(); return; }
    this.openPop(k);
  }
  private drawModes(): void {
    this.el.querySelectorAll<HTMLElement>('.card[data-mode]').forEach((c) => c.classList.toggle('on', c.dataset.mode === this.mode.kind));
    const mode = this.mode;
    const course = mode.kind === 'trial' ? this.courses.find((c) => c.id === mode.course) : undefined;
    this.el.querySelector('[data-trial-meta]')!.textContent = course ? `${course.name} · ${course.best !== null ? `best ${clock(course.best)}` : 'no time yet'}` : this.courses.length ? `${this.courses.length} courses on real runs.` : 'Race a real run against your best.';
    const o = this.o.settings.outrun;
    const dl = (rowById('outrun.difficulty') as Row & { opts: [string, string][] }).opts.find(([v]) => v === o.difficulty)?.[1] ?? '';
    this.el.querySelector('[data-outrun-meta]')!.textContent = `A snow monster chases you down. ${dl}, ${o.escape === 'base' ? 'reach the base' : 'endless'}.`;
    this.el.querySelector<HTMLElement>('.go .ride')!.dataset.mode = MODE_LABEL[mode.kind];
  }

  // ---------------------------------------------------------------- the pop-up panels
  private openPop(kind: 'trial' | 'outrun' | 'resort' | 'account'): void {
    this.popOff?.(); this.popOff = null;
    this.popKind = kind;
    this.pop.classList.toggle('acct', kind === 'account');
    const pick = (id: string) => { const r = rowById(id)!; return `<div class="qrow" data-q="${id}" data-nav tabindex="-1"><span class="lbl">${esc(r.label.replace(/^Outrun /, '').replace(/^./, (c) => c.toUpperCase()))}</span><span class="ctl"><button class="arr" data-d="-1" data-nav="skip" tabindex="-1" aria-label="Previous">&#8249;</button><span class="pv"></span><button class="arr" data-d="1" data-nav="skip" tabindex="-1" aria-label="Next">&#8250;</button></span></div>`; };
    const cur = this.mode.kind === 'trial' ? this.mode.course : '';
    if (kind === 'trial') {
      this.pop.innerHTML = `<div class="ph">Time trial</div><p>Pick a course: RIDE starts you just above its start gate.</p><div class="courses">${this.courses.length
        ? this.courses.map((c) => `<button class="course${c.id === cur ? ' on' : ''}" data-course="${c.id}"><span class="cn">${esc(c.name)}</span><span class="cl">${fmtDistance(c.length, this.metric)}</span><span class="cb">${c.best !== null ? clock(c.best) : 'no time yet'}</span></button>`).join('')
        : '<p class="dim">No courses on this resort.</p>'}</div>`;
      this.pop.querySelectorAll<HTMLButtonElement>('button[data-course]').forEach((b) => b.addEventListener('click', () => { this.mode = { kind: 'trial', course: b.dataset.course! }; this.closePop(); this.drawModes(); }));
    } else if (kind === 'outrun') {
      this.pop.innerHTML = `<div class="ph">Outrun</div><p>A snow monster chases you down the mountain. Stay ahead, or get eaten.</p>${OUTRUN_ROWS.map(pick).join('')}<button class="primary" data-ok>Pick Outrun</button>`;
      this.pop.querySelectorAll<HTMLElement>('.qrow').forEach((q) => q.addEventListener('click', (e) => { const a = (e.target as HTMLElement).closest<HTMLButtonElement>('button.arr'); this.cycle(q, a ? Number(a.dataset.d) : 1, !a); }));
      this.pop.querySelector('[data-ok]')!.addEventListener('click', () => { this.mode = { kind: 'outrun' }; this.closePop(); this.drawModes(); });
      this.fillRows();
    } else if (kind === 'account') {
      this.popOff = fillAccountPanel(this.pop, this.o.account, { close: () => this.closePop(), redraw: () => { if (!this.pop.hidden) this.sub.refresh(); } });
    } else {
      this.pop.innerHTML = '<div class="ph">Change resort</div><div class="courses"></div>';
      // FEAT-222: built packs, then the published ones to download (ui/ResortPicker.ts); FEAT-246: Find a resort,
      // and Build it for a signed-in maintainer
      fillResortPicker(this.pop, this.o.slug, this.o.resorts, (slug) => {
        // a resort is its own pack: the page reloads into its shot
        const u = new URL(location.href);
        u.searchParams.set('pack', slug);
        for (const k of ['x', 'y', 'h']) u.searchParams.delete(k);
        location.href = u.toString();
      }, () => this.closePop(), { account: this.o.account, builds: this.o.builds });
    }
    this.pop.hidden = false;
    this.el.classList.add('popped');
    openScreen(this.sub);
    this.hints();
  }
  private closePop(): void {
    if (this.pop.hidden) return;
    this.popOff?.(); this.popOff = null;
    this.pop.hidden = true;
    this.el.classList.remove('popped');
    closeScreen(this.sub); // focus goes back to the card that opened it
    this.popKind = null;
    this.drawModes();
    this.hints();
  }
  private cycle(q: HTMLElement, d: number, wrap: boolean): void {
    const r = rowById(q.dataset.q!);
    if (!r || !('get' in r)) return;
    const s = this.o.settings;
    if (r.kind === 'toggle') r.set(s, !r.get(s));
    else if ('opts' in r) {
      const opts = optsOf(r, s);
      const i = opts.findIndex(([v]) => String(v) === String(r.get(s)));
      const j = wrap ? (i + d + opts.length) % opts.length : Math.max(0, Math.min(opts.length - 1, i + d));
      if (j === i) return;
      r.set(s, opts[j][0]);
    } else return;
    saveSettings(s);
    this.onSettingsChange(s, r.what ?? r.id);
    this.fillRows();
  }
  private fillRows(): void {
    this.pop.querySelectorAll<HTMLElement>('.qrow').forEach((q) => {
      const r = rowById(q.dataset.q!) as Row & { get: (s: Settings) => string | number | boolean };
      const v = r.get(this.o.settings);
      const pv = q.querySelector<HTMLElement>('.pv')!;
      if (r.kind === 'toggle') { pv.textContent = v ? 'On' : 'Off'; return; }
      if (!('opts' in r)) return;
      pv.textContent = optsOf(r, this.o.settings).find(([o]) => String(o) === String(v))?.[1] ?? String(v);
    });
  }

  private hints(): void {
    const h: Hint[] = this.popKind ? [['select', 'Select'], ['move', 'Move'], ['back', 'Back']] : [['select', 'Select'], ['move', 'Move'], ['discipline', 'Snowboard / Skis']];
    renderHints(this.hintEl, h, lastInputKind());
  }

  /** Close everything (the page is leaving). */
  destroy(): void { this.hide(); this.unmountAccount(); this.el.remove(); }
  /** the Settings screen is open over the menu */
  get settingsUp(): boolean { return settingsOpen(); }
}
