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

// ---- FEAT-133: the brake's edge changes speed and direction
/** brake from `v` m/s down a `deg` slope; after the stance is picked (heelside, no steer) hold the
 *  steer at `mod` x the brake side: +1 into the edge, -1 away from it. Returns the stop time (NaN if
 *  still moving after `T` s), the distance, and the travel direction's turn (deg) and speed at `tAt` s */
function stopMod(deg, v, mod, T = 6, tAt = 1.5) {
  const r = start(deg, v), inp = input();
  inp.brake = true;
  let t = 0, tStop = NaN, turnAt = NaN, speedAt = NaN, turnEnd = 0;
  const x0 = r.x, y0 = r.y;
  while (t < T) {
    if (t > 0.05) inp.steer = mod * r.brakeSide;
    r.update(DT, inp); t += DT;
    if (r.speed > 0.5) turnEnd = angle(Math.atan2(r.vx, r.vy));
    if (Math.abs(t - tAt) < DT / 2) { turnAt = turnEnd; speedAt = r.speed; }
    if (r.speed < 0.3) { tStop = t; break; }
  }
  return { r, t: tStop, dist: Math.hypot(r.x - x0, r.y - y0), turnAt, speedAt, turnEnd, side: r.brakeSide };
}
console.log('FEAT-133: brake from 10 m/s on 15 deg, steering into the edge, none, and away from it:');
{
  const into = stopMod(15, 10, 1), plain = stopMod(15, 10, 0), away = stopMod(15, 10, -1);
  for (const [k, s] of [['into', into], ['plain', plain], ['away', away]]) console.log(`  ${k.padEnd(5)}: ${Number.isNaN(s.t) ? 'still going at 6 s' : `stop ${s.t.toFixed(2)} s over ${s.dist.toFixed(1)} m`}, travel turned ${s.turnEnd.toFixed(0)} deg (${s.turnAt.toFixed(0)} deg and ${s.speedAt.toFixed(1)} m/s at 1.5 s), Psi ${(plain.r.brakePsi / D).toFixed(0)}`);
  check('steering into the edge stops harder than a plain brake', into.t < plain.t && into.dist < plain.dist, `${into.t.toFixed(2)} s / ${into.dist.toFixed(1)} m vs ${plain.t.toFixed(2)} s / ${plain.dist.toFixed(1)} m`);
  check('a plain brake stops about as quickly as before (1.3 to 2.0 s)', plain.t > 1.3 && plain.t < 2.0, `${plain.t.toFixed(2)} s`);
  check('a plain hockey stop runs nearly straight (hook under 15 deg)', Math.abs(plain.turnEnd) < 15, `${plain.turnEnd.toFixed(0)} deg`);
  check('steering away from the edge lets off the brake: no stop on 15 deg', Number.isNaN(away.t) || away.t > 2 * plain.t, Number.isNaN(away.t) ? 'still moving at 6 s' : `${away.t.toFixed(2)} s`);
  check('steering away gives a skidded turn toward the edge side', Math.sign(away.turnAt) === away.side && Math.abs(away.turnAt) > 15 && Math.abs(away.turnEnd) > 40, `${away.turnAt.toFixed(0)} deg at 1.5 s, ${away.turnEnd.toFixed(0)} deg by the stop (side ${away.side})`);
}
{
  // a partial swing on a gentle pitch: slows and turns together
  const s = stopMod(8, 10, -1, 1.5);
  console.log(`  skidded turn on 8 deg from 10 m/s, steer away: ${s.turnAt.toFixed(0)} deg and ${s.speedAt.toFixed(1)} m/s at 1.5 s`);
  check('skidded turn slows and turns together', Math.abs(s.turnAt) > 20 && s.speedAt < 8.5, `${s.turnAt.toFixed(0)} deg, ${s.speedAt.toFixed(1)} m/s`);
}
{
  // side-slip: creeping down a 35 deg pitch with the board across, a soft edge slides and a hard edge holds
  const soft = stopMod(35, 2, -1, 3), hard = stopMod(35, 2, 1, 3);
  console.log(`  35 deg side-slip from 2 m/s: soft edge ${Number.isNaN(soft.t) ? `${soft.r.speed.toFixed(1)} m/s after 3 s, ${soft.dist.toFixed(1)} m down` : `stopped in ${soft.t.toFixed(2)} s`}; hard edge ${Number.isNaN(hard.t) ? `${hard.r.speed.toFixed(1)} m/s after 3 s` : `stopped in ${hard.t.toFixed(2)} s over ${hard.dist.toFixed(1)} m`}`);
  check('a soft edge side-slips down a steep pitch', Number.isNaN(soft.t) && soft.r.vy > 1, `${soft.r.speed.toFixed(1)} m/s after 3 s, vy ${soft.r.vy.toFixed(1)}`);
  check('a hard edge holds on it', !Number.isNaN(hard.t) && hard.t < 2.5, Number.isNaN(hard.t) ? `${hard.r.speed.toFixed(1)} m/s after 3 s` : `${hard.t.toFixed(2)} s`);
}
{
  // release out of a skidded turn: the board squares up on the new line and carries on
  const r = start(10, 12), inp = input();
  inp.brake = true;
  for (let i = 0; i < 120; i++) { if (i > 6) inp.steer = -r.brakeSide; r.update(DT, inp); }
  const turned = angle(Math.atan2(r.vx, r.vy)), vMid = r.speed;
  inp.brake = false; inp.steer = 0;
  let jolt = 0;
  for (let i = 0; i < 60; i++) { const h0 = r.heading; r.update(DT, inp); jolt = Math.max(jolt, Math.abs(angle(r.heading - h0)) / DT); }
  const off = Math.abs(angle(r.heading - Math.atan2(r.vx, r.vy))), yaw = Math.abs(angle(r.boardYaw - r.heading));
  console.log(`  release after 1 s of skidded turn at 12 m/s on 10 deg: turned ${turned.toFixed(0)} deg at ${vMid.toFixed(1)} m/s; 0.5 s later heading ${off.toFixed(1)} deg off travel, board ${yaw.toFixed(1)} deg off heading, ${r.speed.toFixed(1)} m/s, peak heading rate ${jolt.toFixed(0)} deg/s`);
  check('release rolls back onto the new line without a jolt', off < 5 && yaw < 3 && r.speed > 0.8 * vMid && jolt < 200, `${off.toFixed(1)} deg off travel, ${jolt.toFixed(0)} deg/s peak`);
}
fs.rmSync(path.dirname(out), { recursive: true, force: true });
console.log(fails ? `${fails} check(s) failed` : 'all brake checks passed');
process.exit(fails ? 1 : 0);
