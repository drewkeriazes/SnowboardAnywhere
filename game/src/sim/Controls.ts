import type { Input } from './Rider';

/**
 * Keyboard, gamepad (and basic touch) input. FEAT-124 layout: everything you do while riding sits
 * under the left hand on WASD and the keys around it; the arrows keep working as second bindings.
 *
 * Board: A / D steer, W tuck (front flip in the air), S brake (backflip in the air), hold and release
 * Space to jump (Space + W / S nollie / ollie), Shift squats on the snow and grabs in the air,
 * Q / Z nose / tail press, X skate. On foot: WASD walk, Shift sprint, Space jump / climb.
 * Everywhere: E interact (lift, skip, strap in or out when stopped away from lifts), hold G to look
 * behind, Alt or the right mouse button to free look, C camera, M map, P piste lines, N next track,
 * T time trial, hold R to restart, K replay, Backspace rewind, F boost in Outrun, ` free fly.
 *
 * Each action has up to two bindings (KeyboardEvent.code, or Mouse2 for the right button).
 */
export type KeyMap = Record<string, string[]>;

/** Gamepad (standard mapping) buttons */
const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
const DEAD = 0.18;
/** one-shot gamepad buttons and the action each one fires */
const PAD_ACTIONS: [number, string][] = [[PAD.Y, 'lift'], [PAD.UP, 'camera'], [PAD.RIGHT, 'map'], [PAD.LEFT, 'piste'], [PAD.DOWN, 'track'], [PAD.SELECT, 'replay'], [PAD.START, 'pause']];

