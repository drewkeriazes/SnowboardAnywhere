// Mogul check (FEAT-059, FEAT-147): the bump function (size from the slope, spread, spacing, pattern
// changes down the run, clamp, creep, fall direction) and the
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
const { mogulHeight, mogulHeightGrad, mogulSize, fallFrom, downhillFrom, MOGUL_MAX_AMP, MOGUL_CELL } = await bundle(['terrain', 'Moguls.ts'], 'moguls.mjs');
const { Rider } = await bundle(['sim', 'Rider.ts'], 'rider.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); if (!ok) fails++; };

// ---------------------------------------------------------------- shape
const D2R = Math.PI / 180;
const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const corrOf = (p, q) => { const mp = mean(p), mq = mean(q); let n = 0, dp = 0, dq = 0; for (let i = 0; i < p.length; i++) { n += (p[i] - mp) * (q[i] - mq); dp += (p[i] - mp) ** 2; dq += (q[i] - mq) ** 2; } return n / Math.sqrt(dp * dq); };
const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
/** bump crests (local maxima over +-1 m, above 0.15 of the size) in a square patch on a plane falling
 *  to -y at `deg`, field strength `amp`; 0.25 m grid, a 1 m border left out */
function crests(cx, cy, side, deg, amp) {
  const t = Math.tan(deg * D2R), px = 0.25, n = Math.round(side / px), H = new Float64Array(n * n), out = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) H[j * n + i] = mogulHeight(cx - side / 2 + i * px, cy - side / 2 + j * px, amp, 0, -t, 0);
  const floor = 0.15 * amp * mogulSize(t);
  for (let j = 4; j < n - 4; j++) for (let i = 4; i < n - 4; i++) {
    const h = H[j * n + i];
    if (h < floor) continue;
    let pk = true;
    for (let q = -4; q <= 4 && pk; q++) for (let r = -4; r <= 4; r++) if ((q || r) && H[(j + q) * n + i + r] > h) { pk = false; break; }
    if (pk) out.push(h);
  }
  return out;
}
{
  let zero = 0;
  for (let y = 0; y <= 60; y += 0.5) for (let x = 0; x <= 60; x += 0.5) zero += Math.abs(mogulHeight(x, y, 0, 0, -0.5, 0));
  check('amp 0 is flat', zero === 0);
  // FEAT-147: size from the slope. Crests over ten 40 m squares down each slope (several pattern regions)
  const field = (deg) => { const c = []; for (let k = 0; k < 10; k++) c.push(...crests(1234 + (k % 4) * 40, -600 - k * 40, 40, deg, 1)); return c; };
  const steep = field(33), mid = field(22), gentle = field(17);
  check('steep run (33 deg): the biggest bumps reach chest to head height (p95 1.3 to 1.8 m)', pct(steep, 0.95) >= 1.3 && Math.max(...steep) <= MOGUL_MAX_AMP + 1e-9,
    `p95 ${pct(steep, 0.95).toFixed(2)}, max ${Math.max(...steep).toFixed(2)} m`);
  check('moderate run (22 deg): bumps knee to thigh high (median 0.45 to 0.9 m)', pct(mid, 0.5) >= 0.45 && pct(mid, 0.5) <= 0.9, `median ${pct(mid, 0.5).toFixed(2)} m`);
  check('gentle run (17 deg): small bumps (p95 under 0.8 m)', pct(gentle, 0.95) < 0.8, `p95 ${pct(gentle, 0.95).toFixed(2)} m`);
  check('steeper is bigger', pct(gentle, 0.5) < pct(mid, 0.5) && pct(mid, 0.5) < pct(steep, 0.5),
    `medians ${pct(gentle, 0.5).toFixed(2)}, ${pct(mid, 0.5).toFixed(2)}, ${pct(steep, 0.5).toFixed(2)} m`);
  check('mogulSize grows with the slope', mogulSize(Math.tan(15 * D2R)) < 0.6 && mogulSize(Math.tan(40 * D2R)) * 1.3 <= MOGUL_MAX_AMP + 1e-9,
    `${mogulSize(Math.tan(15 * D2R)).toFixed(2)} .. ${mogulSize(Math.tan(40 * D2R)).toFixed(2)} m`);
  // less uniform: crest heights on one slope spread out (the old egg-crate's were all equal)
  const cv = Math.sqrt(mean(steep.map((h) => (h - mean(steep)) ** 2))) / mean(steep);
  check('crest heights vary (coefficient of variation over 0.12)', cv > 0.12, cv.toFixed(2));
  // spacing: 4 to 7 m along a line, staggered, so 3 to 9 crests per 100 m2
  const dens = steep.length / (10 * 38 * 38) * 100;
  check('3 to 9 bumps per 100 m2', dens >= 3 && dens <= 9, dens.toFixed(1));
  // pattern changes down the run: crest count over 80 m sections (one pattern region each) differs
  const counts = [];
  for (let k = 0; k < 8; k++) counts.push(crests(1250, -580 - k * 80, 36, 30, 1).length);
  check('the pattern changes down the run (crests per 80 m section vary by 30% or more)', Math.max(...counts) >= 1.3 * Math.min(...counts), counts.join(' '));
  // troughs reach the base; the cell blend can take them a little below it
  let lo = Infinity;
  for (let y = -700; y <= -560; y += 0.25) for (let x = 1200; x <= 1300; x += 0.5) lo = Math.min(lo, mogulHeight(x, y, 1, 0, -Math.tan(33 * D2R), 0));
  check('troughs reach the base, at most 0.4 m below it', lo < 0.02 && lo > -0.4, lo.toFixed(3));
  let big = 0;
  for (let y = 0; y <= 80; y += 0.5) for (let x = 0; x <= 80; x += 0.5) big = Math.max(big, mogulHeight(x, y, 5, 0, -2, 0));
  check(`amp 5 on a 63 deg face stays under ${MOGUL_MAX_AMP} m`, big <= MOGUL_MAX_AMP + 1e-9, big.toFixed(3));
  // creep moves the field uphill by its distance (the slow warp stays put, so not exactly)
  const prof = (creep, dy) => { const p = []; for (let y = -600; y >= -657; y -= 0.1) p.push(mogulHeight(1251.4, y + dy, 0.8, 0, -0.5, creep)); return p; };
  const c0 = corrOf(prof(0, 0), prof(2, 2));
  check('2 m of creep moves the field 2 m uphill', c0 > 0.9, c0.toFixed(2));
  // BUG-064: the pattern is anchored to local cells, so a small change in the fall direction moves the
  // bumps by the same small amount anywhere on the map (it used to scale with the distance from the
  // pack origin and scramble the field). Same 57 m path down the fall line, only the direction changes,
  // at every 7.5 degrees of heading and at 0 m, 700 m and 3 km from the origin.
  const SL = Math.tan(28 * D2R);
  const path = (ox, oy, deg, wob) => { const r = deg * D2R, r2 = (deg + wob) * D2R, p = []; for (let s = 0; s < 57; s += 0.1) p.push(mogulHeight(ox + Math.cos(r) * s, oy + Math.sin(r) * s, 0.8, SL * Math.cos(r2), SL * Math.sin(r2), 0)); return p; };
  // contrast over a 12 m square patch (a line down the fall line can sit on a flat row of the pattern)
  const patchSd = (cx, cy, deg) => { const r = deg * D2R, v = []; for (let i = -12; i <= 12; i++) for (let j = -12; j <= 12; j++) v.push(mogulHeight(cx + i * 0.5, cy + j * 0.5, 0.8, SL * Math.cos(r), SL * Math.sin(r), 0)); const m = mean(v); return Math.sqrt(v.reduce((t, x) => t + (x - m) ** 2, 0) / v.length); };
  for (const [ox, oy] of [[3, 7], [700, -700], [-2900, 1100]]) {
    let worst = 1, ratio = Infinity;
    // a cell corner (four cells blend equally) against the four cell centres around it (each cell
    // alone; FEAT-147: cells in different pattern regions have their own relief)
    const kx = Math.round(ox / MOGUL_CELL) * MOGUL_CELL, ky = Math.round(oy / MOGUL_CELL) * MOGUL_CELL, hc = MOGUL_CELL / 2;
    for (let deg = 0; deg < 360; deg += 7.5) {
      worst = Math.min(worst, corrOf(path(ox, oy, deg, 0), path(ox, oy, deg, 0.3)));
      const lone = (patchSd(kx - hc, ky - hc, deg) + patchSd(kx + hc, ky - hc, deg) + patchSd(kx - hc, ky + hc, deg) + patchSd(kx + hc, ky + hc, deg)) / 4;
      ratio = Math.min(ratio, patchSd(kx, ky, deg) / lone);
    }
    const d = Math.round(Math.hypot(ox, oy));
    check(`${d} m from the origin: a 0.3 deg turn of the fall line keeps the same bumps at every heading`, worst > 0.95, worst.toFixed(3));
    // FEAT-147's variance-preserving blend keeps a little less than BUG-062's smooth maximum did (about
    // 80%) but has no creases or steps at the band edges
    check(`${d} m from the origin: bumps where four cells blend keep at least 70% of the lone cells' relief at every heading`, ratio > 0.7, ratio.toFixed(2));
  }
  // no steps: the cell blend and the pattern regions join without a jump (the first FEAT-147 blend, a
  // weighted smooth maximum, snapped tall bumps in at the band edges); 1 cm steps down 400 m of cells
  {
    let worst = 0;
    const t = Math.tan(30 * D2R);
    for (let x = 1230; x < 1300; x += 0.5) for (let y = -560; y > -960; y -= 0.01) {
      worst = Math.max(worst, Math.abs(mogulHeight(x, y, 1, 0, -t, 0) - mogulHeight(x, y - 0.01, 1, 0, -t, 0)));
    }
    check('no steps: under 2 cm of change per 1 cm along the fall line', worst < 0.02, `${(worst * 100).toFixed(2)} cm`);
  }
  // the analytic slope the shader shades with matches the height's own slope (central differences),
  // including inside the cell blend bands; the slow warp is left out of it, so allow a little
  {
    const o = [0, 0, 0];
    let worst = 0, scale = 0;
    for (let i = 0; i < 4000; i++) {
      const x = -900 + (i * 7.31) % 1800, y = -900 + (i * 13.7) % 1800, r = i * 0.37, e = 1e-3, fx = SL * Math.cos(r), fy = SL * Math.sin(r);
      const h = mogulHeightGrad(x, y, 0.8, fx, fy, 0.4, o);
      const gx = (mogulHeight(x + e, y, 0.8, fx, fy, 0.4) - mogulHeight(x - e, y, 0.8, fx, fy, 0.4)) / (2 * e);
      const gy = (mogulHeight(x, y + e, 0.8, fx, fy, 0.4) - mogulHeight(x, y - e, 0.8, fx, fy, 0.4)) / (2 * e);
      if (Math.abs(h - mogulHeight(x, y, 0.8, fx, fy, 0.4)) > 1e-12) worst = Infinity;
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
  downhillFrom((x, y) => 0.4 * y + 0.1 * x, 10, 10, f);
  check('downhillFrom carries the slope as its length', Math.abs(f[0] + 0.1) < 1e-9 && Math.abs(f[1] + 0.4) < 1e-9, `${f[0].toFixed(3)}, ${f[1].toFixed(3)}`);
}

// ---------------------------------------------------------------- riding
/** a plane falling to -y at `deg` with a mogul field of `amp` (settable), ungroomed */
function plane(deg, amp) {
  const SL = Math.tan(deg * Math.PI / 180);
  const st = { amp };
  const base = (_x, y) => SL * y;
  // FEAT-147: bumps sized by the slope; the field starts 10 to 15 m below the start, so the rider rolls
  // into it (standing still in front of a big bump's near-level uphill face, they would not move)
  const runIn = (y) => { const t = Math.min(1, Math.max(0, (-10 - y) / 5)); return t * t * (3 - 2 * t); };
  const h = (x, y) => base(x, y) + mogulHeight(x, y, st.amp * runIn(y), 0, -SL, 0);
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
  // FEAT-147: a steep run's chest-high bumps, straight down with no input: rough and slow, but ridable
  const steep = ride(33, 1, 12);
  check('steep big-bump run (33 deg): no crash in 12 s straight down', !steep.crashed, `${steep.airEdges} air edges`);
  const steepFlat = ride(33, 0, 12);
  check('steep big-bump run is at least 10% slower than a smooth 33 deg plane', steep.meanSpeed < steepFlat.meanSpeed * 0.9,
    `${steep.meanSpeed.toFixed(1)} vs ${steepFlat.meanSpeed.toFixed(1)} m/s`);
}

fs.rmSync(dir, { recursive: true, force: true });
if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
console.log('all ok');
