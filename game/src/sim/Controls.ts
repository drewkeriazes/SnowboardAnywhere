import type { Input } from './Rider';
import { DEFAULT_PAD, PAD, PAUSE_BUTTONS, activePad, padTouched, padUi, type PadKind, type PadState } from './Pad';
import { dualSense } from './DualSense';

/**
 * Keyboard, gamepad (and basic touch) input. FEAT-124 layout: everything you do while riding sits
 * under the left hand on WASD and the keys around it; the arrows keep working as second bindings.
 *
 * Board: A / D steer, W tuck (front flip in the air), S brake (backflip in the air), hold and release
 * Space to jump (Space + W / S nollie / ollie), Shift squats on the snow and grabs in the air,
 * Q / Z nose / tail press (W / S balance it, FEAT-140), X skate. On foot: WASD walk, Shift sprint, Space jump / climb.
 * Everywhere: E interact (lift, skip, strap in or out when stopped away from lifts), hold G to look
 * behind, Alt or the right mouse button to free look, C camera, M map, P piste lines, N next track,
 * T time trial, hold R to restart, K replay, Backspace rewind, F boost in Outrun, ` free fly.
 *
 * Each action has up to two bindings (KeyboardEvent.code, or Mouse2 for the right button).
 */
export type KeyMap = Record<string, string[]>;

/** FEAT-137: controller settings (Settings > Controls > Controller) */
export interface PadConfig {
  /** stick dead zone 0..1 */
  dead: number;
  /** trigger travel (0..1) before R2 / L2 count as held */
  trigDead: number;
  /** right stick look rate multiplier, and its Y inverted */
  lookSens: number; invertY: boolean;
  /** DualSense extras: tilt to look, and its rate multiplier */
  gyro: boolean; gyroSens: number;
}
/** gyro look: the turn in px of mouse movement per radian (the cameras turn about 0.003 rad per px) */
const GYRO_PX_PER_RAD = 1 / 0.003;
/** gyro: degrees a second below which it is noise, and the touchpad swipe (of 1920 across) that cycles the camera */
const GYRO_DEAD = 1.5, SWIPE = 550, SWIPE_S = 0.6;

/** FEAT-248: a same-tab navigation the player asked for (the release toast's Ride) leaves without the leave prompt */
let leavingOnPurpose = false;
export function leaveTo(href: string): void { leavingOnPurpose = true; location.href = href; }

