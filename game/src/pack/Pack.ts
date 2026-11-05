import { HeightSet } from './HeightSet';
import { MaskSet } from './MaskSet';
import type { Features, PackMeta } from './types';

/**
 * A loaded resort pack: metadata, the three height sets, the surface mask and features.
 * `height(x, y, res)` returns the best available height for a requested detail level,
 * falling back to coarser sets when the fine tiles are not loaded yet.
 */
export class Pack {
  readonly meta: PackMeta;
  readonly baseUrl: string;
  readonly fine: HeightSet | null;
  readonly mid: HeightSet | null;
  readonly far: HeightSet | null;
  readonly mask: MaskSet | null;
  features: Features = { lifts: [], runs: [], buildings: [], roads: [], water: [], peaks: [], labels: [] };

  private constructor(baseUrl: string, meta: PackMeta) {
    this.baseUrl = baseUrl;
    this.meta = meta;
    this.fine = meta.terrain.fine ? new HeightSet(`${baseUrl}/fine`, meta.terrain.fine) : null;
    this.mid = meta.terrain.mid ? new HeightSet(`${baseUrl}/mid`, meta.terrain.mid) : null;
    this.far = meta.terrain.far ? new HeightSet(`${baseUrl}/far`, meta.terrain.far) : null;
    this.mask = meta.mask ? new MaskSet(`${baseUrl}/mask`, meta.mask) : null;
  }

  static async load(baseUrl: string): Promise<Pack> {
    const resp = await fetch(`${baseUrl}/meta.json`);
    if (!resp.ok) throw new Error(`Pack not found at ${baseUrl}/ (HTTP ${resp.status}). Run the Vite dev server (cd game && npm run dev) and open http://localhost:5173/?pack=<slug>; the pack folder must exist at packs/<slug>/ next to game/.`);
    const meta = (await resp.json()) as PackMeta;
    const pack = new Pack(baseUrl, meta);
    try {
      pack.features = (await (await fetch(`${baseUrl}/features.json`)).json()) as Features;
    } catch (e) {
      console.warn('no features.json', e);
    }
    return pack;
  }

  /** Sets ordered finest first. */
  get sets(): HeightSet[] {
    return [this.fine, this.mid, this.far].filter((s): s is HeightSet => !!s);
  }

  /**
   * Height for rendering at a target resolution: use the finest loaded set whose resolution
   * is not much finer than needed (coarser sets are smoother and cheaper), fall back outward.
   */
  height(x: number, y: number, res: number): number {
    for (const s of this.sets) {
      if (!s.contains(x, y)) continue;
      // skip sets that are far finer than needed (except when nothing else covers the point)
      if (s.meta.res * 16 < res && s !== this.sets[this.sets.length - 1]) continue;
      const h = s.sample(x, y);
      if (!Number.isNaN(h)) return h;
    }
    // last resort: any set that has data
    for (const s of this.sets) {
      if (!s.contains(x, y)) continue;
      const h = s.sample(x, y);
      if (!Number.isNaN(h)) return h;
    }
    return this.meta.zRange[0];
  }

  /** Best available height for physics (finest loaded set). */
  groundHeight(x: number, y: number): number {
    for (const s of this.sets) {
      if (!s.contains(x, y)) continue;
      const h = s.sample(x, y);
      if (!Number.isNaN(h)) return h;
    }
    return this.meta.zRange[0];
  }

  /** Finest resolution with data at this point (for normal estimation). */
  finestRes(x: number, y: number): number {
    for (const s of this.sets) {
      if (s.contains(x, y) && !Number.isNaN(s.sampleNearest(x, y))) return s.meta.res;
    }
    return this.far?.meta.res ?? 128;
  }

  /** Ground normal from central differences at the finest loaded resolution. Returns [nx, ny, nz]. */
  groundNormal(x: number, y: number, out: Float32Array | number[] = [0, 0, 1]): typeof out {
    const d = Math.max(0.5, this.finestRes(x, y));
    const hl = this.groundHeight(x - d, y), hr = this.groundHeight(x + d, y);
    const hd = this.groundHeight(x, y - d), hu = this.groundHeight(x, y + d);
    let nx = -(hr - hl) / (2 * d), ny = -(hu - hd) / (2 * d), nz = 1;
    const len = Math.hypot(nx, ny, nz);
    out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
    return out;
  }
}
