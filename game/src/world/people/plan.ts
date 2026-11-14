/**
 * FEAT-307: where the static people stand on the runs, planned once per pack from features.json alone
 * (no terrain, no three.js, so tools/peoplecheck.mjs can run it in node). Seeded per run (the pack's slug
 * and the run's OSM id), so a run always gets the same people: about half the runs get none, the rest one
 * or two. `StaticPeople` then finds the run's real middle and edges from the groomed mask, the fall line
 * and the ground once the tiles are in, and drops a spot that lands in the trees, on rock or on a rollover.
 */
import type { Features, RunFeature } from '../../pack/types';

export type PersonKind = 'pair' | 'sitter';

export interface PlannedPerson {
  /** stable id: run index and slot */
  id: string;
  run: number;
  runName: string | null;
  kind: PersonKind;
  /** the pair stands across the middle of the run (1 in 10 pairs; every pair with ?people=center) */
  center: boolean;
  /** which side of the run (+1 right of the run's direction, -1 left) and how far out, 0..1 of the half width */
  side: 1 | -1;
  frac: number;
  /** the point on the run's line (pack metres) and the line's direction there (unit, pack x / y) */
  x: number; y: number; z: number;
  dx: number; dy: number;
  /** 0..1, for the outfits and the small variations */
  seed: number;
}

export interface PlanOptions {
  /** ?people=center: every spot is a pair across the middle of the run; ?people=sitters: every spot a sitting snowboarder (the same spots) */
  force?: 'center' | 'sitters';
  /** points to keep clear (the Free ride start, landmarks), pack metres */
  avoid?: [number, number][];
  /** FEAT-306: the SLOW signs' sites on their runs' lines (pack metres): nobody within SIGN_CLEAR of one */
  signs?: [number, number][];
}

/** runs shorter than this get nobody (m); a short one (to LONG_RUN) at most one */
export const MIN_RUN = 150, LONG_RUN = 300;
/** keep clear of a lift's line by this much each side (m), and of its stations (the bottom's maze and funnel, the top's unload) */
export const LIFT_CLEAR = 18, BOTTOM_CLEAR = 70, TOP_CLEAR = 40;
/** keep clear of the Free ride start and the landmarks (m), and of another planned person (m) */
export const AVOID_CLEAR = 80, PEOPLE_GAP = 60;
/** keep clear of a SLOW sign's site (m): both stand out toward a run's edge, so this is measured along the lines */
export const SIGN_CLEAR = 40;
/** 1 in this many pairs stands dead centre */
export const CENTER_ONE_IN = 10;
/** terrain parks and features: runs whose name says so get nobody (the packs carry no jumps of their own) */
export const PARK_RE = /terrain park|half ?pipe|superpipe|\bjumps?\b|kicker|\bjibs?\b|\brails?\b|boarder ?cross|skier ?cross/i;

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a of a string */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / l2));
  return Math.hypot(px - ax - ex * t, py - ay - ey * t);
}

/** true when (x, y) is on a lift's line or at its stations */
export function nearLift(features: Features, x: number, y: number): boolean {
  for (const l of features.lifts) {
    const s = l.stations;
    if (s.length < 2) continue;
    // the lower station is the bottom (the maze and the funnel behind it)
    const lo = s[0][2] <= s[s.length - 1][2] ? s[0] : s[s.length - 1], hi = lo === s[0] ? s[s.length - 1] : s[0];
    if (Math.hypot(x - lo[0], y - lo[1]) < BOTTOM_CLEAR || Math.hypot(x - hi[0], y - hi[1]) < TOP_CLEAR) return true;
    const line = l.cable.length >= 2 ? l.cable : s;
    for (let i = 1; i < line.length; i++) if (segDist(x, y, line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]) < LIFT_CLEAR) return true;
    for (let i = 1; i < s.length; i++) if (segDist(x, y, s[i - 1][0], s[i - 1][1], s[i][0], s[i][1]) < LIFT_CLEAR) return true;
  }
  return false;
}

/** the run's length and the point and direction at a distance along it */
function along(run: RunFeature, cum: number[], d: number): { x: number; y: number; z: number; dx: number; dy: number } {
  const p = run.points;
  let i = 1;
  while (i < p.length - 1 && cum[i] < d) i++;
  const a = p[i - 1], b = p[i], seg = cum[i] - cum[i - 1] || 1e-9, t = Math.max(0, Math.min(1, (d - cum[i - 1]) / seg));
  const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
  return { x: a[0] + ex * t, y: a[1] + ey * t, z: a[2] + (b[2] - a[2]) * t, dx: ex / l, dy: ey / l };
}

/** How many people a run of this length gets (0..2), from its own random stream. */
export function countFor(length: number, r: number): number {
  if (length < MIN_RUN) return 0;
  if (length < LONG_RUN) return r < 0.7 ? 0 : 1;
  return r < 0.45 ? 0 : r < 0.85 ? 1 : 2;
}

/**
 * Plan the people for a pack: per run (not areas, not parks, at least MIN_RUN long), 0 to 2 spots in the
 * middle 70% of its length, each a chatting pair of skiers (55%) or a snowboarder sitting (45%), away from
 * the lifts, the start, the landmarks and each other. Same features and slug, same plan.
 */
export function planPeople(features: Features, slug: string, opts: PlanOptions = {}): PlannedPerson[] {
  const out: PlannedPerson[] = [];
  const avoid = opts.avoid ?? [], signs = opts.signs ?? [];
  features.runs.forEach((run, ri) => {
    if (run.area || run.points.length < 2 || PARK_RE.test(run.name ?? '')) return;
    const cum = [0];
    for (let i = 1; i < run.points.length; i++) cum.push(cum[i - 1] + Math.hypot(run.points[i][0] - run.points[i - 1][0], run.points[i][1] - run.points[i - 1][1]));
    const len = cum[cum.length - 1];
    const rand = rng(hashString(`${slug}:${run.osmId ?? `${ri}:${run.name ?? ''}`}`));
    const n = countFor(len, rand());
    for (let k = 0; k < n; k++) {
      // the slots split the middle of the run, so two on one run stand well apart
      const lo = n === 1 ? 0.15 : k === 0 ? 0.15 : 0.55, hi = n === 1 ? 0.85 : k === 0 ? 0.45 : 0.85;
      const t = lo + (hi - lo) * rand();
      const kind: PersonKind = rand() < 0.55 ? 'pair' : 'sitter';
      const cr = rand(); // drawn every time, so ?people=center keeps the same spots
      const center = kind === 'pair' && cr < 1 / CENTER_ONE_IN;
      const side: 1 | -1 = rand() < 0.5 ? -1 : 1;
      const frac = 0.6 + 0.25 * rand();
      const seed = rand();
      const p = along(run, cum, t * len);
      if (nearLift(features, p.x, p.y)) continue;
      if (avoid.some(([ax, ay]) => Math.hypot(p.x - ax, p.y - ay) < AVOID_CLEAR)) continue;
      if (signs.some(([sx, sy]) => Math.hypot(p.x - sx, p.y - sy) < SIGN_CLEAR)) continue;
      if (out.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < PEOPLE_GAP)) continue;
      const f = opts.force;
      out.push({ id: `${ri}.${k}`, run: ri, runName: run.name, kind: f === 'center' ? 'pair' : f === 'sitters' ? 'sitter' : kind, center: f === 'center' ? true : f === 'sitters' ? false : center, side, frac, ...p, seed });
    }
  });
  return out;
}
