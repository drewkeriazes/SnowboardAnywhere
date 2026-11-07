import type { Pack } from '../pack/Pack';
import type { Difficulty } from '../pack/types';

/**
 * 2D map of the resort drawn once to an offscreen canvas (hillshade from the mid height set,
 * water, buildings, lifts, runs). Shown two ways:
 *  - minimap: a north-up window around the rider in the bottom-right corner
 *  - full map (M): the whole resort; click to pick a drop-in point
 * Map pixels: x east, y south (row 0 = north). Scale = metres per pixel.
 */
const RUN_COLORS: Record<string, string> = {
  novice: '#22c55e', easy: '#22c55e', intermediate: '#3b82f6',
  advanced: '#111111', expert: '#111111', extreme: '#f97316', freeride: '#f97316',
};

export class ResortMap {
  readonly base: HTMLCanvasElement; // the pre-rendered map
  readonly scale: number; // metres per base pixel
  readonly minX: number; // pack x of base pixel column 0
  readonly maxY: number; // pack y of base pixel row 0
  private readonly pack: Pack;
  private shaded = false;
  private readonly mini: HTMLCanvasElement;
  private readonly full: HTMLCanvasElement;
  private readonly fullWrap: HTMLDivElement;
  private readonly fullInfo: HTMLDivElement;
  fullOpen = false;
  /** called with pack x, y when the player clicks the full map */
  onPick: ((x: number, y: number) => void) | null = null;
  private hover: [number, number] | null = null;

