import type { Pack } from '../pack/Pack';
import type { Difficulty } from '../pack/types';

/**
 * Time-trial courses built from the real piste routes (features.json runs). OSM splits a run
 * into several ways with the same name, so segments with one name are oriented downhill and
 * chained top to bottom where one ends within JOIN m of the next start. The longest chain per
 * name becomes the course. Checkpoints are laid every CHECK_SPACING m along it.
 */
export interface Course {
  id: string;
  name: string;
  difficulty: Difficulty | null;
  points: [number, number, number][]; // downhill polyline, pack coords
  cum: number[]; // cumulative length
  length: number;
  drop: number; // m
  checkpoints: number[]; // distances along the course
  start: [number, number, number];
  finish: [number, number, number];
  dir: [number, number]; // unit vector down the course at the start
}

const JOIN = 25;
const MIN_LENGTH = 300;
const MIN_DROP = 60;
const CHECK_SPACING = 150;

export function buildCourses(pack: Pack): Course[] {
  const byName = new Map<string, { difficulty: Difficulty | null; segs: [number, number, number][][] }>();
  for (const r of pack.features.runs) {
    if (!r.name || (r as { area?: boolean }).area || r.points.length < 2) continue;
    let pts = r.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]);
    if (pts[0][2] < pts[pts.length - 1][2]) pts = pts.reverse(); // downhill
    let e = byName.get(r.name);
    if (!e) { e = { difficulty: r.difficulty, segs: [] }; byName.set(r.name, e); }
    e.segs.push(pts);
  }
  const courses: Course[] = [];
  for (const [name, { difficulty, segs }] of byName) {
    // try every segment as the head of a chain; keep the longest
    let best: [number, number, number][] | null = null, bestLen = 0;
    for (let h = 0; h < segs.length; h++) {
      const used = new Set([h]);
      let chain = [...segs[h]];
      for (;;) {
        const end = chain[chain.length - 1];
        let pick = -1, pd = JOIN;
        segs.forEach((sg, i) => {
          if (used.has(i)) return;
          const d = Math.hypot(sg[0][0] - end[0], sg[0][1] - end[1]);
          if (d < pd && sg[0][2] <= end[2] + 5) { pd = d; pick = i; }
        });
        if (pick < 0) break;
        used.add(pick);
        chain = chain.concat(segs[pick].slice(1));
      }
      const len = polyLength(chain);
      if (len > bestLen) { bestLen = len; best = chain; }
    }
    if (!best) continue;
    const drop = best[0][2] - best[best.length - 1][2];
    if (bestLen < MIN_LENGTH || drop < MIN_DROP) continue;
    const cum = [0];
    for (let i = 1; i < best.length; i++) cum.push(cum[i - 1] + Math.hypot(best[i][0] - best[i - 1][0], best[i][1] - best[i - 1][1]));
    const checkpoints: number[] = [];
    for (let d = CHECK_SPACING; d < bestLen - 40; d += CHECK_SPACING) checkpoints.push(d);
    const dx = best[1][0] - best[0][0], dy = best[1][1] - best[0][1], dl = Math.hypot(dx, dy) || 1;
    courses.push({
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, difficulty, points: best, cum, length: bestLen, drop, checkpoints,
      start: best[0], finish: best[best.length - 1], dir: [dx / dl, dy / dl],
    });
  }
  courses.sort((a, b) => b.drop - a.drop);
  return courses;
}

function polyLength(p: [number, number, number][]): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

/** Point at distance d along the course. */
export function pointAt(c: Course, d: number): [number, number, number] {
  const cum = c.cum;
  let lo = 0, hi = cum.length - 1;
  if (d <= 0) return c.points[0];
  if (d >= c.length) return c.points[hi];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
  const t = (d - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
  const a = c.points[lo], b = c.points[hi];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Distance from (x, y) to the course polyline, and how far along it the closest point is. */
export function nearestOnCourse(c: Course, x: number, y: number): { dist: number; along: number } {
  let best = Infinity, along = 0;
  for (let i = 1; i < c.points.length; i++) {
    const a = c.points[i - 1], b = c.points[i];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const l2 = ex * ex + ey * ey || 1e-6;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2));
    const px = a[0] + ex * t, py = a[1] + ey * t;
    const d = Math.hypot(x - px, y - py);
    if (d < best) { best = d; along = c.cum[i - 1] + Math.sqrt(l2) * t; }
  }
  return { dist: best, along };
}
