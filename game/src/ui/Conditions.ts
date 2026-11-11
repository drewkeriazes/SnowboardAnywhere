import { snowLabel, type SnowState } from '../sim/SnowConditions';
import type { SurfaceInfo } from '../sim/rider/types';
import { PLANE_SPEED } from '../sim/rider/tuning';
import { mogulSize } from '../terrain/Moguls';

/**
 * FEAT-221: what the snow is doing to you, in plain words, for the HUD's first line: the snow kind
 * (with its depth when it is loose and deep), the mogul size on a bump field, and at most two tags
 * from numbers the rider already has ("Powder 14 in · floating", "Moguls 4 ft · Ice · edges
 * skittering"). No new physics.
 */

/** the rider values the readout reads (a Rider has them all) */
export interface ConditionsRider {
  speed: number;
  slopeDeg: number;
  washout: number;
  noseSink: number;
  catchRisk: number;
  snow: SnowState;
  surface: SurfaceInfo;
}

/** mogul field strength from which the readout names the bumps */
export const MOGUL_SHOW = 0.3;
/** chop and slush show their depth past this much loose snow (m); powder always does */
const DEPTH_SHOW = 0.1;
/** new text has to hold this long (s) before it replaces what is shown */
export const HOLD = 0.5;
/** smoothing time (s) on the bump size: the slope swings over each bump face */
const MOGUL_TAU = 1.5;

/** the tags in order, first match wins, at most two shown */
const TAGS: [string, (r: ConditionsRider) => boolean][] = [
  ['edge letting go', (r) => r.washout > 0.5],
  ['bogging down', (r) => r.snow.powder > 0.5 && r.speed < 0.6 * PLANE_SPEED],
  ['nose sinking', (r) => r.noseSink > 0.3],
  ['floating', (r) => r.snow.powder > 0.5 && r.speed >= PLANE_SPEED],
  ['edges skittering', (r) => r.snow.grip < 0.75],
  // a bump field already reads "Moguls 4 ft" in front, so the bumps from moguls go without saying
  ['bumpy', (r) => r.snow.jolt > 0.3],
  ['heavy and slow', (r) => r.snow.slush > 0.5],
  ['catchy', (r) => r.catchRisk > 0.5],
  ['brushing shrubs', (r) => r.surface.shrub > 0.2],
  ['in the trees', (r) => r.surface.canopy > 0.4],
];

/** the tags that apply, at most two */
export function conditionTags(r: ConditionsRider): string[] {
  const out: string[] = [];
  for (const [tag, when] of TAGS) {
    if (when(r)) { out.push(tag); if (out.length === 2) break; }
  }
  return out;
}

/** the bump height (m) of the field under the rider at this slope */
export function mogulHeightAt(r: ConditionsRider): number {
  return Math.min(1, r.surface.moguls) * mogulSize(Math.tan(r.slopeDeg * Math.PI / 180));
}

/** the readout for one instant, no hold; `mogulM` the bump height to name (m) */
export function conditionsNow(r: ConditionsRider, metric: boolean, mogulM = mogulHeightAt(r)): string {
  const parts: string[] = [];
  if (r.surface.moguls >= MOGUL_SHOW) {
    const size = metric ? `${(Math.round(mogulM * 10) / 10).toFixed(1)} m` : `${Math.round(mogulM * 3.28084 * 2) / 2} ft`;
    parts.push(`Moguls ${size}`);
  }
  const k = r.snow.kind, d = r.snow.depth;
  let snow = snowLabel(k);
  if (k === 'powder' || ((k === 'chop' || k === 'slush') && d > DEPTH_SHOW)) {
    // inches in 2 in steps, cm in 5 cm steps
    const n = metric ? Math.round(d * 100 / 5) * 5 : Math.round(d * 39.3701 / 2) * 2;
    if (n > 0) snow += metric ? ` ${n} cm` : ` ${n} in`;
  }
  parts.push(snow);
  const tags = conditionTags(r);
  if (tags.length) parts.push(tags.join(', '));
  return parts.join(' · ');
}

// the one hold: what is shown, the text waiting to replace it and since when, the smoothed bump size
let shown = '', pending = '', pendingSince = 0, last = -Infinity, mogulM = 0;

/** forget what was shown: the next call shows its text at once (tests, a new session) */
export function resetConditions(): void { shown = ''; pending = ''; pendingSince = 0; last = -Infinity; mogulM = 0; }

/**
 * The HUD's conditions text. A change only shows once the new text has held for HOLD seconds, so a
 * state that flips every frame never flickers. `now` is in seconds. A gap in the calls (the line
 * hidden in the air or on foot) starts over and shows the snow at once.
 */
export function conditionsText(r: ConditionsRider, metric: boolean, now = performance.now() / 1000): string {
  const dt = now - last;
  const fresh = !(dt >= 0 && dt < 0.25);
  last = now;
  const target = mogulHeightAt(r);
  mogulM = fresh || r.surface.moguls < MOGUL_SHOW ? target : mogulM + (target - mogulM) * (1 - Math.exp(-dt / MOGUL_TAU));
  const text = conditionsNow(r, metric, mogulM);
  if (fresh || shown === '') { shown = text; pending = ''; return shown; }
  if (text === shown) { pending = ''; return shown; }
  if (text !== pending) { pending = text; pendingSince = now; return shown; }
  if (now - pendingSince >= HOLD) { shown = text; pending = ''; }
  return shown;
}
