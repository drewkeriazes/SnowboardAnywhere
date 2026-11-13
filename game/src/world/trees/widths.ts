import { SPECIES, hash01 } from './species';

/**
 * FEAT-298: crown width by openness. A tree with open ground round it grows wide, one in a crowd tall and narrow.
 * The pipeline (MapPacker-SnowboardAnywhere/pipeline/widths.py) measures each tree's openness, widens it, thins the
 * stand's stems so the canopy stays what it was, and writes `meta.instances.crownWidths` with the model it used. With
 * that block a pack's record field 4 is the crown radius to draw (m), for every tree in trees/ and farTrees/, and the
 * lower half of a stand image carries a width factor per 4 m cell in B. A pack without it draws as before.
 *
 * The game applies the widths it is given; the model itself runs here only for the clump impostors' stand patches
 * (clumps.ts), which are not pack trees and have to widen the same way or the forest changes shape at the handover.
 */
export interface CrownWidthsMeta {
  /** the open-grown crown radius / height a widened species moves toward (lidar, open-grown conifers: 0.15 to 0.17) */
  open: number;
  /** the neighbours' crown cover within 10 m at which a tree is fully open, and fully closed */
  cover: [number, number];
  /** a widened tree's own width draw: 1 - jitter .. 1 + jitter, mean 1 */
  jitter: number;
  /** the species ids that widen (low crown bases; a high-crown form would be a wide cap on a bare pole) */
  widen: number[];
  /** the hand multipliers (resort and species) already in the widths, per species id, for the clumps */
  k: number[];
  /** the detected crowns' drawn area over their area at the species radii (pack-wide), for the crowns' growth past the stems */
  crownArea?: number;
}

/** B of a stand image's lower half: the width factor x WIDTH_STEP (0 = none, factor 1) */
export const WIDTH_STEP = 100;
/** the stem's own width draw (hash salt) */
const S_WIDTH = 29;

/** the crown widths block a pack carries, or null (record field 4 is then the species formula, nudged as before) */
export function crownWidthsOf(meta: { instances?: { crownWidths?: CrownWidthsMeta } }): CrownWidthsMeta | null {
  const w = meta.instances?.crownWidths;
  return w && Array.isArray(w.widen) && w.open > 0 ? w : null;
}

/** openness 0 (crowded) .. 1 (open) from the neighbours' crown cover within 10 m */
export function openness(m: CrownWidthsMeta, cover10: number): number {
  const u = Math.max(0, Math.min(1, (cover10 - m.cover[0]) / Math.max(1e-6, m.cover[1] - m.cover[0])));
  return 1 - u * u * (3 - 2 * u);
}

/** the width factor (on the species' radius) openness gives a species, before the tree's own draw */
export function openFactor(m: CrownWidthsMeta, species: number, open: number): number {
  if (!m.widen.includes(species)) return 1;
  const rr = SPECIES[species].radius;
  return 1 + ((Math.max(m.open, rr) - rr) / rr) * open;
}

/** a widened tree's own width draw at (x, y) (pack metres); 1 for a species that does not widen */
export function widthDraw(m: CrownWidthsMeta, species: number, x: number, y: number): number {
  return m.widen.includes(species) ? 1 - m.jitter + 2 * m.jitter * hash01(x, y, S_WIDTH) : 1;
}

/** E[draw^2], what the draw does to a widened species' mean crown area */
export function drawArea(m: CrownWidthsMeta): number {
  return 1 + (m.jitter * m.jitter) / 3;
}
