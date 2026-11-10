/**
 * FEAT-159: how deep the snowpack is at a spot (m from the ground to the snow surface), for burying the
 * shrubs. The terrain is drawn as the snow surface, so a shrub of height h shows h minus this.
 *
 * Settled base by month at the reference height (3,000 m), Colorado-like: about 0.4 m in mid November,
 * 1.2 m at New Year, 1.6 m in March, gone by June (SEASON_BASE). Elevation scales it, from about a third
 * on the valley floors along I-70 (2,450 m) to 1.25 times from about 3,200 m up. Steep sun-facing slopes hold less
 * (south faces lose up to 40 %, 60 % on a spring day) and shaded north faces a little more. On top of the
 * base: the new snow (FEAT-105's cover, 0..1 after a storm, up to 0.35 m) and the loose layer of a fresh
 * day (FEAT-077, 0.1 m), the part `SnowConditions.depth` rides in. `override` (the `?snowdepth=` URL
 * parameter, and treeshot) sets one depth everywhere instead.
 *
 * The absolute heights suit the Colorado packs (Vail's base is at 2,475 m, Breckenridge's at 2,930 m).
 */

export interface SnowpackState {
  /** settled base at REF_Z (m) */
  base: number;
  /** new and loose snow on top, the same everywhere (m) */
  fresh: number;
  /** how much a south face loses at most (0..1) */
  sun: number;
  /** one depth everywhere (m), or null */
  override: number | null;
}

/** settled base at REF_Z (m) by month 1..12 (index 0 repeats December) */
const SEASON_BASE = [1.0, 1.25, 1.45, 1.6, 1.4, 0.6, 0.05, 0, 0, 0, 0.1, 0.45, 1.0];
const REF_Z = 3000;
/** the elevation scale: K_LO at Z_LO, rising by K_PER_KM per km, clamped to K_MIN..K_MAX */
const Z_LO = 2450, K_LO = 0.35, K_PER_KM = 1.18, K_MIN = 0.2, K_MAX = 1.25;
/** the most a full south face loses, and on a spring day; a north face gains up to NORTH */
const SOUTH = 0.4, SOUTH_SPRING = 0.6, NORTH = 0.1;
/** the slope (sine) at which the aspect counts in full */
const ASPECT_SLOPE = 0.35;
/** new snow at a full storm's cover (m), and a fresh day's loose layer (m) */
const NEW_SNOW = 0.35, FRESH_DAY = 0.1;

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** the day's snowpack: month 1..12, FEAT-077's snow conditions, FEAT-105's new snow cover 0..1 */
export function snowpackState(month: number, day: 'fresh' | 'mid' | 'spring', newSnow: number, override: number | null = null): SnowpackState {
  const m = Math.round(month), i = m >= 1 && m <= 12 ? m : 0;
  return {
    base: SEASON_BASE[i] / elevationK(REF_Z),
    fresh: NEW_SNOW * clamp(newSnow, 0, 1) + (day === 'fresh' ? FRESH_DAY : 0),
    sun: day === 'spring' ? SOUTH_SPRING : SOUTH,
    override,
  };
}

/** the elevation's share of the reference base */
export function elevationK(z: number): number {
  return clamp(K_LO + K_PER_KM * (z - Z_LO) / 1000, K_MIN, K_MAX);
}

/**
 * The aspect's share (about 0.6 .. 1.1) from the ground normal's horizontal part (pack: x east, y north),
 * before the day's `sun` factor: returns [south, north] weights 0..1 for snowpackDepth.
 */
export function aspectOf(nx: number, ny: number, out: [number, number] = [0, 0]): [number, number] {
  const s = Math.hypot(nx, ny);
  if (s < 1e-4) { out[0] = out[1] = 0; return out; }
  const k = Math.min(1, s / ASPECT_SLOPE), south = -ny / s; // the normal leans south on a south-facing slope
  out[0] = Math.max(0, south) * k; out[1] = Math.max(0, -south) * k;
  return out;
}

/** the snowpack depth (m) at height z on a slope with aspect weights [south, north] (aspectOf) */
export function snowpackDepth(st: SnowpackState, z: number, south: number, north: number): number {
  if (st.override !== null) return Math.max(0, st.override);
  const base = st.base * elevationK(z) * (1 - st.sun * south + NORTH * north);
  return Math.max(0, base) + st.fresh;
}

/** whether two states would bury the shrubs differently enough to redo them (about 2 cm) */
export function snowpackChanged(a: SnowpackState, b: SnowpackState): boolean {
  if ((a.override === null) !== (b.override === null)) return true;
  if (a.override !== null && b.override !== null) return Math.abs(a.override - b.override) > 0.005;
  return Math.abs(a.base - b.base) > 0.015 || Math.abs(a.fresh - b.fresh) > 0.02 || a.sun !== b.sun;
}
