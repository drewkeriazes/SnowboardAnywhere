// Lip check (FEAT-277): rides the Rider physics off lips, side hits and kickers on exact synthetic
// surfaces (no pack, no browser) and checks the takeoff against projectile physics: leave a lip at
// horizontal speed v with takeoff angle theta and you fly from vz = v tan(theta) until the parabola
// meets the ground. Holding the jump (or pressing the board) through the lip adds a little; big air
// comes from speed and angle, not the pop. Open snow must not launch you any more than before:
//   1. a 15 deg side hit at about 10 m/s onto the flat: 0.3 to 0.6 s of air, within 15% of physics
//   2. the same with the jump held (never released): at least 0.08 s more air
//   3. the same with a press (lean 0.8): more air than 1, no more than 2
//   4. a 25 deg kicker at about 20 m/s onto a table and a 32 deg landing: within 15% of physics, and
//      a held jump adds under 20% of the air
//   5. a 20 deg groomer with 1 m elevation-model noise (bilinear, normals over +-1 m like the pack),
//      straight tuck and linked carves: no more takeoffs or air than main before FEAT-277
//   6. a rollover from 10 to 25 deg over 18 m at 20 m/s: no more than main (physics: no air)
//   7. a 3.5 m cat track across 25 deg: along it no more than main; crossing it down the fall line at
//      15 m/s leaves the shelf flat and lands on the 25 deg slope below, within 15% of physics
//   8. the flat and 2 to 6 deg rises ridden into at 18 m/s (climbing, where a lip counts) with 8 and 10 cm
//      of 1 m noise (lidar; Vail groomers read as 8 to 9): no more than main (15 and 20 cm, stress levels, printed)
//   9. a 2 deg falling run-out with 10 cm noise: no more than main
//  10. a roller on a 20 deg run, a 3 m face at -5 or +5 deg breaking back to -20: within 15% of physics
// Prints the numbers and exits 1 on a failed check.
// node tools/lipcheck.mjs [--src <dir>]   (--src: another game/src to bundle, e.g. main's for a before)
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { GAME } from './paths.mjs';

