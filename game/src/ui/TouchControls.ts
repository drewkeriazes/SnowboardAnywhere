import type { Controls } from '../sim/Controls';

/**
 * On-screen controls for touch devices: a virtual stick on the left (x = steer, push up =
 * tuck, pull down = brake), a jump button (hold and release) and small buttons for board on / off, lift,
 * map, camera and pause on the right. Writes into Controls' touch fields and fires one-shot
 * actions through `press`. Shown only when the device has a coarse pointer, or with ?touch.
 */
export class TouchControls {
  readonly el: HTMLDivElement;
  private readonly controls: Controls;
  private stickId: number | null = null;
  private stickOrigin: [number, number] = [0, 0];
  private readonly knob: HTMLDivElement;
  private readonly stick: HTMLDivElement;
  readonly pressed = new Set<string>();

  static wanted(): boolean {
    return new URLSearchParams(location.search).has('touch') || (window.matchMedia?.('(pointer: coarse)').matches ?? false) || navigator.maxTouchPoints > 1;
  }

  constructor(controls: Controls) {
    this.controls = controls;
    this.el = document.createElement('div');
    this.el.id = 'touch';
    this.el.innerHTML = `
      <div class="stick"><div class="knob"></div><div class="hint">steer &middot; up tuck &middot; down brake</div></div>
      <div class="btns">
        <button data-a="pause" class="small">II</button>
        <button data-a="map" class="small">MAP</button>
        <button data-a="camera" class="small">CAM</button>
        <button data-a="board" class="mid">BOARD</button>
        <button data-a="lift" class="mid">LIFT</button>
        <button data-a="jump" class="big">JUMP</button>
      </div>`;
    document.body.appendChild(this.el);
    this.stick = this.el.querySelector('.stick') as HTMLDivElement;
    this.knob = this.el.querySelector('.knob') as HTMLDivElement;
    const R = 56; // px travel
    const setStick = (dx: number, dy: number) => {
      const l = Math.hypot(dx, dy) || 1, k = Math.min(1, l / R);
      const nx = (dx / l) * k, ny = (dy / l) * k;
      this.knob.style.transform = `translate(${(nx * R).toFixed(0)}px, ${(ny * R).toFixed(0)}px)`;
      controls.touchSteer = Math.max(-1, Math.min(1, nx * 1.4));
      controls.touchTuck = ny < -0.45;
      controls.touchBrake = ny > 0.45;
    };
    this.stick.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this.stickId = t.identifier;
      const r = this.stick.getBoundingClientRect();
      this.stickOrigin = [r.left + r.width / 2, r.top + r.height / 2];
      setStick(t.clientX - this.stickOrigin[0], t.clientY - this.stickOrigin[1]);
    }, { passive: false });
    this.stick.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) if (t.identifier === this.stickId) setStick(t.clientX - this.stickOrigin[0], t.clientY - this.stickOrigin[1]);
    }, { passive: false });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) if (t.identifier === this.stickId) { this.stickId = null; this.knob.style.transform = ''; controls.touchSteer = 0; controls.touchTuck = false; controls.touchBrake = false; }
    };
    this.stick.addEventListener('touchend', end); this.stick.addEventListener('touchcancel', end);
    // buttons
    this.el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      const a = b.dataset.a!;
      const down = (e: Event) => { e.preventDefault(); b.classList.add('down'); if (a === 'jump') controls.touchJumpDown(); else this.pressed.add(a); };
      const up = (e: Event) => { e.preventDefault(); b.classList.remove('down'); if (a === 'jump') controls.touchJumpUp(); };
      b.addEventListener('touchstart', down, { passive: false }); b.addEventListener('touchend', up); b.addEventListener('touchcancel', up);
      b.addEventListener('mousedown', down); b.addEventListener('mouseup', up); // desktop testing with ?touch
    });
  }

  /** Consume a one-shot button press. */
  once(action: string): boolean { if (this.pressed.has(action)) { this.pressed.delete(action); return true; } return false; }
  setVisible(v: boolean): void { this.el.style.display = v ? '' : 'none'; }
  destroy(): void { this.el.remove(); }
}
