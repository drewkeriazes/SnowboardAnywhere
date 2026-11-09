import type { Rider } from '../sim/Rider';

/**
 * First-person goggle lens, drawn over the canvas as DOM:
 *  - frame: a soft, mostly translucent goggle outline around the screen edge with a nose bridge
 *    at the bottom, and a slight lens tint toward the edges in the lens colour (SVG, scaled to the window;
 *    the lens itself, which filters the view, is the shader pass in world/Lens.ts)
 *  - lens canvas: snow spray drifting past at speed, frost creeping in from the corners in deep
 *    powder, and a short darken pulse on hard landings (the camera shakes at the same time)
 * `strength` (0..1) scales the frame and tint; the effects follow the rider state.
 */
const FRAME_SVG = `
<svg viewBox="0 0 1000 1000" preserveAspectRatio="none" width="100%" height="100%">
  <defs>
    <radialGradient id="gTint" cx="50%" cy="46%" r="72%">
      <stop offset="55%" stop-color="#ffb347" stop-opacity="0"/>
      <stop offset="100%" stop-color="#ff9a2e" stop-opacity="0.16"/>
    </radialGradient>
    <linearGradient id="gGlare" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.07"/>
      <stop offset="0.35" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="gSoft" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="3.5"/></filter>
  </defs>
  <path d="M0 0H1000V1000H0Z M45 55 Q500 0 955 55 Q992 62 994 140 L994 790 Q992 905 910 935 Q770 968 615 955 Q565 950 545 905 Q500 830 455 905 Q435 950 385 955 Q230 968 90 935 Q8 905 6 790 L6 140 Q8 62 45 55Z"
        fill="#07090d" fill-opacity="0.96" fill-rule="evenodd" filter="url(#gSoft)"/>
  <path d="M45 55 Q500 0 955 55 Q992 62 994 140 L994 790 Q992 905 910 935 Q770 968 615 955 Q565 950 545 905 Q500 830 455 905 Q435 950 385 955 Q230 968 90 935 Q8 905 6 790 L6 140 Q8 62 45 55Z"
        fill="url(#gTint)" stroke="#ffffff" stroke-opacity="0.08" stroke-width="3"/>
  <rect x="0" y="0" width="1000" height="1000" fill="url(#gGlare)"/>
</svg>`;

interface Flake { x: number; y: number; vx: number; vy: number; r: number; life: number }

export class GoggleView {
  private readonly frame: HTMLDivElement;
  private readonly lens: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private frost = 0;
  private frostTex: HTMLCanvasElement | null = null;
  private dark = 0;
  private lastShock = 0;
  private flakes: Flake[] = [];
  private shown = false;
  strength = 0.6;

  constructor() {
    this.frame = document.createElement('div');
    this.frame.id = 'goggles';
    this.frame.innerHTML = FRAME_SVG;
    this.lens = document.createElement('canvas');
    this.lens.id = 'lens';
    this.g = this.lens.getContext('2d')!;
    // under the HUD and prompts (they come later in the DOM)
    const hud = document.getElementById('hud');
    document.body.insertBefore(this.lens, hud);
    document.body.insertBefore(this.frame, hud);
  }

  destroy(): void { this.frame.remove(); this.lens.remove(); }

  /** FEAT-130: the edge tint takes the lens colour (a hex string); null = no lens, no tint */
  setLens(color: string | null): void {
    const stops = this.frame.querySelectorAll('#gTint stop');
    stops.forEach((st) => { if (color) st.setAttribute('stop-color', color); });
    stops[stops.length - 1]?.setAttribute('stop-opacity', color ? '0.16' : '0');
  }

