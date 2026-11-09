// Mogul check (FEAT-059): the bump function (shape, spacing, clamp, creep, fall direction) and the
// Rider physics over a mogul field on exact planes (no pack, no browser). Riding a 25 degree bump run
// straight must throw the rider off the snow and bleed speed against the flat plane beside it; a
// field that appears under the rider (its tile loading late) must not drop or fling them.
// node tools/mogulcheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { GAME } from './paths.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mogulcheck-'));
const bundle = async (entry, name) => {
  const out = path.join(dir, name);
  await build({ entryPoints: [path.join(GAME, 'src', ...entry)], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
  return import(pathToFileURL(out).href);
};
const { mogulHeight, mogulHeightGrad, fallFrom, MOGUL_SPACING, MOGUL_MAX_AMP, MOGUL_CELL } = await bundle(['terrain', 'Moguls.ts'], 'moguls.mjs');
const { Rider } = await bundle(['sim', 'Rider.ts'], 'rider.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); if (!ok) fails++; };

// ---------------------------------------------------------------- shape
{
  let maxH = 0, minH = Infinity, zero = 0;
  for (let y = 0; y <= 60; y += 0.25) for (let x = 0; x <= 60; x += 0.25) {
    const h = mogulHeight(x, y, 0.8, 0, -1, 0);
    maxH = Math.max(maxH, h); minH = Math.min(minH, h);
    zero += Math.abs(mogulHeight(x, y, 0, 0, -1, 0));
  }
  check('amp 0 is flat', zero === 0);
  check('amp 0.8 peaks between 0.75 and 0.8', maxH >= 0.75 && maxH <= 0.8, maxH.toFixed(3));
  check('troughs reach the base', minH < 0.02, minH.toFixed(3));
  let big = 0;
  for (let y = 0; y <= 60; y += 0.5) for (let x = 0; x <= 60; x += 0.5) big = Math.max(big, mogulHeight(x, y, 5, 0, -1, 0));
  check(`amp 5 clamps to ${MOGUL_MAX_AMP}`, big <= MOGUL_MAX_AMP + 1e-9, big.toFixed(3));
  // profile straight down the fall line (fall = -y): count maxima over 57 m, expect about 10
  const prof = (creep) => { const p = []; for (let y = 0; y >= -57; y -= 0.1) p.push(mogulHeight(1.4, y, 0.8, 0, -1, creep)); return p; };
  const a = prof(0);
  let peaks = 0;
  for (let i = 1; i < a.length - 1; i++) if (a[i] > a[i - 1] && a[i] >= a[i + 1] && a[i] > 0.3) peaks++;
  check(`about 10 bumps in 57 m (${MOGUL_SPACING} m spacing)`, peaks >= 8 && peaks <= 12, `${peaks}`);
  const b = prof(MOGUL_SPACING / 2);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  const corr = num / Math.sqrt(da * db);
  check('half a spacing of creep inverts the profile', corr < -0.5, corr.toFixed(2));
  // BUG-064: the grid is anchored to local cells, so a small change in the fall direction moves the
  // bumps by the same small amount anywhere on the map (it used to scale with the distance from the
  // pack origin and scramble the field). Same 57 m path down the fall line, only the direction changes,
  // at every 7.5 degrees of heading and at 0 m, 700 m and 3 km from the origin.
  const corrOf = (p, q) => { const mp = mean(p), mq = mean(q); let n = 0, dp = 0, dq = 0; for (let i = 0; i < p.length; i++) { n += (p[i] - mp) * (q[i] - mq); dp += (p[i] - mp) ** 2; dq += (q[i] - mq) ** 2; } return n / Math.sqrt(dp * dq); };
  const path = (ox, oy, deg, wob) => { const r = deg * Math.PI / 180, r2 = (deg + wob) * Math.PI / 180, p = []; for (let s = 0; s < 57; s += 0.1) p.push(mogulHeight(ox + Math.cos(r) * s, oy + Math.sin(r) * s, 0.8, Math.cos(r2), Math.sin(r2), 0)); return p; };
  // contrast over a 12 m square patch (a line down the fall line can sit on a flat row of the pattern)
  const patchSd = (cx, cy, deg) => { const r = deg * Math.PI / 180, v = []; for (let i = -12; i <= 12; i++) for (let j = -12; j <= 12; j++) v.push(mogulHeight(cx + i * 0.5, cy + j * 0.5, 0.8, Math.cos(r), Math.sin(r), 0)); const m = mean(v); return Math.sqrt(v.reduce((t, x) => t + (x - m) ** 2, 0) / v.length); };
  for (const [ox, oy] of [[3, 7], [700, -700], [-2900, 1100]]) {
    let worst = 1, ratio = Infinity;
    // a cell corner (four cells blend equally) and the nearest cell centre (one cell alone)
    const kx = Math.round(ox / MOGUL_CELL) * MOGUL_CELL, ky = Math.round(oy / MOGUL_CELL) * MOGUL_CELL;
    for (let deg = 0; deg < 360; deg += 7.5) {
      worst = Math.min(worst, corrOf(path(ox, oy, deg, 0), path(ox, oy, deg, 0.3)));
      ratio = Math.min(ratio, patchSd(kx, ky, deg) / patchSd(kx + MOGUL_CELL / 2, ky + MOGUL_CELL / 2, deg));
    }
    const d = Math.round(Math.hypot(ox, oy));
    check(`${d} m from the origin: a 0.3 deg turn of the fall line keeps the same bumps at every heading`, worst > 0.95, worst.toFixed(3));
    check(`${d} m from the origin: bumps where four cells blend keep at least 75% of a lone cell's relief at every heading`, ratio > 0.75, ratio.toFixed(2));
  }
  // the analytic slope the shader shades with matches the height's own slope (central differences),
  // including inside the cell blend bands; the slow phase jitter is left out of it, so allow a little
  {
    const o = [0, 0, 0];
    let worst = 0, scale = 0;
    for (let i = 0; i < 4000; i++) {
      const x = -900 + (i * 7.31) % 1800, y = -900 + (i * 13.7) % 1800, r = i * 0.37, e = 1e-3;
      const h = mogulHeightGrad(x, y, 0.8, Math.cos(r), Math.sin(r), 0.4, o);
      const gx = (mogulHeight(x + e, y, 0.8, Math.cos(r), Math.sin(r), 0.4) - mogulHeight(x - e, y, 0.8, Math.cos(r), Math.sin(r), 0.4)) / (2 * e);
      const gy = (mogulHeight(x, y + e, 0.8, Math.cos(r), Math.sin(r), 0.4) - mogulHeight(x, y - e, 0.8, Math.cos(r), Math.sin(r), 0.4)) / (2 * e);
      if (Math.abs(h - mogulHeight(x, y, 0.8, Math.cos(r), Math.sin(r), 0.4)) > 1e-12) worst = Infinity;
      worst = Math.max(worst, Math.hypot(o[1] - gx, o[2] - gy));
      scale = Math.max(scale, Math.hypot(gx, gy));
    }
    check('analytic slope matches the height within 6% of the steepest bump face', worst < 0.06 * scale, `${worst.toFixed(3)} of ${scale.toFixed(2)}`);
  }
  const f = [0, 0];
  fallFrom((x, y) => 0.4 * y, 10, 10, f);
  check('fallFrom on a plane falling to -y', Math.abs(f[0]) < 1e-3 && Math.abs(f[1] + 1) < 1e-3, `${f[0].toFixed(3)}, ${f[1].toFixed(3)}`);
  fallFrom(() => 100, 10, 10, f);
  check('fallFrom on flat ground is east', f[0] === 1 && f[1] === 0);
}

// ---------------------------------------------------------------- riding
/** a plane falling to -y at `deg` with a mogul field of `amp` (settable), ungroomed */
function plane(deg, amp) {
  const SL = Math.tan(deg * Math.PI / 180);
  const st = { amp };
  const base = (_x, y) => SL * y;
  const h = (x, y) => base(x, y) + mogulHeight(x, y, st.amp, 0, -1, 0);
  return {
    st,
    coarseFallbacks: 0,
    mask: { sample: (_x, _y, o) => { const m = o ?? [0, 0, 0, 0]; m[0] = 0; m[1] = 0; m[2] = 0; m[3] = 0; return m; } },
    mogulAmp: () => st.amp,
    groundHeight: h,
    groundNormal: (x, y, o) => {
      const e = 0.25, dx = (h(x + e, y) - h(x - e, y)) / (2 * e), dy = (h(x, y + e) - h(x, y - e)) / (2 * e), l = Math.hypot(dx, dy, 1);
      const n = o ?? [0, 0, 0]; n[0] = -dx / l; n[1] = -dy / l; n[2] = 1 / l; return n;
    },
  };
}
const inp = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, lean: 0, balance: 0 };
/** ride straight down for `secs`; `onStep(t, rider)` may change the world */
function ride(deg, amp, secs, onStep = null) {
  const p = plane(deg, amp);
  const r = new Rider(p, null);
  r.reset(0, 0, Math.PI, 1);
  const dt = 1 / 120;
  let airEdges = 0, wasOn = true, maxAcc = 0, lastVz = 0, airT = 0, maxAir = 0, maxDrop = 0;
  const speeds = [];
  for (let t = 0; t < secs; t += dt) {
    if (onStep) onStep(t, p);
    r.update(dt, inp);
    if (r.onFoot || r.crashed > 0) break;
    if (wasOn && !r.onGround) airEdges++;
    if (!r.onGround) { airT += dt; maxAir = Math.max(maxAir, airT); } else airT = 0;
    wasOn = r.onGround;
    maxAcc = Math.max(maxAcc, Math.abs(r.vz - lastVz) / dt); lastVz = r.vz;
    maxDrop = Math.max(maxDrop, p.groundHeight(r.x, r.y) - r.z); // how far below the snow the rider sinks
    if (t > secs - 6) speeds.push(r.speed);
  }
  const mean = speeds.reduce((s, x) => s + x, 0) / Math.max(1, speeds.length);
  return { airEdges, maxAcc, meanSpeed: mean, maxAir, maxDrop, crashed: r.crashed > 0, dist: r.distance };
}
{
  const flat = ride(25, 0, 12);
  const bumps = ride(25, 0.7, 12);
  check('flat plane: never airborne', flat.airEdges === 0, `${flat.airEdges} air edges`);
  check('bump run: thrown off the snow at least 3 times', bumps.airEdges >= 3, `${bumps.airEdges} air edges`);
  check('bump run: vertical jolts over 2 g', bumps.maxAcc > 2 * 9.81, `${(bumps.maxAcc / 9.81).toFixed(1)} g`);
  check('bump run is at least 10% slower than the groomer beside it', bumps.meanSpeed < flat.meanSpeed * 0.9,
    `${bumps.meanSpeed.toFixed(1)} vs ${flat.meanSpeed.toFixed(1)} m/s`);
  // the field appears under the rider at t = 3 s (its tile loaded late)
  const late = ride(25, 0, 12, (t, p) => { if (t >= 3) p.st.amp = 0.7; });
  check('late tile: rider never sinks more than 0.1 m into the snow', late.maxDrop <= 0.1, `${late.maxDrop.toFixed(2)} m`);
  check('late tile: no air over 1 s', late.maxAir <= 1.0, `${late.maxAir.toFixed(2)} s`);
  check('late tile: no crash', !late.crashed);
}

fs.rmSync(dir, { recursive: true, force: true });
if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
console.log('all ok');
