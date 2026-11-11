import type { HeightSetMeta } from './types';
import { TileStats } from './tileStats';

/**
 * One tiled height set (fine / mid / far). Tiles are Terrarium-encoded PNGs decoded on the
 * CPU into Float32Array grids (row 0 = north). Sampling is bilinear and crosses tile edges.
 * Missing tiles return NaN so callers can fall back to a coarser set.
 */
export class HeightSet {
  readonly meta: HeightSetMeta;
  readonly size: number; // tile size in metres
  private readonly tiles = new Map<number, Float32Array | null>(); // null = loading or missing
  private readonly pending = new Map<number, Promise<void>>();
  /** BUG-063: tiles still downloading */
  get inFlight(): number { return this.pending.size; }
  private readonly missing = new Set<number>();
  private readonly baseUrl: string;
  /** FEAT-229: bytes fetched and decode time (tools/tileperf.mjs) */
  readonly stats = new TileStats();
  /** called when a tile finishes loading so the terrain can rebuild chunks */
  onTileLoaded: ((tx: number, ty: number) => void) | null = null;

  constructor(baseUrl: string, meta: HeightSetMeta) {
    this.baseUrl = baseUrl;
    this.meta = meta;
    this.size = meta.res * meta.tileSize;
  }

  contains(x: number, y: number): boolean {
    const m = this.meta;
    return x >= m.minX && x < m.maxX && y >= m.minY && y < m.maxY;
  }

  private key(tx: number, ty: number): number {
    return ty * 4096 + tx;
  }

  tileCoord(x: number, y: number): [number, number] {
    return [Math.floor((x - this.meta.minX) / this.size), Math.floor((y - this.meta.minY) / this.size)];
  }

  isLoaded(tx: number, ty: number): boolean {
    const t = this.tiles.get(this.key(tx, ty));
    return t !== undefined && t !== null;
  }

  /** Ensure the tiles covering a rectangle are requested. Returns true if all are already loaded. */
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
        if (this.tiles.get(k)) continue;
        if (this.missing.has(k)) continue;
        all = false;
        if (!this.pending.has(k)) this.pending.set(k, this.load(tx, ty));
      }
    }
    return all;
  }

  private async load(tx: number, ty: number): Promise<void> {
    const k = this.key(tx, ty);
    try {
      const t0 = performance.now();
      const resp = await fetch(`${this.baseUrl}/${tx}_${ty}.png`);
      if (!resp.ok) {
        this.missing.add(k);
        return;
      }
      const blob = await resp.blob();
      const t1 = performance.now();
      const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const t2 = performance.now();
      const n = this.meta.tileSize;
      const canvas = new OffscreenCanvas(n, n);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      const data = ctx.getImageData(0, 0, n, n).data;
      bmp.close();
      const out = new Float32Array(n * n);
      for (let i = 0, j = 0; i < out.length; i++, j += 4) {
        const h = data[j] * 256 + data[j + 1] + data[j + 2] / 256 - 32768;
        out[i] = h <= -32767.5 ? NaN : h;
      }
      this.tiles.set(k, out);
      const t3 = performance.now();
      this.stats.add({ tx, ty, t: t3, bytes: blob.size, fetchMs: t1 - t0, bitmapMs: t2 - t1, decodeMs: t3 - t2 });
      this.onTileLoaded?.(tx, ty);
    } catch (e) {
      console.warn('tile load failed', tx, ty, e);
      this.missing.add(k);
    } finally {
      this.pending.delete(k);
    }
  }

  /** Nearest-sample height, NaN if the tile is not loaded. */
  sampleNearest(x: number, y: number): number {
    const m = this.meta;
    const fx = (x - m.minX) / m.res;
    const fy = (y - m.minY) / m.res;
    const n = m.tileSize;
    const tx = Math.floor(fx / n), ty = Math.floor(fy / n);
    const t = this.tiles.get(this.key(tx, ty));
    if (!t) return NaN;
    const col = Math.min(n - 1, Math.max(0, Math.floor(fx - tx * n)));
    const rowFromSouth = Math.min(n - 1, Math.max(0, Math.floor(fy - ty * n)));
    return t[(n - 1 - rowFromSouth) * n + col];
  }

  private sampleGrid(gx: number, gy: number): number {
    // gx, gy are integer sample indices from the set origin (gy counts north from minY)
    const n = this.meta.tileSize;
    const tx = Math.floor(gx / n), ty = Math.floor(gy / n);
    if (tx < 0 || ty < 0 || tx >= this.meta.tilesX || ty >= this.meta.tilesY) return NaN;
    const t = this.tiles.get(this.key(tx, ty));
    if (!t) return NaN;
    const col = gx - tx * n;
    const rowFromSouth = gy - ty * n;
    return t[(n - 1 - rowFromSouth) * n + col];
  }

  /** Bilinear height. Sample centres sit at (minX + (i + 0.5) * res). NaN if data is missing. */
  sample(x: number, y: number): number {
    const m = this.meta;
    const fx = (x - m.minX) / m.res - 0.5;
    const fy = (y - m.minY) / m.res - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const ax = fx - x0, ay = fy - y0;
    const h00 = this.sampleGrid(x0, y0), h10 = this.sampleGrid(x0 + 1, y0);
    const h01 = this.sampleGrid(x0, y0 + 1), h11 = this.sampleGrid(x0 + 1, y0 + 1);
    if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h01) || Number.isNaN(h11)) {
      // edge of data: fall back to whichever samples exist
      const vals = [h00, h10, h01, h11].filter((v) => !Number.isNaN(v));
      if (vals.length === 0) return NaN;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
  }

  /** Drop tiles far from a point (and from an optional second keep point) to bound memory. */
  evictBeyond(x: number, y: number, radius: number, keep?: readonly number[] | null): void {
    for (const [k, t] of this.tiles) {
      if (!t) continue;
      const tx = k % 4096, ty = Math.floor(k / 4096);
      const cx = this.meta.minX + (tx + 0.5) * this.size, cy = this.meta.minY + (ty + 0.5) * this.size;
      const far = Math.hypot(cx - x, cy - y) > radius + this.size;
      const farKeep = !keep || Math.hypot(cx - keep[0], cy - keep[1]) > radius + this.size;
      if (far && farKeep) this.tiles.delete(k);
    }
  }

  get loadedCount(): number {
    let c = 0;
    for (const t of this.tiles.values()) if (t) c++;
    return c;
  }
}