const argv = process.argv.slice(2);
const SRC = argv.includes('--src') ? path.resolve(argv[argv.indexOf('--src') + 1]) : path.join(GAME, 'src');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lipcheck-')), 'rider.mjs');
await build({ entryPoints: [path.join(SRC, 'sim', 'Rider.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error', nodePaths: [path.join(GAME, 'node_modules')] });
const { Rider } = await import(pathToFileURL(out).href);

const D = Math.PI / 180, G = 9.81, DT = 1 / 120;
let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }
const f2 = (v) => v.toFixed(2);

// ---------------------------------------------------------------- surfaces
/**
 * A profile along the line of travel: pieces of horizontal length `len` (m) whose grade angle (deg,
 * + rising along the travel) goes linearly from `a` to `b` (a straight when they match). Angles can jump
 * between pieces (a sharp lip or kink); the height is continuous. Before the first piece and past the
 * last one the end angles carry on. Returns the height z(s) and slope dz/ds(s), exact, and `at(i)`, the
 * distance where piece i starts (at(pieces.length) is the end).
 */
function profile(pieces, s0 = 0, z0 = 0) {
  const st = [], zs = [];
  let s = s0, z = z0;
  for (const p of pieces) { st.push(s); zs.push(z); z = rise(p, p.len) + z; s += p.len; }
  st.push(s); zs.push(z);
  function rise(p, u) {
    const a = p.a * D, b = p.b * D;
    if (a === b) return Math.tan(a) * u;
    const k = (b - a) / p.len;
    return (Math.log(Math.cos(a)) - Math.log(Math.cos(a + k * u))) / k;
  }
  function find(s) { let i = 0; while (i < pieces.length - 1 && s >= st[i + 1]) i++; return i; }
  return {
    at: (i) => st[i],
    z(s) {
      if (s <= s0) return z0 + Math.tan(pieces[0].a * D) * (s - s0);
      const n = pieces.length;
      if (s >= st[n]) return zs[n] + Math.tan(pieces[n - 1].b * D) * (s - st[n]);
      const i = find(s);
      return zs[i] + rise(pieces[i], s - st[i]);
    },
    slope(s) {
      if (s <= s0) return Math.tan(pieces[0].a * D);
      const n = pieces.length;
      if (s >= st[n]) return Math.tan(pieces[n - 1].b * D);
      const i = find(s), p = pieces[i];
      return Math.tan((p.a + (p.b - p.a) * (s - st[i]) / p.len) * D);
    },
  };
}
/** a straight of `len` m at `deg` */
const line = (len, deg) => ({ len, a: deg, b: deg });
/** a curve of radius about `R` m from grade `a` to `b` (deg); its horizontal length is a circle's */
const bend = (R, a, b) => ({ len: R * Math.abs(Math.sin(b * D) - Math.sin(a * D)), a, b });

/** the fake pack the Rider reads: height and slope functions of (x, y), no mask, no moguls */
function pack(height, grad) {
  return {
    mask: null, coarseFallbacks: 0, mogulAmp: () => 0,
    groundHeight: (x, y) => height(x, y),
    groundNormal: (x, y, o = [0, 0, 1]) => { const [gx, gy] = grad(x, y), l = Math.hypot(gx, gy, 1); o[0] = -gx / l; o[1] = -gy / l; o[2] = 1 / l; return o; },
  };
}
/** a profile laid along +y (north): the same for every x */
const alongY = (P) => pack((_x, y) => P.z(y), (_x, y) => [0, P.slope(y)]);

/**
 * A plane falling to +y at `deg` plus noise like a 1 m elevation model: a seeded Gaussian height of
 * standard deviation `sd` m at every 1 m grid node, read bilinearly, with the normal from central
 * differences over +-1 m (as Pack.groundNormal does at the finest 1 m set).
 */
function demPlane(deg, sd, seed) {
  const t = Math.tan(deg * D);
  const hash = (i, j, k) => { let h = (i * 374761393 + j * 668265263 + (seed * 3 + k) * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return ((h >>> 0) + 0.5) / 4294967296; };
  const node = (i, j) => sd * Math.sqrt(-2 * Math.log(hash(i, j, 0))) * Math.cos(2 * Math.PI * hash(i, j, 1));
  const h = (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), ax = x - i, ay = y - j;
    const n = (node(i, j) * (1 - ax) + node(i + 1, j) * ax) * (1 - ay) + (node(i, j + 1) * (1 - ax) + node(i + 1, j + 1) * ax) * ay;
    return -t * y + n;
  };
  return pack(h, (x, y) => [(h(x + 1, y) - h(x - 1, y)) / 2, (h(x, y + 1) - h(x, y - 1)) / 2]);
}

/**
 * The bend along the travel (vx, vy) at (x, y), for the takeoff report only: the slope behind minus the
 * slope ahead, each a least-squares fit through the height here to the heights 1, 2 and 3 m away (as
 * FEAT-277's lipShare in sim/rider/Jumps.ts measures it; about 0.25 for a 15 deg kink onto the flat).
 */
function bendAt(p, x, y, vx, vy) {
  const l = Math.hypot(vx, vy) || 1, ux = vx / l, uy = vy / l, h0 = p.groundHeight(x, y);
  let back = 0, ahead = 0, kk = 0;
  for (const d of [1, 2, 3]) {
    back += (h0 - p.groundHeight(x - ux * d, y - uy * d)) * d;
    ahead += (p.groundHeight(x + ux * d, y + uy * d) - h0) * d;
    kk += d * d;
  }
  return (back - ahead) / kk;
}

// ---------------------------------------------------------------- riding
const input =() => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, lean: 0, balance: 0 });

