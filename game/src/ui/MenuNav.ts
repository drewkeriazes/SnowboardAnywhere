import { intentForKey, LETTER_INTENTS, type NavIntent } from './MenuKeys';
import { padUi } from '../sim/Pad';

/**
 * FEAT-128: one focus manager for every menu. Open screens form a stack and only the top one takes
 * input: the keyboard through one capture-phase listener (a handled key never reaches `Controls`, which
 * is what keeps Esc from toggling pause twice), the controller through `PadNav.ts` (FEAT-137's loop,
 * which hands its presses here with `padIntent` while a screen is open), the mouse and touch through
 * hover and click.
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
  /** the focus moved (a detail panel follows it) */
  onFocus?: (el: HTMLElement | null) => void;
}

/** what takes focus; `data-nav="skip"` marks a control inside a focusable row (a segment, a slider), which the row drives */
const FOCUSABLE = ['button', 'select', 'input', '[data-nav]'].map((s) => `${s}:not([data-nav=skip])`).join(', ');
/** what the controller can't operate: keyboard rebind slots wait for a key, colour pickers need the mouse (as FEAT-137's PadNav) */
const PAD_SKIP = '.keys button.key, input[type=color], [data-pad-skip]';
const visible = (el: HTMLElement): boolean => el.isConnected && el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled && el.dataset.nav !== 'skip' && !el.closest('.miss, .gone');
const isText = (el: Element | null): boolean => el instanceof HTMLInputElement && ['text', 'search', 'email', 'number', 'password'].includes(el.type);

export class Screen {
  private cur: HTMLElement | null = null;
  /** focused before this screen opened */
  returnTo: HTMLElement | null = null;

  constructor(readonly root: HTMLElement, readonly opts: ScreenOpts = {}) {
    // hover focuses only when the pointer really moves: content scrolling under a resting mouse
    // (the panel follows the keyboard or controller focus) must not steal the focus
    root.addEventListener('pointermove', (e) => {
      if (Math.abs(e.movementX) + Math.abs(e.movementY) < 1) return;
      if (top() !== this) return; // a screen under another (pause under its Mode screen) leaves the hover to the top one
      const el = (e.target as HTMLElement).closest<HTMLElement>(FOCUSABLE);
      if (el && root.contains(el) && visible(el) && el !== this.cur) this.focus(el, false);
    });
    root.addEventListener('pointerdown', (e) => setKind((e as PointerEvent).pointerType === 'touch' ? 'touch' : 'mouse'));
  }

  /** the visible focusables, in document order; on the controller, not the keyboard key slots or colour pickers (a controller can't use them) */
  items(): HTMLElement[] {
    const pad = kind === 'pad';
    return [...this.root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => visible(el) && !(pad && el.matches(PAD_SKIP)));
  }

  focus(el: HTMLElement | null, scroll = true): void {
    this.cur?.classList.remove('nav-focus');
    this.cur = el;
    if (el) {
      el.classList.add('nav-focus');
      el.focus({ preventScroll: true });
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    }
    this.opts.onFocus?.(el);
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
/** PadNav (FEAT-137) saw the controller come into use or go out of it: the hints follow at once, before any menu press. */
export function notePadInUse(on: boolean): void { if (on) setKind('pad'); else if (kind === 'pad') setKind('keyboard'); }
/** The input kind used last (hint bars show keys or pad buttons from it). */
export function lastInputKind(): InputKind { return kind; }

/** Pause all menu input (a Settings key slot waiting for a key press). */
export function setNavSuspended(on: boolean): void { suspended = on; }

const top = (): Screen | null => stack[stack.length - 1] ?? null;

function onKeyDown(e: KeyboardEvent): void {
  const s = top();
  if (!s || suspended || padUi.listening) return; // a key or controller slot waiting for a press owns the keys (Esc cancels it)
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

/** A menu screen is open (PadNav then hands its presses to `padIntent` instead of moving focus itself). */
export function hasScreen(): boolean { return stack.length > 0; }

/**
 * A controller press for the top screen (from PadNav, with its own repeat on the D-pad and stick).
 * X is Reset section where a screen has one, else Snowboard / Skis. True when a screen took it.
 */
export function padIntent(i: NavIntent, down = true): boolean {
  const s = top();
  if (!s || suspended || padUi.listening) return false;
  setKind('pad');
  if (!s.root.contains(document.activeElement) || !s.focused) s.refresh();
  if (i === 'reset') return s.handle('reset', down) || s.handle('discipline', down);
  return s.handle(i, down);
}

/** Put a screen on top and focus its primary item. */
export function openScreen(s: Screen): void {
  if (stack.includes(s)) return;
  const a = document.activeElement;
  s.returnTo = a instanceof HTMLElement && a !== document.body ? a : null;
  stack.push(s);
  s.focusPrimary();
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
  if (!stack.length) suspended = false; // nothing can be waiting for a key once every menu is closed
}
