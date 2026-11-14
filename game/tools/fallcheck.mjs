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
const outC = path.join(path.dirname(out), 'collider.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'sim', 'Collider.ts')], bundle: true, format: 'esm', platform: 'node', outfile: outC, logLevel: 'error' });
const { Collider } = await import(pathToFileURL(outC).href);

const D = Math.PI / 180;
/** plane falling toward +y (north) at `deg` degrees; the fall line is heading 0 */
function plane(deg, moguls = 0) {
  const t = Math.tan(deg * D), k = 1 / Math.hypot(t, 1);
  return {
    mask: null, coarseFallbacks: 0, mogulAmp: () => moguls,
    groundHeight: (x, y) => -t * y,
    groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = t * k; o[2] = k; return o; },
  };
}
const input = () => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false });
const DT = 1 / 120;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const EAST = Math.PI / 2;

/** start at `v` m/s along `dir` (radians from +y, clockwise) on a groomed `deg` slope with the fall line setting `fallLine` */
function start(deg, v, dir, fallLine, moguls = 0) {
  const r = new Rider(plane(deg, moguls), null);
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
// the flat board drifts down and follows its slide round (not an autopilot snap, not rails): within
// 30 deg of the fall line in 1.2 to 2.5 s on 30 deg at 8 m/s (it was 0.9 s before the follow model)
check('realistic: a flat board on 30 deg drifts down and comes round toward the fall line, not at once', real30.toFall < 30 && real30.vy > 3 && real30.tDown > 1.2 && real30.tDown < 2.5 && !real30.crashed, `${real30.toFall.toFixed(0)} deg, vy ${real30.vy.toFixed(1)}, skid ${real30.skid.toFixed(2)}, down at ${real30.tDown.toFixed(2)} s, crashed ${real30.crashed}`);
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
  // the flat-base catch: from a stand across a 30 deg pitch with nothing pressed the board side-slips
  // (no speed along it, so it does not follow round), and in moguls the downhill edge soon catches; a
  // little uphill edge, Assisted, or a fast traverse on a groomer never catch
  const slip = (fallLine, steer, moguls, T = 4) => {
    const r = start(30, 0, EAST, fallLine, moguls), inp = input();
    inp.steer = steer;
    let t = 0, skid = 0;
    while (t < T && r.crashed <= 0) { r.update(DT, inp); t += DT; skid = Math.max(skid, r.skid); }
    return { crashed: r.crashed > 0, t, skid, hit: r.lastHit, side: r.crashSide, moved: Math.hypot(r.x, r.y) };
  };
  const bumps = slip(1, 0, 0.4), bumpsHeld = slip(1, 0.3, 0.4), bumpsAssist = slip(0.5, 0, 0.4), groomed = slip(1, 0, 0);
  console.log(`flat side-slip from a stand on 30 deg: moguls ${bumps.crashed ? `catch at ${bumps.t.toFixed(2)} s (${bumps.hit}, side ${bumps.side})` : 'no catch'}, skid ${bumps.skid.toFixed(2)}; with a little uphill edge ${bumpsHeld.crashed ? 'catch' : `no catch, ${bumpsHeld.moved.toFixed(2)} m`}; assisted ${bumpsAssist.crashed ? 'catch' : 'no catch'}; groomer ${groomed.crashed ? `catch at ${groomed.t.toFixed(2)} s` : 'no catch'} in 4 s`);
  check('flat across the slope with nothing pressed it side-slips', bumps.skid > 0.3, `skid ${bumps.skid.toFixed(2)}`);
  check('realistic: side-slipping flat through moguls catches the downhill edge, falling downhill', bumps.crashed && bumps.hit === 'catch' && bumps.side === -1, bumps.crashed ? `${bumps.t.toFixed(2)} s, side ${bumps.side}` : 'no catch');
  check('a little uphill edge keeps the downhill edge off the snow', !bumpsHeld.crashed, bumpsHeld.crashed ? `caught at ${bumpsHeld.t.toFixed(2)} s` : 'no catch');
  check('assisted: no flat-base catch', !bumpsAssist.crashed, bumpsAssist.crashed ? 'caught' : 'no catch');
  check('a flat traverse at speed on a groomer never catches', !real30.crashed && !real8.crashed, `30 deg ${real30.crashed}, 8 deg ${real8.crashed}`);
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
  check('a little uphill edge in the same slide checks it instead', !uphill.crashed && uphill.speed < 2 && uphill.across > 60, uphill.crashed ? 'crashed' : `${uphill.speed.toFixed(1)} m/s, ${uphill.across.toFixed(0)} deg after 1 s`);
  check('assisted: no edge catch', !assist.crashed, assist.crashed ? 'crashed' : 'no crash');
  // the catch is about sliding sideways, not about which edge: turning onto the downhill edge out of a
  // clean traverse (steady, or held with keyboard taps) is just a turn and never slams
  const turnOut = (taps) => {
    const r = start(30, 10, EAST, 1), inp = input();
    let t = 0;
    while (t < 3 && r.crashed <= 0) { inp.steer = t < 1.5 ? (taps ? ((t % 0.5) < 0.2 ? 1 : 0) : 0.4) : -1; r.update(DT, inp); t += DT; }
    return { crashed: r.crashed > 0, toFall: Math.abs(wrap(r.heading)) / D };
  };
  const outSteady = turnOut(false), outTaps = turnOut(true);
  console.log(`downhill edge out of a clean 10 m/s traverse on 30 deg: steady ${outSteady.crashed ? 'slams' : `turns, ${outSteady.toFall.toFixed(0)} deg from the fall line after`}; keyboard taps ${outTaps.crashed ? 'slams' : 'turns'}`);
  check('turning onto the downhill edge out of a clean traverse is just a turn', !outSteady.crashed && !outTaps.crashed, `steady ${outSteady.crashed}, taps ${outTaps.crashed}`);
  // and it is not about the slope either: sliding sideways at 4 m/s on the flat, the leading edge catches, the trailing edge stops it
  const flatSlide = (steer) => {
    const r = start(0, 0, EAST, 1), inp = input();
    r.vy = 4; // sliding toward the heading's left (north) with the board across
    inp.steer = steer;
    let t = 0;
    while (t < 1 && r.crashed <= 0) { r.update(DT, inp); t += DT; }
    return { crashed: r.crashed > 0, t, side: r.crashSide };
  };
  const lead = flatSlide(-1), trail = flatSlide(1);
  console.log(`sliding sideways on the flat at 4 m/s: leading edge ${lead.crashed ? `slams at ${lead.t.toFixed(2)} s (side ${lead.side})` : 'no crash'}, trailing edge ${trail.crashed ? 'slams' : 'stops it'}`);
  check('sliding sideways onto the leading edge slams on the flat too, over that edge', lead.crashed && lead.side === -1, lead.crashed ? `${lead.t.toFixed(2)} s, side ${lead.side}` : 'no crash');
  check('the trailing edge in the same slide never catches', !trail.crashed, trail.crashed ? 'crashed' : 'no crash');
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
  // linked turns finished right across a steep slope (even past it, climbing a little) change onto the
  // downhill edge every time, and must never catch
  let steepCatches = 0, steepRuns = 0;
  for (const deg of [20, 30, 35]) for (const v of [8, 15]) for (const swing of [85, 100]) for (const amt of [1, 0.6]) {
    const r = start(deg, v, 0, 1), inp = input();
    inp.steer = amt; steepRuns++;
    for (let i = 0; i < 120 * 10 && r.crashed <= 0; i++) {
      const h = wrap(r.heading) / D;
      if (inp.steer > 0 && h > swing) inp.steer = -amt; else if (inp.steer < 0 && h < -swing) inp.steer = amt;
      r.update(DT, inp);
    }
    if (r.crashed > 0) steepCatches++;
  }
  check('linked turns finished across a steep slope never catch', steepCatches === 0, `${steepCatches} of ${steepRuns} runs caught`);
  check('linked carves scrub little extra speed with the fall line on', on.minSpeed > off.minSpeed - 1.5, `${on.minSpeed.toFixed(1)} vs ${off.minSpeed.toFixed(1)} m/s`);
}
{
  // FEAT-288 the crash slide: a crashed body keeps its speed and slides down the fall line,
  // a = g (sin a - mu cos a) - k v^2, ends once it is slow (or at the cap), still stops on a trunk, and falls off a drop
  /** crash at `v` m/s along `dir` on a `deg` plane (or on `pack`, with `collider`); returns the slide */
  const slide = (deg, v, dir = 0, fallLine = 1, pack = null, collider = null) => {
    const r = new Rider(pack ?? plane(deg), collider);
    r.fallLine = fallLine; r.surface.groomed = 1;
    r.reset(0, 0, dir);
    r.vx = Math.sin(dir) * v; r.vy = Math.cos(dir) * v;
    r.crash(1.3);
    const v0 = r.speed, z0 = r.z, inp = input();
    let t = 0, speed1 = NaN, speed3 = NaN, maxVUp = -Infinity, wasAir = false, maxY = -Infinity;
    const trail = [];
    while (r.crashed > 0 && t < 10) {
      r.update(DT, inp); t += DT;
      if (Number.isNaN(speed1) && t >= 1) speed1 = r.speed;
      if (Number.isNaN(speed3) && t >= 3) speed3 = r.speed;
      maxVUp = Math.max(maxVUp, -r.vy * Math.cos(dir)); // the uphill part of the slide (dir 0 is downhill)
      maxY = Math.max(maxY, r.y);
      if (r.crashAir) wasAir = true;
      trail.push(r.x, r.y, r.z);
    }
    return { r, t, v0, speed1, speed3, end: r.speed, dist: Math.hypot(r.x, r.y), drop: z0 - r.z, maxVUp, wasAir, maxY, trail };
  };
  const blue = slide(20, 20), green = slide(10, 20), black = slide(30, 20), flat = slide(0, 20), uphill = slide(20, 12, Math.PI), assist = slide(20, 20, 0, 0.5);
  const fmt = (s) => `${s.dist.toFixed(1)} m in ${s.t.toFixed(2)} s, ${s.v0.toFixed(1)} m/s after the impact, ${Number.isNaN(s.speed1) ? '-' : s.speed1.toFixed(1)} m/s at 1 s, ${Number.isNaN(s.speed3) ? '-' : s.speed3.toFixed(1)} at 3 s, up at ${s.end.toFixed(1)} m/s`;
  console.log('crash slide from 20 m/s straight down the fall line:');
  for (const [k, s] of [['green 10 deg', green], ['blue 20 deg', blue], ['black 30 deg', black], ['flat', flat], ['blue, assisted', assist]]) console.log(`  ${k.padEnd(15)}: ${fmt(s)}`);
  console.log(`  uphill on 20 deg from 12 m/s: ${fmt(uphill)}`);
  check('the impact takes about a quarter of the speed', Math.abs(blue.v0 - 15) < 0.01, `${blue.v0.toFixed(1)} m/s from 20`);
  check('blue: the body slides on well down the hill (tens of metres, not about 7)', blue.dist > 30 && blue.dist < 90 && blue.speed1 > 10, fmt(blue));
  check('green: slows and stops much sooner than on the blue', green.dist < 0.7 * blue.dist && green.speed3 < 0.6 * blue.speed3 && green.t < blue.t - 0.5, `${fmt(green)}; blue ${blue.speed3.toFixed(1)} m/s at 3 s`);
  check('black: the slide is capped, no soft lock', black.t <= 6.05 && black.end === 0 && black.dist > blue.dist, fmt(black));
  check('flat: a crash on the flat still stops', flat.end < 2 && flat.t < 3 && flat.dist < 25, fmt(flat));
  check('uphill: slows to a stop and is never pushed back up the hill', uphill.maxVUp <= uphill.v0 + 1e-6 && uphill.end < 2 && uphill.t < 2.5, fmt(uphill));
  check('never up while still moving fast', [blue, green, black, flat, uphill].every((s) => s.end < 2), [blue, green, black, flat, uphill].map((s) => s.end.toFixed(1)).join(', '));
  check('assisted: a shorter slide than realistic', assist.dist < 0.8 * blue.dist, `${assist.dist.toFixed(1)} m against ${blue.dist.toFixed(1)} m`);
  // the same crash twice lands on the same metre (replays and recordings rerun the sim)
  const again = slide(20, 20);
  check('the slide is deterministic', again.trail.length === blue.trail.length && again.trail.every((v, i) => v === blue.trail[i]), `${again.trail.length / 3} and ${blue.trail.length / 3} steps`);
  // a trunk 20 m down the fall line (radius 0.3, pushed out to 0.3 + the body's 0.4)
  const TREE_Y = 20;
  const tree = {
    floorAt: () => -Infinity, brushAt: () => 0,
    resolve: (x, y, z, rad) => {
      const dx = x, dy = y - TREE_Y, d = Math.hypot(dx, dy), R = 0.3 + rad;
      if (d >= R) return null;
      const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : -1;
      return { x: nx * R, y: TREE_Y + ny * R, nx, ny, kind: 0, inside: false, top: z + 10, ledge: false };
    },
  };
  const trunk = slide(20, 20, 0, 1, null, tree);
  console.log(`  blue with a trunk 20 m down: ${fmt(trunk)}, furthest ${trunk.maxY.toFixed(1)} m down`);
  check('a crash into a trunk still stops at the trunk', trunk.maxY < TREE_Y && trunk.dist < TREE_Y + 1, `furthest ${trunk.maxY.toFixed(1)} m down, ends ${trunk.r.y.toFixed(1)} m`);
  // FEAT-307: a sitting snowboarder 20 m down, the parts StaticPeople puts in the real Collider (kind 0, like a trunk)
  const people = new Collider(), sz = -Math.tan(20 * D) * TREE_Y;
  people.add(0, TREE_Y, 0.45, sz - 1, sz + 1.1, 0);
  people.add(0.6, TREE_Y + 0.42, 0.3, sz - 1, sz + 0.35, 0); people.add(-0.6, TREE_Y + 0.42, 0.3, sz - 1, sz + 0.35, 0);
  const person = slide(20, 20, 0, 1, null, people);
  console.log(`  blue with a sitting person 20 m down: ${fmt(person)}, furthest ${person.maxY.toFixed(1)} m down`);
  check('a crash into a static person stops at the person, like a trunk', person.maxY < TREE_Y && person.dist < TREE_Y + 1, `furthest ${person.maxY.toFixed(1)} m down, ends ${person.r.y.toFixed(1)} m`);
  // a 20 deg slope with a 12 m cliff band 15 m down
  const t20 = Math.tan(20 * D), k20 = 1 / Math.hypot(t20, 1), CLIFF_Y = 15;
  const cliff = {
    mask: null, coarseFallbacks: 0, mogulAmp: () => 0,
    groundHeight: (x, y) => -t20 * y - (y > CLIFF_Y ? 12 : 0),
    groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = t20 * k20; o[2] = k20; return o; },
  };
  const off = slide(20, 20, 0, 1, cliff);
  const cliffTop = -t20 * CLIFF_Y;
  // glued to the face would put the body at the foot at once; falling, it is still above the foot a step past the edge
  let i = 0; while (i < off.trail.length && off.trail[i + 1] <= CLIFF_Y + 1) i += 3;
  const pastZ = off.trail[i + 2], footZ = cliff.groundHeight(0, off.trail[i + 1]);
  console.log(`  blue over a 12 m cliff band: ${fmt(off)}, ${(pastZ - footZ).toFixed(1)} m above the snow 1 m past the edge, ${off.drop.toFixed(1)} m down in all`);
  check('a crash over a cliff falls off it instead of sticking to the face', off.wasAir && pastZ - footZ > 2 && off.drop > -cliffTop + 12, `airborne ${off.wasAir}, ${(pastZ - footZ).toFixed(1)} m above the snow past the edge`);
}
fs.rmSync(path.dirname(out), { recursive: true, force: true });
console.log(fails ? `${fails} check(s) failed` : 'all fall line checks passed');
process.exit(fails ? 1 : 0);
