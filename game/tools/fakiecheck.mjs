// Riding switch physics check (FEAT-139): rides the Rider physics on an exact 17 degree plane (no pack,
// no browser), regular and goofy. A 180 lands riding switch with the heading along the travel and the
// board drawn turned round (tail leading) with no jump, and stays switch; steering right turns right;
// a switch 360 stays switch; a 180 goes back. Carving up the hill until the board slides back puts the
// rider in switch still facing the same way. Unstrapping and strapping in keep the rider where they face.
// Trick names (Backside 180, Switch frontside 360, Switch backflip).
// node tools/fakiecheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { GAME } from './paths.mjs';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fakiecheck-')), 'rider.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'sim', 'Rider.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { Rider, spinName, switchName, trickName } = await import(pathToFileURL(out).href);

const SL = Math.tan(17 * Math.PI / 180);
const nl = Math.hypot(SL, 1);
const pack = {
  coarseFallbacks: 0, mask: null,
  groundHeight: (_x, y) => SL * y,
  groundNormal: (_x, _y, out) => { const o = out ?? [0, 0, 0]; o[0] = 0; o[1] = -SL / nl; o[2] = 1 / nl; return o; },
};

const inp = (o = {}) => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, ...o });
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = (a) => (a * 180 / Math.PI).toFixed(0);
const drawn = (r) => r.boardYaw + (r.toeSign < 0 ? Math.PI : 0); // what RiderView draws (board, not seated)
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); if (!ok) fails++; };

/** run n frames of 1/60 s, tracking the largest frame-to-frame jump of the drawn yaw */
function run(r, n, i) {
  let worst = 0, prev = drawn(r);
  for (let k = 0; k < n; k++) { r.update(1 / 60, i); const d = drawn(r); worst = Math.max(worst, Math.abs(wrap(d - prev))); prev = d; }
  return worst;
}
/** launch into the air and spin with steer `s` until the board has turned `a` rad (the air spin rate depends on
 *  the jump mode, FEAT-311), then hold straight until landing */
function spinJump(r, s, a) {
  r.onGround = false; r.vz = 9; r.z += 0.1; r.airTime = 0; r.spin = 0; r.flip = 0; r.flipRate = 0;
  let jump = 0;
  for (let k = 0; k < 600 && Math.abs(r.spin) < a - 0.03; k++) jump = Math.max(jump, run(r, 1, inp({ steer: s })));
  let k = 0;
  while (!r.onGround && k++ < 600) jump = Math.max(jump, run(r, 1, inp()));
  return { jump, landed: r.onGround };
}

