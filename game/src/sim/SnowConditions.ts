import type { SurfaceInfo } from './Rider';

/**
 * FEAT-053: what the snow is like under the board, from data the pack already has (the surface
 * mask, the ground normal for slope and aspect, the elevation, the canopy) and the day (the hour,
 * the weather, the new snow, the Snow conditions setting). Six kinds share the ground, weights
 * summing to 1:
 *  - groomed: corduroy, fast, grippy and predictable (and a dusting of new snow on it is still groomed)
 *  - powder: untracked soft snow off the groomers; keeps best in the shade of north aspects, high
 *    up, under the trees and after a storm; speed-scaled drag until the board planes, wider turns,
 *    the nose sinks when slow
 *  - chop: tracked-out off-piste (open ground skied all day): small random jolts through the board
 *  - ice: wind-scoured exposed ridges, and spring refreeze first thing: little edge grip, skids sooner
 *  - slush: low, sunny, late in the day, most of all in spring: heavy, slow, soft
 *  - rock: bare rock and scree (the grip and sound for it are FEAT-103's; it is here for the readout)
 * Shifts with the weather and the time of day: a storm adds powder everywhere, the afternoon sun
 * softens the south faces and the morning refreezes them in spring, and open off-piste gets tracked
 * out as the day goes on.
 */
export type SnowKind = 'groomed' | 'powder' | 'chop' | 'ice' | 'slush' | 'rock';

/** the day's conditions, set by main.ts from the settings and the weather */
export interface SnowWorld {
  /** local hour 0..24 */
  hour: number;
  /** 0..1 it is snowing now (storm 1, flurries about 0.3) */
  storm: number;
  /** 0..1 new snow lying (FEAT-105's cover: the New snow setting, plus what a storm adds as it falls) */
  newSnow: number;
  /** FEAT-077's Snow conditions setting */
  day: 'fresh' | 'mid' | 'spring';
  /** the mountain's elevation range (m), for where "high up" is */
  zLow: number; zHigh: number;
}

export interface SnowState {
  groomed: number; powder: number; chop: number; ice: number; slush: number; rock: number;
  /** the kind with the most weight here, for the HUD */
  kind: SnowKind;
  /** loose snow depth (m) a board or boot sinks into: about 0 on ice, up to 0.4 in deep powder */
  depth: number;
  // ---- derived for the physics (weighted blends of the per-kind values below)
  /** multiplier on the snow's sideways hold (1 on groomed) */
  grip: number;
  /** constant snow drag (m/s^2) */
  drag0: number;
  /** speed-scaled snow drag (m/s^2 per m/s), apart from the powder term the rider computes */
  drag1: number;
  /** multiplier on the carve's turn force and the sidecut's arc: below 1 the turns come round wider and slower */
  turn: number;
  /** 0..1 random edge jolts: 0 until the chop is about a third of the snow here, 1 when it is most of it */
  jolt: number;
  /** how much a skid scrubs speed (1 on groomed, less on ice) */
  skidScrub: number;
}

export function newSnowState(): SnowState {
  return { groomed: 1, powder: 0, chop: 0, ice: 0, slush: 0, rock: 0, kind: 'groomed', depth: 0.02, grip: 1, drag0: 0.07, drag1: 0, turn: 1, jolt: 0, skidScrub: 1 };
}

export const DEFAULT_SNOW_WORLD: SnowWorld = { hour: 13, storm: 0, newSnow: 0, day: 'mid', zLow: 0, zHigh: 3000 };

/** per-kind physics: grip, drag0 (m/s^2), drag1 (per m/s), turn, skid scrub, loose depth (m) */
const K: Record<SnowKind, [number, number, number, number, number, number]> = {
  groomed: [1.0, 0.07, 0.000, 1.0, 1.0, 0.025],
  powder: [0.85, 0.15, 0.000, 0.7, 1.3, 0.3],
  chop: [0.9, 0.18, 0.003, 0.9, 1.1, 0.08],
  ice: [0.5, 0.04, 0.000, 1.0, 0.4, 0.004],
  slush: [0.9, 0.5, 0.01, 0.85, 1.2, 0.06],
  rock: [1.0, 0.2, 0.000, 1.0, 1.0, 0.008],
};
/** the jolts start once the chop weight passes JOLT_FROM and are full by JOLT_FROM + JOLT_RANGE: a
 *  third of chop mixed into powder rides smooth */
const JOLT_FROM = 0.3, JOLT_RANGE = 0.5;
const KINDS: SnowKind[] = ['groomed', 'powder', 'chop', 'ice', 'slush', 'rock'];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The snow at a spot. `n` is the ground normal (pack frame: x east, y north, z up), `z` the elevation.
 */
