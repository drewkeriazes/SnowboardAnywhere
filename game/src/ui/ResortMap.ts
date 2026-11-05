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
    this.full.addEventListener('mousemove', (e) => { this.hover = this.toPack(e); this.drawFull(); });
    this.full.addEventListener('mouseleave', () => { this.hover = null; this.drawFull(); });
    this.full.addEventListener('click', (e) => { const p = this.toPack(e); if (p && this.onPick) this.onPick(p[0], p[1]); });
    window.addEventListener('resize', () => { if (this.fullOpen) this.drawFull(); });
  }

  // ---------------------------------------------------------------- coordinate helpers
  toPixel(x: number, y: number): [number, number] { return [(x - this.minX) / this.scale, (this.maxY - y) / this.scale]; }
  private fullRect(): { ox: number; oy: number; s: number } {
    const s = Math.min(window.innerWidth / this.base.width, window.innerHeight / this.base.height) * 0.96;
    return { ox: (window.innerWidth - this.base.width * s) / 2, oy: (window.innerHeight - this.base.height * s) / 2, s };
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
    // lift names
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = '#5a0a14'; ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 3;
    for (const l of f.lifts) {
      if (!l.name || l.stations.length < 2) continue;
      const m = l.stations[Math.floor(l.stations.length / 2)];
      const [px, py] = this.toPixel(m[0], m[1]);
      ctx.strokeText(l.name, px + 4, py - 4); ctx.fillText(l.name, px + 4, py - 4);
    }
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
    // rider: triangle pointing along heading (north up)
    ctx.translate(S / 2, S / 2); ctx.rotate(heading);
    ctx.fillStyle = '#ff3b30'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 4); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    // north tick
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('N', S / 2, 14);
  }

  // ---------------------------------------------------------------- full map
  toggle(): void { this.fullOpen ? this.close() : this.open(); }
  open(): void { this.fullOpen = true; this.fullWrap.style.display = 'flex'; this.tryShade(); this.drawFull(); }
  close(): void { this.fullOpen = false; this.fullWrap.style.display = 'none'; }

  riderPos: [number, number, number] = [0, 0, 0];
  spawnPos: [number, number] | null = null;

  drawFull(): void {
    const c = this.full;
    c.width = window.innerWidth; c.height = window.innerHeight;
    const ctx = c.getContext('2d')!;
    const { ox, oy, s } = this.fullRect();
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, ox, oy, this.base.width * s, this.base.height * s);
    const dot = (x: number, y: number, color: string, r: number) => { const [px, py] = this.toPixel(x, y); ctx.beginPath(); ctx.arc(ox + px * s, oy + py * s, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); };
    if (this.spawnPos) dot(this.spawnPos[0], this.spawnPos[1], '#22c55e', 6);
    dot(this.riderPos[0], this.riderPos[1], '#ff3b30', 7);
    if (this.hover) {
      dot(this.hover[0], this.hover[1], 'rgba(255,255,255,.5)', 5);
      const h = this.pack.groundHeight(this.hover[0], this.hover[1]);
      const near = this.nearestRun(this.hover[0], this.hover[1]);
      this.fullInfo.innerHTML = `<b>${this.pack.meta.name}</b> &middot; click to drop in &middot; M or Esc to close<br>` +
        `${this.hover[0].toFixed(0)}, ${this.hover[1].toFixed(0)} m &middot; ${(h * 3.28084).toFixed(0)} ft` + (near ? ` &middot; ${near}` : '');
    } else {
      this.fullInfo.innerHTML = `<b>${this.pack.meta.name}</b> &middot; click to drop in &middot; M or Esc to close`;
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
