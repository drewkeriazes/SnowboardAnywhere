// Jump height check (FEAT-311): pops on an exact flat plane (no pack, no browser) through the rider's own
// update loop at 60 fps and reports the peak height above the takeoff snow for a tap, a full charge, an
// ollie and a squat ollie, in each jump mode, and the most front flip a squat nollie reaches off the flat. Real
// mode: the high end of expert snowboarders' measured ollies (29 to 36 cm on average, SD about 30%; List et al.,
// ISBS 2012), a tap clearly smaller, and no flip off flat snow. Arcade mode keeps the old heights.
// node tools/jumpcheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jumpcheck-')), 'rider.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'sim', 'Rider.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { Rider } = await import(pathToFileURL(out).href);

/** an exact plane falling toward +y at `deg` degrees */
function plane(deg) {
  const t = Math.tan(deg * Math.PI / 180), k = 1 / Math.hypot(t, 1);
  return { mask: null, coarseFallbacks: 0, groundHeight: (x, y) => -t * y, groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = t * k; o[2] = k; return o; } };
}
/** a full charge riding straight down a `deg` slope at `v` m/s: the most clearance off the slope (m, measured
 *  square to it) and the air time (s) */
function slopePop(mode, deg, v) {
  const a = deg * Math.PI / 180, t = Math.tan(a), c = Math.cos(a);
  const r = new Rider(plane(deg), null);
  r.jumpMode = mode; r.reset(0, 0, 0); r.vy = v * c; r.vz = -v * Math.sin(a);
  for (let i = 0; i < 60; i++) r.update(FRAME, input({ jumpHeld: true }));
  r.update(FRAME, input({ jumpReleased: true }));
  let clear = 0, k = 0;
  for (; k < 900 && !r.onGround; k++) { clear = Math.max(clear, (r.z + t * r.y) * c); r.update(FRAME, input()); }
  return { clear, air: k * FRAME };
}
const flat = { mask: null, coarseFallbacks: 0, groundHeight: () => 0, groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = 0; o[2] = 1; return o; } };
const FRAME = 1 / 60;
const input = (o = {}) => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false, lean: 0, ...o });

/** ride at 8 m/s on the flat, hold jump for `hold` s (with `lean` / `squat` held), release, and return the peak
 *  height above the snow and the takeoff vertical speed */
function pop(mode, hold, { lean = 0, squat = false } = {}) {
  const r = new Rider(flat, null);
  if (mode) r.jumpMode = mode;
  r.reset(0, 0, 0);
  r.vy = 8;
  for (let i = 0; i < 60; i++) r.update(FRAME, input({ squat, lean }));
  const frames = Math.round(hold / FRAME);
  for (let i = 0; i < frames; i++) r.update(FRAME, input({ jumpHeld: true, squat, lean }));
  const rel = input({ jumpReleased: true, squat, lean });
  let peak = 0, vz = 0, k = 0;
  r.update(FRAME, rel);
  vz = r.vz;
  while (!r.onGround && k++ < 600) { r.update(FRAME, input()); peak = Math.max(peak, r.z); }
  return { peak, vz, popped: k > 0 };
}

/** squat nollie (W, as the keyboard sends it: tuck plus the lean), then W in the air: 'again' let go for a frame and
 *  held again, 'held' kept down from the pop, 'off' let go. The most front flip (rad) reached, the flip at `at` s of
 *  air, and the pitch and crash at the landing */
function nollie(mode, how, at = 0.15) {
  const r = new Rider(flat, null), o = { lean: 1, squat: true }; // the lean only while charging, as Controls sends it
  r.jumpMode = mode; r.reset(0, 0, 0); r.vy = 8;
  for (let i = 0; i < 60; i++) r.update(FRAME, input({ squat: true }));
  for (let i = 0; i < 60; i++) r.update(FRAME, input({ ...o, jumpHeld: true }));
  r.update(FRAME, input({ ...o, tuck: true, jumpReleased: true }));
  if (how === 'again') r.update(FRAME, input());
  let f = 0, last = 0, fAt = null;
  for (let k = 0; k < 600 && !r.onGround; k++) {
    f = Math.max(f, r.flip); last = r.flip;
    if (fAt === null && r.airTime >= at) fAt = r.flip;
    r.update(FRAME, input({ tuck: how !== 'off' }));
  }
  return { f, fAt, last, crashed: r.crashed > 0 };
}

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }
const m = (x) => `${x.toFixed(2)} m`;

