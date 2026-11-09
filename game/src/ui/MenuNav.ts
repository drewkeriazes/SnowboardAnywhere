import { intentForKey, LETTER_INTENTS, MENU_PAD, type NavIntent } from './MenuKeys';
import { PAD } from './PadMap';

/**
 * FEAT-128: one focus manager for every menu. Open screens form a stack and only the top one takes
 * input: the keyboard through one capture-phase listener (a handled key never reaches `Controls`, which
 * is what keeps Esc from toggling pause twice), the gamepad through its own poll while any screen is
 * open (nothing runs while all menus are closed), the mouse and touch through hover and click.
 * Focus is always on something visible: opening a screen focuses its primary item, closing it gives
 * focus back to whatever had it before.
 */
export type InputKind = 'keyboard' | 'pad' | 'mouse' | 'touch';

export interface ScreenOpts {
  /** the item focused when the screen opens (else the first focusable) */
  primary?: () => HTMLElement | null;
  /** B / Esc; without it Back does nothing and the key passes through */
  onBack?: () => void;
  /** screen-specific intents (tabs, peek, reset, ...); return true when handled */
  onIntent?: (i: NavIntent, down: boolean) => boolean;
  /** the last input kind changed (hint bars re-render) */
  onInputKind?: (k: InputKind) => void;
}

const FOCUSABLE = 'button, select, input, [data-nav]';
const visible = (el: HTMLElement): boolean => el.isConnected && el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled && el.dataset.nav !== 'skip';
const isText = (el: Element | null): boolean => el instanceof HTMLInputElement && ['text', 'search', 'email', 'number', 'password'].includes(el.type);

export class Screen {
  private cur: HTMLElement | null = null;
  /** focused before this screen opened */
  returnTo: HTMLElement | null = null;

  constructor(readonly root: HTMLElement, readonly opts: ScreenOpts = {}) {
    root.addEventListener('pointerover', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(FOCUSABLE);
      if (el && root.contains(el) && visible(el) && el !== this.cur) this.focus(el, false);
    });
    root.addEventListener('pointerdown', (e) => setKind((e as PointerEvent).pointerType === 'touch' ? 'touch' : 'mouse'));
  }

  /** the visible focusables, in document order */
  items(): HTMLElement[] { return [...this.root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible); }

  focus(el: HTMLElement | null, scroll = true): void {
    this.cur?.classList.remove('nav-focus');
    this.cur = el;
    if (!el) return;
    el.classList.add('nav-focus');
    el.focus({ preventScroll: true });
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }

  get focused(): HTMLElement | null {
    // follow real focus (a click, a script) when it sits on one of this screen's items
    const a = document.activeElement;
    if (a instanceof HTMLElement && a !== this.cur && this.root.contains(a) && a.matches(FOCUSABLE) && visible(a)) this.focus(a, false);
    if (this.cur && !visible(this.cur)) this.focus(null);
    return this.cur;
  }

  focusPrimary(): void {
    const p = this.opts.primary?.() ?? null;
    this.focus(p && visible(p) ? p : this.items()[0] ?? null);
  }

  /** After the screen's contents changed: keep focus if it is still visible, else go to the primary. */
  refresh(): void { if (!this.focused) this.focusPrimary(); }

  /** Tab order step (wraps). */
  private step(d: number): void {
    const items = this.items();
    if (!items.length) return;
    const i = this.focused ? items.indexOf(this.focused) : -1;
    this.focus(items[(i + d + items.length) % items.length]);
  }

  /** The nearest focusable in a direction: distance along the axis plus twice the distance across it. */
  private move(dir: 'up' | 'down' | 'left' | 'right'): void {
    const from = this.focused;
    if (!from) { this.focusPrimary(); return; }
    const a = from.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best: HTMLElement | null = null, bestScore = Infinity;
    for (const el of this.items()) {
      if (el === from) continue;
      const b = el.getBoundingClientRect();
      const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
      const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
      const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      if (along <= 1) continue;
      const score = along + 2 * across;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) this.focus(best);
  }

  /** Change a select or range by one option or step; true when the focused item took it. */
  private adjust(d: number): boolean {
    const el = this.focused;
    if (el instanceof HTMLSelectElement) {
      const n = el.options.length;
      if (!n) return true;
      el.selectedIndex = Math.max(0, Math.min(n - 1, el.selectedIndex + d));
    } else if (el instanceof HTMLInputElement && el.type === 'range') {
      if (d > 0) el.stepUp(); else el.stepDown();
    } else return false;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /** Run one intent; true when it was used. */
  handle(i: NavIntent, down = true): boolean {
    if (this.opts.onIntent?.(i, down)) return true;
    if (!down) return false;
    switch (i) {
      case 'up': case 'down': this.move(i); return true;
      case 'left': case 'right': if (!this.adjust(i === 'left' ? -1 : 1)) this.move(i); return true;
      case 'next': this.step(1); return true;
      case 'prev': this.step(-1); return true;
      case 'select': {
        const el = this.focused;
        if (!el) { this.focusPrimary(); return true; }
        if (el instanceof HTMLSelectElement) { const n = el.options.length; if (n) { el.selectedIndex = (el.selectedIndex + 1) % n; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } }
        else if (el instanceof HTMLInputElement && el.type === 'range') { /* left / right change it */ }
        else el.click();
        return true;
      }
      case 'back': if (this.opts.onBack) { this.opts.onBack(); return true; } return false;
      default: return false;
    }
  }
}

// ---------------------------------------------------------------- the stack and its inputs
const stack: Screen[] = [];
let suspended = false;
let kind: InputKind = 'mouse';
/** key codes whose keydown a screen used: their keyup is swallowed too */
const swallowed = new Set<string>();

