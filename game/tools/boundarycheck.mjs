// Out of bounds check (FEAT-305): the boundary rope's outline, its crossings and the 1 in 30 yeti roll, render-free
// (no browser, no pack needed). On a made-up resort (a block of parallel runs on a plane) it checks that the outline
// derived from the runs is one counter-clockwise ring around them with posts about 12 m apart and an open gap where a
// road crosses it; that a move over the rope reads out (+1) or in (-1); that with the odds at 1 (?yetiodds=1) a
// crossing wakes the yeti once, with the toast word for word, the yeti about 45 m behind the rider and chasing, and no
// second wake inside the cooldown; that with a fixed seed about 1 in 30 of many crossings hit; and that the egg ends
// cleanly (gives up, a real Outrun start, a teleport) and keeps no Outrun best score.
// With a pack folder it also reports that pack's outline and rolls its own rope:
//   node tools/boundarycheck.mjs [packDir]        (exit code 1 if a check fails)
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GAME } from './paths.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boundarycheck-'));
const entry = path.join(tmp, 'entry.ts');
const src = (p) => JSON.stringify(path.join(GAME, 'src', p).replace(/\\/g, '/'));
fs.writeFileSync(entry, `export { Boundary, SPACING } from ${src('sim/Boundary.ts')};
export { OutOfBounds, ODDS, COOLDOWN } from ${src('sim/OutOfBounds.ts')};
export { YetiEgg, OOB_TOAST } from ${src('modes/YetiEgg.ts')};
export { Outrun } from ${src('sim/Outrun.ts')};
`);
const out = path.join(tmp, 'oob.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { Boundary, SPACING, OutOfBounds, ODDS, COOLDOWN, YetiEgg, OOB_TOAST, Outrun } = await import(pathToFileURL(out).href);

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };

// ---- a made-up resort: 9 runs falling north to south (x -400..400, y -600..600) on a 20 degree plane, one lift,
// a road crossing the bottom edge
const tan = Math.tan(20 * Math.PI / 180);
const runs = [];
for (let i = 0; i < 9; i++) { const x = -400 + i * 100; runs.push({ name: `r${i}`, difficulty: 'easy', groomed: true, gladed: false, points: [[x, 600, 0], [x + 20, 0, 0], [x, -600, 0]] }); }
const features = {
  runs, lifts: [{ name: 'L', type: 'chair_lift', stations: [[0, -600, 0], [0, 600, 0]], towers: [], cable: [] }],
  buildings: [], roads: [{ name: 'road', kind: 'road', width: 6, points: [[0, -900, 0], [0, -500, 0]] }], water: [], peaks: [], labels: [],
};
const bounds = { minX: -1500, minY: -1500, maxX: 1500, maxY: 1500 };
const t0 = performance.now();
const b = Boundary.fromFeatures(features, bounds);
const ms = performance.now() - t0;
ok(b && b.source === 'runs' && b.rings.length === 1, `one ring derived from the runs (${b?.rings.length} rings, ${ms.toFixed(0)} ms)`);
const r = b.rings[0], n = r.length / 2;
let area = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, gapMax = 0, sum = 0;
for (let i = 0; i < n; i++) {
  const j = (i + 1) % n;
  area += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1];
  minX = Math.min(minX, r[2 * i]); maxX = Math.max(maxX, r[2 * i]); minY = Math.min(minY, r[2 * i + 1]); maxY = Math.max(maxY, r[2 * i + 1]);
  const g = Math.hypot(r[2 * j] - r[2 * i], r[2 * j + 1] - r[2 * i + 1]);
  gapMax = Math.max(gapMax, SPACING - g); sum += g;
}
ok(area > 0, 'the ring runs counter-clockwise (in bounds on the left)');
ok(minX > -480 && minX < -430 && maxX > 440 && maxX < 500 && minY > -680 && minY < -630 && maxY > 630 && maxY < 680,
  `the rope sits about 60 m outside the outermost runs (x ${minX.toFixed(0)}..${maxX.toFixed(0)}, y ${minY.toFixed(0)}..${maxY.toFixed(0)})`);
