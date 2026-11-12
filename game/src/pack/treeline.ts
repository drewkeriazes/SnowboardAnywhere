import type { PackMeta } from './types';

/** Colorado treeline (m), the value tuned on Vail; used when a pack has no measured `treeline` (DATA-021) */
export const DEFAULT_TREELINE = 3480;

/**
 * The resort's treeline (m): meta.treeline from the pipeline, else Colorado's (older packs, and packs whose box had no
 * forest to measure). `null` when the pack measured none (FEAT-234: forest from the bottom of the box to the top, Boston
 * Mills): no snow-ghost band, and a procedural forest that opens by slope and land cover only, not by elevation.
 */
export function treelineOf(meta: Pick<PackMeta, 'treeline'>): number | null {
  if (meta.treeline === null) return null;
  return meta.treeline ?? DEFAULT_TREELINE;
}