export function snowAt(s: SurfaceInfo, n: ArrayLike<number>, z: number, w: SnowWorld, out: SnowState): SnowState {
  const hard = Math.min(1, s.rock + s.scree);
  const groomedRaw = Math.min(1, s.groomed) * (1 - hard);
  const off = Math.max(0, 1 - Math.min(1, s.groomed)) * (1 - hard);
  const trees = clamp01((s.canopy - 0.15) / 0.3);
  // aspect: how far the slope faces north (1), south (0), flat ground in the middle
  const fall = Math.hypot(n[0], n[1]);
  const shade = clamp01(0.5 + 0.5 * n[1] / Math.max(0.2, fall));
  const steep = clamp01((fall - 0.25) / 0.4); // 0 below about 15 degrees, 1 past about 33
  const e = clamp01((z - w.zLow) / Math.max(1, w.zHigh - w.zLow));
  // the day: the hour, the sun on this face, how long the hill has been skied
  const afternoon = clamp01((w.hour - 12) / 4);
  const morning = clamp01((9.5 - w.hour) / 2.5);
  const skiedDay = clamp01((w.hour - 8.5) / 6.5);
  const sunny = (1 - w.storm) * (1 - shade);
  const fresh = clamp01(w.newSnow + w.storm * 0.5);
  // warmth: spring softens everything the sun reaches by the afternoon, mid-season only the low
  // sunny faces late on; higher is colder
  const warmth = (w.day === 'spring' ? 0.55 + 0.45 * afternoon : w.day === 'mid' ? 0.35 * afternoon : 0.15 * afternoon)
    * (0.35 + 0.65 * sunny) * (1 - 0.75 * e) * (1 - fresh) * (1 - morning);
  const slushShare = clamp01(warmth * 1.4 - 0.25);
  // ice: spring refreeze first thing (the groomers scraped firm, the off-piste crusted), and wind
  // scouring on high open ground, steeper exposed faces most; new snow softens both
  const refreeze = (w.day === 'spring' ? 0.7 : w.day === 'mid' ? 0.2 : 0.05) * morning;
  const scoured = e * e * (1 - trees) * (0.6 + 0.4 * steep) * (1 - 0.6 * shade) * (1 - 0.7 * groomedRaw); // flat high ridgetops scour hardest
  const iceShare = clamp01(Math.max(refreeze, 0.8 * scoured) * (1 - fresh)) * (1 - slushShare);
  // off-piste: untracked powder keeps in the shade, high up, under the trees and after a storm; open
  // ground gets tracked out into chop as the day goes on (less when it is still snowing)
  const keep = clamp01(0.15 + 0.25 * shade + 0.15 * e + 0.45 * trees + fresh);
  const tracked = (w.day === 'fresh' ? 0.4 : w.day === 'mid' ? 0.9 : 0.75) * (0.05 + 0.95 * skiedDay) * (1 - trees) * (1 - fresh) * (1 - w.storm);
  const chopShare = clamp01(tracked * (1 - keep));
  // on the groomers a real fall of new snow rides like powder, a dusting is still corduroy
  const groomPow = clamp01((w.newSnow - 0.3) / 0.7) * 0.6;

  let groomed = groomedRaw * (1 - groomPow);
  let powder = groomedRaw * groomPow + off * (1 - chopShare);
  let chop = off * chopShare;
  // the day's ice and slush take their share of whatever snow is here (slush on the groomers too)
  const snow = groomed + powder + chop;
  const ice = snow * iceShare, slush = (snow - ice) * slushShare;
  const left = snow > 0 ? (snow - ice - slush) / snow : 0;
  groomed *= left; powder *= left; chop *= left;
  const rock = hard;
  const total = groomed + powder + chop + ice + slush + rock;
  const f = total > 1e-6 ? 1 / total : 0;
  out.groomed = groomed * f; out.powder = powder * f; out.chop = chop * f; out.ice = ice * f; out.slush = slush * f; out.rock = rock * f;
  if (total <= 1e-6) { out.groomed = 1; }

  // depth: powder deeper in the shade, under the trees and with new snow
  const powDepth = 0.12 + 0.08 * shade + 0.1 * trees + 0.2 * fresh;
  let kind: SnowKind = 'groomed', best = -1;
  let grip = 0, drag0 = 0, drag1 = 0, turn = 0, scrub = 0, depth = 0;
  for (const k of KINDS) {
    const wk = out[k];
    if (wk > best) { best = wk; kind = k; }
    const p = K[k];
    grip += wk * p[0]; drag0 += wk * p[1]; drag1 += wk * p[2]; turn += wk * p[3]; scrub += wk * p[4];
    depth += wk * (k === 'powder' ? powDepth : p[5]);
  }
  const jolt = clamp01((out.chop - JOLT_FROM) / JOLT_RANGE);
  out.kind = kind; out.grip = grip; out.drag0 = drag0; out.drag1 = drag1; out.turn = turn; out.jolt = jolt; out.skidScrub = scrub; out.depth = depth;
  return out;
}

/** the HUD's name for the snow here */
export function snowLabel(k: SnowKind): string {
  return k === 'groomed' ? 'Groomed' : k === 'powder' ? 'Powder' : k === 'chop' ? 'Chop' : k === 'ice' ? 'Ice' : k === 'slush' ? 'Slush' : 'Rock';
}
