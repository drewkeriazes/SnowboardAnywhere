import * as THREE from 'three';
import type { CoverLevelMeta, CoverMeta } from './types';
import { decodeRGBA } from './MaskSet';

/**
 * FEAT-153: forest cover levels for the terrain at a distance (`cover/<level>.png`, see MapPacker's docs/pack-format.md).
 * Each level is one RGBA image over a rectangle (R forest share 0..1, G canopy height, B rock, A 255 - built-up).
 * The terrain shader samples the forest per pixel from a mipmapped GPU texture (the mips are the box-filtered
 * levels, so a trail narrower than a far chunk's vertex spacing still shows); the chunk builder samples all
 * four channels per vertex from a half-resolution CPU copy. Finer levels fade in over `blend` metres inside
 * their edges, so the pack's lidar canopy hands over to the land cover around it without a seam.
 */
export class CoverLevel {
  readonly meta: CoverLevelMeta;
  /** pack-frame rectangle: minX, minY, maxX, maxY */
  readonly rect: [number, number, number, number];
  /** RGBA bytes at half resolution (row 0 = north), for per-vertex sampling */
  private cpu: Uint8Array | null = null;
  private cw = 0;
  private ch = 0;
  private cres = 0;
  /** forest at full resolution, mipmapped: R from far off, G from near */
  texture: THREE.DataTexture | null = null;
  /** FEAT-168: the texture's B holds where the drawn trees stand */
  hasTrees = false;

  constructor(meta: CoverLevelMeta) {
    this.meta = meta;
    this.rect = [meta.minX, meta.minY, meta.minX + meta.w * meta.res, meta.minY + meta.h * meta.res];
  }

  get loaded(): boolean { return !!this.cpu; }