  constructor(pack: Pack) {
    this.pack = pack;
    const b = pack.meta.bounds;
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    this.scale = Math.max(w, h) / 1024;
    this.minX = b.minX; this.maxY = b.maxY;
    this.base = document.createElement('canvas');
    this.base.width = Math.ceil(w / this.scale); this.base.height = Math.ceil(h / this.scale);
    this.drawFeatures();

    this.mini = document.createElement('canvas');
    this.mini.width = 220; this.mini.height = 220;
    this.mini.id = 'minimap';
    Object.assign(this.mini.style, { position: 'fixed', right: '16px', bottom: '16px', width: '220px', height: '220px', borderRadius: '50%', border: '2px solid rgba(255,255,255,.7)', boxShadow: '0 2px 10px rgba(0,0,0,.4)', pointerEvents: 'none' });
    document.body.appendChild(this.mini);

    this.fullWrap = document.createElement('div');
    Object.assign(this.fullWrap.style, { position: 'fixed', inset: '0', background: 'rgba(8,12,24,.88)', display: 'none', alignItems: 'center', justifyContent: 'center', zIndex: '10', cursor: 'crosshair' });
    this.full = document.createElement('canvas');
    this.fullWrap.appendChild(this.full);
    this.fullInfo = document.createElement('div');
    Object.assign(this.fullInfo.style, { position: 'absolute', left: '16px', top: '12px', color: '#fff', font: '14px system-ui, sans-serif', textShadow: '0 1px 3px #000', pointerEvents: 'none' });
    this.fullWrap.appendChild(this.fullInfo);
    document.body.appendChild(this.fullWrap);
    // zoom about the cursor, drag to pan, click (no drag) to drop in
    let down: { x: number; y: number; t: number; cx: number; cy: number } | null = null;
    let dragged = false;
    this.full.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.full.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      this.hover = this.toPack(e); this.drawFull();
    }, { passive: false });
    this.full.addEventListener('mousedown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now(), cx: this.centre[0], cy: this.centre[1] }; dragged = false; });
    this.full.addEventListener('mousemove', (e) => {
      if (down && (dragged || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4)) {
        dragged = true;
        const { s } = this.fullRect();
        this.centre = [down.cx - (e.clientX - down.x) / s * this.scale, down.cy + (e.clientY - down.y) / s * this.scale];
        this.full.style.cursor = 'grabbing';
      }
      this.hover = this.toPack(e); this.drawFull();
    });
    const up = (e: MouseEvent) => {
      if (down && !dragged && performance.now() - down.t < 400) { const p = this.toPack(e); if (p && this.onPick) this.onPick(p[0], p[1]); }
      down = null; dragged = false; this.full.style.cursor = 'crosshair';
    };
    this.full.addEventListener('mouseup', up);
    this.full.addEventListener('mouseleave', (e) => { this.hover = null; if (down) up(e); this.drawFull(); });
    this.full.addEventListener('dblclick', (e) => { e.preventDefault(); const r = this.full.getBoundingClientRect(); this.zoomAt(e.clientX - r.left, e.clientY - r.top, 2); this.drawFull(); });
    this.onKey = (e: KeyboardEvent) => {
      if (!this.fullOpen) return;
      if (e.key === '+' || e.key === '=') { this.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.5); this.drawFull(); }
      else if (e.key === '-') { this.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.5); this.drawFull(); }
      else if (e.key === 'Home' || e.key === '0') { this.zoom = 1; this.centre = this.boundsCentre(); this.drawFull(); }
    };
    window.addEventListener('keydown', this.onKey);
    // touch: one finger pans, two fingers pinch-zoom, tap drops in
    let touch: { x: number; y: number; d: number; cx: number; cy: number; zoom: number; moved: boolean } | null = null;
    const tpos = (e: TouchEvent) => { const r = this.full.getBoundingClientRect(); const t = Array.from(e.touches); const x = t.reduce((a, q) => a + q.clientX, 0) / t.length - r.left, y = t.reduce((a, q) => a + q.clientY, 0) / t.length - r.top; const d = t.length > 1 ? Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) : 0; return { x, y, d }; };
    this.full.addEventListener('touchstart', (e) => { e.preventDefault(); const p = tpos(e); touch = { ...p, cx: this.centre[0], cy: this.centre[1], zoom: this.zoom, moved: false }; }, { passive: false });
    this.full.addEventListener('touchmove', (e) => {
      e.preventDefault(); if (!touch) return;
      const p = tpos(e);
      if (Math.hypot(p.x - touch.x, p.y - touch.y) > 6 || (touch.d && Math.abs(p.d - touch.d) > 6)) touch.moved = true;
      if (touch.d && p.d) this.zoom = Math.min(8, Math.max(0.5, touch.zoom * (p.d / touch.d)));
      const { s } = this.fullRect();
      this.centre = [touch.cx - (p.x - touch.x) / s * this.scale, touch.cy + (p.y - touch.y) / s * this.scale];
      this.drawFull();
    }, { passive: false });
    this.full.addEventListener('touchend', (e) => {
      if (touch && !touch.moved && e.touches.length === 0) {
        const r = this.full.getBoundingClientRect();
        const { ox, oy, s } = this.fullRect();
        const px = (touch.x - ox) / s, py = (touch.y - oy) / s;
        if (px >= 0 && py >= 0 && px < this.base.width && py < this.base.height && this.onPick) this.onPick(this.minX + px * this.scale, this.maxY - py * this.scale);
        void r;
      }
      if (e.touches.length === 0) touch = null;
    });
    window.addEventListener('resize', () => { if (this.fullOpen) this.drawFull(); });
  }

  // ---------------------------------------------------------------- coordinate helpers
  toPixel(x: number, y: number): [number, number] { return [(x - this.minX) / this.scale, (this.maxY - y) / this.scale]; }
  /** full-map view: zoom factor over fit-to-screen and the pack point at the screen centre */
  zoom = 1;
  centre: [number, number] = [0, 0];
  private boundsCentre(): [number, number] { const b = this.pack.meta.bounds; return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]; }
  /** screen = ox + basePx * s */
  private fullRect(): { ox: number; oy: number; s: number } {
    const fit = Math.min(window.innerWidth / this.base.width, window.innerHeight / this.base.height) * 0.96;
    const s = fit * this.zoom;
    const [cbx, cby] = this.toPixel(this.centre[0], this.centre[1]);
    return { ox: window.innerWidth / 2 - cbx * s, oy: window.innerHeight / 2 - cby * s, s };
  }
  /** Zoom by `factor` keeping the pack point under screen (sx, sy) fixed. */
  private zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.fullRect();
    const bx = (sx - before.ox) / before.s, by = (sy - before.oy) / before.s; // base px under the cursor
    this.zoom = Math.min(8, Math.max(0.5, this.zoom * factor));
    const fit = before.s / (this.zoom / factor);
    const s = fit * this.zoom;
    // choose centre so that base (bx, by) stays at (sx, sy): ox = sx - bx*s; centre base px = (W/2 - ox)/s
    const cbx = (window.innerWidth / 2 - (sx - bx * s)) / s, cby = (window.innerHeight / 2 - (sy - by * s)) / s;
    this.centre = [this.minX + cbx * this.scale, this.maxY - cby * this.scale];
  }
  private toPack(e: MouseEvent): [number, number] | null {
    const r = this.full.getBoundingClientRect();
    const { ox, oy, s } = this.fullRect();
    const px = (e.clientX - r.left - ox) / s, py = (e.clientY - r.top - oy) / s;
    if (px < 0 || py < 0 || px >= this.base.width || py >= this.base.height) return null;
    return [this.minX + px * this.scale, this.maxY - py * this.scale];
  }

  // ---------------------------------------------------------------- base map
  /** Hillshade from the mid set once its tiles over the resort are loaded. Returns true when drawn. */
  tryShade(): boolean {
    if (this.shaded) return true;
    const set = this.pack.mid ?? this.pack.fine;
    if (!set) return false;
    const b = this.pack.meta.bounds;
    if (!set.request(b.minX, b.minY, b.maxX, b.maxY)) return false;
    const W = this.base.width, H = this.base.height;
    const img = new ImageData(W, H);
    const d = img.data;
    const res = this.scale;
    const lx = -0.5, ly = 0.6, lz = 0.62; // light from the north-west, like a trail map
    for (let j = 0; j < H; j++) {
      const y = this.maxY - (j + 0.5) * res;
      for (let i = 0; i < W; i++) {
        const x = this.minX + (i + 0.5) * res;
        const hl = set.sample(x - res, y), hr = set.sample(x + res, y), hd = set.sample(x, y - res), hu = set.sample(x, y + res);
        const h = set.sample(x, y);
        let shade = 0.6;
        if (!Number.isNaN(hl + hr + hd + hu)) {
          const nx = -(hr - hl) / (2 * res), ny = -(hu - hd) / (2 * res);
          const len = Math.hypot(nx, ny, 1);
          shade = Math.max(0, (nx * lx + ny * ly + lz) / len);
        }
        // snow tint, slightly bluer in shade, warmer high up
        const t = Number.isNaN(h) ? 0.5 : Math.min(1, Math.max(0, (h - this.pack.meta.zRange[0]) / (this.pack.meta.zRange[1] - this.pack.meta.zRange[0])));
        const v = 0.45 + 0.55 * shade;
        const o = (j * W + i) * 4;
        d[o] = 255 * v * (0.86 + 0.1 * t); d[o + 1] = 255 * v * (0.9 + 0.06 * t); d[o + 2] = 255 * v; d[o + 3] = 255;
      }
    }
    const ctx = this.base.getContext('2d')!;
    ctx.putImageData(img, 0, 0);
    this.drawFeatures();
    this.shaded = true;
    return true;
  }

  private drawFeatures(): void {
    const ctx = this.base.getContext('2d')!;
    if (!this.shaded) { ctx.fillStyle = '#dfe7f2'; ctx.fillRect(0, 0, this.base.width, this.base.height); }
    const f = this.pack.features;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // water
    ctx.fillStyle = '#7fb3e6';
    for (const w of f.water) this.poly(ctx, w.points, true);
    // roads
    ctx.strokeStyle = 'rgba(90,90,100,.55)'; ctx.lineWidth = 1;
    for (const r of f.roads) this.path(ctx, r.points);
    // buildings
    ctx.fillStyle = '#6b5e4f';
    for (const bld of f.buildings) this.poly(ctx, bld.points, true);
    // runs
    for (const run of f.runs) {
      ctx.strokeStyle = RUN_COLORS[(run.difficulty ?? 'intermediate') as Difficulty] ?? '#888';
      ctx.lineWidth = run.difficulty === 'advanced' || run.difficulty === 'expert' ? 1.6 : 2.2;
      this.path(ctx, run.points);
    }
    // lifts: red line with end dots
    ctx.strokeStyle = '#d7263d'; ctx.lineWidth = 1.8;
    for (const l of f.lifts) {
      if (l.stations.length < 2) continue;
      this.path(ctx, l.stations);
      ctx.fillStyle = '#d7263d';
      for (const s of [l.stations[0], l.stations[l.stations.length - 1]]) { const [px, py] = this.toPixel(s[0], s[1]); ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fill(); }
    }
  }

  // ---------------------------------------------------------------- labels (drawn at display time, collision-placed)
  /**
   * Draw lift (and optionally run) names so none overlap. `toScreen` maps pack coords to canvas
   * pixels for the current view. Long lifts go first; each label tries right, left, above, below.
   * Returns the number of labels placed.
   */
  private drawLabels(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], opts: { max: number; font: number; runs: boolean; inside: (sx: number, sy: number) => boolean; near?: [number, number] }): number {
    const f = this.pack.features;
    type Cand = { name: string; x: number; y: number; prio: number; kind: 'lift' | 'run' };
    const cands: Cand[] = [];
    for (const l of f.lifts) {
      if (!l.name || l.stations.length < 2 || l.type === 'magic_carpet') continue;
      const a = l.stations[0], b = l.stations[l.stations.length - 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      let prio = len;
      if (opts.near) prio = -Math.hypot(mx - opts.near[0], my - opts.near[1]); // nearest first on the minimap
      cands.push({ name: l.name, x: mx, y: my, prio, kind: 'lift' });
    }
    if (opts.runs) {
      const seen = new Set<string>();
      for (const r of f.runs) {
        if (!r.name || r.points.length < 2 || seen.has(r.name)) continue;
        seen.add(r.name);
        const m = r.points[Math.floor(r.points.length / 2)];
        cands.push({ name: r.name, x: m[0], y: m[1], prio: r.points.length * 0.01, kind: 'run' });
      }
    }
    cands.sort((a, b) => b.prio - a.prio);
    const placed: [number, number, number, number][] = [];
    const overlaps = (b: [number, number, number, number]) => placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
    ctx.font = `${opts.font}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.lineJoin = 'round';
    let n = 0;
    const pad = 2, h = opts.font + 2;
    for (const c of cands) {
      if (n >= opts.max) break;
      const [sx, sy] = toScreen(c.x, c.y);
      if (!opts.inside(sx, sy)) continue;
      const w = ctx.measureText(c.name).width + pad * 2;
      const anchors: [number, number, CanvasTextAlign][] = [[sx + 6, sy, 'left'], [sx - 6, sy, 'right'], [sx, sy - h, 'center'], [sx, sy + h, 'center']];
      for (const [ax, ay, align] of anchors) {
        const x0 = align === 'left' ? ax : align === 'right' ? ax - w : ax - w / 2;
        const box: [number, number, number, number] = [x0, ay - h / 2, x0 + w, ay + h / 2];
        if (overlaps(box) || !opts.inside(box[0], box[1]) || !opts.inside(box[2], box[3])) continue;
        placed.push(box);
        ctx.textAlign = align;
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.fillStyle = c.kind === 'lift' ? '#5a0a14' : '#1f2937';
        ctx.strokeText(c.name, ax, ay); ctx.fillText(c.name, ax, ay);
        n++;
        break;
      }
    }
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    return n;
  }

  private path(ctx: CanvasRenderingContext2D, pts: number[][]): void {
    if (pts.length < 2) return;
    ctx.beginPath();
    pts.forEach((p, i) => { const [px, py] = this.toPixel(p[0], p[1]); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.stroke();
  }
  private poly(ctx: CanvasRenderingContext2D, pts: number[][], fill: boolean): void {
    if (pts.length < 3) return;
    ctx.beginPath();
    pts.forEach((p, i) => { const [px, py] = this.toPixel(p[0], p[1]); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.closePath();
    if (fill) ctx.fill(); else ctx.stroke();
  }

  // ---------------------------------------------------------------- minimap
  /** Draw the minimap: `radius` metres around the rider, heading arrow. */
  /** active time-trial course to draw on the minimap (null when none) */
  trialRoute: [number, number, number][] | null = null;
  /** pack x,y of the lift bottom to pulse on the minimap (set each frame by main) */
  liftMarker: [number, number] | null = null;
  /** Outrun monsters (FEAT-097), pack x,y, drawn on both maps */
  monsters: [number, number][] = [];
  /** Outrun base target (FEAT-097) */
  baseMarker: [number, number] | null = null;

  drawMini(x: number, y: number, heading: number, radius = 900): void {
    this.tryShade();
    const c = this.mini, ctx = c.getContext('2d')!;
    const S = c.width;
    const pxPerM = S / (2 * radius);
    const [cx, cy] = this.toPixel(x, y);
    const srcW = S / pxPerM / this.scale; // base pixels covered
    ctx.save();
    ctx.clearRect(0, 0, S, S);
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#cfd9e6'; ctx.fillRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, cx - srcW / 2, cy - srcW / 2, srcW, srcW, 0, 0, S, S);
    const k = S / srcW; // display px per base px
    this.drawLabels(ctx, (px, py) => { const [bx, by] = this.toPixel(px, py); return [(bx - (cx - srcW / 2)) * k, (by - (cy - srcW / 2)) * k]; },
      { max: 4, font: 10, runs: false, near: [x, y], inside: (sx, sy) => Math.hypot(sx - S / 2, sy - S / 2) < S / 2 - 6 });
    if (this.trialRoute && this.trialRoute.length > 1) {
      const toS = (px: number, py: number): [number, number] => { const [bx, by] = this.toPixel(px, py); return [(bx - (cx - srcW / 2)) * k, (by - (cy - srcW / 2)) * k]; };
      ctx.strokeStyle = 'rgba(255,210,63,.95)'; ctx.lineWidth = 3.5; ctx.lineJoin = 'round';
      ctx.beginPath();
      this.trialRoute.forEach((p, i) => { const [sx, sy] = toS(p[0], p[1]); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); });
      ctx.stroke();
      const f = this.trialRoute[this.trialRoute.length - 1];
      const [fx, fy] = toS(f[0], f[1]);
      // chequered flag
      ctx.fillStyle = '#111'; ctx.fillRect(fx - 1, fy - 16, 2, 16);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { ctx.fillStyle = (i + j) % 2 ? '#fff' : '#111'; ctx.fillRect(fx + 1 + i * 4, fy - 16 + j * 4, 4, 4); }
    }
    if (this.liftMarker) {
      const [bx, by] = this.toPixel(this.liftMarker[0], this.liftMarker[1]);
      const mx = (bx - (cx - srcW / 2)) * k, my = (by - (cy - srcW / 2)) * k;
      const pulse = 5 + 3 * Math.sin(performance.now() / 180);
      ctx.beginPath(); ctx.arc(mx, my, pulse, 0, Math.PI * 2); ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(mx, my, 2.5, 0, Math.PI * 2); ctx.fillStyle = '#ffd166'; ctx.fill();
    }
    if (this.baseMarker) {
      const [bx, by] = this.toPixel(this.baseMarker[0], this.baseMarker[1]);
      const mx = (bx - (cx - srcW / 2)) * k, my = (by - (cy - srcW / 2)) * k;
      ctx.beginPath(); ctx.arc(mx, my, 6, 0, Math.PI * 2); ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 2.5; ctx.stroke();
    }
    for (const m of this.monsters) {
      const [bx, by] = this.toPixel(m[0], m[1]);
      const mx = (bx - (cx - srcW / 2)) * k, my = (by - (cy - srcW / 2)) * k;
      // off the minimap: pinned to its edge in the monster's direction
      const d = Math.hypot(mx - S / 2, my - S / 2), lim = S / 2 - 8;
      const px = d > lim ? S / 2 + (mx - S / 2) * lim / d : mx, py = d > lim ? S / 2 + (my - S / 2) * lim / d : my;
      const pulse = 6 + 2 * Math.sin(performance.now() / 120);
      ctx.beginPath(); ctx.arc(px, py, pulse, 0, Math.PI * 2); ctx.fillStyle = 'rgba(124,58,237,.9)'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
    // rider: triangle pointing along heading (north up)
    ctx.translate(S / 2, S / 2); ctx.rotate(heading);
    ctx.fillStyle = '#ff3b30'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 4); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    // north tick
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('N', S / 2, 14);
  }

  // ---------------------------------------------------------------- full map
  /** Remove the DOM nodes (quit to menu). */
  private onKey: ((e: KeyboardEvent) => void) | null = null;
  destroy(): void { this.mini.remove(); this.fullWrap.remove(); if (this.onKey) window.removeEventListener('keydown', this.onKey); }
  metric = false;

  toggle(): void { this.fullOpen ? this.close() : this.open(); }
  private opened = false;
  open(): void {
    this.fullOpen = true; this.fullWrap.style.display = 'flex'; this.tryShade();
    if (!this.opened) { this.opened = true; this.zoom = 1; this.centre = this.boundsCentre(); }
    this.drawFull();
  }
  close(): void { this.fullOpen = false; this.fullWrap.style.display = 'none'; }

  riderPos: [number, number, number] = [0, 0, 0];
  /** time-trial course starts to flag on the full map (empty when time trials are off) */
  courseStarts: { x: number; y: number; name: string; best: number | null }[] = [];
  spawnPos: [number, number] | null = null;

  drawFull(): void {
    const c = this.full;
    c.width = window.innerWidth; c.height = window.innerHeight;
    const ctx = c.getContext('2d')!;
    const { ox, oy, s } = this.fullRect();
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = true;
    ctx.save();
    ctx.beginPath(); ctx.rect(ox, oy, this.base.width * s, this.base.height * s); ctx.clip();
    ctx.drawImage(this.base, ox, oy, this.base.width * s, this.base.height * s);
    ctx.restore();
    const toScreen = (x: number, y: number): [number, number] => { const [bx, by] = this.toPixel(x, y); return [ox + bx * s, oy + by * s]; };
    const inside = (sx: number, sy: number) => sx >= 0 && sy >= 0 && sx <= c.width && sy <= c.height;
    this.drawLabels(ctx, toScreen, { max: 200, font: Math.min(16, 11 + 2 * this.zoom), runs: this.zoom >= 2, inside });
    const dot = (x: number, y: number, color: string, r: number) => { const [px, py] = this.toPixel(x, y); ctx.beginPath(); ctx.arc(ox + px * s, oy + py * s, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); };
    for (const cs of this.courseStarts) {
      const [px, py] = this.toPixel(cs.x, cs.y);
      const sx = ox + px * s, sy = oy + py * s;
      ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, sy - 14); ctx.stroke();
      ctx.fillStyle = '#facc15'; ctx.beginPath(); ctx.moveTo(sx, sy - 14); ctx.lineTo(sx + 10, sy - 10.5); ctx.lineTo(sx, sy - 7); ctx.closePath(); ctx.fill();
      if (this.zoom >= 1.5) { ctx.font = '11px system-ui'; ctx.fillStyle = '#111'; ctx.fillText(cs.best !== null ? `${cs.name} ${cs.best.toFixed(1)}s` : cs.name, sx + 12, sy - 8); }
    }
    if (this.spawnPos) dot(this.spawnPos[0], this.spawnPos[1], '#22c55e', 6);
    if (this.baseMarker) dot(this.baseMarker[0], this.baseMarker[1], '#4ade80', 9);
    for (const m of this.monsters) dot(m[0], m[1], '#7c3aed', 8);
    dot(this.riderPos[0], this.riderPos[1], '#ff3b30', 7);
    if (this.hover) {
      dot(this.hover[0], this.hover[1], 'rgba(255,255,255,.5)', 5);
      const h = this.pack.groundHeight(this.hover[0], this.hover[1]);
      const near = this.nearestRun(this.hover[0], this.hover[1]);
      this.fullInfo.innerHTML = `<b>${this.pack.meta.name}</b> &middot; click to drop in &middot; scroll to zoom (${this.zoom.toFixed(1)}x) &middot; drag to pan &middot; Home resets &middot; M or Esc to close<br>` +
        `${this.hover[0].toFixed(0)}, ${this.hover[1].toFixed(0)} m &middot; ${this.metric ? `${h.toFixed(0)} m` : `${(h * 3.28084).toFixed(0)} ft`}` + (near ? ` &middot; ${near}` : '');
    } else {
      this.fullInfo.innerHTML = `<b>${this.pack.meta.name}</b> &middot; click to drop in &middot; scroll to zoom (${this.zoom.toFixed(1)}x) &middot; drag to pan &middot; Home resets &middot; M or Esc to close`;
    }
  }

  private nearestRun(x: number, y: number): string | null {
    let best = 60, name: string | null = null;
    for (const r of this.pack.features.runs) {
      if (!r.name) continue;
      for (let i = 0; i < r.points.length; i += 2) {
        const d = Math.hypot(r.points[i][0] - x, r.points[i][1] - y);
        if (d < best) { best = d; name = r.name; }
      }
    }
    return name;
  }
}
