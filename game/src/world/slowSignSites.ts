import type { Difficulty, Features } from '../pack/types';

/**
 * FEAT-306: where the SLOW signs go, from the pack's runs and lifts alone (no three.js, no terrain, so
 * tools/slowsigncheck.mjs runs it in node on a pack's features.json). Real resorts put Slow Zone signs at
 * the entrance to a slow zone: where a run merges into another, and on the approach to the base area and
 * its lifts (the research on the card, #673). So a site is the bottom end of a green or blue run (the
 * last way of its name, OSM splitting a run into several ways) that ends on another run or near a lift's
 * bottom station, set a little uphill of that end, off to the side of the run. Blacks and freeride never
 * get one, nor does the upper part of a run (the sign sits in the bottom quarter of the named run's
 * length). Most runs get none: a hash of the run's id keeps a share of the candidates and sites keep
 * SPACING apart, so the same signs appear on every load and a merge of several greens gets one sign.
 */

export interface SlowSignSite {
  /** the point on the run's line the sign stands beside (pack metres) */
  cx: number; cy: number; cz: number;
  /** the direction riders travel there, radians clockwise from north (downhill along the run) */
  heading: number;
  /** unit vector across the run toward the sign's side (pack x, y) and the first-guess distance from the line (m) */
  sx: number; sy: number; offset: number;
  /** the run: its index in features.runs, its name and difficulty */
  run: number; name: string | null; difficulty: Difficulty | null;
  /** why it has a sign: a merge into another run, or the approach to a lift's bottom (the base area) */
  reason: 'merge' | 'base';
  /** metres from the top of the named run's chain to the sign, and the chain's whole length */
  along: number; length: number;
}

/** green and blue; blacks, double blacks, freeride and unrated runs never get a sign */
export const SLOW_DIFFICULTIES: readonly (Difficulty | null)[] = ['novice', 'easy', 'intermediate'];
/** ways of one name join where an end lies this close to the next one's start (as sim/Courses.ts) */
const JOIN = 25;
/** a run's bottom end this close to another run's line is a merge */
const MERGE_R = 20;
/** a run's bottom end this close to a lift's bottom station is a base / lift approach */
const BASE_R = 150;
/** the sign stands this share of the run's length above its bottom end, kept within these metres */
const UP_SHARE = 0.12, UP_MIN = 15, UP_MAX = 40;
/** the sign must sit in this bottom share of the named run */
export const LOWER_SHARE = 0.25;
/** shorter runs (connectors, cat-track stubs) get none */
const MIN_LENGTH = 80;
/** share of candidates kept, by reason: base approaches are where real resorts sign most */
const KEEP: Record<SlowSignSite['reason'], number> = { base: 0.5, merge: 0.25 };
/** a base approach with this hash share gets a pair, one sign each side */
const PAIR = 0.35;
/** no two sites closer than this (m) */
const SPACING = 150;
/** first-guess distance of the sign from the run's line (m); world/SlowSigns.ts moves it to the groomed edge once the mask has loaded */
export const OFFSET = 12;
/** clearances (m): from any lift line, from a chairlift's bottom (its maze, world/LiftLines.ts), from any station */
const LIFT_LINE_CLEAR = 15, CHAIR_BOTTOM_CLEAR = 45, STATION_CLEAR = 20;
/** steepest run at the sign (rise over run along the line): a slow zone is gentle ground, not a rollover or a jump's landing */
const MAX_GRADE = Math.tan(22 * Math.PI / 180);

type P3 = [number, number, number];

/** FNV-1a of a string, as 0..1 */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) / 4294967296;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / l2)) : 0;
  return Math.hypot(px - ax - ex * t, py - ay - ey * t);
}

function lineDist(px: number, py: number, pts: readonly P3[]): number {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  return d;
}

