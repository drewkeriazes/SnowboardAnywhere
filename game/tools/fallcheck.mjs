// Fall line check (FEAT-134): rides the Rider physics on exact inclined planes (no pack, no
// browser). A flat board across a slope should side-slip and swing toward the fall line unless
// the uphill edge is held; standing on a slope needs the uphill edge; the downhill edge catches;
// the assist setting at Off keeps the old rails. Prints the numbers and exits 1 on a failed check.
// node tools/fallcheck.mjs
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fallcheck-')), 'rider.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'sim', 'Rider.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { Rider } = await import(pathToFileURL(out).href);

const D = Math.PI / 180;
/** plane falling toward +y (north) at `deg` degrees; the fall line is heading 0 */
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
const EAST = Math.PI / 2;

/** start at `v` m/s along `dir` (radians from +y, clockwise) on a groomed `deg` slope with the fall line setting `fallLine` */
function start(deg, v, dir, fallLine) {
  const r = new Rider(plane(deg), null);
  r.fallLine = fallLine;
  r.surface.groomed = 1;
  r.reset(0, 0, dir);
  r.vx = Math.sin(dir) * v; r.vy = Math.cos(dir) * v;
  r.vz = -Math.tan(deg * D) * r.vy;
  return r;
}
let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

/**
 * Traverse east (the fall line is to the left) at `v` m/s with `steer` held for `T` s. Returns the
 * heading's angle from the fall line at the end (deg, 0 = straight down), the downhill speed vy,
 * the most skid seen, and when the heading came within 30 deg of the fall line (s, NaN if never).
 */
function traverse(deg, v, fallLine, steer = 0, T = 3) {
  const r = start(deg, v, EAST, fallLine), inp = input();
  inp.steer = steer;
  let t = 0, skid = 0, tDown = NaN, crashed = false, maxToFall = 0;
  while (t < T) {
    r.update(DT, inp); t += DT;
    skid = Math.max(skid, r.skid);
    maxToFall = Math.max(maxToFall, Math.abs(wrap(r.heading)) / D);
    if (Number.isNaN(tDown) && Math.abs(wrap(r.heading)) < 30 * D) tDown = t;
    if (r.crashed > 0) crashed = true;
  }
  return { r, toFall: Math.abs(wrap(r.heading)) / D, maxToFall, vy: r.vy, skid, tDown, crashed, speed: r.speed };
}

console.log('traverse east at 8 m/s, no input, 3 s (heading angle from the fall line at the end, downhill speed, skid):');
const real30 = traverse(30, 8, 1), real8 = traverse(8, 8, 1), off30 = traverse(30, 8, 0), assist30 = traverse(30, 8, 0.5);
for (const [k, s] of [['realistic 30 deg', real30], ['realistic 8 deg', real8], ['assisted 30 deg', assist30], ['off 30 deg', off30]]) {
  console.log(`  ${k.padEnd(17)}: ${s.toFall.toFixed(0)} deg from the fall line, vy ${s.vy.toFixed(1)} m/s, skid ${s.skid.toFixed(2)}, within 30 deg at ${Number.isNaN(s.tDown) ? 'never' : s.tDown.toFixed(2) + ' s'}`);
}
check('realistic: a flat board on 30 deg side-slips and swings down toward the fall line', real30.toFall < 30 && real30.vy > 3 && real30.skid > 0.2 && real30.tDown < 2.5, `${real30.toFall.toFixed(0)} deg, vy ${real30.vy.toFixed(1)}, skid ${real30.skid.toFixed(2)}, down at ${real30.tDown.toFixed(2)} s`);
check('realistic: on a gentle 8 deg the pull is mild', real8.toFall > 2 * real30.toFall && (Number.isNaN(real8.tDown) || real8.tDown > 2 * real30.tDown), `${real8.toFall.toFixed(0)} deg from the fall line after 3 s`);
check('assisted: between realistic and off', assist30.toFall > real30.toFall && assist30.toFall < off30.toFall && assist30.vy > off30.vy, `${assist30.toFall.toFixed(0)} deg, vy ${assist30.vy.toFixed(1)}`);
check('off: a flat board traverses on rails as before', off30.toFall > 85 && Math.abs(off30.vy) < 1 && off30.skid < 0.05, `${off30.toFall.toFixed(0)} deg, vy ${off30.vy.toFixed(1)}, skid ${off30.skid.toFixed(2)}`);