const TAP = 0.1, FULL = 1.0;
const cases = [['tap', TAP, {}], ['full', FULL, {}], ['full ollie', FULL, { lean: -1 }], ['full squat ollie', FULL, { lean: -1, squat: true }]];
const res = {};
for (const mode of ['arcade', 'real']) {
  for (const [name, hold, o] of cases) {
    const p = pop(mode, hold, o);
    res[`${mode} ${name}`] = p;
    console.log(`     ${mode.padEnd(6)} ${name.padEnd(17)} peak ${m(p.peak)}  takeoff ${p.vz.toFixed(2)} m/s`);
  }
}
// the old pop, (2.5 + 4.5 x charge) m/s, which Arcade keeps: measured on main before FEAT-311, a 0.1 s tap peaks at
// 0.57 m (3.14 m/s) and a full charge at 2.52 m (6.92 m/s)
const oldTap = 0.57, oldFull = 2.52;
check('arcade tap unchanged', Math.abs(res['arcade tap'].peak - oldTap) < 0.06, m(res['arcade tap'].peak));
check('arcade full charge unchanged', Math.abs(res['arcade full'].peak - oldFull) < 0.1, m(res['arcade full'].peak));
check('real full charge at the high end of an expert ollie (0.38 to 0.48 m)', res['real full'].peak > 0.38 && res['real full'].peak < 0.48, m(res['real full'].peak));
check('real squat ollie at an expert best (0.55 to 0.65 m)', res['real full squat ollie'].peak > 0.55 && res['real full squat ollie'].peak < 0.65, m(res['real full squat ollie'].peak));
check('real tap clearly smaller than a full charge', res['real tap'].peak < 0.5 * res['real full'].peak, `${m(res['real tap'].peak)} against ${m(res['real full'].peak)}`);
check('real tap still pops', res['real tap'].popped && res['real tap'].peak > 0.08, m(res['real tap'].peak));
check('real ollie still higher than a plain pop', res['real full ollie'].peak > res['real full'].peak, `${m(res['real full ollie'].peak)} against ${m(res['real full'].peak)}`);
/** a full-charge pop (squat ollie if `big`) with full steer through the air: the spin (rad) on the landing */
function spin(mode, big) {
  const r = new Rider(flat, null), o = big ? { lean: -1, squat: true } : {};
  r.jumpMode = mode; r.reset(0, 0, 0); r.vy = 8;
  for (let i = 0; i < 60; i++) r.update(FRAME, input({ squat: !!big }));
  for (let i = 0; i < 60; i++) r.update(FRAME, input({ ...o, jumpHeld: true }));
  r.update(FRAME, input({ ...o, jumpReleased: true }));
  let s = 0;
  for (let k = 0; k < 600 && !r.onGround; k++) { s = r.spin; r.update(FRAME, input({ steer: 1 })); }
  return Math.abs(s);
}
const deg = (a) => `${(a * 180 / Math.PI).toFixed(0)} deg`;
const fr = nollie('real', 'again').f, fa = nollie('arcade', 'again').f;
check('real: no front flip off flat snow (short of 300 deg, the crash window)', fr < 300 * Math.PI / 180, deg(fr));
check('arcade: a front flip off flat snow still goes round', fa > 2 * Math.PI, deg(fa));
// FEAT-311: W still down from the nollie tucks first (the pop's rotation, sped up only by the tuck, I_OPEN / I_TUCK),
// so the flip starts about the apex; let go at the pop and the nollie lands near level
const held = nollie('real', 'held');
check('real: W kept down from a nollie barely turns before the tuck is in (under 12 deg at 0.15 s)', held.fAt < 12 * Math.PI / 180, deg(held.fAt));
check('real: and then flips on, too late to land off flat snow (you land on your face)', held.crashed && held.last > 60 * Math.PI / 180, `${deg(held.last)} at the landing`);
for (const mode of ['real', 'arcade']) {
  const h = nollie(mode, 'off');
  check(`${mode}: a nollie with W let go at the pop lands near level`, !h.crashed && Math.abs(h.last) < 35 * Math.PI / 180, `${deg(h.last)} at the landing${h.crashed ? ', crashed' : ''}`);
}
// FEAT-311: Real's air is short, so it spins quicker: a full charge fits a 180 (an early trick off flat snow), a squat ollie no 360
const s1 = spin('real', false), s2 = spin('real', true);
check('real: a full charge spins a 180', s1 > Math.PI, deg(s1));
check('real: no 360 off flat snow, even from a squat ollie', s2 < 300 * Math.PI / 180, deg(s2));
// FEAT-311: on Realistic the pop adds to the velocity along the snow, so a pop down a slope leaves it the same at
// any speed (the old launch dropped the downhill fall: about 5 m off a 20 deg slope at 20 m/s); Arcade keeps that
const slow = slopePop('real', 20, 5), fast = slopePop('real', 20, 20), arc = slopePop('arcade', 20, 20);
check('real: a pop down a 20 deg slope at 20 m/s clears about what it does slowly', fast.clear < 0.65 && fast.clear < slow.clear + 0.1, `${m(fast.clear)} at 20 m/s, ${m(slow.clear)} at 5 m/s, ${fast.air.toFixed(2)} s of air`);
check('arcade: keeps the big air down a slope at speed', arc.clear > 5, `${m(arc.clear)}`);
process.exit(fails ? 1 : 0);
