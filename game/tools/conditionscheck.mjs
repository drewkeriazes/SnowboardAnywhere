// HUD conditions readout check (FEAT-221): fake rider states, no browser. Each row of the issue's tag
// table gives the expected text, the depth shows in 2 in steps (5 cm in metric), a mogul field names
// its size in front, at most two tags show, a state that flips every frame never changes the text
// before the 0.5 s hold, and a default groomed cruise reads "Groomed" only.
// node tools/conditionscheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conditionscheck-'));
const out = path.join(dir, 'conditions.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'ui', 'Conditions.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const C = await import(pathToFileURL(out).href);
const snowOut = path.join(dir, 'snow.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'sim', 'SnowConditions.ts')], bundle: true, format: 'esm', platform: 'node', outfile: snowOut, logLevel: 'error' });
const { newSnowState } = await import(pathToFileURL(snowOut).href);

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

/** a groomed cruise at 15 m/s on a 20 degree run, then `f` changes what it needs */
function rider(f = () => {}) {
  const r = {
    speed: 15, slopeDeg: 20, washout: 0, noseSink: 0, catchRisk: 0,
    snow: newSnowState(),
    surface: { rock: 0, scree: 0, groomed: 1, canopy: 0, moguls: 0, shrub: 0 },
  };
  f(r);
  return r;
}
/** powder `d` m deep (all powder: grip 0.85, so no skitter) */
const powder = (d) => (r) => { Object.assign(r.snow, { groomed: 0, powder: 1, kind: 'powder', depth: d, grip: 0.85 }); r.surface.groomed = 0; };
const ice = (r) => { Object.assign(r.snow, { groomed: 0.2, ice: 0.8, kind: 'ice', depth: 0.004, grip: 0.6 }); };
const both = (...fs) => (r) => fs.forEach((f) => f(r));

const expect = (label, r, want, metric = false) => {
  const got = C.conditionsNow(r, metric);
  check(label, got === want, `"${got}"${got === want ? '' : ` (want "${want}")`}`);
};

// ---- defaults and the snow kinds
expect('groomed cruise', rider(), 'Groomed');
expect('rock', rider((r) => Object.assign(r.snow, { groomed: 0, rock: 1, kind: 'rock', depth: 0.008 })), 'Rock');

// ---- the tag table, one row at a time (speed 15 so no powder speed tags unless asked)
expect('edge letting go', rider((r) => { r.washout = 0.6; }), 'Groomed · edge letting go');
expect('nose sinking', rider((r) => { r.noseSink = 0.4; }), 'Groomed · nose sinking');
expect('bogging down', rider(both(powder(0.41), (r) => { r.speed = 5; })), 'Powder 16 in · bogging down');
expect('floating', rider(powder(0.36)), 'Powder 14 in · floating');
expect('between bogging and floating', rider(both(powder(0.36), (r) => { r.speed = 9; })), 'Powder 14 in');
expect('edges skittering', rider(ice), 'Ice · edges skittering');
expect('bumpy (chop jolts)', rider((r) => Object.assign(r.snow, { groomed: 0.1, chop: 0.9, kind: 'chop', depth: 0.075, jolt: 0.75 })), 'Chop · bumpy');
expect('heavy and slow', rider((r) => Object.assign(r.snow, { groomed: 0.3, slush: 0.7, kind: 'slush', depth: 0.06, grip: 0.93 })), 'Slush · heavy and slow');
expect('catchy', rider((r) => { r.catchRisk = 0.8; }), 'Groomed · catchy');
expect('brushing shrubs', rider((r) => { r.surface.shrub = 0.3; }), 'Groomed · brushing shrubs');
expect('in the trees', rider((r) => { r.surface.canopy = 0.6; }), 'Groomed · in the trees');
expect('just under every threshold', rider((r) => { r.washout = 0.5; r.noseSink = 0.3; r.catchRisk = 0.5; r.surface.shrub = 0.2; r.surface.canopy = 0.4; r.snow.grip = 0.75; r.snow.jolt = 0.3; }), 'Groomed');

// ---- at most two tags, first match wins
expect('two tags', rider(both(powder(0.41), (r) => { r.speed = 3; r.noseSink = 0.5; })), 'Powder 16 in · bogging down, nose sinking');
expect('three match, two shown', rider((r) => { r.washout = 0.7; r.noseSink = 0.5; r.surface.canopy = 0.8; }), 'Groomed · edge letting go, nose sinking');

// ---- depth: chop and slush only past 10 cm, 2 in / 5 cm steps, metric
expect('deep chop shows its depth', rider((r) => Object.assign(r.snow, { groomed: 0, chop: 1, kind: 'chop', depth: 0.15, jolt: 1 })), 'Chop 6 in · bumpy');
expect('powder in cm', rider(powder(0.36)), 'Powder 35 cm · floating', true);
expect('powder 2 in steps', rider(powder(0.39)), 'Powder 16 in · floating');
expect('powder 5 cm steps', rider(powder(0.39)), 'Powder 40 cm · floating', true);

// ---- moguls: the size in front, feet in 0.5 ft steps (m in metric); the bumps alone add no "bumpy"
const moguls = (amp, deg) => (r) => { r.surface.moguls = amp; r.slopeDeg = deg; };
const h = C.mogulHeightAt(rider(moguls(1, 33)));
expect('moguls on ice', rider(both(ice, moguls(1, 33))), `Moguls ${Math.round(h * 3.28084 * 2) / 2} ft · Ice · edges skittering`);
check('steep full field is head high', h > 1.2 && h < 1.5, `${h.toFixed(2)} m = ${(h * 3.28084).toFixed(1)} ft`);
expect('moguls metric', rider(moguls(1, 33)), `Moguls ${h.toFixed(1)} m · Groomed`, true);
expect('a weak field reads as snow', rider(moguls(0.29, 33)), 'Groomed');

// ---- the hold
C.resetConditions();
const g = rider(), p = rider(powder(0.36));
let t = 100;
check('first call shows at once', C.conditionsText(g, false, t) === 'Groomed', C.conditionsText(g, false, t));
let changed = false;
for (let i = 1; i <= 120; i++) { t += 1 / 60; if (C.conditionsText(i % 2 ? p : g, false, t) !== 'Groomed') changed = true; }
check('a state flipping every frame never changes the text', !changed, `2 s of flipping groomed / powder, text ${changed ? 'changed' : 'held'}`);
let at = NaN;
for (let i = 1; i <= 60; i++) { t += 1 / 60; if (C.conditionsText(p, false, t) !== 'Groomed' && Number.isNaN(at)) at = i / 60; }
check('a steady change shows after 0.5 s', at >= C.HOLD && at < C.HOLD + 0.05, `after ${at.toFixed(3)} s`);
t += 1;
check('a gap in the calls shows the snow at once', C.conditionsText(g, false, t) === 'Groomed', C.conditionsText(g, false, t));
let cruise = true;
for (let i = 0; i < 600; i++) { t += 1 / 60; if (C.conditionsText(g, false, t) !== 'Groomed') cruise = false; }
check('a groomed cruise reads Groomed only', cruise, '10 s');
// the bump size eases instead of following each bump face
C.resetConditions();
const mog = (deg) => rider(moguls(1, deg));
const first = C.conditionsText(mog(30), false, t);
let sizes = new Set();
for (let i = 1; i <= 240; i++) { t += 1 / 60; sizes.add(C.conditionsText(mog(i % 20 < 10 ? 24 : 36), false, t)); }
check('bump size holds over bump faces', sizes.size <= 2, `${first} then ${[...sizes].join(' | ')}`);

// ---- the real Rider on a 15 degree groomer: a straight run and linked turns read "Groomed" only
const riderOut = path.join(dir, 'rider.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'sim', 'Rider.ts')], bundle: true, format: 'esm', platform: 'node', outfile: riderOut, logLevel: 'error' });
const { Rider } = await import(pathToFileURL(riderOut).href);
const D = Math.PI / 180, tn = Math.tan(15 * D), kn = 1 / Math.hypot(tn, 1);
const plane = {
  mask: null, coarseFallbacks: 0,
  groundHeight: (x, y) => -tn * y,
  groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = tn * kn; o[2] = kn; return o; },
};
for (const [label, steer] of [['straight', () => 0], ['linked turns', (s) => (Math.floor(s / 1.5) % 2 ? 0.6 : -0.6)]]) {
  const r = new Rider(plane, null);
  r.surface.groomed = 1;
  r.reset(0, 0, 0);
  r.vy = 12; r.vz = -tn * 12;
  const inp = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false };
  const seen = new Set();
  for (let i = 0; i < 1200; i++) {
    inp.steer = steer(i / 120);
    r.update(1 / 120, inp);
    if (i > 120 && r.onGround) seen.add(C.conditionsNow(r, false));
  }
  check(`real rider, groomer, ${label}`, seen.size === 1 && seen.has('Groomed'), `${[...seen].join(' | ')} (at ${r.speed.toFixed(1)} m/s)`);
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
