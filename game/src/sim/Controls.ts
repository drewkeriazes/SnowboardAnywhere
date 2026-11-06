import type { Input } from './Rider';

/**
 * Keyboard (and basic touch) input. Mapping matches the common browser ski games:
 * Left/Right or A/D steer, Up/W tuck, Down/S brake, hold and release Space to jump,
 * Shift grab. R resets, C cycles the camera, M toggles the piste overlay, F free-fly.
 */
export class Controls {
  readonly input: Input = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false };
  /** action -> KeyboardEvent.code (remappable); WASD stay as fixed aliases for the movement keys */
  keymap: Record<string, string> = { left: 'ArrowLeft', right: 'ArrowRight', tuck: 'ArrowUp', brake: 'ArrowDown', jump: 'Space', grab: 'ShiftLeft', lift: 'KeyE', trial: 'KeyT', map: 'KeyM', camera: 'KeyC', restart: 'KeyR', piste: 'KeyP', fly: 'KeyF', track: 'KeyN' };
  invertSteer = false;
  private readonly listeners: [string, EventListener][] = [];
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
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === this.keymap.jump) this.input.jumpReleased = true;
    };
    const bl = () => this.keys.clear();
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku); window.addEventListener('blur', bl);
    this.listeners.push(['keydown', kd as EventListener], ['keyup', ku as EventListener], ['blur', bl]);

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

  /** Remove the window listeners (quit to menu). */
  dispose(): void { for (const [t, f] of this.listeners) window.removeEventListener(t, f); }

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
    this.pressed.clear = this.pressed.clear; // keep tslint quiet
    return this.input;
  }

  endFrame(): void {
    this.pressed.clear();
  }
}