export class Controls {
  readonly input: Input = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false, skate: false, lean: 0, balance: 0 };
  /** FEAT-140: main sets this while a press would be balanced (on the board, on the snow, Press balance not Off):
   *  with a press key held, W / S and the left stick up / down then balance the press instead of tucking and braking */
  balancing = false;
  /** action -> up to two codes (remappable in Settings > Controls) */
  keymap: KeyMap = {};
  invertSteer = false;
  /** FEAT-111: ask before the page closes (Ctrl+W mid-ride); main turns it off while paused */
  guardLeave = true;
  private readonly listeners: [string, EventListener][] = [];
  private readonly docListeners: [string, EventListener][] = [];
  readonly keys = new Set<string>();
  private readonly pressed = new Set<string>(); // one-shot codes
  private readonly padPressed = new Set<string>(); // one-shot actions from the controller (touchpad swipe)
  /** FEAT-137: action -> up to two controller buttons (remappable in Settings > Controls) */
  padKeys: Record<string, number[]> = { ...DEFAULT_PAD };
  padCfg: PadConfig = { dead: 0.18, trigDead: 0.3, lookSens: 1, invertY: false, gyro: false, gyroSens: 1 };
  /** the controller read this frame (null on keyboard) */
  pad: PadState | null = null;
  /** controller buttons down this frame (triggers past their dead zone, muted ones not), and last frame */
  private readonly padDown: boolean[] = [];
  private readonly padPrev: boolean[] = [];
  /** buttons ignored until let go (held through a menu press, so Cross on Resume does not jump) */
  private readonly padMuted = new Set<number>();
  /** one-shot actions already taken from the controller this frame */
  private readonly padUsed = new Set<string>();
  private padJumpPrev = false;
  /** right stick (free look) -1..1 times the look rate, and the gyro turn this frame (px of mouse movement), read by main */
  padLookX = 0; padLookY = 0; gyroDx = 0; gyroDy = 0;
  private readonly gyroBias = [0, 0, 0];
  private readonly gyroRate = [0, 0, 0];
  private gyroT = 0;
  private swipe: { x0: number; t: number } | null = null;
  /** a controller is connected, and what kind */
  padActive = false;
  /** FEAT-137: a controller is connected and was used more recently than the keyboard or mouse (the hints show its buttons) */
  get usingPad(): boolean { return this.padActive && padUi.lastWasPad; }
  padKind: PadKind = 'xbox';
  touchSteer = 0;
  touchTuck = false;
  touchBrake = false;

  constructor(el: HTMLElement) {
    const kd = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT' || (e.target as HTMLElement | null)?.tagName === 'SELECT') return; // typing in a menu
      this.keys.add(e.code);
      this.pressed.add(e.code);
      padUi.lastWasPad = false; // FEAT-137: the hints follow the keyboard again
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'AltLeft', 'AltRight', 'Backspace', 'Backquote'].includes(e.code)) e.preventDefault();
      // anyone who binds Ctrl: block the browser shortcuts a page can block while it is held
      // (only when Ctrl itself is bound to an action, so Ctrl+R etc. keep working for everyone else)
      if (e.ctrlKey && (this.bound('ControlLeft') || this.bound('ControlRight')) && this.bound(e.code === 'ControlLeft' || e.code === 'ControlRight' ? '' : e.code)) e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault(); // else Alt focuses the browser menu bar
      if (this.is('jump', e.code)) this.input.jumpReleased = true;
    };
    const bl = () => this.keys.clear();
    // FEAT-124: the right mouse button is a binding too (free look)
    const md = (e: MouseEvent) => { padUi.lastWasPad = false; if (e.button === 2) { this.keys.add('Mouse2'); this.pressed.add('Mouse2'); } };
    const mu = (e: MouseEvent) => { if (e.button === 2) this.keys.delete('Mouse2'); };
    const cm = (e: Event) => e.preventDefault();
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku); window.addEventListener('blur', bl);
    window.addEventListener('mousedown', md); window.addEventListener('mouseup', mu); el.addEventListener('contextmenu', cm);
    this.listeners.push(['keydown', kd as EventListener], ['keyup', ku as EventListener], ['blur', bl], ['mousedown', md as EventListener], ['mouseup', mu as EventListener]);
    // FEAT-111: Ctrl+W / Ctrl+N / Ctrl+T can't be blocked with preventDefault, so ask before leaving
    // mid-ride, and in real fullscreen ask the browser to hand those keys to the page (Keyboard Lock, Chromium)
    const unload = (e: BeforeUnloadEvent) => { if (!this.guardLeave || leavingOnPurpose) return; e.preventDefault(); e.returnValue = ''; };
    const fs = () => {
      const kb = (navigator as Navigator & { keyboard?: { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void } }).keyboard;
      if (document.fullscreenElement) kb?.lock?.(['KeyW', 'KeyN', 'KeyT', 'KeyS', 'KeyD', 'KeyR', 'KeyF']).catch(() => undefined);
      else kb?.unlock?.();
    };
    if (!navigator.webdriver) { window.addEventListener('beforeunload', unload); this.listeners.push(['beforeunload', unload as EventListener]); } // not under Playwright (tools reload pages)
    document.addEventListener('fullscreenchange', fs);
    this.docListeners.push(['fullscreenchange', fs]);
    this.padMute(); // the button that started the session (Cross on Free ride) is still down
  }
  private touchJump = false;
  touchJumpDown(): void { this.touchJump = true; }
  touchJumpUp(): void { if (this.touchJump) { this.touchJump = false; this.input.jumpReleased = true; } }

  /** Is `code` one of `action`'s bindings? */
  is(action: string, code: string): boolean { return !!this.keymap[action]?.includes(code); }
  private bound(code: string): boolean { if (!code) return false; for (const a in this.keymap) if (this.keymap[a].includes(code)) return true; return false; }
  /** Is any binding of `action` held (keys or controller buttons)? */
  held(action: string): boolean {
    const b = this.keymap[action]; if (b) for (const c of b) if (this.keys.has(c)) return true;
    return this.padKeyHeld(action);
  }
  private padKeyHeld(action: string): boolean { const p = this.padKeys[action]; if (p) for (const i of p) if (this.padDown[i]) return true; return false; }
  /** FEAT-137: a controller button went down this frame (raw, for the map and the replay viewer) */
  padOnce(i: number): boolean { return !!this.padDown[i] && !this.padPrev[i]; }
  /** a controller button is down */
  padHeld(i: number): boolean { return !!this.padDown[i]; }
  /** Ignore every controller button held now until it is let go (after a menu, the map, a drop in). */
  padMute(): void {
    const p = activePad();
    if (p) for (let i = 0; i < p.buttons.length; i++) if (p.buttons[i].pressed || p.buttons[i].value > 0.05) { this.padMuted.add(i); this.padDown[i] = false; }
  }

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
    if (!this.padUsed.has(name)) for (const i of this.padKeys[name] ?? []) if (this.padOnce(i)) { this.padUsed.add(name); hit = true; }
    return hit;
  }

  /** Free look held (the mapped keys, either Alt, the right stick, or the controller tilted just now). */
  get looking(): boolean { return this.held('look') || this.keys.has('AltLeft') || this.keys.has('AltRight') || this.padLookX !== 0 || this.padLookY !== 0 || this.gyroT > 0; }

  /** Look behind held (G, or its controller button: R3). */
  get glancing(): boolean { return this.held('glance'); }

  /** Remove the window listeners (quit to menu). */
  dispose(): void { for (const [t, f] of this.listeners) window.removeEventListener(t, f); for (const [t, f] of this.docListeners) document.removeEventListener(t, f); }

  /** Read the controller into padDown (with the trigger dead zone and muted buttons), the pause buttons to Esc, the DualSense extras' gyro and swipe. */
  private readPad(dt: number): PadState | null {
    for (let i = 0; i < this.padDown.length; i++) this.padPrev[i] = this.padDown[i];
    const gp = activePad();
    this.pad = gp; this.padActive = !!gp;
    this.padLookX = this.padLookY = 0; this.gyroDx = this.gyroDy = 0;
    if (!gp) { this.padDown.fill(false); this.padMuted.clear(); this.gyroT = 0; return null; }
    this.padKind = gp.kind;
    if (padTouched(gp)) padUi.lastWasPad = true;
    for (let i = 0; i < gp.buttons.length; i++) {
      const btn = gp.buttons[i];
      let down = i === PAD.LT || i === PAD.RT ? btn.value > this.padCfg.trigDead || (btn.pressed && btn.value === 0) : btn.pressed;
      if (this.padMuted.has(i)) { if (!btn.pressed && btn.value < 0.05) this.padMuted.delete(i); down = false; }
      this.padDown[i] = down;
    }
    for (const i of PAUSE_BUTTONS) if (this.padOnce(i)) this.pressed.add('Escape');
    // DualSense extras over WebHID: tilt to look (the drift learnt while it is still), swipe the touchpad to cycle the camera
    this.gyroT = Math.max(0, this.gyroT - dt);
    if (gp.source === 'hid') {
      if (this.padCfg.gyro) {
        const g = dualSense.gyro, b = this.gyroBias, rate = this.gyroRate;
        for (let i = 0; i < 3; i++) {
          const r = g[i] - b[i];
          if (Math.abs(r) < 4) b[i] += r * Math.min(1, dt * 0.5);
          rate[i] = Math.abs(r) > GYRO_DEAD ? r - Math.sign(r) * GYRO_DEAD : 0;
        }
        // y is yaw, x is pitch; the signs are a first guess to confirm on a DualSense (turn it left: the view should turn left)
        const k = GYRO_PX_PER_RAD * this.padCfg.gyroSens * dt * Math.PI / 180;
        this.gyroDx = -rate[1] * k; this.gyroDy = -rate[0] * k * (this.padCfg.invertY ? -1 : 1);
        if (Math.hypot(this.gyroDx, this.gyroDy) > 0.2) this.gyroT = 0.4;
      }
      const t = dualSense.touch;
      if (t.active && !this.swipe) this.swipe = { x0: t.x, t: 0 };
      else if (t.active && this.swipe) { this.swipe.t += dt; if (Math.abs(t.x - this.swipe.x0) > SWIPE && this.swipe.t < SWIPE_S) { this.padPressed.add('camera'); this.swipe.t = SWIPE_S; } }
      else if (!t.active) this.swipe = null;
    }
    return gp;
  }

  update(dt = 1 / 60): Input {
    // ---- FEAT-124 / FEAT-137 controller (one source: sim/Pad.ts), read first so held() sees this frame's buttons
    const gp = this.readPad(dt);
    let steer = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    let tuck = this.held('tuck'), brake = this.held('brake'), jump = this.held('jump');
    let crouch = this.held('grab'), squatOnly = this.held('squat'), skate = this.held('skate');
    let padY = 0; // FEAT-140: the left stick's fore-aft, analog (+ up)
    // the buttons feed held() / action() through padKeys; the left stick steers and leans, the right stick looks
    // (no per-frame allocations beyond getGamepads itself: plain loops, padDown / padPrev reused)
    if (gp) {
      const c = this.padCfg, dead = c.dead;
      const ax = (i: number) => { const a = gp.axes[i] ?? 0; return Math.abs(a) > dead ? (a - Math.sign(a) * dead) / (1 - dead) : 0; };
      if (ax(0)) steer = Math.max(-1, Math.min(1, steer + ax(0)));
      padY = -ax(1);
      // the stick's up / down tuck and brake too; the triggers do through padKeys (held past trigDead)
      if (ax(1) < -0.5) tuck = true;
      if (ax(1) > 0.5) brake = true;
      this.padLookX = ax(2) * c.lookSens; this.padLookY = ax(3) * c.lookSens * (c.invertY ? -1 : 1);
    }
    // jump releases on the controller like the key does
    const padJump = gp ? this.padKeyHeld('jump') : false;
    if (!padJump && this.padJumpPrev) this.input.jumpReleased = true;
    this.padJumpPrev = padJump;
    let lean = (this.held('pressNose') ? 1 : 0) - (this.held('pressTail') ? 1 : 0);
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
    // FEAT-140: holding a press, weight forward / back balances it (the keys are all or nothing, the stick is analog)
    this.input.balance = 0;
    if (this.balancing && lean !== 0 && !this.input.jumpHeld) {
      const keys = (this.held('tuck') ? 1 : 0) - (this.held('brake') ? 1 : 0);
      this.input.balance = Math.max(-1, Math.min(1, keys + padY));
      this.input.tuck = false; this.input.brake = false;
    }
    return this.input;
  }

  /** FEAT-128: a menu over the game (the main menu's backdrop) has the input this frame: drop the key presses,
   *  the held keys and the controller buttons so no riding action, hold or Esc reaches the session. */
  suspendFrame(): void {
    this.pressed.clear(); this.padPressed.clear(); this.keys.clear();
    this.padDown.fill(false);
    this.padLookX = this.padLookY = 0; this.gyroDx = this.gyroDy = 0; // the right stick and the gyro don't turn the backdrop
    this.input.jumpReleased = false;
  }

  endFrame(): void {
    this.pressed.clear();
    this.padPressed.clear();
    this.padUsed.clear();
  }
}