function setKind(k: InputKind): void {
  if (k === kind) return;
  kind = k;
  for (const s of stack) s.opts.onInputKind?.(k);
}
/** The input kind used last (hint bars show keys or pad buttons from it). */
export function lastInputKind(): InputKind { return kind; }

/** Pause all menu input (a Settings key slot waiting for a key press). */
export function setNavSuspended(on: boolean): void { suspended = on; }

const top = (): Screen | null => stack[stack.length - 1] ?? null;

function onKeyDown(e: KeyboardEvent): void {
  const s = top();
  if (!s || suspended) return;
  const i = intentForKey(e.code, e.shiftKey);
  if (!i) return;
  const t = e.target as Element | null;
  // typing: a text field keeps its letters and caret keys; a select keeps letter type-ahead
  if (isText(t) && (LETTER_INTENTS.has(i) || i === 'left' || i === 'right' || (i === 'select' && e.code === 'Space'))) return;
  if (t instanceof HTMLSelectElement && LETTER_INTENTS.has(i)) return;
  if (!s.root.contains(document.activeElement) && document.activeElement !== document.body) s.refresh();
  setKind('keyboard');
  if (e.repeat && (i === 'select' || i === 'back' || LETTER_INTENTS.has(i))) { e.preventDefault(); e.stopPropagation(); return; }
  if (s.handle(i, true)) { e.preventDefault(); e.stopPropagation(); swallowed.add(e.code); }
}
function onKeyUp(e: KeyboardEvent): void {
  if (!swallowed.delete(e.code)) return;
  e.preventDefault(); e.stopPropagation();
  const s = top();
  const i = intentForKey(e.code, e.shiftKey);
  if (s && i) s.handle(i, false);
}
window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('keyup', onKeyUp, true);

// ---- gamepad: edges, with repeat on the D-pad and the left stick
const REPEAT_FIRST = 400, REPEAT_EVERY = 120, STICK = 0.5;
let raf = 0;
let prev: boolean[] = [];
const held: Partial<Record<NavIntent, number>> = {}; // intent -> next repeat time
const BUTTONS: [number, NavIntent][] = (Object.entries(MENU_PAD) as [NavIntent, keyof typeof PAD][])
  .filter(([i]) => i !== 'discipline') // X is reset first, then Snowboard / Skis (see below)
  .map(([i, b]) => [PAD[b], i]);
let padsBlocked = false;
function firstPad(): Gamepad | null {
  if (padsBlocked || !navigator.getGamepads) return null;
  let pads: ArrayLike<Gamepad | null>;
  try { pads = navigator.getGamepads(); } catch { padsBlocked = true; return null; }
  for (let i = 0; i < pads.length; i++) { const p = pads[i]; if (p && p.connected && p.mapping === 'standard') return p; }
  return null;
}

function poll(now: number): void {
  raf = stack.length ? requestAnimationFrame(poll) : 0;
  const s = top();
  const gp = firstPad();
  if (!s || !gp) { prev = []; return; }
  const pressed = gp.buttons.map((b) => b.pressed);
  const stickX = gp.axes[0] ?? 0, stickY = gp.axes[1] ?? 0;
  const dirOn: Partial<Record<NavIntent, boolean>> = {
    up: pressed[PAD.UP] || stickY < -STICK, down: pressed[PAD.DOWN] || stickY > STICK,
    left: pressed[PAD.LEFT] || stickX < -STICK, right: pressed[PAD.RIGHT] || stickX > STICK,
  };
  if (suspended) { prev = pressed; return; }
  const fire = (i: NavIntent, down: boolean) => { setKind('pad'); if (!s.root.contains(document.activeElement)) s.refresh(); s.handle(i, down); };
  // direction intents repeat while held
  for (const d of ['up', 'down', 'left', 'right'] as NavIntent[]) {
    if (dirOn[d]) {
      if (held[d] === undefined) { held[d] = now + REPEAT_FIRST; fire(d, true); }
      else if (now >= held[d]!) { held[d] = now + REPEAT_EVERY; fire(d, true); }
    } else delete held[d];
  }
  for (const [b, i] of BUTTONS) {
    if (i === 'up' || i === 'down' || i === 'left' || i === 'right') continue;
    if (pressed[b] && !prev[b]) {
      if (i === 'reset') { setKind('pad'); if (!s.handle('reset', true)) s.handle('discipline', true); }
      else fire(i, true);
    } else if (!pressed[b] && prev[b]) s.handle(i, false);
  }
  prev = pressed;
}

/** Put a screen on top and focus its primary item. */
export function openScreen(s: Screen): void {
  if (stack.includes(s)) return;
  const a = document.activeElement;
  s.returnTo = a instanceof HTMLElement && a !== document.body ? a : null;
  stack.push(s);
  s.focusPrimary();
  // a pad button already down when the screen opens doesn't count as a press
  const gp = firstPad();
  prev = gp ? gp.buttons.map((b) => b.pressed) : [];
  if (!raf) raf = requestAnimationFrame(poll);
}

/** Take a screen off the stack and give focus back to what had it before. */
export function closeScreen(s: Screen): void {
  const i = stack.indexOf(s);
  if (i < 0) return;
  stack.splice(i, 1);
  s.focus(null);
  const r = s.returnTo;
  s.returnTo = null;
  const t = top();
  if (r && r.isConnected && visible(r)) { if (t) t.focus(r); else r.focus({ preventScroll: true }); }
  else t?.refresh();
  if (!stack.length && raf) { cancelAnimationFrame(raf); raf = 0; }
}
