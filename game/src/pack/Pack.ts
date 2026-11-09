import { HeightSet } from './HeightSet';
import { MaskSet } from './MaskSet';
import { CoverSet } from './CoverSet';
import type { Features, PackMeta } from './types';
import { downhillFrom, mogulHeight, MOGUL_FALL_D } from '../terrain/Moguls';

/** chunks at this resolution or finer carry the mogul bumps in their geometry */
export const MOGUL_MAX_RES = 2;
/** coarser chunks up to this resolution shade the same field in the terrain shader (seen from the lift) */
export const MOGUL_SHADE_MAX_RES = 16;

/** A straight bridge deck segment (pack metres). The surface runs from a to b at the given z. */
export interface Deck { ax: number; ay: number; az: number; bx: number; by: number; bz: number; hw: number }
const DECK_CELL = 32;

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
  /** sky visibility 0..1 in channel 0 (gullies and cliff feet darker); null in older packs */
  readonly ao: MaskSet | null;
  /** piste direction set (DATA-002), optional */
  readonly dir: MaskSet | null;
  /** FEAT-059: mogul amplitude 0..1 m in channel 0; null in older packs */
  readonly moguls: MaskSet | null;
  /** FEAT-153: forest cover levels for the terrain at a distance; null in older packs */
  readonly cover: CoverSet | null;
  /** amplitude multiplier (new snow softens the bumps) and uphill creep in metres (season date) */
  mogulScale = 1;
  mogulCreep = 0;
  features: Features = { lifts: [], runs: [], buildings: [], roads: [], water: [], peaks: [], labels: [] };

  private constructor(baseUrl: string, meta: PackMeta) {
    this.baseUrl = baseUrl;
    this.meta = meta;
    this.fine = meta.terrain.fine ? new HeightSet(`${baseUrl}/fine`, meta.terrain.fine) : null;
    this.mid = meta.terrain.mid ? new HeightSet(`${baseUrl}/mid`, meta.terrain.mid) : null;
    this.far = meta.terrain.far ? new HeightSet(`${baseUrl}/far`, meta.terrain.far) : null;
    this.mask = meta.mask ? new MaskSet(`${baseUrl}/mask`, meta.mask) : null;
    this.ao = meta.ao ? new MaskSet(`${baseUrl}/ao`, meta.ao) : null;
    this.dir = meta.dir ? new MaskSet(`${baseUrl}/dir`, meta.dir) : null;
    this.moguls = meta.moguls ? new MaskSet(`${baseUrl}/moguls`, meta.moguls) : null;
    this.cover = meta.cover && meta.cover.levels.length ? new CoverSet(baseUrl, meta.cover) : null;
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
   * `bumps = false` leaves the mogul bumps out (BUG-062: the chunk builder wants the base surface for
   * its normals and adds the bumps to the positions itself).
   */
  height(x: number, y: number, res: number, bumps = true): number {
    for (const s of this.sets) {
      if (!s.contains(x, y)) continue;
      // skip sets that are far finer than needed (except when nothing else covers the point)
      if (s.meta.res * 16 < res && s !== this.sets[this.sets.length - 1]) continue;
      const h = s.sample(x, y);
      if (!Number.isNaN(h)) return bumps && res <= MOGUL_MAX_RES ? h + this.bumpAt(x, y) : h;
    }
    // last resort: any set that has data
    for (const s of this.sets) {
      if (!s.contains(x, y)) continue;
      const h = s.sample(x, y);
      if (!Number.isNaN(h)) return h;
    }
    return this.meta.zRange[0];
  }

  /**
   * Count of terrainHeight() calls that wanted a finer set (the point is inside it) but had to
   * use a coarser one because the tile was not loaded yet. Physics diffs it per step to warn.
   */
  coarseFallbacks = 0;

  /** Terrain height from the finest loaded set plus the mogul bumps, ignoring bridges. Independent of render LOD. */
  terrainHeight(x: number, y: number): number {
    return this.baseHeight(x, y) + this.bumpAt(x, y);
  }

  setMoguls(scale: number, creepM: number): void {
    this.mogulScale = Math.max(0, Math.min(1, scale)); this.mogulCreep = creepM;
  }

  private readonly mogTmp = [0, 0, 0, 0];
  private readonly fallTmp = [1, 0];

  /** FEAT-059: mogul amplitude (m) at a point from the pack's moguls set; 0 without the set or its tile. */
  mogulAmp(x: number, y: number, raw = false): number {
    if (!this.moguls || (!raw && this.mogulScale <= 0)) return 0;
    return this.moguls.sampleBilinear(x, y, this.mogTmp)[0] * (raw ? 1 : this.mogulScale);
  }

  /** FEAT-059: the bump height at a point: the field's amplitude here, aligned to the local fall line and
   *  sized by its slope (FEAT-147). */
  bumpAt(x: number, y: number): number {
    const amp = this.mogulAmp(x, y);
    if (amp < 0.005) return 0;
    // BUG-064: a wide difference so the rows hold their direction; its length is the slope (FEAT-147)
    const f = downhillFrom(this.baseFn, x, y, this.fallTmp, MOGUL_FALL_D);
    return mogulHeight(x, y, amp, f[0], f[1], this.mogulCreep);
  }

  private readonly baseFn = (x: number, y: number) => this.baseHeight(x, y);

  /** DEM height from the finest loaded set, without bumps. */
  private baseHeight(x: number, y: number): number {
    let skipped = false;
    for (const s of this.sets) {
      if (!s.contains(x, y)) continue;
      const h = s.sample(x, y);
      if (!Number.isNaN(h)) {
        if (skipped) this.coarseFallbacks++;
        return h;
      }
      skipped = true;
    }
    return this.meta.zRange[0];
  }

  /**
   * Best available height for physics: terrain, or a bridge deck above it. Pass the rider's z
   * so something well below a deck (in the gully under it) keeps the terrain.
   */
  groundHeight(x: number, y: number, z?: number): number {
    const t = this.terrainHeight(x, y);
    if (this.deckGrid.size === 0) return t;
    const d = this.deckHeight(x, y);
    if (d > t && (z === undefined || z > d - 2.5)) return d;
    return t;
  }

  private readonly deckGrid = new Map<string, Deck[]>();
  readonly decks: Deck[] = [];
  private deckHit: Deck | null = null;

  addDeck(d: Deck): void {
    this.decks.push(d);
    const pad = d.hw + 1;
    const x0 = Math.floor((Math.min(d.ax, d.bx) - pad) / DECK_CELL), x1 = Math.floor((Math.max(d.ax, d.bx) + pad) / DECK_CELL);
    const y0 = Math.floor((Math.min(d.ay, d.by) - pad) / DECK_CELL), y1 = Math.floor((Math.max(d.ay, d.by) + pad) / DECK_CELL);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const k = `${cx},${cy}`;
      let a = this.deckGrid.get(k);
      if (!a) { a = []; this.deckGrid.set(k, a); }
      a.push(d);
    }
  }

  /** Highest deck surface over (x, y), or -Infinity. */
  deckHeight(x: number, y: number): number {
    const a = this.deckGrid.get(`${Math.floor(x / DECK_CELL)},${Math.floor(y / DECK_CELL)}`);
    this.deckHit = null;
    if (!a) return -Infinity;
    let best = -Infinity;
    for (const d of a) {
      const ex = d.bx - d.ax, ey = d.by - d.ay, l2 = ex * ex + ey * ey;
      const t = ((x - d.ax) * ex + (y - d.ay) * ey) / l2;
      if (t < 0 || t > 1) continue;
      const lat = Math.abs((x - d.ax) * ey - (y - d.ay) * ex) / Math.sqrt(l2);
      if (lat > d.hw) continue;
      const z = d.az + (d.bz - d.az) * t;
      if (z > best) { best = z; this.deckHit = d; }
    }
    return best;
  }

  /** Finest resolution with data at this point (for normal estimation). */
  finestRes(x: number, y: number): number {
    for (const s of this.sets) {
      if (s.contains(x, y) && !Number.isNaN(s.sampleNearest(x, y))) return s.meta.res;
    }
    return this.far?.meta.res ?? 128;
  }

  /** Ground normal from central differences at the finest loaded resolution. Returns [nx, ny, nz]. */
  groundNormal(x: number, y: number, out: Float32Array | number[] = [0, 0, 1], z?: number): typeof out {
    if (this.deckGrid.size) {
      // on a deck: its own plane, so the gully beside it does not tilt the rider
      const dz = this.deckHeight(x, y), k = this.deckHit;
      if (k && dz > this.terrainHeight(x, y) && (z === undefined || z > dz - 2.5)) {
        const ex = k.bx - k.ax, ey = k.by - k.ay, l2 = ex * ex + ey * ey, g = (k.bz - k.az) / l2;
        const nx = -g * ex, ny = -g * ey, len = Math.hypot(nx, ny, 1);
        out[0] = nx / len; out[1] = ny / len; out[2] = 1 / len;
        return out;
      }
    }
    const d = Math.max(0.5, this.finestRes(x, y));
    const hl = this.terrainHeight(x - d, y), hr = this.terrainHeight(x + d, y);
    const hd = this.terrainHeight(x, y - d), hu = this.terrainHeight(x, y + d);
    let nx = -(hr - hl) / (2 * d), ny = -(hu - hd) / (2 * d), nz = 1;
    const len = Math.hypot(nx, ny, nz);
    out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
    return out;
  }
}