/**
 * Ride `p` from (x, y) along `heading` (radians from +y, clockwise) at horizontal speed `v` on groomed
 * snow for `secs`, `drive(t, r, inp)` setting the input each step. `lip` (optional): the distance along
 * +y of a lip; the speed on the snow just before it is kept. Returns every air (start y, length s, peak
 * height over the ground m, takeoff vz), the takeoffs, the lip speed, the speed range and a crash.
 */
function ride(p, { x = 0, y = 0, heading = 0, v, secs, drive = null, lip = null }) {
  const r = new Rider(p, null);
  r.pressMode = 'off'; // the press balance (FEAT-140) is presscheck's; here only the lean counts
  r.surface.groomed = 1;
  r.reset(x, y, heading);
  r.z = p.groundHeight(x, y);
  r.vx = Math.sin(heading) * v; r.vy = Math.cos(heading) * v;
  const n = p.groundNormal(x, y);
  r.vz = -(r.vx * n[0] + r.vy * n[1]) / n[2];
  const inp = input();
  const airs = [];
  let air = null, wasOn = true, crashed = false, lipVh = NaN, lipV = NaN, vMin = Infinity, vMax = 0;
  for (let t = 0; t < secs; t += DT) {
    if (drive) drive(t, r, inp);
    r.update(DT, inp);
    if (r.crashed > 0) crashed = true;
    if (r.onGround && lip !== null && r.y < lip) { lipVh = Math.hypot(r.vx, r.vy); lipV = Math.hypot(r.vx, r.vy, r.vz); }
    if (wasOn && !r.onGround) { air = { x: r.x, y: r.y, t: 0, peak: 0, vz: r.vz, v: r.speed, bend: bendAt(p, r.x, r.y, r.vx, r.vy) }; airs.push(air); }
    if (!r.onGround && air) { air.t += DT; air.peak = Math.max(air.peak, r.z - p.groundHeight(r.x, r.y)); }
    wasOn = r.onGround;
    vMin = Math.min(vMin, r.speed); vMax = Math.max(vMax, r.speed);
  }
  const longest = airs.reduce((m, a) => Math.max(m, a.t), 0);
  return { airs, takeoffs: airs.length, long: airs.filter((a) => a.t > 0.15).length, longest, lipVh, lipV, vMin, vMax, crashed, r };
}
/** the first air that starts within 1 m of the lip (the takeoff off it), or a zero one */
const offLip = (run, lip) => run.airs.find((a) => a.y > lip - 0.2 && a.y < lip + 1) ?? { y: NaN, t: 0, peak: 0, vz: 0 };

/** projectile physics: leave (s0, z0) at horizontal speed `vh` and vertical `vz0` over profile P; the time to land and the peak over the ground */
function flight(P, s0, z0, vh, vz0) {
  let peak = 0;
  for (let t = 1e-4; t < 20; t += 1e-4) {
    const s = s0 + vh * t, above = z0 + vz0 * t - G * t * t / 2 - P.z(s);
    if (above <= 0) return { t, peak };
    peak = Math.max(peak, above);
  }
  return { t: Infinity, peak };
}
/** the first few takeoffs of a set of runs: where, the vz and speed leaving, the bend there, the air */
const takeoffs = (airs, n = 6) => airs.slice(0, n).map((a) => `${a.where ?? ''}at (${a.x.toFixed(1)}, ${a.y.toFixed(1)}) vz ${f2(a.vz)} m/s at ${a.v.toFixed(1)} m/s, bend ${f2(a.bend)}, ${f2(a.t)} s`).join('; ');
const describe = (run, a) => `${f2(a.t)} s air, peak ${f2(a.peak)} m, takeoff vz ${f2(a.vz)} m/s, lip ${f2(run.lipV)} m/s (${f2(run.lipVh)} horizontal), ${run.takeoffs} takeoff(s)${run.crashed ? ', CRASHED' : ''}`;