export class Controls {
  readonly input: Input = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false, skate: false, lean: 0 };
  /** action -> up to two codes (remappable in Settings > Controls) */
  keymap: KeyMap = {};
  invertSteer = false;
  /** FEAT-111: ask before the page closes (Ctrl+W mid-ride); main turns it off while paused */
  guardLeave = true;
  private readonly listeners: [string, EventListener][] = [];
  private readonly docListeners: [string, EventListener][] = [];
  readonly keys = new Set<string>();
  private readonly pressed = new Set<string>(); // one-shot codes
  private readonly padPressed = new Set<string>(); // one-shot actions from the gamepad
  private padPrev: boolean[] = [];
  /** right stick (free look), -1..1, read by main as mouse movement */
  padLookX = 0; padLookY = 0;
  /** a gamepad is connected (for the hints) */
  padActive = false;
  touchSteer = 0;
  touchTuck = false;
  touchBrake = false;

  constructor(el: HTMLElement) {
    const kd = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT' || (e.target as HTMLElement | null)?.tagName === 'SELECT') return; // typing in a menu
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'AltLeft', 'AltRight', 'Backspace', 'Backquote'].includes(e.code)) e.preventDefault();
      // anyone who binds Ctrl: block the browser shortcuts a page can block while it is held
      if (e.ctrlKey && this.bound(e.code === 'ControlLeft' || e.code === 'ControlRight' ? '' : e.code)) e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault(); // else Alt focuses the browser menu bar
      if (this.is('jump', e.code)) this.input.jumpReleased = true;
    };
    const bl = () => this.keys.clear();
    // FEAT-124: the right mouse button is a binding too (free look)
    const md = (e: MouseEvent) => { if (e.button === 2) { this.keys.add('Mouse2'); this.pressed.add('Mouse2'); } };
    const mu = (e: MouseEvent) => { if (e.button === 2) this.keys.delete('Mouse2'); };
    const cm = (e: Event) => e.preventDefault();
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku); window.addEventListener('blur', bl);
    window.addEventListener('mousedown', md); window.addEventListener('mouseup', mu); el.addEventListener('contextmenu', cm);
    this.listeners.push(['keydown', kd as EventListener], ['keyup', ku as EventListener], ['blur', bl], ['mousedown', md as EventListener], ['mouseup', mu as EventListener]);
    // FEAT-111: Ctrl+W / Ctrl+N / Ctrl+T can't be blocked with preventDefault, so ask before leaving
    // mid-ride, and in real fullscreen ask the browser to hand those keys to the page (Keyboard Lock, Chromium)
    const unload = (e: BeforeUnloadEvent) => { if (!this.guardLeave) return; e.preventDefault(); e.returnValue = ''; };
    const fs = () => {
      const kb = (navigator as Navigator & { keyboard?: { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void } }).keyboard;
      if (document.fullscreenElement) kb?.lock?.(['KeyW', 'KeyN', 'KeyT', 'KeyS', 'KeyD', 'KeyR', 'KeyF']).catch(() => undefined);
      else kb?.unlock?.();
    };
    if (!navigator.webdriver) { window.addEventListener('beforeunload', unload); this.listeners.push(['beforeunload', unload as EventListener]); } // not under Playwright (tools reload pages)
    document.addEventListener('fullscreenchange', fs);
    this.docListeners.push(['fullscreenchange', fs]);
  }
  private touchJump = false;
  touchJumpDown(): void { this.touchJump = true; }
  touchJumpUp(): void { if (this.touchJump) { this.touchJump = false; this.input.jumpReleased = true; } }

  /** Is `code` one of `action`'s bindings? */
  is(action: string, code: string): boolean { return !!this.keymap[action]?.includes(code); }
  private bound(code: string): boolean { if (!code) return false; for (const a in this.keymap) if (this.keymap[a].includes(code)) return true; return false; }
  /** Is any binding of `action` held? */
  held(action: string): boolean { const b = this.keymap[action]; if (b) for (const c of b) if (this.keys.has(c)) return true; return false; }

  /** Consume a one-shot key press by code. */
  once(code: string): boolean {
    if (this.pressed.has(code)) { this.pressed.delete(code); return true; }
    return false;
  }
  /** Consume a one-shot press of a mapped action (keyboard or gamepad). */
  action(name: string): boolean {
    let hit = false;
    for (const c of this.keymap[name] ?? []) if (this.once(c)) hit = true;
    if (this.padPressed.delete(name)) hit = true;
    return hit;
  }

  /** Free look held (the mapped keys, either Alt, or the right stick). */
  get looking(): boolean { return this.held('look') || this.keys.has('AltLeft') || this.keys.has('AltRight') || Math.hypot(this.padLookX, this.padLookY) > DEAD; }

  /** Look behind held (G, or the right stick click). */
  get glancing(): boolean { return this.held('glance') || this.padGlance; }
  private padGlance = false;

  /** Remove the window listeners (quit to menu). */
  dispose(): void { for (const [t, f] of this.listeners) window.removeEventListener(t, f); for (const [t, f] of this.docListeners) document.removeEventListener(t, f); }

  update(): Input {
    let steer = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    let tuck = this.held('tuck'), brake = this.held('brake'), jump = this.held('jump');
    let crouch = this.held('grab'), squatOnly = this.held('squat'), skate = this.held('skate');
    let lean = (this.held('pressNose') ? 1 : 0) - (this.held('pressTail') ? 1 : 0);
    // ---- FEAT-124 gamepad (the standard mapping)
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = Array.from(pads ?? []).find((p) => p && p.connected && p.mapping === 'standard') ?? null;
    this.padActive = !!gp;
    this.padLookX = this.padLookY = 0; this.padGlance = false;
    if (gp) {
      const b = (i: number) => !!gp.buttons[i]?.pressed, v = (i: number) => gp.buttons[i]?.value ?? 0;
      const ax = (i: number) => { const a = gp.axes[i] ?? 0; return Math.abs(a) > DEAD ? a : 0; };
      if (ax(0)) steer = Math.max(-1, Math.min(1, steer + ax(0)));
      if (ax(1) < -0.5 || v(PAD.RT) > 0.3) tuck = true;
      if (ax(1) > 0.5 || v(PAD.LT) > 0.3) brake = true;
      if (b(PAD.A)) jump = true;
      if (!b(PAD.A) && this.padPrev[PAD.A]) this.input.jumpReleased = true;
      if (b(PAD.X)) crouch = true;
      if (b(PAD.B)) skate = true;
      lean += (b(PAD.RB) ? 1 : 0) - (b(PAD.LB) ? 1 : 0);
      this.padLookX = ax(2); this.padLookY = ax(3);
      this.padGlance = b(PAD.R3);
      for (const [i, a] of PAD_ACTIONS) if (b(i) && !this.padPrev[i]) { if (a === 'pause') this.pressed.add('Escape'); else this.padPressed.add(a); }
      this.padPrev = gp.buttons.map((x) => x.pressed);
    }
    if (this.invertSteer) steer = -steer;
    if (steer === 0) steer = this.touchSteer;
    this.input.steer = steer;
    this.input.tuck = tuck || this.touchTuck;
    this.input.brake = brake || this.touchBrake;
    this.input.jumpHeld = jump || this.touchJump;
    // FEAT-124: one "get small" key: the rider squats on the snow and grabs in the air (sprint on foot)
    this.input.grab = crouch;
    this.input.squat = crouch || squatOnly;
    this.input.skate = skate;
    // FEAT-112: while charging a jump, W/S lean forward (tail up, nollie) / back (nose up, ollie)
    // instead of tucking or braking; Q / Z hold a nose / tail press without jumping
    lean = Math.max(-1, Math.min(1, lean));
    if (this.input.jumpHeld && (this.input.tuck || this.input.brake)) {
      lean = (this.input.tuck ? 1 : 0) - (this.input.brake ? 1 : 0);
      this.input.tuck = false; this.input.brake = false;
    }
    this.input.lean = lean;
    return this.input;
  }

  endFrame(): void {
    this.pressed.clear();
    this.padPressed.clear();
  }
}
