// Carve feel check (BUG-053): rides the Rider physics on exact inclined planes (no pack, no
// browser) and reports high-speed turn rates, radii and the edge-to-edge crossover against the
// targets in the issue: at 25 m/s a full carve comes round at about 1.0 rad/s standing and 0.7
// tucked (a radius of 20 to 30 m standing), and an edge change takes about 0.3 s with the board
// still coming round through the crossover. Slow pivots are unchanged.
// node tools/carvecheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carvecheck-')), 'rider.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'sim', 'Rider.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { Rider } = await import(pathToFileURL(out).href);

const D = Math.PI / 180;
/** plane falling toward +y (north) at `deg` degrees */
function plane(deg) {
  const t = Math.tan(deg * D), k = 1 / Math.hypot(t, 1);
  return {
    mask: null, coarseFallbacks: 0,
    groundHeight: (x, y) => -t * y,
    groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = t * k; o[2] = k; return o; },
  };
}
const input = () => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false });
const DT = 1 / 120;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** start at `v` m/s travelling along `dir` (radians from +y, clockwise) on a groomed `deg` slope */
function start(deg, v, dir = 0, disc = 'board') {
  const r = new Rider(plane(deg), null);
  r.discipline = disc;
  r.surface.groomed = 1; // a groomer: no pack mask, so the surface stays as set
  r.reset(0, 0, dir);
  r.vx = Math.sin(dir) * v; r.vy = Math.cos(dir) * v;
  r.vz = -Math.tan(deg * D) * r.vy * Math.cos(dir);
  return r;
}

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

/** one step; returns the heading rate (rad/s) over it */
function tick(r, inp) { const h0 = r.heading; r.update(DT, inp); return wrap(r.heading - h0) / DT; }

/**
 * Full steer from `v` m/s down the fall line: the peak turn rate over the first `T` seconds, the
 * speed and edge there, and the time for the rate to reach 90 % of its peak.
 */
function turn(deg, v, tuck, steer = 1, T = 1.2) {
  const r = start(deg, v), inp = input();
  inp.steer = steer; inp.tuck = tuck;
  let peak = 0, vAt = v, edgeAt = 0, t = 0, t90 = NaN;
  const rates = [];
  while (t < T) {
    const rate = Math.abs(tick(r, inp)); t += DT;
    rates.push({ t, rate });
    if (rate > peak) { peak = rate; vAt = r.speed; edgeAt = Math.abs(r.edge) / D; }
  }
  for (const s of rates) if (s.rate >= 0.9 * peak) { t90 = s.t; break; }
  return { r, peak, radius: vAt / peak, vAt, edgeAt, t90 };
}

/**
 * Linked carves: hold right until the edge settles, then left. Returns the crossover time (steer
 * reversal to 90 % of the settled edge on the new side) and the longest stretch with the heading
 * rate below `dead` rad/s during it (the hang between turns).
 */
function crossover(deg, v, tuck, dead = 0.2) {
  const r = start(deg, v), inp = input();
  inp.steer = 1; inp.tuck = tuck;
  for (let i = 0; i < 120; i++) tick(r, inp); // 1 s on the right edge, wherever the speed has gone
  const settled = Math.abs(r.edge), v0 = r.speed;
  inp.steer = -1;
  let t = 0, tCross = NaN, hang = 0, run = 0, minRate = Infinity, minEdge = Infinity;
  while (t < 2) {
    const rate = tick(r, inp); t += DT;
    if (Number.isNaN(tCross)) {
      if (Math.abs(rate) < dead) { run += DT; hang = Math.max(hang, run); } else run = 0;
      minRate = Math.min(minRate, Math.abs(rate));
    }
    if (r.edge < -0.9 * settled && Number.isNaN(tCross)) tCross = t;
  }
  return { settled: settled / D, v0, tCross, hang, minRate };
}