  async load(baseUrl: string): Promise<void> {
    const resp = await fetch(`${baseUrl}/${this.meta.file}`);
    if (!resp.ok) throw new Error(`cover ${this.meta.file}: HTTP ${resp.status}`);
    const bmp = await createImageBitmap(await resp.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const { w, h } = this.meta;
    const px = decodeRGBA(bmp, w, h);
    bmp.close();
    // GPU: R = the forest as seen from far off, G = from near, where single trees show (BUG-069: only the
    // closed stands of drawn trees; the same as R for a level without a `stands` image)
    let near: Uint8ClampedArray | null = null;
    if (this.meta.stands) {
      try {
        const r2 = await fetch(`${baseUrl}/${this.meta.stands}`);
        if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
        const b2 = await createImageBitmap(await r2.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        near = decodeRGBA(b2, w, h);
        b2.close();
      } catch (e) { console.warn(`cover ${this.meta.stands} not loaded`, e); }
    }
    // FEAT-168: with `crowns`, B = where the drawn trees stand (their shadows on the snow), in an RGBA texture
    const trees = near && this.meta.crowns ? near : null;
    const n = trees ? 4 : 2;
    const r = new Uint8Array(w * h * n);
    for (let i = 0; i < w * h; i++) {
      r[i * n] = px[i * 4]; r[i * n + 1] = near ? near[i * 4] : px[i * 4];
      if (trees) { r[i * n + 2] = trees[i * 4 + 1]; r[i * n + 3] = 255; }
    }
    this.hasTrees = !!trees;
    const tex = new THREE.DataTexture(r, w, h, trees ? THREE.RGBAFormat : THREE.RGFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.anisotropy = 8; // grazing views of distant slopes keep their trails
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    this.texture = tex;
    // CPU: 2 x 2 box down to half resolution (coarse chunks never sample finer than 8 m)
    const cw = w >> 1, ch = h >> 1;
    const c = new Uint8Array(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const a = ((2 * y) * w + 2 * x) * 4, b = a + w * 4, o = (y * cw + x) * 4;
        for (let k = 0; k < 4; k++) c[o + k] = (px[a + k] + px[a + 4 + k] + px[b + k] + px[b + 4 + k] + 2) >> 2;
      }
    }
    this.cpu = c; this.cw = cw; this.ch = ch; this.cres = this.meta.res * 2;
    // FEAT-278 prototype (canopy shell): the forest share and where the drawn trees stand at full resolution,
    // then box-filtered down by twos, so the shell's tiles read the level matching their vertex spacing
    if (CoverLevel.keepCrowns && trees) {
      let lw = w, lh = h, lres = this.meta.res;
      let cur = new Uint8Array(w * h * 2);
      for (let i = 0; i < w * h; i++) { cur[i * 2] = px[i * 4]; cur[i * 2 + 1] = trees[i * 4 + 1]; }
      this.crownMips = [{ w: lw, h: lh, res: lres, data: cur }];
      while (lres < 64 && lw > 2 && lh > 2) {
        const nw = lw >> 1, nh = lh >> 1, nx = new Uint8Array(nw * nh * 2);
        for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
          const a = ((2 * y) * lw + 2 * x) * 2, b = a + lw * 2, o = (y * nw + x) * 2;
          for (let k = 0; k < 2; k++) nx[o + k] = (cur[a + k] + cur[a + 2 + k] + cur[b + k] + cur[b + 2 + k] + 2) >> 2;
        }
        lw = nw; lh = nh; lres *= 2; cur = nx;
        this.crownMips.push({ w: lw, h: lh, res: lres, data: cur });
      }
    }
  }

  /** FEAT-278 prototype: set before the pack loads to keep `crownMips` (canopy=shell) */
  static keepCrowns = false;
  /** FEAT-278: (forest share, crowns) pyramids, finest first; null unless keepCrowns and the level has crowns */
  crownMips: { w: number; h: number; res: number; data: Uint8Array }[] | null = null;

  /** FEAT-278: bilinear (forest share, crown cover) 0..1 at (x, y) from the pyramid level nearest `res` m, into out[0..1] */
  sampleCrowns(x: number, y: number, res: number, out: number[]): void {
    const mips = this.crownMips!;
    let m = mips[0];
    for (const l of mips) if (l.res <= res * 1.01) m = l;
    const fx = Math.min(m.w - 1, Math.max(0, (x - this.rect[0]) / m.res - 0.5));
    const fy = Math.min(m.h - 1, Math.max(0, (this.rect[3] - y) / m.res - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(m.w - 1, x0 + 1), y1 = Math.min(m.h - 1, y0 + 1);
    // at the level's own spacing: the nearest texel (a vertex reads its own footprint's box average, not a blur of four)
    const near = res < m.res * 1.5;
    const tx = near ? (fx - x0 >= 0.5 ? 1 : 0) : fx - x0, ty = near ? (fy - y0 >= 0.5 ? 1 : 0) : fy - y0, d = m.data;
    for (let k = 0; k < 2; k++) {
      const a = d[(y0 * m.w + x0) * 2 + k], b = d[(y0 * m.w + x1) * 2 + k], c = d[(y1 * m.w + x0) * 2 + k], e = d[(y1 * m.w + x1) * 2 + k];
      const top = a + (b - a) * tx, bot = c + (e - c) * tx;
      out[k] = (top + (bot - top) * ty) / 255;
    }
  }

  /** 0 outside, ramping to 1 over `blend` m inside the edges */
  weight(x: number, y: number, blend: number): number {
    const r = this.rect;
    const d = Math.min(x - r[0], r[2] - x, y - r[1], r[3] - y);
    if (d <= 0 || !this.cpu) return 0;
    if (d >= blend) return 1;
    const t = d / blend;
    return t * t * (3 - 2 * t);
  }

  /** bilinear RGBA 0..1 at (x, y) into out */
  sample(x: number, y: number, out: number[]): void {
    const c = this.cpu!, cw = this.cw, ch = this.ch;
    const fx = Math.min(cw - 1, Math.max(0, (x - this.rect[0]) / this.cres - 0.5));
    const fy = Math.min(ch - 1, Math.max(0, (this.rect[3] - y) / this.cres - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(cw - 1, x0 + 1), y1 = Math.min(ch - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const i00 = (y0 * cw + x0) * 4, i10 = (y0 * cw + x1) * 4, i01 = (y1 * cw + x0) * 4, i11 = (y1 * cw + x1) * 4;
    for (let k = 0; k < 4; k++) {
      const top = c[i00 + k] + (c[i10 + k] - c[i00 + k]) * tx;
      const bot = c[i01 + k] + (c[i11 + k] - c[i01 + k]) * tx;
      out[k] = (top + (bot - top) * ty) / 255;
    }
    out[3] = 1 - out[3]; // stored as not built-up
  }
}

export class CoverSet {
  readonly meta: CoverMeta;
  /** coarsest first, so finer levels are blended over it */
  readonly levels: CoverLevel[];
  /** called once per level as it arrives */
  onLevelLoaded: ((level: CoverLevel) => void) | null = null;
  private readonly tmp = [0, 0, 0, 0];

  constructor(baseUrl: string, meta: CoverMeta) {
    this.meta = meta;
    this.levels = meta.levels.map((m) => new CoverLevel(m)).sort((a, b) => b.meta.res - a.meta.res);
    for (const l of this.levels) {
      l.load(baseUrl).then(() => this.onLevelLoaded?.(l), (e) => console.warn('cover level not loaded', e));
    }
  }

  /**
   * Blended cover at (x, y): out = [forest 0..1, canopy height m, rock 0..1, built-up 0..1]. Returns how much
   * of the result is data (0 = no level here yet; the caller mixes in its procedural fallback by 1 - that).
   */
  sample(x: number, y: number, out: number[]): number {
    out[0] = out[1] = out[2] = out[3] = 0;
    let cov = 0;
    const s = this.tmp, blend = this.meta.blend;
    for (const l of this.levels) {
      const w = l.weight(x, y, blend);
      if (w <= 0) continue;
      l.sample(x, y, s);
      for (let k = 0; k < 4; k++) out[k] += (s[k] - out[k]) * w;
      cov += (1 - cov) * w;
    }
    if (cov > 0) for (let k = 0; k < 4; k++) out[k] /= cov; // levels blended over nothing: renormalise
    out[1] *= this.meta.heightMax;
    return cov;
  }
}
