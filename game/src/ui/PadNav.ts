import { PAD, activePad, padButtonName, padTouched, padUi, type PadKind } from '../sim/Pad';
import { dualSense } from '../sim/DualSense';
import { padGlyph } from './PadGlyphs';

/**
 * FEAT-137: drive the menus with a controller. While the main menu, the pause menu or the Outrun card is
 * on screen: D-pad or left stick moves the focus (spatially, to the nearest control that way), Cross / A
 * presses it, left / right change a slider or a list, Circle / B backs out of an open settings panel (or
 * resumes from pause), L1 / R1 switch the settings tabs. It runs its own frame loop so it also works on
 * the main menu, before a session exists. It also keeps `body.pad-on` (and `pad-ps` / `pad-xbox`) in
 * step with the controller in use, and with `?debug=pad` shows what every connected controller reports.
 */
const ROOTS = ['#outrun-card', '#pause', '#menu'];
const FOCUSABLE = 'button, select, input:not([type=color]), a[href]';
const REPEAT_DELAY = 0.35, REPEAT_RATE = 0.11;

let started = false;
const debugOn = typeof location !== 'undefined' && new URLSearchParams(location.search).get('debug') === 'pad';
let kindShown: PadKind | null = null;
const prev: boolean[] = [];
let focused: HTMLElement | null = null;
let rootShown: HTMLElement | null = null;
let held: { dir: string; t: number } | null = null;

const visible = (el: Element): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest('.hidden')) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  const st = getComputedStyle(el);
  return st.display !== 'none' && st.visibility !== 'hidden' && el.getClientRects().length > 0;
};
const openRoot = (): HTMLElement | null => {
  for (const s of ROOTS) { const el = document.querySelector<HTMLElement>(s); if (el && visible(el)) return el; }
  return null;
};
/** keyboard rebind slots are left out: they wait for a key, which a controller cannot press */
const focusables = (root: HTMLElement): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => visible(el) && !el.matches('.keys button.key'));

function setFocus(el: HTMLElement | null): void {
  focused?.classList.remove('padfocus');
  focused = el;
  if (!el) return;
  el.classList.add('padfocus');
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
}

/** The nearest control in a direction: along the axis first, sideways offset counts double. */
function move(root: HTMLElement, dx: number, dy: number): void {
  const list = focusables(root);
  if (!focused || !list.includes(focused)) { setFocus(list.find((e) => e.classList.contains('primary')) ?? list[0] ?? null); return; }
  const a = focused.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const el of list) {
    if (el === focused) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    const along = (bx - ax) * dx + (by - ay) * dy;
    if (along <= 2) continue;
    // sideways: the gap between the boxes across the move (0 when they overlap)
    const side = dx !== 0 ? Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)) : Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
    const score = along + 2 * side + (dx !== 0 && side > 0 ? 400 : 0);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) setFocus(best);
}

const fire = (el: HTMLElement, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
/** Left / right on a slider or a list changes it; true when it did. */
function adjust(el: HTMLElement, d: number): boolean {
  if (el instanceof HTMLInputElement && el.type === 'range') {
    const step = Number(el.step) || 1, min = Number(el.min), max = Number(el.max);
    const v = Math.max(min, Math.min(max, Number(el.value) + d * step));
    if (v !== Number(el.value)) { el.value = String(v); fire(el, 'input'); fire(el, 'change'); }
    return true;
  }
  if (el instanceof HTMLSelectElement) {
    const i = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + d));
    if (i !== el.selectedIndex) { el.selectedIndex = i; fire(el, 'input'); fire(el, 'change'); }
    return true;
  }
  return false;
}

function back(root: HTMLElement): void {
  // an open settings panel closes back to the button that opened it
  const panel = focused?.closest<HTMLElement>('.settings');
  if (panel && root.contains(panel) && visible(panel)) {
    const opener = panel.previousElementSibling;
    if (opener instanceof HTMLButtonElement) { opener.click(); setFocus(opener); return; }
  }
  root.querySelector<HTMLElement>('[data-pad-back]')?.click();
}

function tab(root: HTMLElement, d: number): void {
  const panel = focused?.closest<HTMLElement>('.settings') ?? root.querySelector<HTMLElement>('.settings:not(.hidden)');
  const tabs = panel ? Array.from(panel.querySelectorAll<HTMLButtonElement>('.tabs button')) : [];
  if (!tabs.length) return;
  const i = Math.max(0, tabs.findIndex((b) => b.classList.contains('on')));
  const next = tabs[(i + d + tabs.length) % tabs.length];
  next.click(); setFocus(next);
}

/** Hint lines in static menus (`.pad-hint` elements) follow the controller kind. */
export function menuPadHint(kind: PadKind): string {
  return `${padGlyph(kind, PAD.UP)}${padGlyph(kind, PAD.DOWN)} move &middot; ${padGlyph(kind, PAD.A)} select &middot; ${padGlyph(kind, PAD.B)} back &middot; ${padGlyph(kind, PAD.LB)} ${padGlyph(kind, PAD.RB)} settings tabs`;
}