  /** Per frame. `show` = first person with the goggle setting on; `fp` = first person at all (effects). */
  update(r: Rider, dt: number, fp: boolean, show: boolean, riding: boolean): void {
    this.frame.style.opacity = show ? String(0.5 + 0.5 * this.strength) : '0';
    if (!fp) {
      if (this.shown) { this.g.clearRect(0, 0, this.lens.width, this.lens.height); this.shown = false; this.flakes.length = 0; this.frost = 0; this.dark = 0; }
      return;
    }
    this.shown = true;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    if (this.lens.width !== w || this.lens.height !== h) { this.lens.width = w; this.lens.height = h; this.frostTex = null; }
    const g = this.g;
    g.clearRect(0, 0, w, h);
    const spd = r.speed;
    const s = r.surface;
    const hard = Math.min(1, s.rock + s.scree);
    const powder = Math.max(0, 1 - s.groomed - hard);
    const onSnow = r.onGround && !riding;

    // frost: builds in deep, fast powder, clears slowly elsewhere
    const frostT = onSnow ? Math.min(1, powder * Math.max(0, spd - 6) / 14) : 0;
    this.frost += (frostT - this.frost) * Math.min(1, dt * (frostT > this.frost ? 0.5 : 0.12));
    if (this.frost > 0.02) {
      if (!this.frostTex) this.frostTex = makeFrost(w, h);
      g.globalAlpha = Math.min(0.85, this.frost);
      g.drawImage(this.frostTex, 0, 0);
      g.globalAlpha = 1;
    }

    // snow drift: flakes stream outward from the centre of view, more with speed, spray and powder
    const rate = onSnow ? Math.max(0, spd - 9) * (0.6 + r.skid * 2 + powder * 1.5) : 0;
    let emit = rate * dt;
    while (emit > 0 && this.flakes.length < 60) {
      if (emit < 1 && Math.random() > emit) break;
      emit -= 1;
      const a = Math.random() * Math.PI * 2, d = 0.05 + Math.random() * 0.25;
      const v = (0.25 + Math.random() * 0.5) * (spd / 15);
      this.flakes.push({ x: 0.5 + Math.cos(a) * d, y: 0.5 + Math.sin(a) * d * 0.7, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.7 + 0.05, r: 1.5 + Math.random() * 3.5, life: 0.4 + Math.random() * 0.5 });
    }
    for (let i = this.flakes.length - 1; i >= 0; i--) {
      const f = this.flakes[i];
      f.life -= dt;
      // accelerate as they near the edge (perspective)
      const k = 1 + 2.5 * Math.hypot(f.x - 0.5, f.y - 0.5);
      f.x += f.vx * dt * k; f.y += f.vy * dt * k;
      if (f.life <= 0 || f.x < -0.05 || f.x > 1.05 || f.y < -0.05 || f.y > 1.05) { this.flakes.splice(i, 1); continue; }
      const rad = f.r * dpr * k;
      const x = f.x * w, y = f.y * h;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `rgba(255,255,255,${Math.min(0.75, f.life * 1.5)})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }

    // hard landing: a short darken pulse
    if (r.landingShock > this.lastShock + 0.2 && r.landingShock > 0.4) this.dark = Math.min(0.55, r.landingShock * 0.55);
    this.lastShock = r.landingShock;
    this.dark *= Math.exp(-dt * 5);
    if (this.dark > 0.01) { g.fillStyle = `rgba(0,0,0,${this.dark})`; g.fillRect(0, 0, w, h); }
  }
}

/** Corner frost: feathery white streaks dense at the corners, fading toward the middle. */
function makeFrost(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  const corners: [number, number][] = [[0, 0], [w, 0], [0, h], [w, h]];
  const reach = Math.min(w, h) * 0.42;
  g.lineCap = 'round';
  for (const [cx, cy] of corners) {
    // soft haze
    const hz = g.createRadialGradient(cx, cy, 0, cx, cy, reach);
    hz.addColorStop(0, 'rgba(235,245,255,0.55)'); hz.addColorStop(0.6, 'rgba(235,245,255,0.12)'); hz.addColorStop(1, 'rgba(235,245,255,0)');
    g.fillStyle = hz; g.fillRect(0, 0, w, h);
    // crystals: short branching strokes
    for (let i = 0; i < 260; i++) {
      const d = reach * Math.pow(Math.random(), 1.6);
      const a = Math.random() * Math.PI / 2; // quarter circle into the screen from this corner
      const x = cx ? cx - Math.cos(a) * d : Math.cos(a) * d, y = cy ? cy - Math.sin(a) * d : Math.sin(a) * d;
      const len = 4 + Math.random() * 14 * (1 - d / reach);
      const dir = Math.random() * Math.PI * 2;
      g.strokeStyle = `rgba(255,255,255,${0.15 + 0.35 * (1 - d / reach)})`;
      g.lineWidth = 0.6 + Math.random();
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(dir) * len, y + Math.sin(dir) * len);
      for (const b of [-0.7, 0.7]) { g.moveTo(x + Math.cos(dir) * len * 0.5, y + Math.sin(dir) * len * 0.5); g.lineTo(x + Math.cos(dir) * len * 0.5 + Math.cos(dir + b) * len * 0.4, y + Math.sin(dir) * len * 0.5 + Math.sin(dir + b) * len * 0.4); }
      g.stroke();
    }
  }
  return c;
}