// ---------------------------------------------------------------- 1 to 3: side hit
{
  // on the flat: 10 m run-in, a 4 m radius transition up to 15 deg, 2.5 m of face, a sharp lip, flat past it
  const P = profile([line(10, 0), bend(4, 0, 15), line(2.5, 15), line(40, 0)]);
  const LIP = P.at(3), p = alongY(P), v0 = 11;
  const go = (drive) => ride(p, { v: v0, secs: 4, drive, lip: LIP });
  const plain = go(null), jumped = go((t, r, inp) => { inp.jumpHeld = true; }), pressed = go((t, r, inp) => { inp.lean = 0.8; });
  const a1 = offLip(plain, LIP), a2 = offLip(jumped, LIP), a3 = offLip(pressed, LIP);
  const want = flight(P, LIP, P.z(LIP), plain.lipVh, plain.lipVh * Math.tan(15 * D));
  console.log(`side hit, 15 deg face 2.5 m long, 4 m transition, flat beyond (physics at ${f2(plain.lipVh)} m/s: ${f2(want.t)} s, peak ${f2(want.peak)} m):`);
  console.log(`  no input:   ${describe(plain, a1)}`);
  console.log(`  jump held:  ${describe(jumped, a2)}`);
  console.log(`  press 0.8:  ${describe(pressed, a3)}`);
  check('side hit at 10 m/s with no input: 0.3 to 0.6 s of air, within 15% of projectile physics', a1.t >= 0.3 && a1.t <= 0.6 && Math.abs(a1.t - want.t) <= 0.15 * want.t && !plain.crashed,
    `${f2(a1.t)} s against ${f2(want.t)} s`);
  // a full charge adds about 0.8 m/s of vz, 2 * 0.8 / g = 0.16 s of air; half of it (0.08 s, ten steps) is
  // a clear gain that still passes if the charge is not quite full at the lip
  check('jump held through the lip: at least 0.08 s more air', a2.t >= a1.t + 0.08 && !jumped.crashed, `${f2(a2.t)} s against ${f2(a1.t)} s (+${f2(a2.t - a1.t)})`);
  // the press springs less than a full charge; two steps (0.017 s) is the least that is not step noise
  check('press through the lip: more air than none, no more than the jump held', a3.t >= a1.t + 2 * DT && a3.t <= a2.t + DT && !pressed.crashed,
    `${f2(a3.t)} s against ${f2(a1.t)} and ${f2(a2.t)} s`);
}

// ---------------------------------------------------------------- 4: kicker
{
  // FEAT-113 shape: a 15 deg run-in, a 12 m radius transition to a 25 deg lip (2 m of face), a 12 m flat
  // table at lip height, a sharp knuckle onto a 32 deg landing, a 30 m radius run-out to the flat
  const P = profile([line(12, -15), bend(12, -15, 25), line(2, 25), line(12, 0), line(70, -32), bend(30, -32, 0), line(60, 0)]);
  const LIP = P.at(3), p = alongY(P), v0 = 20.6;
  const plain = ride(p, { v: v0, secs: 8, lip: LIP }), jumped = ride(p, { v: v0, secs: 8, lip: LIP, drive: (t, r, inp) => { inp.jumpHeld = true; } });
  const a1 = offLip(plain, LIP), a2 = offLip(jumped, LIP);
  const want = flight(P, LIP, P.z(LIP), plain.lipVh, plain.lipVh * Math.tan(25 * D));
  console.log(`kicker, 25 deg lip, 12 m table, 32 deg landing (physics at ${f2(plain.lipVh)} m/s: ${f2(want.t)} s, peak ${f2(want.peak)} m):`);
  console.log(`  no input:   ${describe(plain, a1)}`);
  console.log(`  jump held:  ${describe(jumped, a2)}`);
  check('kicker at 20 m/s: air within 15% of projectile physics', Math.abs(a1.t - want.t) <= 0.15 * want.t && !plain.crashed, `${f2(a1.t)} s against ${f2(want.t)} s`);
  check('kicker: a held jump adds under 20% of the air (speed and angle send you, not the pop)', a2.t >= a1.t - DT && a2.t - a1.t < 0.2 * a1.t,
    `${f2(a2.t)} s against ${f2(a1.t)} s (+${(100 * (a2.t - a1.t) / Math.max(a1.t, 1e-9)).toFixed(0)}%)`);
}

