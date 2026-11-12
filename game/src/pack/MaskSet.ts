import type { MaskMeta } from './types';
import { TileStats } from './tileStats';

/**
 * Surface class mask: R rock, G scree, B groomed piste, A canopy cover. Values 0..1. Also the
 * single-channel sets on the same grid (ao, dir, moguls), built with `opaque`.
 */
export class MaskSet {
  readonly meta: MaskMeta;
  readonly size: number;
  private readonly tiles = new Map<number, Uint8ClampedArray | null>();
  private readonly pending = new Map<number, Promise<void>>();
  /** BUG-063: tiles still downloading */
  get inFlight(): number { return this.pending.size; }
  private readonly missing = new Set<number>();
  private readonly baseUrl: string;
  /** FEAT-229: bytes fetched and decode time (tools/tileperf.mjs) */
  readonly stats = new TileStats();
  onTileLoaded: ((tx: number, ty: number) => void) | null = null;
  /**
   * BUG-087: the tiles carry no alpha (the greyscale ao, dir and moguls sets), so the 2D canvas reads them
   * exactly and the WebGL readback, which stalls the main thread on the frame's GPU work, is not needed.
   */
  private readonly opaque: boolean;

  constructor(baseUrl: string, meta: MaskMeta, opts: { opaque?: boolean } = {}) {
    this.baseUrl = baseUrl;
    this.meta = meta;
    this.size = meta.res * meta.tileSize;
    this.opaque = opts.opaque ?? false;
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
      // main-thread time only: the async readback's fence wait is idle
      const timing = { mainMs: 0 };
      if (this.opaque) { this.tiles.set(k, decodeOpaque(bmp, this.meta.tileSize)); timing.mainMs = performance.now() - t2; }
      else this.tiles.set(k, await decodeRGBAAsync(bmp, this.meta.tileSize, this.meta.tileSize, timing));
      bmp.close();
      const t3 = performance.now();
      this.stats.add({ tx, ty, t: t3, bytes: blob.size, fetchMs: t1 - t0, bitmapMs: t2 - t1, decodeMs: timing.mainMs });
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
function decoderGL(): WebGL2RenderingContext | null {
  if (gl === undefined) gl = new OffscreenCanvas(1, 1).getContext('webgl2', { premultipliedAlpha: false, antialias: false });
  return gl;
}
export function decodeRGBA(bmp: ImageBitmap, n: number, h = n): Uint8ClampedArray {
  const gl = decoderGL();
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
    const px = new Uint8Array(n * h * 4);
    // texture row 0 is the image's top row and readPixels starts at framebuffer row 0, so rows keep image order
    gl.readPixels(0, 0, n, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out = new Uint8ClampedArray(px.buffer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb); gl.deleteTexture(tex);
    return out;
  }
  // fallback: 2D canvas (loses RGB where alpha is 0)
  return decodeOpaque(bmp, n, h);
}

/**
 * BUG-087: decodeRGBA without the stall, for tiles that stream in while riding. The pixels are read into a
 * buffer on the GPU and copied out once a fence says the copy is done, polled between tasks, so the main
 * thread never waits on the frame's GPU work. Same bytes as decodeRGBA.
 */
export async function decodeRGBAAsync(bmp: ImageBitmap, n: number, h = n, timing?: { mainMs: number }): Promise<Uint8ClampedArray> {
  let t = performance.now();
  const gl = decoderGL();
  if (!gl) { const out = decodeOpaque(bmp, n, h); if (timing) timing.mainMs += performance.now() - t; return out; }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, n * h * 4, gl.STREAM_READ);
  gl.readPixels(0, 0, n, h, gl.RGBA, gl.UNSIGNED_BYTE, 0); // into the buffer: returns at once
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb); gl.deleteTexture(tex);
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  // WebGL only allows a zero timeout, so poll; WAIT_FAILED (context lost) falls through to the read
  while (sync && gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) {
    if (timing) timing.mainMs += performance.now() - t;
    await new Promise((r) => setTimeout(r, 4));
    t = performance.now();
  }
  if (sync) gl.deleteSync(sync);
  const px = new Uint8Array(n * h * 4);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
  gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.deleteBuffer(buf);
  if (timing) timing.mainMs += performance.now() - t;
  return new Uint8ClampedArray(px.buffer);
}

/**
 * BUG-087: an image without transparency (greyscale, or alpha 255 everywhere) through a 2D canvas: exact,
 * since premultiplication changes nothing at full alpha, and no GPU readback. The WebGL path above takes
 * about 1 ms on its own but 25 to 60 ms while the game renders, as `readPixels` waits for the frame's GPU work.
 */
export function decodeOpaque(bmp: ImageBitmap, n: number, h = n): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(n, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, n, h).data;
}
