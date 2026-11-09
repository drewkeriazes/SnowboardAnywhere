/**
 * FEAT-137: one place that knows which controller is in use and reads it. Every reader (the ride
 * controls, the menu navigation, the settings' button rebinding) asks `activePad()` for one snapshot in
 * the standard-mapping button order, whichever source it came from:
 *  - the Gamepad API with the standard mapping (Chrome and Edge map a DualSense this way),
 *  - the Gamepad API with no mapping for a Sony pad (Firefox's raw order), remapped here,
 *  - the DualSense over WebHID once "Connect DualSense extras" is on (sim/DualSense.ts). While it is live
 *    the Gamepad API's copy of that controller is skipped so presses don't double up.
 */

/** Standard-mapping button indices. The DualSense names: Cross, Circle, Square, Triangle, L1, R1, L2, R2, Create, Options, L3, R3, D-pad, PS, touchpad click. */
export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16, TOUCH: 17 } as const;
export const PAD_BUTTONS = 18;

export type PadKind = 'ps' | 'xbox' | 'generic';
export interface PadButton { pressed: boolean; value: number }
export interface PadState {
  id: string;
  kind: PadKind;
  buttons: readonly PadButton[];
  axes: readonly number[];
  source: 'gamepad' | 'hid';
  /** the Gamepad API object (for its vibrationActuator), null for the HID source */
  gp: Gamepad | null;
}

/** Sony: vendor 054c. DualSense 0ce6, DualSense Edge 0df2 (DualShock 4 05c4 / 09cc get the same labels). */
export function padKind(id: string): PadKind {
  const s = id.toLowerCase();
  // Xbox first: a Series X/S pad over Bluetooth is "Xbox Wireless Controller (... Vendor: 045e ...)", which the
  // PlayStation "wireless controller" name would also match
  if (/xbox|xinput|045e/.test(s)) return 'xbox';
  if (/054c/.test(s) || /dualsense|dualshock|wireless controller|playstation/.test(s)) return 'ps';
  return 'generic';
}
export function isDualSense(id: string): boolean { const s = id.toLowerCase(); return /054c/.test(s) && /0ce6|0df2/.test(s) || /dualsense/.test(s); }

/** Button names per kind, for text (settings titles, the debug overlay). The glyphs are in ui/PadGlyphs.ts. */
const NAMES: Record<PadKind, string[]> = {
  ps: ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'PS', 'Touchpad'],
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Select', 'Start', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Guide', 'Button 17'],
  generic: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Select', 'Start', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home', 'Button 17'],
};
export function padButtonName(kind: PadKind, b: number): string { return NAMES[kind][b] ?? `Button ${b}`; }

/**
 * Default controller buttons per action (two slots each, remappable in Settings > Controls like the keys).
 * The left stick always steers and leans (up / down tuck and brake), the right stick looks, and
 * Options / Start and PS / Home always pause, so a bad rebind can't lock anyone out of the menu.
 */
export const DEFAULT_PAD: Record<string, number[]> = {
  jump: [PAD.A], grab: [PAD.X], squat: [], pressNose: [PAD.RB], pressTail: [PAD.LB], skate: [PAD.B], tuck: [PAD.RT], brake: [PAD.LT],
  lift: [PAD.Y], board: [], glance: [PAD.R3],
  camera: [PAD.UP], map: [PAD.RIGHT, PAD.TOUCH], piste: [PAD.LEFT], track: [PAD.DOWN], trial: [], restart: [], replay: [PAD.SELECT], rewind: [], fly: [],
  boost: [PAD.L3],
};
/** buttons that always pause (not rebindable) */
export const PAUSE_BUTTONS: readonly number[] = [PAD.START, PAD.HOME];

/** A saved controller map with any action it lacks filled from the defaults. */
export function migratePadKeys(raw: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const a in DEFAULT_PAD) out[a] = [...DEFAULT_PAD[a]];
  if (!raw || typeof raw !== 'object') return out;
  for (const [a, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[a] = v.filter((b) => Number.isInteger(b) && b >= 0 && b < PAD_BUTTONS && !PAUSE_BUTTONS.includes(b)).slice(0, 2);
  }
  return out;
}

// ---------------------------------------------------------------- sources
/** The live WebHID DualSense, if any (registered by sim/DualSense.ts so this module has no WebHID code). */
export interface HidPadSource { readonly live: boolean; readonly state: PadState }
let hidSource: HidPadSource | null = null;
export function setHidSource(s: HidPadSource | null): void { hidSource = s; }

/**
 * FEAT-138: the connected gamepads, or null. Firefox (and Chrome as it phases it in) only exposes the Gamepad
 * API in a secure context (https or localhost); over plain http on the home network getGamepads is missing or throws, so the
 * game plays on keyboard instead of failing every frame. After the first throw it stops asking.
 */
