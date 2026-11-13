import { DualSenseHID, dualSense } from '../sim/DualSense';
import { PAD, PAUSE_BUTTONS, activePad, lastPadKind, migratePadKeys, padButtonName, padUi } from '../sim/Pad';
import { padFx } from '../sim/PadFeedback';
import { LENSES } from '../world/Lens';
import { renderHints, type Hint } from './HintBar';
import { MENU_KEYS, MENU_PAD } from './MenuKeys';
import { Screen, closeScreen, lastInputKind, openScreen, setNavSuspended } from './MenuNav';
import { padGlyph, stickGlyph } from './PadGlyphs';
import { KEY_GROUPS, PAD_GROUPS, applyUiScale, defaultSettings, keyName, migrateKeys, saveSettings, type Settings } from './Settings';
import { CATEGORIES, HELD_FIELDS, SECTIONS, descOf, optsOf, presetLine, rowsOf, type CatId, type Row } from './SettingsRows';
import { LoadingScreen } from './Loading';

/**
 * FEAT-128 settings screen (layout B): full screen, categories on the left, rows of label and control in
 * the middle, a detail panel for the focused row on the right. Opened from the main menu (over a blurred
 * backdrop) and the pause menu (over the live game, dimmed, with Peek to see it and a live fps readout).
 * Left / right change the focused row, A / Enter toggles or opens it, LB / RB or Q / E switch category,
 * X / R resets the category (press twice), hold Y / V to peek. One instance, reused.
 */
export interface Credit { title: string; artist?: string; license?: string; url?: string; playlist?: string }
export interface SettingsOpen {
  overGame: boolean;
  onChange: (s: Settings, what: string) => void;
  /** FEAT-285: apply the held graphics options (already copied into the settings and saved) and resolve once the
   *  frames run clean; `progress` moves the loading bar. Without it Apply calls onChange(s, 'quality'). */
  onApply?: (s: Settings, progress: (p: number, text: string) => void) => Promise<void>;
  cat?: CatId;
  /** the live frame rate (over the game) */
  fps?: () => number;
  /** the shipped music, for Credits */
  credits?: () => Credit[];
  onClose?: () => void;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const ROW_OF = new Map<string, Row>(SECTIONS.flatMap((s) => s.rows.map((r) => [r.id, r] as [string, Row])));
const CAT_OF = new Map<string, CatId>(SECTIONS.flatMap((s) => s.rows.map((r) => [r.id, s.cat] as [string, CatId])));
const catLabel = (c: CatId) => CATEGORIES.find((x) => x.id === c)!.label;
/** the hint chips for a category's what (onChange) list, deduplicated */
const whatOf = (r: Row) => r.what ?? r.id;

class SettingsOverlay {
  readonly el: HTMLDivElement;
  private o: SettingsOpen | null = null;
  private cat: CatId = 'gameplay';
  private readonly screen: Screen;
  private readonly hintEl: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly searchEl: HTMLInputElement;
  private cancelListen: (() => void) | null = null;
  private armed: { what: CatId | 'all'; t: number } | null = null;
  private fpsTimer = 0;
  private rumbleMsg = '';
  /** on the MenuNav stack (set after openScreen) */
  private shown = false;
  /** FEAT-285: the held rows (heavy graphics) read and write this copy; `s` keeps the applied values until Apply */
  private draft: Settings;
  private applying = false;
  private readonly leaveEl: HTMLElement;
  private readonly leaveScreen: Screen;

  constructor(private readonly s: Settings) {
    this.draft = { ...s };
    this.el = document.createElement('div');
    this.el.id = 'settings';
    this.el.innerHTML = `
      <header class="top">
        <div class="title">Settings</div>
        <div class="cathint"></div>
        <input type="search" class="search" placeholder="Search settings" aria-label="Search settings" spellcheck="false">
        <button class="peek" data-nav="skip" tabindex="-1">Hold to peek</button>
        <div class="fps"></div>
        <button class="close" data-nav="skip" tabindex="-1" aria-label="Close">&times;</button>
      </header>
      <nav class="cats">${CATEGORIES.map((c) => `<button data-cat="${c.id}">${c.label}</button>`).join('')}<div class="grow"></div><button data-reset-all>Reset all</button></nav>
      <main class="rows">${CATEGORIES.map((c) => this.page(c.id)).join('')}<div class="nomatch">No settings match.</div></main>
      <aside class="detail"></aside>
      <footer class="hintbar"></footer>
      <div class="leave" hidden role="dialog" aria-modal="true" aria-labelledby="settings-leave-h">
        <div class="box"><h3 id="settings-leave-h">Graphics changes waiting</h3>
          <p>Apply them now (a short loading screen while the renderer rebuilds), or discard them and keep the graphics as they are?</p>
          <div class="btns"><button class="act primary" data-leave="apply">Apply</button><button class="act" data-leave="discard">Discard</button><button class="act" data-leave="stay">Keep editing</button></div></div>
      </div>`;
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
    this.hintEl = this.el.querySelector('.hintbar')!;
    this.detail = this.el.querySelector('.detail')!;
    this.searchEl = this.el.querySelector('.search')!;
    this.leaveEl = this.el.querySelector('.leave')!;
    this.wire();
    this.screen = new Screen(this.el, {
      primary: () => this.firstRow(),
      onBack: () => { if (this.searchEl.value) { this.searchEl.value = ''; this.applySearch(); this.screen.focus(this.searchEl); } else this.requestClose(); },
      onIntent: (i, down) => this.intent(i, down),
      onInputKind: () => this.hints(),
      onFocus: (el) => this.showDetail(el),
    });
    // FEAT-285: leaving with graphics changes waiting asks Apply or Discard; Back keeps editing
    this.leaveScreen = new Screen(this.leaveEl, {
      primary: () => this.leaveEl.querySelector<HTMLElement>('[data-leave="apply"]'),
      onBack: () => this.closeLeave(),
      onIntent: () => this.applying, // nothing moves while Apply runs
    });
  }

