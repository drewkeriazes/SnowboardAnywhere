import * as THREE from 'three';
import type { CoverLevelMeta, CoverMeta } from './types';
import { decodeRGBA } from './MaskSet';

/**
 * FEAT-153: forest cover levels for the terrain at a distance (`cover/<level>.png`, see pack-format.md).
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
  /** forest channel at full resolution, mipmapped */
  texture: THREE.DataTexture | null = null;

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
    // GPU: the forest channel only
    const r = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) r[i] = px[i * 4];
    const tex = new THREE.DataTexture(r, w, h, THREE.RedFormat, THREE.UnsignedByteType);
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