let padsBlocked = false;
export function readPads(): ArrayLike<Gamepad | null> | null {
  if (padsBlocked || typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  try { return navigator.getGamepads(); } catch { padsBlocked = true; return null; }
}

const kinds = new Map<string, PadKind>();
const kindOf = (id: string): PadKind => { let k = kinds.get(id); if (!k) { k = padKind(id); kinds.set(id, k); } return k; };

/** reused snapshots (no per-frame allocation) */
const std: { -readonly [K in keyof PadState]: PadState[K] } = { id: '', kind: 'generic', buttons: [], axes: [], source: 'gamepad', gp: null };
const remapButtons: PadButton[] = Array.from({ length: PAD_BUTTONS }, () => ({ pressed: false, value: 0 }));
const remapAxes = [0, 0, 0, 0];
const remapped: { -readonly [K in keyof PadState]: PadState[K] } = { id: '', kind: 'ps', buttons: remapButtons, axes: remapAxes, source: 'gamepad', gp: null };

/**
 * A Sony pad with no standard mapping (Firefox on Windows reports the raw DirectInput order: Square, Cross,
 * Circle, Triangle, L1, R1, L2, R2, Create, Options, L3, R3, PS, touchpad; axes LX, LY, RX, L2, R2, RY, and
 * the D-pad as a hat on axis 9). Best effort: `?debug=pad` shows the raw order to check it against.
 */
function remapSony(gp: Gamepad): PadState {
  const raw = gp.buttons, ax = gp.axes;
  const set = (i: number, pressed: boolean, value = pressed ? 1 : 0) => { remapButtons[i].pressed = pressed; remapButtons[i].value = value; };
  const rb = (i: number) => !!raw[i]?.pressed;
  set(PAD.A, rb(1)); set(PAD.B, rb(2)); set(PAD.X, rb(0)); set(PAD.Y, rb(3));
  set(PAD.LB, rb(4)); set(PAD.RB, rb(5));
  const trig = (axis: number, btn: number) => { const v = ax[axis] !== undefined ? (ax[axis] + 1) / 2 : rb(btn) ? 1 : 0; return Math.max(0, Math.min(1, v)); };
  const l2 = trig(3, 6), r2 = trig(4, 7);
  set(PAD.LT, l2 > 0.12, l2); set(PAD.RT, r2 > 0.12, r2);
  set(PAD.SELECT, rb(8)); set(PAD.START, rb(9)); set(PAD.L3, rb(10)); set(PAD.R3, rb(11)); set(PAD.HOME, rb(12)); set(PAD.TOUCH, rb(13));
  // hat: -1 (up) in 8 steps of 2/7 clockwise; anything past 1 is centred
  const h = ax[9];
  let up = false, down = false, left = false, right = false;
  if (h !== undefined && h >= -1.01 && h <= 1.01) {
    const d = Math.round((h + 1) * 3.5) % 8; // 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW
    up = d === 7 || d === 0 || d === 1; right = d >= 1 && d <= 3; down = d >= 3 && d <= 5; left = d >= 5 && d <= 7;
  }
  set(PAD.UP, up); set(PAD.DOWN, down); set(PAD.LEFT, left); set(PAD.RIGHT, right);
  remapAxes[0] = ax[0] ?? 0; remapAxes[1] = ax[1] ?? 0; remapAxes[2] = ax[2] ?? 0; remapAxes[3] = ax[5] ?? 0;
  remapped.id = gp.id; remapped.gp = gp;
  return remapped;
}

/** The kind of the last controller seen (for labels while none is connected). */
export let lastPadKind: PadKind | null = null;

/** The controller to read this frame, or null (keyboard). */
export function activePad(): PadState | null {
  if (hidSource?.live) { lastPadKind = 'ps'; return hidSource.state; }
  const pads = readPads();
  if (!pads) return null;
  let fallback: Gamepad | null = null;
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (!p || !p.connected) continue;
    if (p.mapping === 'standard') {
      std.id = p.id; std.kind = kindOf(p.id); std.buttons = p.buttons; std.axes = p.axes; std.gp = p;
      lastPadKind = std.kind;
      return std;
    }
    if (!fallback && kindOf(p.id) === 'ps') fallback = p;
  }
  if (fallback) { lastPadKind = 'ps'; return remapSony(fallback); }
  return null;
}

/**
 * shared UI state: a settings slot is waiting for a controller button (the menu navigation stands aside), and
 * whether the controller (not the keyboard or mouse) was used last, so the hints follow the hands
 */
export const padUi = { listening: false, lastWasPad: true };
/** any button down or a stick pushed past half way */
export function padTouched(p: PadState): boolean {
  for (let i = 0; i < p.buttons.length; i++) if (p.buttons[i].pressed) return true;
  for (let i = 0; i < p.axes.length; i++) if (Math.abs(p.axes[i]) > 0.5) return true;
  return false;
}