  get isOpen(): boolean { return !!this.o; }

  open(o: SettingsOpen): void {
    this.o = o;
    this.el.classList.toggle('over-game', o.overGame);
    this.el.classList.toggle('over-menu', !o.overGame);
    (this.el.querySelector('.peek') as HTMLElement).style.display = o.overGame ? '' : 'none';
    this.searchEl.value = '';
    this.draft = { ...this.s }; // nothing waiting
    this.leaveEl.hidden = true;
    this.el.style.display = '';
    document.body.classList.add('settings-open');
    this.fillAll();
    this.drawKeys();
    this.drawCredits();
    this.openCat(o.cat ?? this.cat, false);
    openScreen(this.screen);
    this.shown = true;
    this.hints();
    const fpsEl = this.el.querySelector<HTMLElement>('.fps')!;
    fpsEl.textContent = '';
    if (o.fps) this.fpsTimer = window.setInterval(() => { fpsEl.textContent = `${Math.round(o.fps!())} fps`; }, 500);
  }

  /** Back or the close button: with graphics changes waiting, ask Apply or Discard first */
  private requestClose(): void {
    if (this.applying) return;
    if (!this.pending().length) { this.close(); return; }
    this.cancelListen?.();
    this.leaveEl.hidden = false;
    openScreen(this.leaveScreen);
  }
  private closeLeave(): void {
    if (this.applying) return;
    this.leaveEl.hidden = true;
    closeScreen(this.leaveScreen);
  }
  private async leave(how: 'apply' | 'discard' | 'stay'): Promise<void> {
    if (this.applying) return;
    if (how === 'stay') { this.closeLeave(); return; }
    if (how === 'apply') await this.apply();
    else this.discard();
    this.closeLeave();
    this.close();
  }

  /** Close now. Graphics changes still waiting are dropped (the menus close it this way when they hide). */
  close(): void {
    if (!this.o) return;
    const o = this.o;
    if (!this.leaveEl.hidden) { this.leaveEl.hidden = true; closeScreen(this.leaveScreen); }
    this.draft = { ...this.s };
    this.cancelListen?.();
    this.peek(false);
    clearInterval(this.fpsTimer);
    this.armed = null;
    this.o = null;
    this.shown = false;
    this.el.style.display = 'none';
    document.body.classList.remove('settings-open');
    closeScreen(this.screen);
    o.onClose?.();
  }

  // ---------------------------------------------------------------- building
  private page(c: CatId): string {
    const secs = SECTIONS.filter((s) => s.cat === c);
    return `<section class="page" data-cat="${c}"><h2 class="pagetitle">${catLabel(c)}</h2>` + secs.map((sec, i) =>
      `<div class="sect"><div class="sh"><span>${sec.title}</span>${i === 0 && c !== 'credits' ? `<button class="reset-cat" data-reset-cat="${c}">Reset ${catLabel(c).toLowerCase()}</button>` : ''}</div>` +
      sec.rows.map((r) => this.row(r)).join('') + '</div>').join('') + '</section>';
  }

  private row(r: Row): string {
    const search = esc(`${r.label} ${descOf(r, this.s)}`.toLowerCase());
    const head = `data-row="${r.id}" data-kind="${r.kind}" data-search="${search}"`;
    const desc = `<span class="sdesc"></span>`;
    switch (r.kind) {
      case 'info': return `<div class="srow info" ${head}><span class="txt">${esc(descOf(r, this.s))}</span></div>`;
      case 'custom': return `<div class="srow block" ${head}><div class="mount" data-mount="${r.mount}"></div></div>`;
      case 'action': return `<div class="srow" ${head} data-nav tabindex="-1"><span class="lbl">${r.label}</span><span class="ctl"><button class="act" data-nav="skip" tabindex="-1"></button><span class="status"></span></span>${desc}</div>`;
      case 'toggle': return `<div class="srow" ${head} data-nav tabindex="-1"><span class="lbl">${r.label}</span><span class="ctl"><span class="tv"></span><span class="tgl"><i></i></span></span>${desc}</div>`;
      case 'seg': return `<div class="srow" ${head} data-nav tabindex="-1"><span class="lbl">${r.label}</span><span class="ctl"><span class="seg">${optsOf(r, this.s).map(([v, l]) => `<button data-v="${esc(String(v))}" data-nav="skip" tabindex="-1">${l}</button>`).join('')}</span></span>${desc}</div>`;
      case 'pick': return `<div class="srow" ${head} data-nav tabindex="-1"><span class="lbl">${r.label}</span><span class="ctl"><button class="arr" data-d="-1" data-nav="skip" tabindex="-1" aria-label="Previous">&#8249;</button><span class="pv"></span><button class="arr" data-d="1" data-nav="skip" tabindex="-1" aria-label="Next">&#8250;</button></span>${desc}</div>`;
      case 'slider': return `<div class="srow" ${head} data-nav tabindex="-1"><span class="lbl">${r.label}</span><span class="ctl"><input type="range" min="${r.min}" max="${r.max}" step="${r.step}" data-nav="skip" tabindex="-1"><span class="val"></span></span>${desc}</div>`;
      case 'color': return `<div class="srow" ${head} data-nav tabindex="-1" data-pad-skip><span class="lbl">${r.label}</span><span class="ctl"><input type="color" data-nav="skip" tabindex="-1"><span class="val"></span></span>${desc}</div>`;
    }
  }