for (const goofy of [false, true]) {
  console.log(`---- ${goofy ? 'goofy' : 'regular'}`);
  const r = new Rider(pack, null);
  const tricks = [];
  r.onTrick = (n) => tricks.push(n);
  r.goofy = goofy;
  r.reset(0, 0, Math.PI); // facing downhill (-y)
  run(r, 240, inp());
  check('rides away in the normal stance', !r.switch && r.speed > 8, `speed ${r.speed.toFixed(1)}`);
  // a 180: spin about PI in the air
  const pre = drawn(r);
  let j = spinJump(r, 1, Math.PI);
  const vAlong = r.vx * Math.sin(r.heading) + r.vy * Math.cos(r.heading);
  check('180 lands', j.landed && r.crashed <= 0, `crashed ${r.crashed.toFixed(2)}`);
  check('no drawn yaw jump beyond the spin', j.jump < 0.12, `largest step ${deg(j.jump)} deg`);
  check('180 rides away switch', r.switch, `switch ${r.switch}`);
  check('heading along travel after the 180', vAlong > 0, `vAlong ${vAlong.toFixed(1)}`);
  check('drawn board turned about 180 (tail leading)', Math.abs(Math.abs(wrap(drawn(r) - pre)) - Math.PI) < 0.6, `${deg(wrap(drawn(r) - pre))} deg`);
  check('180 trick named', tricks.at(-1) === (goofy ? 'Frontside 180' : 'Backside 180'), `${tricks.at(-1)}`);
  // no jump of the drawn yaw at the landing / turn-round beyond the spin itself
  const after = run(r, 120, inp());
  check('stays switch on its own (2 s)', r.switch && after < 0.1, `largest drawn yaw step ${deg(after)} deg`);
  // steering while switch: right turns right (clockwise, + heading rate)
  const h0 = Math.atan2(r.vx, r.vy);
  run(r, 40, inp({ steer: 1 }));
  const dh = wrap(Math.atan2(r.vx, r.vy) - h0);
  check('steer right turns right riding switch', dh > 0.2 && r.switch, `travel turned ${deg(dh)} deg`);
  run(r, 40, inp({ steer: -1 }));
  check('the toe edge is on the heading left riding regular switch, right riding goofy switch', r.toeSign === (goofy ? 1 : -1), `toeSign ${r.toeSign}`);
  run(r, 120, inp());
  // a switch 360 keeps you switch
  j = spinJump(r, 1, 2 * Math.PI);
  check('switch 360 lands switch', j.landed && r.switch && r.crashed <= 0, `switch ${r.switch} crashed ${r.crashed.toFixed(2)}`);
  check('switch 360 named', tricks.at(-1) === (goofy ? 'Switch backside 360' : 'Switch frontside 360'), `${tricks.at(-1)}`);
  run(r, 120, inp());
  // another 180 takes you back
  j = spinJump(r, -1, Math.PI);
  check('180 back to the normal stance', j.landed && !r.switch, `switch ${r.switch}`);
  check('switch 180 named', tricks.at(-1) === (goofy ? 'Switch frontside 180' : 'Switch backside 180'), `${tricks.at(-1)}`);

  // carve up the hill until the board stalls and slides back
  const c = new Rider(pack, null); c.goofy = goofy;
  c.reset(0, 0, 0); // facing straight uphill
  c.vx = 0; c.vy = 9; // moving uphill at 9 m/s
  const before = drawn(c);
  const jumpC = run(c, 300, inp());
  check('slid back down the hill into switch', c.switch && c.vy < -2, `switch ${c.switch} vy ${c.vy.toFixed(1)}`);
  check('still facing the same way (drawn yaw unchanged)', Math.abs(wrap(drawn(c) - before)) < 0.05 && jumpC < 0.05, `turned ${deg(wrap(drawn(c) - before))} deg, largest step ${deg(jumpC)} deg`);

  // unstrap and strap back in from switch: the on-foot body is drawn along the heading
  const u = new Rider(pack, null); u.goofy = goofy;
  u.reset(0, 0, Math.PI / 2); // across the hill, standing on the edge
  run(u, 60, inp());
  u.switch = true; const sw = drawn(u);
  check('unstrap starts', u.toggleBoard() === '', '');
  check('on foot the heading is the way the rider faced', Math.abs(wrap(u.heading - sw)) < 1e-6 && !u.switch, `${deg(wrap(u.heading - sw))} deg`);
  run(u, 90, inp());
  const walk = u.heading;
  check('strap in starts', u.toggleBoard() === '', '');
  run(u, 90, inp());
  check('strapped in normal stance, drawn where the walker faced', !u.unstrapped && !u.switch && Math.abs(wrap(drawn(u) - walk)) < 1e-6, `switch ${u.switch} ${deg(wrap(drawn(u) - walk))} deg`);
}
console.log('---- names');
check('spinName', spinName(-Math.PI, 1) === 'Frontside 180' && spinName(Math.PI * 2, 1) === 'Backside 360' && spinName(Math.PI * 2, -1) === 'Frontside 360' && spinName(1, 1) === '', '');
check('switchName', switchName(trickName(-6.4, 0, 1), true) === 'Switch backflip' && switchName('Rodeo 540', true) === 'Switch rodeo 540' && switchName('Backside 180', false) === 'Backside 180', switchName(trickName(-6.4, 0, 1), true));
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