// ---------------------------------------------------------------- 5 to 7: open snow, against main
// Measured on main before FEAT-277 (e968ce0, node tools/lipcheck.mjs --src <main's game/src>): none of these
// left the snow at all. Open snow must not
// launch you more than it did: no more takeoffs (one more allowed where main has a handful: a changed step
// can move a takeoff by one bump), no more airs over 0.15 s, the longest no more than 0.02 s (2 steps) longer.
const MAIN = {
  dem5Straight: { takeoffs: 0, long: 0, longest: 0 },
  dem5Carve: { takeoffs: 0, long: 0, longest: 0 },
  dem10Straight: { takeoffs: 0, long: 0, longest: 0 },
  dem10Carve: { takeoffs: 0, long: 0, longest: 0 },
  rollover: { takeoffs: 0, long: 0, longest: 0 },
  catAlong: { takeoffs: 0, long: 0, longest: 0 },
  catDrift: { takeoffs: 0, long: 0, longest: 0 },
  // climbing open snow and the run-out (8, 9): flat and 2 to 6 deg rises, 4 seeds each, per noise level
  climb8: { takeoffs: 0, long: 0, longest: 0 },
  climb10: { takeoffs: 0, long: 0, longest: 0 },
  climb15: { takeoffs: 0, long: 0, longest: 0 },
  climb20: { takeoffs: 0, long: 0, longest: 0 },
  runout: { takeoffs: 0, long: 0, longest: 0 },
};
function noMore(label, run, base) {
  const ok = run.takeoffs <= base.takeoffs + (base.takeoffs >= 3 ? 1 : 0) && run.long <= base.long && run.longest <= base.longest + 2 * DT + 1e-9;
  check(`${label}: no more air than main`, ok && !run.crashed,
    `${run.takeoffs} takeoffs (main ${base.takeoffs}), ${run.long} over 0.15 s (main ${base.long}), longest ${f2(run.longest)} s (main ${f2(base.longest)})${run.crashed ? ', CRASHED' : ''}`);
  if (!ok && run.airs?.length) console.log(`       takeoffs: ${takeoffs(run.airs)}`);
}
/** add run `b` into the total `a` (takeoffs, long airs, the longest, crashes, speeds, the airs tagged `where`) */
function addRun(a, b, where) {
  a.takeoffs += b.takeoffs; a.long += b.long; a.longest = Math.max(a.longest, b.longest); a.crashed ||= b.crashed;
  a.vMin = Math.min(a.vMin, b.vMin); a.vMax = Math.max(a.vMax, b.vMax);
  for (const air of b.airs) a.airs.push({ ...air, where: where + (air.where ?? '') });
  return a;
}
const total = () => ({ takeoffs: 0, long: 0, longest: 0, crashed: false, vMin: Infinity, vMax: 0, airs: [] });
{
  // standard deviation of the per-node noise: 5 cm is a typical open-snow lidar error on a 1 m DEM, 10 cm is
  // the USGS 3DEP QL2 limit (RMSEz 10 cm). Vail's groomed runs (10 to 35 deg) are as rough as about 8 to 9 cm
  // of this noise by the bend over +-1.5 m along the fall line (its spread 0.09; 5 cm gives 0.05, 10 cm 0.11)
  const runs = (sd) => {
    const agg = total(), carve = total();
    for (const seed of [1, 2, 3]) {
      const p = demPlane(20, sd, seed);
      addRun(agg, ride(p, { x: 0.37 + seed * 11, v: 15, secs: 15, drive: (t, r, inp) => { inp.tuck = r.speed < 25; } }), `seed ${seed} `);
      addRun(carve, ride(p, { x: 0.37 + seed * 11, v: 15, secs: 15, drive: (t, r, inp) => { inp.steer = Math.floor(t / 1.25) % 2 ? -0.7 : 0.7; inp.tuck = r.speed < 20; } }), `seed ${seed} `);
    }
    return [agg, carve];
  };
  for (const [sd, key] of [[0.05, 'dem5'], [0.1, 'dem10']]) {
    const [s, c] = runs(sd);
    console.log(`20 deg groomer, ${sd * 100} cm noise on a 1 m grid, 3 seeds x 15 s: straight ${s.takeoffs} takeoffs, longest ${f2(s.longest)} s (${f2(s.vMin)} to ${f2(s.vMax)} m/s); linked carves ${c.takeoffs} takeoffs, longest ${f2(c.longest)} s (${f2(c.vMin)} to ${f2(c.vMax)} m/s)`);
    noMore(`groomer with ${sd * 100} cm DEM noise, straight tuck`, s, MAIN[key + 'Straight']);
    noMore(`groomer with ${sd * 100} cm DEM noise, linked carves`, c, MAIN[key + 'Carve']);
  }
}
{
  // a convex rollover: 10 deg rolling to 25 deg over 18 m (a radius of about 70 m). At 20 m/s it asks
  // v^2/R = 5.7 m/s^2 of the 9 m/s^2 that gravity holds you down with, so physics keeps you on the snow
  const P = profile([line(20, -10), { len: 18, a: -10, b: -25 }, line(60, -25)]);
  const run = ride(alongY(P), { v: 20, secs: 4 });
  console.log(`rollover 10 to 25 deg over 18 m at 20 m/s: ${run.takeoffs} takeoffs, longest ${f2(run.longest)} s, ${f2(run.vMin)} to ${f2(run.vMax)} m/s`);
  noMore('rollover at 20 m/s', run, MAIN.rollover);
  check('rollover at 20 m/s: physics keeps you on the snow (no air over 0.15 s)', run.long === 0, `longest ${f2(run.longest)} s`);
}
{
  // a 3.5 m flat cat track cut across a 25 deg slope falling to +y: the uphill edge a concave kink, the downhill one a convex kink
  const P = profile([line(30, -25), line(3.5, 0), line(60, -25)]);
  const p = alongY(P), A = P.at(1), B = P.at(2), EAST = Math.PI / 2;
  const along = ride(p, { y: (A + B) / 2, heading: EAST, v: 10, secs: 4 });
  // drifting off the downhill edge at 5 deg to the track: across the edge at under 1 m/s, so no lip
  const drift = ride(p, { y: A + 0.3, heading: EAST - 5 * D, v: 10, secs: 4 });
  console.log(`cat track along at 10 m/s: ${along.takeoffs} takeoffs, longest ${f2(along.longest)} s; drifting off its edge at 5 deg: ${drift.takeoffs} takeoffs, longest ${f2(drift.longest)} s${drift.crashed ? ', crashed' : ''}`);
  noMore('cat track, along it at 10 m/s', along, MAIN.catAlong);
  noMore('cat track, drifting off the downhill edge at 5 deg', drift, MAIN.catDrift);
  // crossing it down the fall line: the shelf is a lip (flat onto 25 deg). Leave it flat at the shelf speed
  // and land on the slope below: t = 2 v tan(25) / g
  const cross = ride(p, { y: A - 8, v: 15 * Math.cos(25 * D), secs: 4, lip: B });
  const a = offLip(cross, B), want = flight(P, B, P.z(B), cross.lipVh, 0);
  console.log(`cat track crossed down the fall line (physics at ${f2(cross.lipVh)} m/s: ${f2(want.t)} s, peak ${f2(want.peak)} m): ${describe(cross, a)}`);
  check('cat track crossed at 15 m/s: off the shelf within 15% of projectile physics', Math.abs(a.t - want.t) <= 0.15 * want.t && !cross.crashed, `${f2(a.t)} s against ${f2(want.t)} s`);
}