  private wire(): void {
    const el = this.el;
    el.querySelectorAll<HTMLButtonElement>('.cats button[data-cat]').forEach((b) => b.addEventListener('click', () => { this.openCat(b.dataset.cat as CatId, false); this.screen.focus(b, false); }));
    el.querySelectorAll<HTMLButtonElement>('[data-reset-cat]').forEach((b) => b.addEventListener('click', () => this.askReset(b.dataset.resetCat as CatId)));
    el.querySelector('[data-reset-all]')!.addEventListener('click', () => this.askReset('all'));
    el.querySelector('.close')!.addEventListener('click', () => this.requestClose());
    el.querySelectorAll<HTMLButtonElement>('[data-leave]').forEach((b) => b.addEventListener('click', () => void this.leave(b.dataset.leave as 'apply' | 'discard' | 'stay')));
    // rows: a click on the row selects it, the inner controls do their own thing
    el.querySelectorAll<HTMLElement>('.srow[data-nav]').forEach((rowEl) => {
      const r = ROW_OF.get(rowEl.dataset.row!)!;
      rowEl.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        this.screen.focus(rowEl, false);
        const segB = t.closest<HTMLButtonElement>('.seg button'), arr = t.closest<HTMLButtonElement>('button.arr');
        if (segB && 'get' in r) { const v = optsOf(r as Row & { opts: never }, this.src(r)).find(([o]) => String(o) === segB.dataset.v)?.[0]; if (v !== undefined) this.change(r, v); }
        else if (arr) this.adjust(r, Number(arr.dataset.d));
        else if (t.closest('input')) { /* the input's own events */ }
        else this.activate(r, rowEl);
      });
      const input = rowEl.querySelector('input');
      if (input && 'get' in r) input.addEventListener('input', () => this.change(r, r.kind === 'slider' ? Number(input.value) : input.value));
    });
    // typing in the search box stays in the box (no map on M, no camera on C behind the screen)
    this.searchEl.addEventListener('keydown', (e) => e.stopPropagation());
    this.searchEl.addEventListener('input', () => this.applySearch());
    // Peek on the mouse or touch: held down
    const peekB = el.querySelector<HTMLElement>('.peek')!;
    peekB.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.peek(true);
      const end = () => { this.peek(false); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
      window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    });
    window.addEventListener('blur', () => this.peek(false)); // a held V whose keyup went to another window
    const prevStatus = dualSense.onStatus;
    dualSense.onStatus = (st) => { prevStatus?.(st); if (this.o) this.fillAll(); };
  }

  // ---------------------------------------------------------------- values
  /** the settings a row reads and writes: the draft for a held graphics row (FEAT-285), else the live settings */
  private src(r: Row): Settings { return r.held ? this.draft : this.s; }
  /** the held fields changed in the draft and not applied yet */
  private pending(): string[] {
    const d = this.draft as unknown as Record<string, unknown>, s = this.s as unknown as Record<string, unknown>;
    return HELD_FIELDS.filter((f) => d[f] !== s[f]);
  }

  private fillAll(): void {
    const pending = this.pending().length;
    this.el.querySelectorAll<HTMLElement>('.srow[data-row]').forEach((rowEl) => {
      const r = ROW_OF.get(rowEl.dataset.row!);
      if (!r) return;
      const s = this.src(r);
      rowEl.classList.toggle('gone', !!r.hidden?.());
      const note = r.note?.(s) ?? null;
      rowEl.classList.toggle('overridden', !!note);
      const d = rowEl.querySelector<HTMLElement>('.sdesc'); if (d) d.textContent = descOf(r, s);
      if (r.kind === 'action') {
        const b = rowEl.querySelector<HTMLButtonElement>('button.act')!;
        b.textContent = r.id === 'hid' ? (dualSense.connected ? 'Disconnect' : 'Connect') : typeof r.button === 'function' ? r.button(s) : r.button;
        const st = rowEl.querySelector<HTMLElement>('.status')!;
        st.textContent = r.id === 'hid' ? (dualSense.status || (dualSense.connected ? 'Connected' : 'Not connected')) : r.id === 'rumble-test' ? this.rumbleMsg
          : r.id === 'gfx-apply' ? (this.applying ? 'Applying...' : pending ? `${pending} ${pending === 1 ? 'change' : 'changes'} waiting` : 'Nothing to apply') : '';
        if (r.id === 'gfx-apply') { b.disabled = !pending || this.applying; b.classList.toggle('primary', !!pending); }
        return;
      }
      if (!('get' in r)) return;
      const v = r.get(s);
      rowEl.classList.toggle('pending', !!r.held && String(v) !== String(r.get(this.s)));
      if (r.kind === 'toggle') { rowEl.classList.toggle('on', !!v); rowEl.querySelector('.tv')!.textContent = v ? 'On' : 'Off'; }
      else if (r.kind === 'seg') {
        const opts = optsOf(r, s);
        rowEl.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
        rowEl.classList.toggle('custom', !opts.some(([o]) => String(o) === String(v)));
      } else if (r.kind === 'pick') {
        const opts = optsOf(r, s);
        const i = opts.findIndex(([o]) => String(o) === String(v));
        const pv = rowEl.querySelector<HTMLElement>('.pv')!;
        pv.textContent = i >= 0 ? opts[i][1] : 'Custom';
        pv.style.setProperty('--sw', r.id === 'goggleLens' && v !== 'auto' ? (LENSES[v as keyof typeof LENSES]?.swatch ?? 'transparent') : 'transparent');
        rowEl.classList.toggle('swatch', r.id === 'goggleLens');
        rowEl.querySelector<HTMLButtonElement>('.arr[data-d="-1"]')!.disabled = i <= 0;
        rowEl.querySelector<HTMLButtonElement>('.arr[data-d="1"]')!.disabled = i >= opts.length - 1;
      } else if (r.kind === 'slider') {
        const inp = rowEl.querySelector('input')!; inp.value = String(v);
        inp.style.setProperty('--fill', `${((Number(v) - r.min) / (r.max - r.min)) * 100}%`);
        rowEl.querySelector('.val')!.textContent = r.fmt(Number(v));
      } else if (r.kind === 'color') {
        rowEl.querySelector('input')!.value = String(v);
        rowEl.querySelector('.val')!.textContent = String(v);
      }
    });
    // a section whose rows are all gone hides (DualSense extras without WebHID)
    this.el.querySelectorAll<HTMLElement>('.sect').forEach((sec) => sec.classList.toggle('gone', !sec.querySelector('.srow:not(.gone)')));
    this.showDetail(this.screen?.focused ?? null);
  }

  private change(r: Row, v: string | number | boolean): void {
    if (!('set' in r)) return;
    if (r.held) { r.set(this.draft, v); this.fillAll(); this.hints(); return; } // FEAT-285: waits for Apply, nothing rebuilds
    r.set(this.s, v);
    this.commit([whatOf(r)]);
  }

  /** FEAT-285: the held graphics options go live behind a loading screen; the settings screen stays open */
  private async apply(): Promise<void> {
    if (this.applying || !this.pending().length) return;
    this.applying = true;
    const s = this.s as unknown as Record<string, unknown>, d = this.draft as unknown as Record<string, unknown>;
    for (const f of HELD_FIELDS) s[f] = d[f];
    saveSettings(this.s);
    this.fillAll();
    const screen = new LoadingScreen('Applying settings', { eyebrow: 'Graphics', over: true });
    screen.set(0.15, 'Rebuilding the renderer');
    await screen.painted(); // drawn before the rebuild blocks the page
    const o = this.o;
    try {
      if (o?.onApply) await o.onApply(this.s, (p, t) => screen.set(p, t));
      else o?.onChange(this.s, 'quality');
    } catch (e) {
      console.error('Applying graphics settings failed', e);
    } finally {
      screen.hide();
      this.applying = false;
      this.draft = { ...this.s };
      if (this.o) { this.fillAll(); this.hints(); }
    }
  }
  /** FEAT-285: every held graphics option back to what is applied */
  private discard(): void {
    this.draft = { ...this.s };
    this.fillAll(); this.hints();
  }
  private commit(whats: string[]): void {
    saveSettings(this.s);
    for (const w of new Set(whats)) this.o?.onChange(this.s, w);
    applyUiScale(this.s);
    this.fillAll();
  }

  /** left / right on a row; true when the row took it */
  private adjust(r: Row, d: number): boolean {
    if (!('get' in r)) return false;
    const v = r.get(this.src(r));
    if (r.kind === 'toggle') { this.change(r, d > 0); return true; }
    if (r.kind === 'seg' || r.kind === 'pick') {
      const opts = optsOf(r, this.src(r));
      const i = opts.findIndex(([o]) => String(o) === String(v));
      const j = i < 0 ? (d > 0 ? 0 : opts.length - 1) : Math.max(0, Math.min(opts.length - 1, i + d));
      if (j !== i) this.change(r, opts[j][0]);
      return true;
    }
    if (r.kind === 'slider') {
      const n = Math.round((Math.max(r.min, Math.min(r.max, Number(v) + d * r.step))) / r.step) * r.step;
      const fixed = Number(n.toFixed(4));
      if (fixed !== v) this.change(r, fixed);
      return true;
    }
    return false;
  }

  /** A / Enter / click on a row */
  private activate(r: Row, rowEl: HTMLElement): void {
    const s = this.src(r);
    if (r.kind === 'toggle') this.change(r, !r.get(s));
    else if (r.kind === 'seg' || r.kind === 'pick') {
      const opts = optsOf(r, s);
      const i = opts.findIndex(([o]) => String(o) === String(r.get(s)));
      this.change(r, opts[(i + 1) % opts.length][0]);
    } else if (r.kind === 'color') rowEl.querySelector<HTMLInputElement>('input')!.click();
    else if (r.kind === 'action') this.action(r.action);
  }

  private action(a: string): void {
    const s = this.s;
    if (a === 'keys-reset') { s.keys = migrateKeys(undefined).keys; s.keysNote = false; this.commit(['keys']); this.drawKeys(); }
    else if (a === 'pad-reset') { s.padKeys = migratePadKeys(undefined); this.commit(['padKeys']); this.drawKeys(); }
    else if (a === 'rumble-test') { this.rumbleMsg = 'Testing...'; this.fillAll(); void padFx.test(activePad()).then((m) => { this.rumbleMsg = m; this.fillAll(); }); }
    else if (a === 'hid') void (dualSense.connected ? dualSense.disconnect() : dualSense.connect()).then(() => this.fillAll());
    else if (a === 'gfx-apply') void this.apply();
  }

  // ---------------------------------------------------------------- reset
  /** the first press arms, a second within 3 s resets (X and R sit next to other keys) */
  private askReset(what: CatId | 'all'): void {
    const now = performance.now();
    if (this.armed && this.armed.what === what && now - this.armed.t < 3000) { this.armed = null; this.reset(what); }
    else { this.armed = { what, t: now }; setTimeout(() => { if (this.armed && performance.now() - this.armed.t >= 3000) { this.armed = null; this.armLabels(); this.hints(); } }, 3100); }
    this.armLabels(); this.hints();
  }
  private armLabels(): void {
    this.el.querySelectorAll<HTMLButtonElement>('[data-reset-cat]').forEach((b) => {
      const c = b.dataset.resetCat as CatId, on = this.armed?.what === c;
      b.classList.toggle('armed', on); b.textContent = on ? 'Press again to reset' : `Reset ${catLabel(c).toLowerCase()}`;
    });
    const all = this.el.querySelector<HTMLButtonElement>('[data-reset-all]')!;
    all.classList.toggle('armed', this.armed?.what === 'all'); all.textContent = this.armed?.what === 'all' ? 'Press again' : 'Reset all';
  }
  private reset(what: CatId | 'all'): void {
    const d = defaultSettings();
    if (what === 'all') {
      // the nested objects keep their identity (the pause menu and the game hold them); a ?weather= override clears as with Reset conditions
      const { outfit, outrun } = this.s;
      // FEAT-285: the held graphics options reset in the draft and wait for Apply like any other change to them
      const live = this.s as unknown as Record<string, unknown>, draft = this.draft as unknown as Record<string, unknown>;
      const applied = Object.fromEntries(HELD_FIELDS.map((f) => [f, live[f]]));
      Object.assign(this.s, d, { outfit: Object.assign(outfit, d.outfit), outrun: Object.assign(outrun, d.outrun) });
      for (const f of HELD_FIELDS) { draft[f] = live[f]; live[f] = applied[f]; }
      this.commit(['reset', 'clouds']);
    } else {
      const whats: string[] = [];
      const lens = this.s.goggleLens; // the outfit preset carries a lens, but the lens is Camera's setting
      for (const r of rowsOf(what)) if ('set' in r) { r.set(this.src(r), r.get(d)); if (!r.held) whats.push(whatOf(r)); }
      if (what === 'rider') this.s.goggleLens = lens;
      if (what === 'controls') { this.s.keys = d.keys; this.s.padKeys = d.padKeys; this.s.keysNote = false; whats.push('keys', 'padKeys'); }
      this.commit(whats);
    }
    this.drawKeys();
  }

  // ---------------------------------------------------------------- key and controller slots (FEAT-124, FEAT-137)
  private drawKeys(): void {
    this.cancelListen?.();
    const s = this.s, kind = activePad()?.kind ?? lastPadKind ?? 'ps';
    const keysHost = this.el.querySelector<HTMLElement>('[data-mount="keys"]')!;
    const owner = new Map<string, string[]>();
    for (const act in s.keys) for (const c of s.keys[act] ?? []) owner.set(c, [...(owner.get(c) ?? []), act]);
    const kslot = (act: string, i: number) => {
      const c = s.keys[act]?.[i] ?? '';
      const clash = !!c && (owner.get(c)?.length ?? 0) > 1;
      return `<button class="key${clash ? ' clash' : ''}" data-action="${act}" data-slot="${i}" title="${clash ? 'Also bound to: ' + owner.get(c)!.filter((x) => x !== act).join(', ') : ''}">${esc(keyName(c))}</button>`;
    };
    keysHost.innerHTML = KEY_GROUPS.map(([g, list]) => `<div class="sub">${g}</div>` +
      list.map(([act, label]) => `<div class="srow keyrow" data-row="keys" data-search="${esc(label.toLowerCase())}"><span class="lbl">${label}</span><span class="ctl keys">${kslot(act, 0)}${kslot(act, 1)}</span></div>`).join('')).join('');
    keysHost.querySelectorAll<HTMLButtonElement>('button.key').forEach((b) => b.addEventListener('click', () => this.listenKey(b)));
    // the fixed buttons and the menu buttons, as glyphs from the tables (nothing typed by hand)
    const g = (b: number) => padGlyph(kind, b);
    this.el.querySelector<HTMLElement>('[data-mount="pad-help"]')!.innerHTML = `<div class="txt" data-padnav-hint>` +
      `${stickGlyph('L')} steers and leans (up / down tuck and brake), ${stickGlyph('R')} looks, ${PAUSE_BUTTONS.map(g).join(' or ')} pauses. ` +
      `In menus: ${[PAD.UP, PAD.DOWN, PAD.LEFT, PAD.RIGHT].map(g).join('')} or ${stickGlyph('L')} move, ${g(MENU_PAD.select!)} picks, ${g(MENU_PAD.back!)} goes back, ${g(MENU_PAD.prevCat!)} ${g(MENU_PAD.nextCat!)} switch category, hold ${g(MENU_PAD.peek!)} to peek, ${g(MENU_PAD.reset!)} resets.</div>`;
    const padHost = this.el.querySelector<HTMLElement>('[data-mount="padkeys"]')!;
    const powner = new Map<number, string[]>();
    for (const act in s.padKeys) for (const b of s.padKeys[act] ?? []) powner.set(b, [...(powner.get(b) ?? []), act]);
    const pslot = (act: string, i: number) => {
      const b = s.padKeys[act]?.[i];
      const clash = b !== undefined && (powner.get(b)?.length ?? 0) > 1;
      const title = b === undefined ? 'unbound' : padButtonName(kind, b) + (clash ? ' (also: ' + powner.get(b)!.filter((x) => x !== act).join(', ') + ')' : '');
      return `<button class="key pad${clash ? ' clash' : ''}" data-paction="${act}" data-slot="${i}" title="${title}">${b === undefined ? '-' : padGlyph(kind, b)}</button>`;
    };
    padHost.innerHTML = PAD_GROUPS.map(([g, list]) => `<div class="sub">${g}</div>` +
      list.map(([act, label]) => `<div class="srow keyrow" data-row="padkeys" data-search="${esc(label.toLowerCase())}"><span class="lbl">${label}</span><span class="ctl padkeys">${pslot(act, 0)}${pslot(act, 1)}</span></div>`).join('')).join('');
    padHost.querySelectorAll<HTMLButtonElement>('button.key').forEach((b) => b.addEventListener('click', () => this.listenPad(b)));
    if (this.searchEl.value) this.applySearch();
    if (this.o && this.shown) this.screen.refresh(); // not while opening: openScreen has to see where focus came from first
  }

  private listenKey(clicked: HTMLButtonElement): void {
    const b = this.restartSlot(clicked, `button.key[data-action="${clicked.dataset.action}"][data-slot="${clicked.dataset.slot}"]`);
    b.textContent = '...'; b.classList.add('listening');
    setNavSuspended(true); // the menus ignore keys and pad while a slot waits for one
    const act = b.dataset.action!, i = Number(b.dataset.slot), s = this.s;
    const set = (code: string | null) => {
      const arr = [...(s.keys[act] ?? [])];
      if (code === null) arr.splice(i, 1); else arr[i] = code;
      s.keys[act] = arr.filter((x) => !!x).slice(0, 2);
      this.commit(['keys']);
    };
    const done = () => { stop(); this.drawKeys(); this.refocusSlot(`button.key[data-action="${act}"][data-slot="${i}"]`); };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return; // the Enter that opened the slot, still held
      if (e.code === 'Delete') set(null); else if (e.code !== 'Escape') set(e.code);
      done();
    };
    const onMouse = (e: MouseEvent) => { if (e.button !== 2) return; e.preventDefault(); e.stopPropagation(); set('Mouse2'); done(); };
    const mouseTimer = setTimeout(() => window.addEventListener('mousedown', onMouse, true), 0);
    const stop = () => { clearTimeout(mouseTimer); window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onMouse, true); this.cancelListen = null; setNavSuspended(false); };
    this.cancelListen = () => { stop(); this.drawKeys(); };
    window.addEventListener('keydown', onKey, true);
  }

  private listenPad(clicked: HTMLButtonElement): void {
    const btn = this.restartSlot(clicked, `button.key[data-paction="${clicked.dataset.paction}"][data-slot="${clicked.dataset.slot}"]`);
    btn.textContent = '...'; btn.classList.add('listening');
    const act = btn.dataset.paction!, i = Number(btn.dataset.slot), s = this.s;
    const set = (b: number | null) => {
      const arr = [...(s.padKeys[act] ?? [])];
      if (b === null) arr.splice(i, 1); else arr[i] = b;
      s.padKeys[act] = arr.filter((x) => x !== undefined && x !== null).slice(0, 2);
      this.commit(['padKeys']);
    };
    // wait for every button to be let go (the Cross that opened the slot), then take the next press
    let armed = false, raf = 0;
    const t0 = performance.now();
    const poll = () => {
      const p = activePad();
      const down = p ? p.buttons.findIndex((x, j) => (j !== 6 && j !== 7 ? x.pressed : x.value > 0.5)) : -1;
      if (!armed) { if (down < 0) armed = true; }
      else if (down >= 0) { if (!PAUSE_BUTTONS.includes(down)) set(down); done(); return; }
      if (performance.now() - t0 > 6000) { done(); return; }
      raf = requestAnimationFrame(poll);
    };
    const onKey = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); if (e.code === 'Delete' || e.code === 'Backspace') set(null); done(); };
    const stop = () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey, true); padUi.listening = false; this.cancelListen = null; };
    const done = () => { stop(); this.drawKeys(); this.refocusSlot(`button.key[data-paction="${act}"][data-slot="${i}"]`); };
    this.cancelListen = () => { stop(); this.drawKeys(); };
    padUi.listening = true;
    window.addEventListener('keydown', onKey, true);
    raf = requestAnimationFrame(poll);
  }
  /** A slot that was still listening stops (else both would take the next key); that redraws the slots, so the
   *  clicked one is found again by its action and slot, and keeps the focus. */
  private restartSlot(clicked: HTMLButtonElement, sel: string): HTMLButtonElement {
    if (!this.cancelListen) return clicked;
    this.cancelListen();
    const b = this.el.querySelector<HTMLButtonElement>(sel) ?? clicked;
    this.screen.focus(b, false);
    return b;
  }
  /** after a slot redraws, focus stays on the same slot */
  private refocusSlot(sel: string): void { const b = this.el.querySelector<HTMLElement>(sel); if (b) this.screen.focus(b, false); }

  private drawCredits(): void {
    const host = this.el.querySelector<HTMLElement>('[data-mount="credits"]')!;
    const c = this.o?.credits?.() ?? [];
    host.innerHTML = (c.length
      ? `<div class="sub">Music</div>` + c.map((t) => `<div class="credit">${esc(t.title)}${t.artist ? ` by ${esc(t.artist)}` : ''}${t.license ? ` <span class="dim">(${esc(t.license)})</span>` : ''}${t.url ? ` <a href="${esc(t.url)}" target="_blank" rel="noopener">source</a>` : ''}${t.playlist ? ` <span class="dim">${esc(t.playlist)}</span>` : ''}</div>`).join('')
        + `<div class="credit dim">Playlists without tracks play the built-in jukebox (procedural, no samples).</div>`
      : `<div class="credit dim">No playlist shipped: the built-in jukebox plays procedural music in each playlist's style. Drop tracks in game/public/music/ (see README there).</div>`)
      + `<div class="sub">Textures</div><div class="credit">Rock and talus: Rock030, Gravel040 by ambientCG.com <span class="dim">(CC0)</span></div>`
      + `<div class="sub">Fonts</div><div class="credit">Barlow and Barlow Condensed by The Barlow Project Authors <span class="dim">(SIL Open Font License)</span></div>`;
  }

  // ---------------------------------------------------------------- categories, search, detail, peek
  private openCat(c: CatId, focusFirst: boolean): void {
    this.cat = c;
    if (c === 'credits') this.drawCredits(); // the music list loads after the menu
    if (this.searchEl.value) { this.searchEl.value = ''; this.applySearch(); }
    this.el.querySelectorAll<HTMLElement>('.cats button[data-cat]').forEach((b) => b.classList.toggle('on', b.dataset.cat === c));
    this.el.querySelectorAll<HTMLElement>('.page').forEach((p) => p.classList.toggle('shown', p.dataset.cat === c));
    this.el.querySelector('.rows')!.scrollTop = 0;
    this.armed = null; this.armLabels();
    if (focusFirst) this.screen.focus(this.firstRow());
    this.hints();
  }
  private firstRow(): HTMLElement | null {
    const items = this.screen?.items() ?? [];
    // the first setting (not the section's Reset button), else the category itself
    return items.find((e) => e.closest('.page.shown') && !e.matches('.reset-cat')) ?? this.el.querySelector<HTMLElement>(`.cats button[data-cat="${this.cat}"]`);
  }
  private cycle(d: number): void {
    const i = CATEGORIES.findIndex((c) => c.id === this.cat);
    const next = CATEGORIES[(i + d + CATEGORIES.length) % CATEGORIES.length].id;
    const inCats = !!this.screen.focused?.closest('.cats');
    this.openCat(next, !inCats);
    if (inCats) this.screen.focus(this.el.querySelector<HTMLElement>(`.cats button[data-cat="${next}"]`));
  }

  private applySearch(): void {
    const q = this.searchEl.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const on = q.length > 0;
    this.el.classList.toggle('searching', on);
    let any = false;
    this.el.querySelectorAll<HTMLElement>('.srow[data-search]').forEach((r) => {
      const hay = r.dataset.search ?? '';
      const hit = !on || q.every((w) => hay.includes(w));
      r.classList.toggle('miss', !hit);
    });
    // a key block shows when one of its keys matched, its parent row stays
    this.el.querySelectorAll<HTMLElement>('.srow.block').forEach((b) => { if (on && b.querySelector('.keyrow:not(.miss)')) b.classList.remove('miss'); });
    this.el.querySelectorAll<HTMLElement>('.sect').forEach((sec) => { const vis = !!sec.querySelector('.srow:not(.miss):not(.gone):not(.keyrow)'); sec.classList.toggle('miss', on && !vis); });
    this.el.querySelectorAll<HTMLElement>('.page').forEach((p) => { const vis = !!p.querySelector('.sect:not(.miss):not(.gone)'); p.classList.toggle('miss', on && !vis); if (vis && on) any = true; });
    this.el.querySelectorAll<HTMLElement>('.cats button[data-cat]').forEach((b) => b.classList.toggle('on', !on && b.dataset.cat === this.cat));
    this.el.querySelector<HTMLElement>('.nomatch')!.style.display = on && !any ? 'block' : 'none';
    this.hints();
  }

  private showDetail(el: HTMLElement | null): void {
    if (!this.detail) return;
    const rowEl = el?.closest<HTMLElement>('[data-row]');
    const r = rowEl ? ROW_OF.get(rowEl.dataset.row!) : undefined;
    let h = '';
    if (r) {
      const cat = CAT_OF.get(r.id)!;
      const keyLabel = el?.closest('.keyrow')?.querySelector('.lbl')?.textContent;
      const s = this.src(r);
      h = `<div class="eyebrow">${catLabel(cat)}</div><h3>${esc(keyLabel ?? r.label)}</h3><p>${esc(descOf(r, s))}</p>`;
      const note = r.note?.(s);
      if (note) h += `<p class="note">${esc(note)}</p>`;
      if (rowEl?.classList.contains('pending')) h += `<p class="note">Waiting for Apply (Graphics &gt; Apply).</p>`;
      if (r.cost) h += `<p class="cost"><b>Cost</b> ${esc(r.cost)}</p>`;
      const pl = presetLine(r, s);
      if (pl) h += `<p class="presets"><b>Presets</b> ${esc(pl)}</p>`;
      if (r.id === 'hid') h += `<p class="note">${esc(dualSense.status || (dualSense.connected ? 'Connected' : 'Not connected'))}</p>`;
    } else if (el?.dataset.cat) {
      const c = el.dataset.cat as CatId;
      h = `<div class="eyebrow">Category</div><h3>${catLabel(c)}</h3><p>${SECTIONS.filter((s) => s.cat === c).map((s) => s.title).join(', ')}.</p>`;
    } else if (el?.dataset.resetCat) h = `<h3>Reset ${catLabel(el.dataset.resetCat as CatId).toLowerCase()}</h3><p>Puts every setting in this category back to its default. Press twice.</p>`;
    else if (el?.hasAttribute('data-reset-all')) h = `<h3>Reset all</h3><p>Puts every setting back to its default, keys and controller buttons included. Press twice.</p>`;
    else if (el === this.searchEl) h = `<h3>Search</h3><p>Type to find a setting in any category by its name or description.</p>`;
    this.detail.innerHTML = h;
  }

  private peek(on: boolean): boolean {
    if (on && !this.o?.overGame) return false;
    document.body.classList.toggle('peeking', on);
    return true;
  }

  private intent(i: string, down: boolean): boolean {
    if (this.applying) return true; // the loading screen is up: nothing moves, Back waits
    if (i === 'peek') return this.peek(down);
    if (!down) return false;
    const f = this.screen.focused;
    const rowEl = f?.matches('.srow[data-nav]') ? f : null;
    const r = rowEl ? ROW_OF.get(rowEl.dataset.row!) : undefined;
    switch (i) {
      case 'left': case 'right': return !!r && this.adjust(r, i === 'left' ? -1 : 1);
      case 'select':
        if (r && rowEl) { this.activate(r, rowEl); return true; }
        if (f?.dataset.cat) { this.openCat(f.dataset.cat as CatId, true); return true; }
        if (f === this.searchEl) { const first = this.screen.items().find((e) => e.closest('.page') && !e.closest('.miss')); if (first) this.screen.focus(first); return true; }
        return false;
      case 'prevCat': case 'nextCat': this.cycle(i === 'nextCat' ? 1 : -1); return true;
      case 'reset': if (this.cat !== 'credits' && !this.searchEl.value) this.askReset(this.cat); return true;
      default: return false;
    }
  }

  private hints(): void {
    const cat = this.searchEl.value ? null : this.cat;
    const h: Hint[] = [['select', 'Select'], ['adjust', 'Change'], ['cat', 'Category']];
    if (this.o?.overGame) h.push(['peek', 'Hold to peek']);
    if (cat && cat !== 'credits') h.push(['reset', this.armed && this.armed.what === cat ? 'Press again to reset' : `Reset ${catLabel(cat).toLowerCase()}`]);
    h.push(['back', this.searchEl.value ? 'Clear search' : 'Back']);
    renderHints(this.hintEl, h, lastInputKind());
    const k = lastInputKind() === 'pad';
    const kind = activePad()?.kind ?? lastPadKind ?? 'ps';
    this.el.querySelector<HTMLElement>('.cathint')!.innerHTML = k ? `<kbd class="pad">${padGlyph(kind, MENU_PAD.prevCat!)}</kbd><kbd class="pad">${padGlyph(kind, MENU_PAD.nextCat!)}</kbd>` : `<kbd>${keyName(MENU_KEYS.prevCat[0])}</kbd><kbd>${keyName(MENU_KEYS.nextCat[0])}</kbd>`;
  }
}

let inst: SettingsOverlay | null = null;
/** Open the settings screen (one instance for the page; `s` is the one settings object the game shares). */
export function openSettings(s: Settings, o: SettingsOpen): void { (inst ??= new SettingsOverlay(s)).open(o); }
export function closeSettings(): void { inst?.close(); }
export function settingsOpen(): boolean { return !!inst?.isOpen; }