function polyLength(pts: readonly P3[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

function inside(px: number, py: number, poly: readonly [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** lifts: their lines, bottom stations, and which are chairs (those have a maze behind the loading point) */
function liftEnds(features: Pick<Features, 'lifts'>) {
  return features.lifts.filter((l) => l.stations.length >= 2).map((l) => {
    const s = l.stations, a = s[0], b = s[s.length - 1];
    const bottom = a[2] <= b[2] ? a : b;
    return { line: s as P3[], bottom, chair: /chair/.test(l.type) };
  });
}

/** A test for where a sign may stand: clear of lift lines, chair mazes, stations and building footprints. */
export function signClear(features: Pick<Features, 'lifts' | 'buildings'>): (x: number, y: number) => boolean {
  const lifts = liftEnds(features);
  const footprints = features.buildings.filter((b) => b.points.length >= 3).map((b) => b.points);
  return (x, y) =>
    lifts.every((l) => lineDist(x, y, l.line) >= LIFT_LINE_CLEAR
      && Math.hypot(l.bottom[0] - x, l.bottom[1] - y) >= (l.chair ? CHAIR_BOTTOM_CLEAR : STATION_CLEAR)
      && l.line.every((s) => Math.hypot(s[0] - x, s[1] - y) >= STATION_CLEAR))
    && footprints.every((f) => !inside(x, y, f));
}

/** The SLOW sign sites for a pack: deterministic, the same list on every load. `slug` seeds the hash with the resort too. */
export function slowSignSites(features: Pick<Features, 'runs' | 'lifts' | 'buildings'>, slug: string): SlowSignSite[] {
  // every run line, downhill, with its chain key (OSM splits one run into several ways of the same name)
  const ways = features.runs.map((r, i) => {
    if (r.area || r.points.length < 2) return null;
    let pts = r.points.map((p) => [p[0], p[1], p[2]] as P3);
    if (pts[0][2] < pts[pts.length - 1][2]) pts = pts.reverse();
    return { i, key: r.name ?? `#${i}`, pts, len: polyLength(pts), top: pts[0], bot: pts[pts.length - 1] };
  });
  const live = ways.filter((w): w is NonNullable<typeof w> => !!w);
  const byKey = new Map<string, typeof live>();
  for (const w of live) { let a = byKey.get(w.key); if (!a) byKey.set(w.key, a = []); a.push(w); }
  const near = (a: P3, b: P3) => Math.hypot(a[0] - b[0], a[1] - b[1]) < JOIN;

  const lifts = liftEnds(features);

  const cands: (SlowSignSite & { h: number; pair: boolean })[] = [];
  for (const w of live) {
    const r = features.runs[w.i];
    if (!SLOW_DIFFICULTIES.includes(r.difficulty)) continue;
    const kin = byKey.get(w.key)!;
    // only the bottom way of the named run: no way of the same name carries on from its end
    if (kin.some((o) => o !== w && near(o.top, w.bot))) continue;
    // the chain's length above: walk up through ways of the same name whose bottom meets this top
    let length = w.len, head = w;
    const used = new Set([w]);
    for (;;) {
      const up = kin.find((o) => !used.has(o) && near(o.bot, head.top));
      if (!up) break;
      used.add(up); length += up.len; head = up;
    }
    if (length < MIN_LENGTH) continue;
    // why: the end lies on another run's line, or near a lift's bottom
    const [bx, by] = w.bot;
    const base = lifts.some((l) => Math.hypot(l.bottom[0] - bx, l.bottom[1] - by) < BASE_R);
    const merge = live.some((o) => o.key !== w.key && lineDist(bx, by, o.pts) < MERGE_R);
    if (!base && !merge) continue;
    const reason: SlowSignSite['reason'] = base ? 'base' : 'merge';
    const id = `${slug}:${r.osmId ?? `${w.key}:${w.i}`}`;
    const h = hash01(id);
    if (h >= KEEP[reason]) continue;
    // the point `up` metres above the bottom end, along the way
    const up = Math.min(UP_MAX, Math.max(UP_MIN, UP_SHARE * length), w.len * 0.9);
    if (up < UP_MIN * 0.6 || up > LOWER_SHARE * length) continue;
    let k = w.pts.length - 1, left = up;
    while (k > 0) {
      const a = w.pts[k - 1], b = w.pts[k], seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (seg >= left) break;
      left -= seg; k--;
    }
    if (k === 0) continue;
    const a = w.pts[k - 1], b = w.pts[k], seg = Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1]));
    const t = 1 - left / seg;
    const cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t, cz = a[2] + (b[2] - a[2]) * t;
    // gentle ground: the grade along the line over the 30 m about the sign
    {
      const back = w.pts[Math.max(0, k - 2)], fwd = w.pts[Math.min(w.pts.length - 1, k + 1)];
      const run = Math.hypot(fwd[0] - back[0], fwd[1] - back[1]);
      if (run > 1 && (back[2] - fwd[2]) / run > MAX_GRADE) continue;
    }
    const dx = (b[0] - a[0]) / seg, dy = (b[1] - a[1]) / seg; // downhill
    const heading = Math.atan2(dx, dy);
    const side = hash01(id + ':side') < 0.5 ? -1 : 1;
    // across the run: 90 degrees clockwise of the travel direction is the rider's right
    const rx = dy, ry = -dx;
    cands.push({
      cx, cy, cz, heading, sx: rx * side, sy: ry * side, offset: OFFSET, run: w.i, name: r.name, difficulty: r.difficulty, reason,
      along: length - up, length, h, pair: reason === 'base' && hash01(id + ':pair') < PAIR,
    });
  }

  const clear = signClear(features);

  // sparse: lowest hash first, each SPACING from the ones kept
  cands.sort((p, q) => p.h - q.h);
  const out: SlowSignSite[] = [];
  for (const c of cands) {
    if (out.some((o) => Math.hypot(o.cx - c.cx, o.cy - c.cy) < SPACING)) continue;
    const sides = c.pair ? [1, -1] : [1];
    const kept = sides.map((s) => ({ ...c, sx: c.sx * s, sy: c.sy * s }))
      .filter((s) => clear(s.cx + s.sx * s.offset, s.cy + s.sy * s.offset));
    for (const { h: _h, pair: _p, ...s } of kept) out.push(s);
  }
  return out;
}