// ---------------------------------------------------------------- 8 to 10: climbing open snow, the run-out, rollers
{
  // 8. FEAT-277's lip only counts leaving the snow climbing, and 5 to 7 all descend. So: the flat and 2, 4
  // and 6 deg rises ridden into at 18 m/s (about 13 m/s after 4 s up 6 deg), straight with no input, 4
  // seeds each, with 8 and 10 cm of 1 m noise (honest lidar; Vail groomers read as 8 to 9 cm by the bend);
  // 15 and 20 cm are stress levels, printed and not checked: noise that rough makes real 13 degree kinks
  for (const [sd, key] of [[0.08, 'climb8'], [0.1, 'climb10'], [0.15, 'climb15'], [0.2, 'climb20']]) {
    const all = total(), per = [];
    for (const deg of [0, 2, 4, 6]) {
      const g = total();
      for (const seed of [1, 2, 3, 4]) addRun(g, ride(demPlane(-deg, sd, seed + 10 * deg), { x: 0.37 + seed * 7, v: 18, secs: 4 }), `${deg} deg seed ${seed} `);
      addRun(all, g, '');
      per.push(`${deg} deg ${g.takeoffs}/${g.long}/${f2(g.longest)} s`);
    }
    const base = MAIN[key];
    console.log(`flat and rises, ${sd * 100} cm noise, 4 seeds x 4 s from 18 m/s (takeoffs / over 0.15 s / longest): ${per.join(', ')}; ${all.vMin.toFixed(1)} to ${all.vMax.toFixed(1)} m/s; ${all.takeoffs - base.takeoffs} takeoffs and ${all.long - base.long} airs over 0.15 s more than main`);
    if (sd <= 0.1) noMore(`flat and 2 to 6 deg rises with ${sd * 100} cm DEM noise, straight`, all, base);
    else if (all.airs.length) console.log(`       takeoffs: ${takeoffs(all.airs)}`);
  }
}
{
  // 9. a 2 deg falling run-out with 10 cm noise, straight from 16 m/s, 4 seeds
  const all = total();
  for (const seed of [1, 2, 3, 4]) addRun(all, ride(demPlane(2, 0.1, seed + 50), { x: 0.37 + seed * 7, v: 16, secs: 5 }), `seed ${seed} `);
  console.log(`2 deg run-out, 10 cm noise, 4 seeds x 5 s from 16 m/s: ${all.takeoffs} takeoffs, longest ${f2(all.longest)} s, ${all.vMin.toFixed(1)} to ${all.vMax.toFixed(1)} m/s`);
  noMore('2 deg run-out with 10 cm DEM noise', all, MAIN.runout);
}
{
  // 10. a roller on a 20 deg descent: a 3 m face eases to -5 deg (or rises to +5), then a sharp break back to
  // -20 deg. A real lip relative to the slope: leave at the face's angle, land on the 20 deg slope below
  for (const face of [-5, 5]) {
    const P = profile([line(15, -20), bend(8, -20, face), line(3, face), line(80, -20)]);
    const LIP = P.at(3), run = ride(alongY(P), { v: 16, secs: 5, lip: LIP });
    const a = offLip(run, LIP), want = flight(P, LIP, P.z(LIP), run.lipVh, run.lipVh * Math.tan(face * D));
    console.log(`roller on 20 deg, 3 m face at ${face > 0 ? '+' : ''}${face} deg (physics at ${f2(run.lipVh)} m/s: ${f2(want.t)} s, peak ${f2(want.peak)} m): ${describe(run, a)}`);
    check(`roller with a ${face > 0 ? '+' : ''}${face} deg face on a 20 deg run: air within 15% of projectile physics`, Math.abs(a.t - want.t) <= 0.15 * want.t && !run.crashed, `${f2(a.t)} s against ${f2(want.t)} s`);
  }
}

fs.rmSync(path.dirname(out), { recursive: true, force: true });
console.log(fails ? `${fails} check(s) failed` : 'all lip checks passed');
process.exit(fails ? 1 : 0);