ok(Math.abs(sum / n - SPACING) < 0.5 && gapMax < 4, `posts about ${SPACING} m apart (mean ${(sum / n).toFixed(2)} m; the tightest corner ${(SPACING - gapMax).toFixed(1)} m)`);
const open = b.open[0].reduce((a, v) => a + v, 0);
ok(open > 0 && open < 5, `the road leaves a gap in the rope (${open} open spans)`);
ok(b.crossing(0, 600, 0, 700) === 1, 'north over the top rope: out (+1)');
ok(b.crossing(0, 700, 0, 600) === -1, 'and back: in (-1)');
ok(b.crossing(-100, 0, 100, 0) === 0, 'a move inside: no crossing');
ok(b.crossing(0, -640, 0, -700) === 0, 'over the road gap: no crossing');
const viaPack = Boundary.fromFeatures({ ...features, boundary: [{ name: 'area', points: [[-500, -700], [500, -700], [500, 700], [-500, 700]] }] }, bounds);
ok(viaPack.source === 'pack' && viaPack.crossing(0, 690, 0, 710) === 1 && viaPack.crossing(0, 0, 10, 0) === 0, "the pack's own boundary polygon wins when it has one");
// a pack polygon with a hole (an enclave): the inner ring, given counter-clockwise like the outer, reads as out of bounds
const withHole = Boundary.fromFeatures({ ...features, boundary: [
  { name: 'area', points: [[-500, -700], [500, -700], [500, 700], [-500, 700]] },
  { name: 'enclave', points: [[-100, -100], [100, -100], [100, 100], [-100, 100]] },
] }, bounds);
ok(withHole.rings.length === 2 && withHole.crossing(0, -110, 0, -90) === 1 && withHole.crossing(0, 90, 0, 110) === -1 && withHole.crossing(0, 690, 0, 710) === 1,
  'a ring inside the outer one is a hole: into it is out (+1), out of it is back in (-1), the outer rope still out');

// ---- the dice: a rider going out over the top rope, 2 s a crossing
function crossOut(d, wait) {
  // inside, then over the rope northward in 0.1 s steps, then back in (far from the first crossing in time)
  d.update(0, 640, wait); d.update(0, 650, 0.1);
  let res = 'none';
  for (let y = 650; y <= 720; y += 2) { const c = d.update(0, y, 0.05); if (c !== 'none') res = c; }
  for (let y = 720; y >= 640; y -= 2) d.update(0, y, 0.05);
  return res;
}
{
  const d = new OutOfBounds(b, 1, 7);
  ok(crossOut(d, 10) === 'hit', 'odds 1: the first crossing hits');
  ok(crossOut(d, 10) === 'out', 'and the next one, 14 s later, is inside the cooldown (no hit twice in a row)');
  ok(crossOut(d, COOLDOWN) === 'hit', `after the ${COOLDOWN} s cooldown it can hit again`);
  ok(d.rolls === 2 && d.crossings === 3, `rolls once per crossing outside the cooldown (${d.rolls} rolls, ${d.crossings} crossings)`);
  d.update(0, 600, 1); const tele = d.update(0, 900, 0.02);
  ok(tele === 'none', 'a teleport over the rope is not a crossing');
}
{
  const d = new OutOfBounds(b, ODDS, 12345), N = 6000;
  for (let i = 0; i < N; i++) crossOut(d, COOLDOWN + 1);
  const rate = d.hits / d.rolls;
  ok(d.rolls === N && Math.abs(rate - 1 / 30) < 0.008, `seed 12345: ${d.hits} hits in ${d.rolls} crossings = 1 in ${(1 / rate).toFixed(1)} (want about 1 in 30)`);
}

// ---- the egg on a fake session: odds 1 (?yetiodds=1), the rider riding north over the top rope at 12 m/s
{
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const pack = {
    meta: { slug: 'test' }, features,
    groundHeight: (x, y) => tan * y, terrainHeight: (x, y) => tan * y,
    groundNormal: (x, y, o = [0, 0, 1]) => { const k = 1 / Math.hypot(tan, 1); o[0] = 0; o[1] = -tan * k; o[2] = k; return o; },
  };
  const toasts = [], puffs = [];
  let views = 0;
  const world = {
    boundary: b, boundaryRope: { visible: true }, lifts: { rideLength: () => 0, seatAt: () => ({ x: 0, y: 0, z: 0 }) },
    monsters: { update: (sim) => { views = sim.monsters.length; }, clear: () => { views = 0; } },
    puffs: { emit: (...a) => puffs.push(a) },
  };
  const rider = { x: 0, y: 560, z: 0, vx: 0, vy: 12, speed: 12, onGround: true, edgeAngle: 0, crashed: 0, landingShock: 0, spin: 0 };
  const ctx = { pack, params: { yetiodds: 1 }, audio: { chase: () => null } };
  const egg = new YetiEgg(ctx, world, { rider, toast: (t) => toasts.push(t) });
  const frame = { dt: 1 / 60, tuck: false, onLift: false, frozen: false, elapsed: 0, detached: false };
  const ride = (e, secs, outrun = false) => { for (let i = 0; i < secs * 60; i++) { rider.y += rider.vy / 60; rider.z = tan * rider.y; e.update(frame, outrun, false); } };
  ride(egg, 10); // 120 m: over the rope at about y 660
  ok(toasts.length === 1 && toasts[0] === OOB_TOAST && OOB_TOAST === "Bad boy, that's out of bounds.", `one toast: "${toasts[0]}"`);
  ok(egg.wakes === 1 && egg.on && views === 1, `the yeti woke once and is drawn (${egg.wakes} wakes, ${views} view)`);
  const m = egg.sim.monsters[0];
  ok(m && egg.sim.phase === 'chase' && m.y < rider.y && m.speed > 3, `it chases from behind (${(rider.y - m.y).toFixed(0)} m back at ${m.speed.toFixed(1)} m/s)`);
  ride(egg, 1);
  rider.y = 600; egg.update(frame, false, false); egg.moved(); ride(egg, 6); // back in, out again inside the cooldown (map teleport ends this yeti)
  ok(toasts.length === 1 && egg.wakes === 1, 'crossing again inside the cooldown: no second toast or yeti');
  ok(!egg.on && views === 0 && puffs.length > 0, 'a teleport ends the chase in a puff of snow');
  // a fresh egg: the chase gives up on its own, and a real Outrun start ends it
  const egg2 = new YetiEgg(ctx, world, { rider, toast: (t) => toasts.push(t) });
  rider.y = 560; egg2.update(frame, false, false);
  ride(egg2, 10);
  ok(egg2.on, 'a second session wakes it again');
  ride(egg2, 1, true);
  ok(!egg2.on && views === 0, 'a real Outrun starting ends the egg chase');
  const egg3 = new YetiEgg(ctx, world, { rider, toast: (t) => toasts.push(t) });
  rider.y = 560; rider.vy = 30; egg3.update(frame, false, false);
  ride(egg3, 60);
  ok(egg3.wakes === 1 && !egg3.on, 'left far behind (30 m/s), it gives up');
  ok(![...store.keys()].some((k) => k.startsWith('outrun:')), 'no Outrun best score written');
  const egg0 = new YetiEgg({ ...ctx, params: { yetiodds: 0 } }, world, { rider, toast: (t) => toasts.push(t) });
  rider.y = 560; rider.vy = 12; egg0.update(frame, false, false); ride(egg0, 10);
  ok(egg0.wakes === 0 && egg0.last !== 'hit', '?yetiodds=0: never');
}

