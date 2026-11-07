import type { Input } from './Rider';

/**
 * Keyboard (and basic touch) input. Mapping matches the common browser ski games:
 * Left/Right or A/D steer, Up/W tuck, Down/S brake, hold and release Space to jump,
 * Shift grab (sprint on foot), Left Ctrl squat (hold), X skate (hold), V / Z nose / tail press (hold); Space + W / S nollie / ollie. B unstraps or straps in. R resets, C cycles the camera, M toggles
 * the piste overlay, F free-fly.
 */
export class Controls {
  readonly input: Input = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false, skate: false, lean: 0 };
  /** action -> KeyboardEvent.code (remappable); WASD stay as fixed aliases for the movement keys */
  keymap: Record<string, string> = { left: 'ArrowLeft', right: 'ArrowRight', tuck: 'ArrowUp', brake: 'ArrowDown', jump: 'Space', grab: 'ShiftLeft', squat: 'ControlLeft', skate: 'KeyX', pressNose: 'KeyV', pressTail: 'KeyZ', lift: 'KeyE', trial: 'KeyT', map: 'KeyM', camera: 'KeyC', restart: 'KeyR', piste: 'KeyP', fly: 'KeyF', track: 'KeyN', look: 'AltLeft', board: 'KeyB' };
  invertSteer = false;
  /** FEAT-111: ask before the page closes (Ctrl+W mid-ride); main turns it off while paused */
  guardLeave = true;
  private readonly listeners: [string, EventListener][] = [];
  private readonly docListeners: [string, EventListener][] = [];
  readonly keys = new Set<string>();
  private readonly pressed = new Set<string>(); // one-shot
  touchSteer = 0;
  touchTuck = false;
  touchBrake = false;

  constructor(el: HTMLElement) {
    const kd = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT' || (e.target as HTMLElement | null)?.tagName === 'SELECT') return; // typing in a menu
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'AltLeft', 'AltRight'].includes(e.code)) e.preventDefault();
      // squatting on Ctrl turns game keys into browser shortcuts (Ctrl+S, Ctrl+D...): block the ones a page can block
      if (e.ctrlKey && this.keys.has(this.keymap.squat) && e.code !== this.keymap.squat) e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault(); // else Alt focuses the browser menu bar
      if (e.code === this.keymap.jump) this.input.jumpReleased = true;
    };
    const bl = () => this.keys.clear();
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku); window.addEventListener('blur', bl);
    this.listeners.push(['keydown', kd as EventListener], ['keyup', ku as EventListener], ['blur', bl]);
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

    void el;
  }
  private touchJump = false;
  touchJumpDown(): void { this.touchJump = true; }
  touchJumpUp(): void { if (this.touchJump) { this.touchJump = false; this.input.jumpReleased = true; } }

  /** Consume a one-shot key press by code. */
  once(code: string): boolean {
    if (this.pressed.has(code)) { this.pressed.delete(code); return true; }
    return false;
  }
  /** Consume a one-shot press of a mapped action. */
  action(name: string): boolean { return this.once(this.keymap[name]); }

  /** Free look held (the mapped key, or either Alt). */
  get looking(): boolean { return this.keys.has(this.keymap.look) || this.keys.has('AltLeft') || this.keys.has('AltRight'); }

  /** Remove the window listeners (quit to menu). */
  dispose(): void { for (const [t, f] of this.listeners) window.removeEventListener(t, f); for (const [t, f] of this.docListeners) document.removeEventListener(t, f); }

  update(): Input {
    const k = this.keys;
    let steer = 0;
    const m = this.keymap;
    if (k.has(m.left) || k.has('KeyA')) steer -= 1;
    if (k.has(m.right) || k.has('KeyD')) steer += 1;
    if (this.invertSteer) steer = -steer;
    if (steer === 0) steer = this.touchSteer;
    this.input.steer = steer;
    this.input.tuck = k.has(m.tuck) || k.has('KeyW') || this.touchTuck;
    this.input.brake = k.has(m.brake) || k.has('KeyS') || this.touchBrake;
    this.input.jumpHeld = k.has(m.jump) || this.touchJump;
    this.input.grab = k.has(m.grab) || k.has('ShiftLeft') || k.has('ShiftRight');
    this.input.squat = k.has(m.squat);
    this.input.skate = k.has(m.skate);
    // FEAT-112: while charging a jump, W/S lean forward (tail up, nollie) / back (nose up, ollie)
    // instead of tucking or braking; V / Z hold a nose / tail press without jumping
    let lean = (k.has(m.pressNose) ? 1 : 0) - (k.has(m.pressTail) ? 1 : 0);
    if (this.input.jumpHeld && (this.input.tuck || this.input.brake)) {
      lean = (this.input.tuck ? 1 : 0) - (this.input.brake ? 1 : 0);
      this.input.tuck = false; this.input.brake = false;
    }
    this.input.lean = lean;
    this.pressed.clear = this.pressed.clear; // keep tslint quiet
    return this.input;
  }

  endFrame(): void {
    this.pressed.clear();
  }
}
