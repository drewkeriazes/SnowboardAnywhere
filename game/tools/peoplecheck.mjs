// Static people check (FEAT-307), no browser and no GPU:
//   - the plan on a real pack's features.json (default vail): per-run counts (0 to 2, about half the runs none),
//     nobody on a lift's line or at its stations, at the start or on a terrain park run, the 1 in 10 centre
//     pairs, the same plan twice, and ?people=center / sitters keeping the same spots
//   - on a 15 degree test slope: a pair (forced to the centre) and a sitter are settled, baked to one mesh each
//     and put in the collider, a rider straight at them at 12 m/s is stopped (crashed), hidden they let it by
// node tools/peoplecheck.mjs [pack]        (exit code 1 if a check fails; reads <packs>/<pack>/features.json, SHOT_PACKS for another folder)
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { GAME, PACKS } from './paths.mjs';

const slug = process.argv[2] ?? 'vail';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peoplecheck-'));
const entry = path.join(dir, 'entry.ts');
const src = (p) => JSON.stringify(path.join(GAME, 'src', p).replace(/\\/g, '/'));
fs.writeFileSync(entry, [
  `export * from ${src('world/people/plan.ts')};`,
  `export { StaticPeople } from ${src('world/StaticPeople.ts')};`,
  `export { Rider } from ${src('sim/Rider.ts')};`,
  `export { Collider } from ${src('sim/Collider.ts')};`,
].join('\n'));
const out = path.join(dir, 'people.mjs');
// the bake needs no WebGL; localStorage-free modules only (Settings' presets are plain data)
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error', define: { 'import.meta.env': '{}' } });
globalThis.window ??= { devicePixelRatio: 1 }; // ui/Settings.ts (the outfit presets) reads it at load
const P = await import(pathToFileURL(out).href);

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

