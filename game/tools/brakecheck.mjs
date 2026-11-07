// Brake check (FEAT-065): rides the Rider physics on exact inclined planes (no pack, no browser)
// and reports hockey-stop times and distances against Komissarov's figures, the board's swing,
// release, and standing still across the hill afterwards.
// node tools/brakecheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brakecheck-')), 'rider.mjs');
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

/** start at `v` m/s travelling along `dir` (radians from +y, clockwise) on a `deg` slope */
function start(deg, v, dir = 0, disc = 'board') {
  const r = new Rider(plane(deg), null);
  r.discipline = disc;
  r.reset(0, 0, dir);
  r.vx = Math.sin(dir) * v; r.vy = Math.cos(dir) * v;
  r.vz = -Math.tan(deg * D) * r.vy; // on the surface, or the first step reads it as a launch
  return r;
}
const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a)) / D;

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

/** hold brake from speed to a stop: time, distance, board angle to travel at 0.3 s */
function stop(deg, v, disc = 'board', steer = 0) {
  const r = start(deg, v, 0, disc), inp = input();
  inp.brake = true; inp.steer = steer;
  let t = 0, dist = 0, gamma03 = NaN, x0 = r.x, y0 = r.y, peak = 0;
  while (t < 10) {
    r.update(DT, inp); t += DT;
    if (Math.abs(t - 0.3) < DT / 2) gamma03 = Math.abs(angle(r.boardYaw - Math.atan2(r.vx, r.vy)));
    peak = Math.max(peak, r.brakeAcc);
    if (r.speed < 0.3) break;
  }
  dist = Math.hypot(r.x - x0, r.y - y0);
  return { r, t, dist, gamma03, peak };
}

console.log('hockey stop, board, 10 m/s, holding brake:');
for (const deg of [5, 15, 25, 35, 45]) {
  const s = stop(deg, 10);
  console.log(`  ${String(deg).padStart(2)} deg: stop ${s.t.toFixed(2)} s over ${s.dist.toFixed(1)} m, board ${s.gamma03.toFixed(0)} deg off travel at 0.3 s, peak ${s.peak.toFixed(1)} m/s^2, side ${s.r.brakeSide}`);
}
{
  // paper (15 deg, 10 m/s): Psi 45 stops in 1.4 s over 7 m once fully across; the swing adds a little
  const s = stop(15, 10);
  check('15 deg stop matches the 45-degree-edge target', s.t > 1.3 && s.t < 2.0 && s.dist > 6 && s.dist < 10, `${s.t.toFixed(2)} s, ${s.dist.toFixed(1)} m (target about 1.4 s + swing, 7 m)`);
  check('board swings across in a fraction of a second', s.gamma03 > 75, `${s.gamma03.toFixed(0)} deg off travel at 0.3 s`);
  check('default stance is heelside', s.r.brakeSide === -1, `side ${s.r.brakeSide}`);
  check('steer right picks toeside', stop(15, 10, 'board', 1).r.brakeSide === 1, '');
  const steep = stop(40, 10);
  check('a 40 deg pitch still stops', steep.t < 6, `${steep.t.toFixed(2)} s over ${steep.dist.toFixed(1)} m`);
}
{
  // stand still afterwards, brake released
  const s = stop(15, 10);
  const r = s.r, inp = input();
  for (let i = 0; i < 30; i++) r.update(DT, Object.assign(inp, { brake: true }));
  inp.brake = false;
  const x0 = r.x, y0 = r.y;
  for (let i = 0; i < 360; i++) r.update(DT, inp);
  const moved = Math.hypot(r.x - x0, r.y - y0);
  const across = Math.abs(Math.sin(r.boardYaw)) ; // fall line is +y, so across = |sin(yaw)|
  check('stands still across the hill after release', moved < 0.05 && across > 0.9, `moved ${(moved * 100).toFixed(1)} cm in 3 s, board ${angle(r.boardYaw).toFixed(0)} deg from the fall line`);
  // turn back down the fall line and ride off
  inp.steer = r.boardYaw > 0 ? -1 : 1;
  for (let i = 0; i < 360 && Math.abs(angle(r.heading)) > 10; i++) r.update(DT, inp);
  inp.steer = 0;
  for (let i = 0; i < 240; i++) r.update(DT, inp);
  check('steering toward the fall line rides off again', r.speed > 3, `${r.speed.toFixed(1)} m/s 2 s after pointing downhill`);
}
{
  // short dab of brake at speed: board swings back after release
  const r = start(15, 15), inp = input();
  inp.brake = true;
  for (let i = 0; i < 36; i++) r.update(DT, inp);
  const mid = Math.abs(angle(r.boardYaw - Math.atan2(r.vx, r.vy)));
  inp.brake = false;
  for (let i = 0; i < 60; i++) r.update(DT, inp);
  const after = Math.abs(angle(r.boardYaw - Math.atan2(r.vx, r.vy)));
  check('board swings back to travel after a short brake', mid > 60 && after < 3 && r.speed > 5, `${mid.toFixed(0)} deg while braking, ${after.toFixed(1)} deg 0.5 s after release, still ${r.speed.toFixed(1)} m/s`);
}
{
  // no brake: board stays on the heading, and straight-lining is unchanged
  const r = start(15, 10), inp = input();
  for (let i = 0; i < 240; i++) r.update(DT, inp);
  check('no brake: board stays on the heading', r.boardYaw === r.heading && r.scrape < 0.01, `yaw ${angle(r.boardYaw).toFixed(2)}, heading ${angle(r.heading).toFixed(2)}`);
}
{
  const fast = stop(15, 10, 'ski');
  const slow = stop(15, 3, 'ski');
  check('skis hockey stop at speed', fast.gamma03 > 75, `${fast.gamma03.toFixed(0)} deg, stop ${fast.t.toFixed(2)} s over ${fast.dist.toFixed(1)} m`);
  check('skis snowplough when slow', slow.gamma03 < 10 && slow.t < 4, `${slow.gamma03.toFixed(0)} deg, stop ${slow.t.toFixed(2)} s over ${slow.dist.toFixed(1)} m`);
}
fs.rmSync(path.dirname(out), { recursive: true, force: true });
console.log(fails ? `${fails} check(s) failed` : 'all brake checks passed');
process.exit(fails ? 1 : 0);