{
  // holding a little uphill edge (steer right: the hill is on the right heading east) keeps the traverse
  const hold = traverse(30, 8, 1, 0.3);
  const more = traverse(30, 8, 1, 0.7);
  console.log(`uphill edge on 30 deg: steer 0.3 -> ${hold.toFall.toFixed(0)} deg from the fall line, vy ${hold.vy.toFixed(1)}, skid ${hold.skid.toFixed(2)}, edge ${(Math.abs(hold.r.edge) / D).toFixed(0)} deg; steer 0.7 -> up to ${more.maxToFall.toFixed(0)} deg from the fall line (carving uphill), ${more.speed.toFixed(1)} m/s after 3 s`);
  check('a little uphill edge holds the traverse (or climbs a little)', hold.toFall > 75 && hold.vy < 1.5 && hold.skid < 0.3, `${hold.toFall.toFixed(0)} deg from the fall line, vy ${hold.vy.toFixed(1)}, skid ${hold.skid.toFixed(2)}`);
  check('more uphill edge carves up the hill', more.maxToFall > 120 && more.speed < hold.speed, `up to ${more.maxToFall.toFixed(0)} deg, ${more.speed.toFixed(1)} m/s`);
}
{
  // climbing (FEAT-134 tuning): nearly straight up the hill the board slows, stops and slides back
  // tail first into switch; the nose must not swing round downhill on the way. A climb across the
  // hill still comes round nose first (the end of a J-turn).
  const climb = (dirDeg, v, deg = 20, T = 5) => {
    const r = start(deg, v, dirDeg * D, 1), inp = input();
    let minNose = 180, tSwitch = NaN, t = 0;
    while (t < T) {
      r.update(DT, inp); t += DT;
      if (!r.switch) minNose = Math.min(minNose, Math.abs(wrap(r.heading)) / D);
      else if (Number.isNaN(tSwitch)) tSwitch = t;
    }
    return { minNose, tSwitch, sw: r.switch, toFall: Math.abs(wrap(r.heading)) / D, speed: r.speed };
  };
  const up = climb(165, 6), steep = climb(150, 6), across = climb(110, 8);
  for (const [k, s] of [['165 deg at 6 m/s', up], ['150 deg at 6 m/s', steep], ['110 deg at 8 m/s', across]]) {
    console.log(`  climb ${k} on 20 deg: nose came within ${s.minNose.toFixed(0)} deg of downhill before switch, ${s.sw ? `switch at ${s.tSwitch.toFixed(2)} s` : 'no switch'}, ends ${s.toFall.toFixed(0)} deg from the fall line at ${s.speed.toFixed(1)} m/s`);
  }
  check('nearly straight up: slides back into switch, the nose stays up the hill', up.sw && up.minNose > 135 && up.toFall < 30, `nose ${up.minNose.toFixed(0)} deg, switch ${up.sw}, ends ${up.toFall.toFixed(0)} deg`);
  check('a steep climb also falls back into switch', steep.sw && steep.minNose > 110 && steep.toFall < 30, `nose ${steep.minNose.toFixed(0)} deg, switch ${steep.sw}, ends ${steep.toFall.toFixed(0)} deg`);
  check('a climb across the hill comes round nose first', !across.sw && across.toFall < 45, `switch ${across.sw}, ends ${across.toFall.toFixed(0)} deg`);
}
{
  // standing across the hill on 25 deg
  const stand = (fallLine, steer, T = 3) => {
    const r = start(25, 0, EAST, fallLine), inp = input();
    inp.steer = steer;
    for (let i = 0; i < T * 120; i++) {
      // steering downhill: let go once the board points within 20 deg of the fall line, as a rider would
      if (steer < 0 && Math.abs(wrap(r.heading)) < 20 * D) inp.steer = 0;
      r.update(DT, inp);
    }
    return { moved: Math.hypot(r.x, r.y), down: r.y, turned: Math.abs(wrap(r.heading - EAST)) / D, speed: r.speed };
  };
  const loose = stand(1, 0), held = stand(1, 1), off = stand(0, 0), run = stand(1, -1);
  // a light uphill edge (steer 0.3, about 7.5 deg): over Assisted's 5 deg, under Realistic's 10
  const aLoose = stand(0.5, 0), aLight = stand(0.5, 0.3), rLight = stand(1, 0.3), aFull = stand(0.5, 1);
  console.log(`assisted on 25 deg for 3 s: no input ${aLoose.moved.toFixed(2)} m; light uphill edge ${(aLight.moved * 100).toFixed(1)} cm (realistic ${rLight.moved.toFixed(2)} m); full edge ${(aFull.moved * 100).toFixed(1)} cm, board turned ${aFull.turned.toFixed(1)} deg`);
  console.log(`standing on 25 deg for 3 s: no input ${loose.moved.toFixed(2)} m (down ${loose.down.toFixed(2)}); uphill edge held ${(held.moved * 100).toFixed(1)} cm, board turned ${held.turned.toFixed(1)} deg; off, no input ${(off.moved * 100).toFixed(1)} cm; steer downhill ${run.speed.toFixed(1)} m/s`);
  check('realistic: let go of the edge and you start to slide', loose.moved > 0.5 && loose.down > 0.3, `${loose.moved.toFixed(2)} m, ${loose.down.toFixed(2)} m downhill`);
  check('realistic: holding the uphill edge stands still without spinning the board', held.moved < 0.05 && held.turned < 5, `${(held.moved * 100).toFixed(1)} cm, turned ${held.turned.toFixed(1)} deg`);
  check('assisted: with no input it slides, less than realistic', aLoose.moved > 0.2 && aLoose.moved < loose.moved, `${aLoose.moved.toFixed(2)} m against ${loose.moved.toFixed(2)} m`);
  check('assisted: a light uphill edge stands still, where realistic needs more', aLight.moved < 0.05 && rLight.moved > 0.5, `${(aLight.moved * 100).toFixed(1)} cm against ${rLight.moved.toFixed(2)} m`);
  check('assisted: holding the uphill edge stands still without spinning the board', aFull.moved < 0.05 && aFull.turned < 5, `${(aFull.moved * 100).toFixed(1)} cm, turned ${aFull.turned.toFixed(1)} deg`);
  check('off: stands still with no input as before', off.moved < 0.05, `${(off.moved * 100).toFixed(1)} cm`);
  check('steering downhill from a stand turns the board and runs', run.speed > 2, `${run.speed.toFixed(1)} m/s after 3 s`);
}
{
  // catching the downhill edge: mid side-slip (board across the hill, sliding straight down it at
  // 4 m/s) roll onto the downhill (left) edge; the uphill edge from the same slide just holds
  const slam = (fallLine, steer) => {
    const r = start(30, 0, EAST, fallLine), inp = input();
    r.vy = 4; r.vz = -Math.tan(30 * D) * r.vy; // sliding down the fall line with the board across it
    inp.steer = steer;
    let t = 0;
    while (t < 1 && r.crashed <= 0) { r.update(DT, inp); t += DT; }
    return { crashed: r.crashed > 0, t, speed: r.speed, across: Math.abs(wrap(r.heading)) / D };
  };
  const real = slam(1, -1), uphill = slam(1, 0.3), assist = slam(0.5, -1);
  console.log(`side-slipping down 30 deg at 4 m/s, board across: downhill edge ${real.crashed ? `slams at ${real.t.toFixed(2)} s` : 'no crash'} (realistic), ${assist.crashed ? 'slams' : 'no crash'} (assisted); a little uphill edge ${uphill.crashed ? 'slams' : `holds, ${uphill.speed.toFixed(1)} m/s and ${uphill.across.toFixed(0)} deg from the fall line after 1 s`}`);
  check('realistic: catching the downhill edge in a side-slip is a slam', real.crashed && real.t < 0.5, real.crashed ? `${real.t.toFixed(2)} s` : 'no crash');
  check('a little uphill edge in the same slide checks it instead', !uphill.crashed && uphill.speed < 1.5 && uphill.across > 60, uphill.crashed ? 'crashed' : `${uphill.speed.toFixed(1)} m/s, ${uphill.across.toFixed(0)} deg after 1 s`);
  check('assisted: no edge catch', !assist.crashed, assist.crashed ? 'crashed' : 'no crash');
  // linked hard carves at speed must not catch, and must not scrub much more speed than with the fall line off
  const linked = (fallLine) => {
    const r = start(15, 20, 0, fallLine), inp = input();
    let crashed = false, minSpeed = 99;
    for (let i = 0; i < 720; i++) { inp.steer = Math.floor(i / 120) % 2 ? -1 : 1; r.update(DT, inp); if (r.crashed > 0) crashed = true; minSpeed = Math.min(minSpeed, r.speed); }
    return { crashed, minSpeed };
  };
  const on = linked(1), off = linked(0);
  console.log(`linked 1 s full carves from 20 m/s on 15 deg for 6 s: slowest ${on.minSpeed.toFixed(1)} m/s realistic, ${off.minSpeed.toFixed(1)} m/s off`);
  check('linked carves at speed never catch an edge', !on.crashed, on.crashed ? 'crashed' : 'no crash');
  check('linked carves scrub little extra speed with the fall line on', on.minSpeed > off.minSpeed - 1.5, `${on.minSpeed.toFixed(1)} vs ${off.minSpeed.toFixed(1)} m/s`);
}
fs.rmSync(path.dirname(out), { recursive: true, force: true });
console.log(fails ? `${fails} check(s) failed` : 'all fall line checks passed');
process.exit(fails ? 1 : 0);
