import type { MaskMeta } from './types';

/** Surface class mask: R rock, G scree, B groomed piste, A canopy cover. Values 0..1. */
export class MaskSet {
  readonly meta: MaskMeta;
  readonly size: number;
  private readonly tiles = new Map<number, Uint8ClampedArray | null>();
  private readonly pending = new Map<number, Promise<void>>();
  /** BUG-063: tiles still downloading */
  get inFlight(): number { return this.pending.size; }
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
      this.tiles.set(k, decodeRGBA(bmp, this.meta.tileSize));
      bmp.close();
      this.onTileLoaded?.(tx, ty);
    } catch (e) {
      this.missing.add(k);
    } finally {
      this.pending.delete(k);
    }
  }

  /** True when the tile under (x, y) is loaded (sample() returns zeros otherwise). */
  has(x: number, y: number): boolean {
    const m = this.meta;
    const n = m.tileSize;
    const tx = Math.floor((x - m.minX) / m.res / n), ty = Math.floor((y - m.minY) / m.res / n);
    return !!this.tiles.get(this.key(tx, ty));
  }

  private readonly corner = [0, 0, 0, 0];
  /**
   * Bilinear version of sample() between the four nearest cell centres (works across tile edges).
   * The terrain uses it so thresholded classes (rock patches) follow smooth outlines, not 2 m cells.
   */
  sampleBilinear(x: number, y: number, out: number[] = [0, 0, 0, 0]): number[] {
    const m = this.meta;
    const fx = (x - m.minX) / m.res - 0.5, fy = (y - m.minY) / m.res - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    out[0] = out[1] = out[2] = out[3] = 0;
    for (let k = 0; k < 4; k++) {
      const cx = x0 + (k & 1), cy = y0 + (k >> 1);
      const w = ((k & 1) ? tx : 1 - tx) * ((k >> 1) ? ty : 1 - ty);
      if (w === 0) continue;
      const c = this.sample(m.minX + (cx + 0.5) * m.res, m.minY + (cy + 0.5) * m.res, this.corner);
      out[0] += c[0] * w; out[1] += c[1] * w; out[2] += c[2] * w; out[3] += c[3] * w;
    }
    return out;
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

/**
 * Read an image's RGBA bytes exactly. A 2D canvas stores colour premultiplied by alpha, so it
 * zeroes RGB wherever alpha is 0; the mask keeps canopy in alpha, which would wipe rock, scree and
 * groomed on all open ground. WebGL with premultiplication off returns the bytes unchanged.
 */
let gl: WebGL2RenderingContext | null | undefined;
function decodeRGBA(bmp: ImageBitmap, n: number): Uint8ClampedArray {
  if (gl === undefined) gl = new OffscreenCanvas(1, 1).getContext('webgl2', { premultipliedAlpha: false, antialias: false });
  if (gl) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const px = new Uint8Array(n * n * 4);
    // texture row 0 is the image's top row and readPixels starts at framebuffer row 0, so rows keep image order
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out = new Uint8ClampedArray(px.buffer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb); gl.deleteTexture(tex);
    return out;
  }
  // fallback: 2D canvas (loses RGB where alpha is 0)
  const canvas = new OffscreenCanvas(n, n);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, n, n).data;
}