console.log('full carve at 25 m/s on a 15 deg groomer (peak over 1.2 s):');
const stand = turn(15, 25, false), tucked = turn(15, 25, true);
console.log(`  standing: ${stand.peak.toFixed(2)} rad/s (${(stand.peak / D).toFixed(0)} deg/s), radius ${stand.radius.toFixed(0)} m at ${stand.vAt.toFixed(1)} m/s, edge ${stand.edgeAt.toFixed(0)} deg, 90 % of peak at ${stand.t90.toFixed(2)} s`);
console.log(`  tucked:   ${tucked.peak.toFixed(2)} rad/s (${(tucked.peak / D).toFixed(0)} deg/s), radius ${tucked.radius.toFixed(0)} m at ${tucked.vAt.toFixed(1)} m/s, edge ${tucked.edgeAt.toFixed(0)} deg, 90 % of peak at ${tucked.t90.toFixed(2)} s`);
check('standing full carve at speed comes round at about 1.0 rad/s', stand.peak > 0.9 && stand.peak < 1.25, `${stand.peak.toFixed(2)} rad/s`);
check('standing carve radius 20 to 30 m', stand.radius >= 18 && stand.radius <= 32, `${stand.radius.toFixed(0)} m`);
check('tucked full carve at speed comes round at about 0.7 rad/s', tucked.peak > 0.6 && tucked.peak < 1.0, `${tucked.peak.toFixed(2)} rad/s`);
check('tucked radius a little wider than standing', tucked.radius > stand.radius && tucked.radius < 45, `${tucked.radius.toFixed(0)} m vs ${stand.radius.toFixed(0)} m`);

console.log('edge to edge at 25 m/s on a 15 deg groomer:');
const xs = crossover(15, 25, false), xt = crossover(15, 25, true);
console.log(`  standing: ${xs.settled.toFixed(0)} deg to -${xs.settled.toFixed(0)} deg in ${xs.tCross.toFixed(2)} s, longest hang below 0.2 rad/s ${xs.hang.toFixed(2)} s, slowest ${xs.minRate.toFixed(2)} rad/s`);
console.log(`  tucked:   ${xt.settled.toFixed(0)} deg to -${xt.settled.toFixed(0)} deg in ${xt.tCross.toFixed(2)} s, longest hang below 0.2 rad/s ${xt.hang.toFixed(2)} s, slowest ${xt.minRate.toFixed(2)} rad/s`);
check('edge to edge in about 0.3 s standing', xs.tCross > 0.15 && xs.tCross < 0.4, `${xs.tCross.toFixed(2)} s`);
check('edge to edge in about 0.3 s tucked', xt.tCross > 0.1 && xt.tCross < 0.4, `${xt.tCross.toFixed(2)} s`);
// the old edge lets go as the new one rolls in, so the rate passes through zero for an instant; the
// steer yaw means it is an instant (was 0.37 s under 0.3 rad/s before BUG-053)
check('no hang at the crossover (board keeps coming round)', xs.hang < 0.12 && xt.hang < 0.12, `${xs.hang.toFixed(2)} s standing, ${xt.hang.toFixed(2)} s tucked below 0.2 rad/s`);

{
  // across the hill: turning back up out of a traverse should not be much weaker than turning down into it
  const down = turn(25, 20, false, 1), up = turn(25, 20, false, -1);
  // start heading east (90 deg): steer right turns down toward the fall line (south is uphill here: the plane falls to +y, so turning toward +y is down)
  const r1 = start(25, 20, Math.PI / 2), r2 = start(25, 20, Math.PI / 2);
  const i1 = Object.assign(input(), { steer: -1 }), i2 = Object.assign(input(), { steer: 1 });
  let pDown = 0, pUp = 0;
  for (let i = 0; i < 144; i++) { pDown = Math.max(pDown, Math.abs(tick(r1, i1))); pUp = Math.max(pUp, Math.abs(tick(r2, i2))); }
  console.log(`traverse at 20 m/s on 25 deg: turning down ${pDown.toFixed(2)} rad/s, turning up across the hill ${pUp.toFixed(2)} rad/s (fall-line turns ${down.peak.toFixed(2)} / ${up.peak.toFixed(2)})`);
  check('turning back up across the hill keeps most of the turn', pUp > 0.6 * pDown, `${pUp.toFixed(2)} vs ${pDown.toFixed(2)} rad/s`);
}
{
  // slow: the pivot turn at 3 m/s is the same as before (FEAT-127 unchanged)
  const s = turn(10, 3, false, 1, 0.5);
  console.log(`slow pivot at 3 m/s: ${s.peak.toFixed(2)} rad/s`);
  check('slow pivot turn unchanged (about 1.7 rad/s, as before BUG-053)', s.peak > 1.5 && s.peak < 1.9, `${s.peak.toFixed(2)} rad/s`);
}
{
  // straight-lining: no steer, no turn
  const r = start(15, 20), inp = input();
  let worst = 0;
  for (let i = 0; i < 240; i++) worst = Math.max(worst, Math.abs(tick(r, inp)));
  check('no steer: no turn', worst < 1e-6 && Math.abs(r.edge) < 1e-6, `${worst.toExponential(1)} rad/s`);
}
fs.rmSync(path.dirname(out), { recursive: true, force: true });
console.log(fails ? `${fails} check(s) failed` : 'all carve checks passed');
process.exit(fails ? 1 : 0);