let debugEl: HTMLDivElement | null = null;
function debug(): void {
  if (!debugEl) {
    debugEl = document.createElement('div');
    Object.assign(debugEl.style, { position: 'fixed', left: '8px', bottom: '8px', zIndex: '99', background: 'rgba(0,0,0,.78)', color: '#e5e7eb', font: '11px ui-monospace, monospace', padding: '8px 10px', borderRadius: '8px', whiteSpace: 'pre', pointerEvents: 'none', maxWidth: '95vw', overflow: 'hidden' });
    document.body.appendChild(debugEl);
  }
  const lines: string[] = [];
  let pads: (Gamepad | null)[] = [];
  try { pads = Array.from(navigator.getGamepads?.() ?? []); } catch { lines.push('getGamepads blocked (not a secure context?)'); }
  for (const p of pads) {
    if (!p) continue;
    const on = p.buttons.map((b, i) => (b.pressed || b.value > 0.05 ? `${i}${b.value > 0 && b.value < 1 ? `=${b.value.toFixed(2)}` : ''}` : '')).filter(Boolean).join(' ');
    lines.push(`[${p.index}] ${p.id}\n    mapping '${p.mapping}' · ${p.buttons.length} buttons · ${p.axes.length} axes · rumble ${(p as Gamepad & { vibrationActuator?: unknown }).vibrationActuator ? 'yes' : 'no'}\n    pressed: ${on || '-'}\n    axes: ${p.axes.map((a) => a.toFixed(2)).join(' ')}`);
  }
  if (!lines.length) lines.push('no gamepad seen yet (press a button)');
  lines.push(`WebHID: ${dualSense.connected ? `${dualSense.bt ? 'Bluetooth' : 'USB'}, ${dualSense.live ? 'live' : 'silent'}, ${dualSense.reports} reports, battery ${dualSense.battery}%` : 'not connected'}`);
  if (dualSense.connected) {
    const g = dualSense.gyro, t = dualSense.touch;
    lines.push(`    gyro ${g.map((v) => v.toFixed(0).padStart(5)).join(' ')} deg/s · touch ${t.active ? `${t.x}, ${t.y}` : 'none'}`);
  }
  const a = activePad();
  if (a) lines.push(`reading: ${a.source} · ${a.kind} · pressed ${a.buttons.map((b, i) => (b.pressed ? padButtonName(a.kind, i) : '')).filter(Boolean).join(', ') || '-'}`);
  debugEl.textContent = lines.join('\n');
}

function frame(t: number, last: number): void {
  const dt = Math.min(0.1, (t - last) / 1000);
  const pad = activePad();
  if (pad && padTouched(pad)) padUi.lastWasPad = true;
  // body classes for the hints: the controller's kind while it was used last
  const kind = pad && padUi.lastWasPad ? pad.kind : null;
  if (kind !== kindShown) {
    kindShown = kind;
    document.body.classList.toggle('pad-on', !!kind);
    document.body.classList.toggle('pad-ps', kind === 'ps');
    document.body.classList.toggle('pad-xbox', !!kind && kind !== 'ps');
    if (kind) document.querySelectorAll<HTMLElement>('.pad-hint').forEach((el) => { el.innerHTML = menuPadHint(kind); });
  }
  if (debugOn) debug();
  const root = openRoot();
  if (root !== rootShown) {
    rootShown = root; held = null;
    if (focused && (!root || !root.contains(focused))) setFocus(null);
    if (pad && root && !focused) move(root, 0, 0); // a menu opened: start on its main button
  }
  if (pad && root && !padUi.listening) {
    if (kind) root.querySelectorAll<HTMLElement>('.pad-hint').forEach((el) => { if (!el.dataset.k || el.dataset.k !== kind) { el.dataset.k = kind; el.innerHTML = menuPadHint(kind); } });
    const b = (i: number) => !!pad.buttons[i]?.pressed;
    const edge = (i: number) => b(i) && !prev[i];
    const ax = pad.axes;
    const dir = b(PAD.UP) || (ax[1] ?? 0) < -0.6 ? 'up' : b(PAD.DOWN) || (ax[1] ?? 0) > 0.6 ? 'down' : b(PAD.LEFT) || (ax[0] ?? 0) < -0.6 ? 'left' : b(PAD.RIGHT) || (ax[0] ?? 0) > 0.6 ? 'right' : '';
    let step = '';
    if (dir) {
      if (!held || held.dir !== dir) { held = { dir, t: -REPEAT_DELAY }; step = dir; }
      else { held.t += dt; if (held.t >= REPEAT_RATE) { held.t = 0; step = dir; } }
    } else held = null;
    if (!focused || !root.contains(focused) || !visible(focused)) { if (step || edge(PAD.A)) { move(root, 0, 0); step = ''; } }
    else if (step) {
      if ((step === 'left' || step === 'right') && adjust(focused, step === 'left' ? -1 : 1)) { /* changed the value */ }
      else move(root, step === 'left' ? -1 : step === 'right' ? 1 : 0, step === 'up' ? -1 : step === 'down' ? 1 : 0);
    }
    if (focused && edge(PAD.A)) {
      if (focused instanceof HTMLSelectElement) adjust(focused, focused.selectedIndex >= focused.options.length - 1 ? -focused.selectedIndex : 1);
      else focused.click();
    }
    if (edge(PAD.B)) back(root);
    if (edge(PAD.LB)) tab(root, -1);
    if (edge(PAD.RB)) tab(root, 1);
  }
  if (pad) for (let i = 0; i < pad.buttons.length; i++) prev[i] = pad.buttons[i].pressed;
  requestAnimationFrame((n) => frame(n, t));
}

/** Start once at boot (the loop lives for the page). */
export function startPadNav(): void {
  if (started || typeof requestAnimationFrame === 'undefined') return;
  started = true;
  void dualSense.reconnect();
  const kb = () => { padUi.lastWasPad = false; };
  window.addEventListener('keydown', kb, true); window.addEventListener('mousedown', kb, true);
  requestAnimationFrame((t) => frame(t, t));
}