// ---- the chase spawn from a standstill below a crest 30 m uphill: at 45 m the yeti would be hidden behind it
{
  const crest = (x, y) => (y < 30 ? Math.max(0, y) * 0.5 : 15 - (y - 30));
  const pack = { meta: { slug: 'test' }, features, groundHeight: crest, terrainHeight: crest,
    groundNormal: (x, y, o = [0, 0, 1]) => { const k = 1 / Math.hypot(0.5, 1); o[0] = 0; o[1] = -0.5 * k; o[2] = k; return o; } };
  const sim = new Outrun(pack, { rideLength: () => 0, seatAt: () => ({ x: 0, y: 0, z: 0 }) });
  const r = { x: 0, y: 0, z: 0, vx: 0, vy: 0, speed: 0, onGround: true, edgeAngle: 0, crashed: 0, landingShock: 0, spin: 0 };
  sim.startChase({ difficulty: 'chill', escape: 'endless', gentle: false }, r, 45);
  const m = sim.monsters[0], d = m ? Math.hypot(m.x - r.x, m.y - r.y) : NaN;
  ok(m && m.y > 0 && d >= 19 && d <= 31, `standing below a crest, the yeti starts uphill on this side of it (${d.toFixed(0)} m away, not 45)`);
}

// ---- a real pack, if given
const packDir = process.argv[2];
if (packDir) {
  const f = JSON.parse(fs.readFileSync(path.join(packDir, 'features.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(packDir, 'meta.json'), 'utf8'));
  const t1 = performance.now();
  const pb = Boundary.fromFeatures(f, meta.bounds);
  const t = performance.now() - t1;
  ok(!!pb, `${meta.slug}: ${pb?.rings.length} rings, ${pb?.posts} posts, ${(pb?.length / 1000).toFixed(1)} km of rope from the ${pb?.source}, ${pb?.open.reduce((s, o) => s + o.reduce((a, v) => a + v, 0), 0)} open spans, ${t.toFixed(0)} ms`);
  if (pb) {
    // walk across every 5th span, out and back, with the default odds and a fixed seed
    const d = new OutOfBounds(pb, ODDS, 99);
    let outs = 0;
    pb.rings.forEach((r, ri) => {
      const k = r.length / 2;
      for (let i = 0; i < k; i += 5) {
        if (pb.open[ri][i]) continue;
        const j = (i + 1) % k, mx = (r[2 * i] + r[2 * j]) / 2, my = (r[2 * i + 1] + r[2 * j + 1]) / 2;
        const ex = r[2 * j] - r[2 * i], ey = r[2 * j + 1] - r[2 * i + 1], L = Math.hypot(ex, ey), nx = ey / L, ny = -ex / L; // right of the span: out
        d.update(mx - nx * 5, my - ny * 5, COOLDOWN + 1);
        if (d.update(mx + nx * 5, my + ny * 5, 0.5) !== 'none') outs++;
        d.update(mx - nx * 5, my - ny * 5, 0.5);
      }
    });
    ok(outs === d.crossings && d.rolls > 50, `${meta.slug}: every rope span crossed outward reads out (${outs}); ${d.hits} hits in ${d.rolls} rolls`);
  }
}

console.log(fails ? `${fails} check(s) failed` : 'all boundary checks passed');
process.exit(fails ? 1 : 0);
