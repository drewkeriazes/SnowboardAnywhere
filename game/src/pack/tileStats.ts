/** FEAT-229: one tile as it arrived (times in ms; `t` from page load) */
export interface TileLoad {
  tx: number;
  ty: number;
  t: number;
  bytes: number;
  /** request to body received (wall clock, overlaps other tiles) */
  fetchMs: number;
  /** createImageBitmap: the PNG decode, off the main thread in Chromium (wall clock) */
  bitmapMs: number;
  /** drawImage, getImageData and the conversion: main thread */
  decodeMs: number;
}

const LOG_CAP = 2000;

/**
 * FEAT-229: what one tile set has fetched and decoded, for tools/tileperf.mjs (read through
 * window.__sim.pack). Totals over the session; `log` keeps the most recent loads.
 */
export class TileStats {
  loads = 0;
  bytes = 0;
  fetchMs = 0;
  bitmapMs = 0;
  decodeMs = 0;
  maxDecodeMs = 0;
  readonly log: TileLoad[] = [];

  add(l: TileLoad): void {
    this.loads++;
    this.bytes += l.bytes;
    this.fetchMs += l.fetchMs;
    this.bitmapMs += l.bitmapMs;
    this.decodeMs += l.decodeMs;
    this.maxDecodeMs = Math.max(this.maxDecodeMs, l.decodeMs);
    if (this.log.length >= LOG_CAP) this.log.shift();
    this.log.push(l);
  }
}