// ---------------------------------------------------------------- the plan on the pack
const packDir = path.join(PACKS, slug);
const features = JSON.parse(fs.readFileSync(path.join(packDir, 'features.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(packDir, 'meta.json'), 'utf8'));
const avoid = [[meta.start.x, meta.start.y]];
const plan = P.planPeople(features, slug, { avoid });
const runLen = (r) => { let s = 0; for (let i = 1; i < r.points.length; i++) s += Math.hypot(r.points[i][0] - r.points[i - 1][0], r.points[i][1] - r.points[i - 1][1]); return s; };
const runs = features.runs.map((r, i) => ({ i, name: r.name, len: runLen(r), area: !!r.area, n: plan.filter((p) => p.run === i).length }));
const typical = runs.filter((r) => !r.area && r.len >= P.LONG_RUN);
const hist = [0, 1, 2, 3].map((k) => typical.filter((r) => r.n === k).length);
console.log(`${slug}: ${features.runs.length} runs, ${typical.length} at least ${P.LONG_RUN} m; ${plan.length} people planned (${plan.filter((p) => p.kind === 'pair').length} pairs, ${plan.filter((p) => p.center).length} of them dead centre, ${plan.filter((p) => p.kind === 'sitter').length} sitters)`);
console.log(`  runs of ${P.LONG_RUN} m and more with 0 / 1 / 2 people: ${hist.slice(0, 3).join(' / ')}`);
for (const r of typical.filter((r) => r.n > 0).slice(0, 12)) console.log(`  ${r.name ?? '(unnamed)'} (${Math.round(r.len)} m): ${r.n}`);
check('0 to 2 per run', runs.every((r) => r.n <= 2), `most on one run ${Math.max(...runs.map((r) => r.n))}`);
const typicalMean = typical.reduce((a, r) => a + r.n, 0) / Math.max(1, typical.length);
check('a typical run shows 0 to 2 and many none', hist[0] / Math.max(1, typical.length) >= 0.35 && typicalMean >= 0.3 && typicalMean <= 1.2, `${(100 * hist[0] / Math.max(1, typical.length)).toFixed(0)}% of them none, ${typicalMean.toFixed(2)} a run on average`);
check('short runs at most one, the shortest none', runs.every((r) => r.len >= P.LONG_RUN || r.n <= 1) && runs.every((r) => r.len >= P.MIN_RUN || r.n === 0), 'ok');
// lifts: an independent distance from every lift line and station
const segD = (px, py, a, b) => { const ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey || 1e-9; const t = Math.max(0, Math.min(1, ((px - a[0]) * ex + (py - a[1]) * ey) / l2)); return Math.hypot(px - a[0] - ex * t, py - a[1] - ey * t); };
let liftMin = Infinity, stationMin = Infinity;
for (const p of plan) for (const l of features.lifts) {
  for (let i = 1; i < l.stations.length; i++) liftMin = Math.min(liftMin, segD(p.x, p.y, l.stations[i - 1], l.stations[i]));
  for (const s of l.stations) stationMin = Math.min(stationMin, Math.hypot(p.x - s[0], p.y - s[1]));
}
check('nobody on a lift line or at a station', liftMin >= P.LIFT_CLEAR - 1e-6 && stationMin >= P.TOP_CLEAR - 1e-6, `nearest lift line ${liftMin.toFixed(0)} m, nearest station ${stationMin.toFixed(0)} m`);
const parks = plan.filter((p) => P.PARK_RE.test(p.runName ?? ''));
check('nobody on a terrain park run', parks.length === 0, `${features.runs.filter((r) => P.PARK_RE.test(r.name ?? '')).length} park runs, ${parks.length} people on them`);
const startMin = Math.min(...plan.map((p) => Math.hypot(p.x - meta.start.x, p.y - meta.start.y)));
check('clear of the Free ride start', startMin >= P.AVOID_CLEAR, `nearest ${startMin.toFixed(0)} m`);
const pairs = plan.filter((p) => p.kind === 'pair'), centreShare = pairs.filter((p) => p.center).length / Math.max(1, pairs.length);
check('about 1 in 10 pairs dead centre', pairs.length < 20 || (centreShare > 0.03 && centreShare < 0.2), `${(100 * centreShare).toFixed(0)}% of ${pairs.length} pairs`);
check('the same plan twice', JSON.stringify(P.planPeople(features, slug, { avoid })) === JSON.stringify(plan), 'deterministic');
const forced = P.planPeople(features, slug, { avoid, force: 'center' }), sit = P.planPeople(features, slug, { avoid, force: 'sitters' });
const sameSpots = (a) => a.length === plan.length && a.every((p, i) => p.x === plan[i].x && p.y === plan[i].y);
check('?people=center: every spot a centre pair, the same spots', sameSpots(forced) && forced.every((p) => p.kind === 'pair' && p.center), `${forced.length} centre pairs`);
check('?people=sitters: every spot a sitter, the same spots', sameSpots(sit) && sit.every((p) => p.kind === 'sitter'), `${sit.length} sitters`);

// ---------------------------------------------------------------- on a test slope
const D = Math.PI / 180, DEG = 15, T = Math.tan(DEG * D), K = 1 / Math.hypot(T, 1);
/** a plane falling toward +y (north) at DEG degrees, with one long straight run down it */
const plane = {
  mask: null, coarseFallbacks: 0, meta: { slug: 'test' },
  features: { lifts: [], runs: [{ name: 'Test', difficulty: 'easy', groomed: true, gladed: false, osmId: 1, points: [[0, -400, 400 * T], [0, 400, -400 * T]] }], buildings: [], roads: [], water: [], peaks: [], labels: [] },
  fine: null, terrainHeight: (x, y) => -T * y, demHeight: (x, y) => -T * y, groundHeight: (x, y) => -T * y, finestRes: () => 1,
  groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = T * K; o[2] = K; return o; },
};
const input = () => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false });
const DT = 1 / 120;
function ride(collider, x0, y0, to) {
  const r = new P.Rider(plane, collider);
  r.surface.groomed = 1;
  r.reset(x0, y0, 0); // heading north, down the fall line
  r.vy = 12; r.vz = -T * 12;
  let t = 0, crashed = 0;
  while (r.y < to && t < 6) { r.update(DT, input()); crashed = Math.max(crashed, r.crashed); t += DT; }
  return { r, crashed };
}
for (const mode of ['center', 'sitters']) {
  // the plan is seeded: try test slugs until the straight run gets somebody
  let people = null, collider = null;
  for (let k = 0; k < 40 && !people; k++) {
    plane.meta.slug = `test${k}`;
    const c = new P.Collider(), sp = new P.StaticPeople(plane, c, mode);
    if (sp.spots.length) { people = sp; collider = c; }
  }
  if (!people) { check(`${mode}: a person on the test run`, false, 'no plan put anybody on it'); continue; }
  const s = people.spots[0];
  people.maintain(s.plan.x, s.plan.y - 20);
  const st = people.stats, placed = people.list()[0];
  check(`${mode}: settled and baked`, st.placed >= 1 && !!s.mesh && s.mesh.geometry.getAttribute('position').count > 1000, `${st.placed} placed, ${s.mesh?.geometry.getAttribute('position').count ?? 0} vertices in one mesh`);
  if (!placed) continue;
  // the fall line on the plane is +y (north); the pair across it, centred on the run (x 0)
  check(`${mode}: on the fall line of the slope`, Math.abs(placed.fy - 1) < 1e-3 && Math.abs(placed.slope - DEG) < 0.2, `fall line (${placed.fx.toFixed(3)}, ${placed.fy.toFixed(3)}), ${placed.slope.toFixed(1)} deg`);
  if (mode === 'center') {
    s.mesh.geometry.computeBoundingBox();
    const bb = s.mesh.geometry.boundingBox;
    check('centre pair across the middle of the run', Math.abs(placed.x) < 0.01 && bb.max.x - bb.min.x > 2 && bb.max.z - bb.min.z < 1.6, `at x ${placed.x.toFixed(2)}, ${(bb.max.x - bb.min.x).toFixed(2)} m across the run, ${(bb.max.z - bb.min.z).toFixed(2)} m along it, ${(bb.max.y - bb.min.y).toFixed(2)} m tall`);
  } else {
    s.mesh.geometry.computeBoundingBox();
    const bb = s.mesh.geometry.boundingBox;
    check('sitter low on the snow', bb.max.y - bb.min.y < 1.25 && bb.max.y - bb.min.y > 0.6, `${(bb.max.y - bb.min.y).toFixed(2)} m tall`);
  }
  // ride straight at it down the fall line, from 30 m above
  const hit = ride(collider, placed.x, placed.y - 30, placed.y + 10);
  check(`${mode}: riding into it stops the rider like any obstacle`, hit.crashed > 0 && hit.r.y < placed.y, `crashed ${hit.crashed.toFixed(2)}, stopped at ${(hit.r.y - placed.y).toFixed(2)} m from it, speed ${hit.r.speed.toFixed(2)}`);
  const clear = ride(collider, placed.x + 15, placed.y - 30, placed.y + 10);
  check(`${mode}: 15 m to the side rides on by`, clear.crashed === 0 && clear.r.y >= placed.y + 10, `reached ${(clear.r.y - placed.y).toFixed(1)} m past it`);
  people.visible = false;
  const off = ride(collider, placed.x, placed.y - 30, placed.y + 10);
  check(`${mode}: hidden (visible = false), it is out of the collider too`, off.crashed === 0 && off.r.y >= placed.y + 10, `reached ${(off.r.y - placed.y).toFixed(1)} m past it`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
