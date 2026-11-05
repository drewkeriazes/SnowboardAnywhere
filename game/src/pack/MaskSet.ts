import type { MaskMeta } from './types';

/** Surface class mask: R rock, G scree, B groomed piste, A canopy cover. Values 0..1. */
export class MaskSet {
  readonly meta: MaskMeta;
  readonly size: number;
  private readonly tiles = new Map<number, Uint8ClampedArray | null>();
  private readonly pending = new Map<number, Promise<void>>();
  private readonly missing = new Set<number>();
  private readonly baseUrl: string;
  onTileLoaded: ((tx: number, ty: number) => void) | null = null;

  constructor(baseUrl: string, meta: MaskMeta) {
    this.baseUrl = baseUrl;
    this.meta = meta;
    this.size = meta.res * meta.tileSize;
  }

  private key(tx: number, ty: number): number {
    return ty * 4096 + tx;
  }

  contains(x: number, y: number): boolean {
    const m = this.meta;
    return x >= m.minX && x < m.minX + m.tilesX * this.size && y >= m.minY && y < m.minY + m.tilesY * this.size;
  }

  request(minX: number, minY: number, maxX: number, maxY: number): boolean {
    const m = this.meta;
    const tx0 = Math.max(0, Math.floor((minX - m.minX) / this.size));
    const ty0 = Math.max(0, Math.floor((minY - m.minY) / this.size));
    const tx1 = Math.min(m.tilesX - 1, Math.floor((maxX - m.minX) / this.size));
    const ty1 = Math.min(m.tilesY - 1, Math.floor((maxY - m.minY) / this.size));
    let all = true;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const k = this.key(tx, ty);
        if (this.tiles.get(k) || this.missing.has(k)) continue;
        all = false;
        if (!this.pending.has(k)) this.pending.set(k, this.load(tx, ty));
      }
    }
    return all;
  }

  private async load(tx: number, ty: number): Promise<void> {
    const k = this.key(tx, ty);
    try {
      const resp = await fetch(`${this.baseUrl}/${tx}_${ty}.png`);
      if (!resp.ok) {
        this.missing.add(k);
        return;
      }
      const bmp = await createImageBitmap(await resp.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const n = this.meta.tileSize;
      const canvas = new OffscreenCanvas(n, n);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      this.tiles.set(k, ctx.getImageData(0, 0, n, n).data);
      bmp.close();
      this.onTileLoaded?.(tx, ty);
    } catch (e) {
      this.missing.add(k);
    } finally {
      this.pending.delete(k);
    }
  }

  /** out = [rock, scree, groomed, canopy] in 0..1; zeros when not loaded. */
  sample(x: number, y: number, out: number[] = [0, 0, 0, 0]): number[] {
    out[0] = out[1] = out[2] = out[3] = 0;
    const m = this.meta;
    const fx = (x - m.minX) / m.res, fy = (y - m.minY) / m.res;
    const n = m.tileSize;
    const tx = Math.floor(fx / n), ty = Math.floor(fy / n);
    const t = this.tiles.get(this.key(tx, ty));
    if (!t) return out;
    const col = Math.min(n - 1, Math.max(0, Math.floor(fx - tx * n)));
    const rowFromSouth = Math.min(n - 1, Math.max(0, Math.floor(fy - ty * n)));
    const i = ((n - 1 - rowFromSouth) * n + col) * 4;
    out[0] = t[i] / 255; out[1] = t[i + 1] / 255; out[2] = t[i + 2] / 255; out[3] = t[i + 3] / 255;
    return out;
  }
}
