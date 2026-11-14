// Jump height check (FEAT-311): pops on an exact flat plane (no pack, no browser) through the rider's own
// update loop at 60 fps and reports the peak height above the takeoff snow for a tap, a full charge, an
// ollie and a squat ollie, in each jump mode. Real mode: a full charge peaks at about the old tap height and
// a tap is clearly smaller. Arcade mode keeps the old heights.
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
check('real full charge about the old tap height', Math.abs(res['real full'].peak - oldTap) < 0.06, `${m(res['real full'].peak)} against ${m(oldTap)}`);
check('real tap clearly smaller than a full charge', res['real tap'].peak < 0.5 * res['real full'].peak, `${m(res['real tap'].peak)} against ${m(res['real full'].peak)}`);
check('real tap still pops', res['real tap'].popped && res['real tap'].peak > 0.08, m(res['real tap'].peak));
check('real ollie still higher than a plain pop', res['real full ollie'].peak > res['real full'].peak, `${m(res['real full ollie'].peak)} against ${m(res['real full'].peak)}`);
process.exit(fails ? 1 : 0);
