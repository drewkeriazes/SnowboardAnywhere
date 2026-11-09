// Press balance check (FEAT-140): rides the Rider physics on exact planes (no pack, no browser) and
// holds a nose or tail press. With Press balance Off the press holds as long as the key; On, with no
// correction it is lost within a few seconds (a slam off the loaded end, or the board dropping
// flat off the other), and W / S played like a person (a reaction delay, a dead band) holds it longer.
// The drift grows with speed and bumps, Easy lasts longer, a lost press stays flat until the key is
// let go, an over-press below 3 m/s stalls instead of slamming, an ollie out of a press reports it
// clean and a short hop rides through, a quick player never loses one (no time limit, even on Hard),
// and holding the press key through a trick lands into the press. Prints the median press times.
// node tools/presscheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { GAME } from './paths.mjs';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'presscheck-')), 'rider.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'sim', 'Rider.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { Rider } = await import(pathToFileURL(out).href);

/** a plane falling away to -y at `deg`, optionally with moguls (amplitude m, wavelength m); groomed everywhere */
function plane(deg, mogul = 0, wave = 6) {
  const SL = Math.tan(deg * Math.PI / 180), k = 2 * Math.PI / wave;
  const h = (x, y) => SL * y + mogul * Math.sin(k * x) * Math.sin(k * y);
  return {
    coarseFallbacks: 0,
    mask: { sample: (_x, _y, o) => { const m = o ?? [0, 0, 0, 0]; m[0] = 0; m[1] = 0; m[2] = 1; m[3] = 0; return m; } },
    groundHeight: h,
    groundNormal: (x, y, o) => {
      const e = 0.25, dx = (h(x + e, y) - h(x - e, y)) / (2 * e), dy = (h(x, y + e) - h(x, y - e)) / (2 * e), l = Math.hypot(dx, dy, 1);
      const n = o ?? [0, 0, 0]; n[0] = -dx / l; n[1] = -dy / l; n[2] = 1 / l; return n;
    },
  };
}
const inp = (o = {}) => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, lean: 0, balance: 0, ...o });
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); if (!ok) fails++; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** a player: W / S toward the centre once the needle is past `band`, seen `delay` s late, let go near the centre */
const player = (band, delay) => {
  const hist = []; let held = 0;
  return (r) => {
    hist.push(r.pressing ? r.pressBalance : 0);
    const b = hist[Math.max(0, hist.length - 1 - Math.round(delay * 60))];
    if (b > band) held = -1; else if (b < -band) held = 1; else if (Math.abs(b) < 0.05) held = 0;
    return held;
  };
};

/**
 * Ride `pre` s down the plane, then hold a press (dir +1 nose, -1 tail) up to `max` s, with W / S from
 * `ctl`. Returns how it ended and the reports.
 */
function press({ deg = 12, mogul = 0, mode = 'on', dir = -1, seed = 1, pre = 3, max = 30, ctl = null, speed = null }) {
  const r = new Rider(plane(deg, mogul), null);
  r.pressMode = mode;
  const reports = [];
  r.onPress = (how, d, t, dist) => reports.push({ how, d, t, dist });
  r.reset(0, 0, Math.PI, seed);
  for (let k = 0; k < pre * 60; k++) { r.update(1 / 60, inp()); if (speed !== null) { const s = Math.hypot(r.vx, r.vy) || 1; r.vx *= speed / s; r.vy *= speed / s; } }
  const startSpeed = r.speed;
  let t = 0, maxSeen = 0, end = null;
  for (let k = 0; k < max * 60; k++) {
    r.update(1 / 60, inp({ lean: dir, balance: ctl ? ctl(r) : 0 }));
    if (speed !== null) { const s = Math.hypot(r.vx, r.vy) || 1; r.vx *= speed / s; r.vy *= speed / s; }
    t += 1 / 60;
    if (r.pressing) maxSeen = Math.max(maxSeen, r.pressT);
    if (reports.length) { end = reports[0]; break; }
  }
  return { r, reports, end, t, maxSeen, startSpeed };
}
const SEEDS = Array.from({ length: 41 }, (_, i) => 101 + i * 104729);
const times = (o) => SEEDS.map((seed) => { const p = press({ ...o, seed }); return p.end ? p.end.t : 30; });

// ---- Off: the press holds as long as the key
{
  const p = press({ mode: 'off', max: 10 });
  check('Press balance Off holds the press for 10 s', !p.end && Math.abs(p.r.lean) > 0.95 && p.r.crashed <= 0 && !p.r.pressing, `lean ${p.r.lean.toFixed(2)}`);
}
// ---- On, no correction: lost within a few seconds, both ways
{
  const ends = SEEDS.map((seed) => press({ seed }));
  const lost = ends.filter((p) => p.end && p.end.t < 10);
  const slams = ends.filter((p) => p.end?.how === 'slam'), flats = ends.filter((p) => p.end?.how === 'flat');
  check('with no correction the press is lost within 10 s', lost.length === ends.length, `${lost.length}/${ends.length}, median ${median(ends.map((p) => p.end?.t ?? 30)).toFixed(1)} s at ${ends[0].startSpeed.toFixed(1)} m/s`);
  check('losing it toward the loaded end slams, the other way drops flat', slams.length > 5 && flats.length > 5 && slams.every((p) => p.r.crashed > 0) && flats.every((p) => p.r.crashed <= 0), `${slams.length} slams, ${flats.length} flat`);
  const flat = flats[0];
  if (flat) {
    for (let k = 0; k < 60; k++) flat.r.update(1 / 60, inp({ lean: -1 }));
    check('a dropped press stays flat while the key is still held', Math.abs(flat.r.lean) < 0.05 && !flat.r.pressing, `lean ${flat.r.lean.toFixed(2)}`);
    for (let k = 0; k < 6; k++) flat.r.update(1 / 60, inp());
    for (let k = 0; k < 30; k++) flat.r.update(1 / 60, inp({ lean: -1 }));
    check('let go and press again starts a new press', flat.r.pressing && flat.r.lean < -0.5, `lean ${flat.r.lean.toFixed(2)}`);
  }
  check('the report carries the time and the distance', ends.every((p) => !p.end || (p.end.t >= 0.5 && p.end.dist > p.end.t * 3 && p.end.d === -1)), JSON.stringify(ends[0].end));
}
// ---- W / S hold it longer; the drift grows with speed and bumps; Easy is easier
const T = {
  none: median(times({ speed: 10 })),
  sloppy: median(times({ speed: 10, ctl: player(0.35, 0.3) })),
  careful: median(times({ speed: 10, ctl: player(0.2, 0.18) })),
  fast: median(times({ speed: 20, ctl: player(0.2, 0.18) })),
  moguls: median(times({ speed: 10, mogul: 0.5, ctl: player(0.2, 0.18) })),
  easy: median(times({ speed: 10, mode: 'easy' })),
};
console.log('median press (s):', Object.entries(T).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', '));
check('a sloppy keyboard player holds a groomer press 4 to 10 s', T.sloppy >= 4 && T.sloppy <= 10, T.sloppy.toFixed(1));
check('a careful player holds it longer than a sloppy one', T.careful > T.sloppy * 1.2, `${T.careful.toFixed(1)} vs ${T.sloppy.toFixed(1)}`);
check('faster is harder', T.fast < T.careful, `${T.fast.toFixed(1)} at 20 m/s vs ${T.careful.toFixed(1)} at 10`);
check('moguls are harder', T.moguls < T.careful, `${T.moguls.toFixed(1)} vs ${T.careful.toFixed(1)}`);
check('Easy lasts longer with no correction', T.easy > T.none * 1.5, `${T.easy.toFixed(1)} vs ${T.none.toFixed(1)}`);
// ---- slow: an over-press stalls instead of slamming
{
  const stalls = SEEDS.map((seed) => press({ seed, speed: 2 })).filter((p) => p.end && (p.end.how === 'stall' || p.end.how === 'slam'));
  check('an over-press below 3 m/s stalls, no crash', stalls.length > 5 && stalls.every((p) => p.end.how === 'stall' && p.r.crashed <= 0 && p.r.speed < 1), `${stalls.length} over-presses: ${[...new Set(stalls.map((p) => p.end.how))].join('/')}`);
}
// ---- an ollie out of a held press reports it clean
{
  const r = new Rider(plane(12), null);
  const reports = []; r.onPress = (how, d, t) => reports.push({ how, d, t });
  r.reset(0, 0, Math.PI, 3);
  for (let k = 0; k < 180; k++) r.update(1 / 60, inp());
  const ctl = player(0.15, 0.1);
  for (let k = 0; k < 60; k++) r.update(1 / 60, inp({ lean: -1, balance: ctl(r) }));
  const held = r.pressing;
  for (let k = 0; k < 20; k++) r.update(1 / 60, inp({ lean: -1, balance: ctl(r), jumpHeld: true }));
  r.update(1 / 60, inp({ lean: -1, jumpReleased: true }));
  check('an ollie out of a 1.3 s tail press reports it clean on takeoff', held && !r.onGround && !r.pressing && reports.length === 1 && reports[0].how === 'clean' && reports[0].d === -1, JSON.stringify(reports));
}
// ---- a short hop (a roller) rides through
{
  const r = new Rider(plane(12), null);
  const reports = []; r.onPress = (how) => reports.push(how);
  r.reset(0, 0, Math.PI, 5);
  for (let k = 0; k < 180; k++) r.update(1 / 60, inp());
  const ctl = player(0.15, 0.1);
  for (let k = 0; k < 40; k++) r.update(1 / 60, inp({ lean: -1, balance: ctl(r) }));
  r.onGround = false; r.vz += 1.2; r.z += 0.05; r.airTime = 0; // bucked off a roller
  let air = 0;
  for (let k = 0; k < 60; k++) { r.update(1 / 60, inp({ lean: -1, balance: ctl(r) })); if (!r.onGround) air++; }
  check('the press rides through a short hop', air > 3 && air < 18 && r.pressing && reports.length === 0, `${(air / 60).toFixed(2)} s of air, ${reports.join('/') || 'no report'}`);
}
// ---- no press is ever past saving: a quick analog player on Hard, fast and on moguls
{
  // reads where the needle is and how fast it moves (a person watching it does both), no reaction delay
  const quick = () => { let prev = 0; return (r) => { const b = r.pressing ? r.pressBalance : 0, v = (b - prev) * 60; prev = b; return Math.max(-1, Math.min(1, -(4 * b + 0.8 * v))); }; };
  const ends = SEEDS.slice(0, 15).map((seed) => press({ seed, mode: 'hard', speed: 20, mogul: 0.5, max: 60, ctl: quick() }).end);
  console.log('quick on Hard:', ends.map((e) => e ? `${e.how} ${e.t.toFixed(1)}` : 'held').join(', '));
  const lost = ends.filter((e) => e && e.how !== 'clean');
  check('a quick player never loses a press on Hard at 20 m/s on moguls in 60 s (no time limit)', lost.length === 0, lost.length ? `lost ${lost.map((e) => `${e.how} at ${e.t.toFixed(1)} s`).join(', ')}` : `${ends.filter((e) => !e).length} held 60 s, the rest bucked into the air`);
}
// ---- land into a press from a trick
{
  const r = new Rider(plane(12), null);
  const reports = []; r.onPress = (how, d, t, dist, sw, from) => reports.push({ how, from });
  const tricks = []; r.onTrick = (n) => tricks.push(n);
  r.reset(0, 0, Math.PI, 9);
  for (let k = 0; k < 180; k++) r.update(1 / 60, inp());
  r.onGround = false; r.vz = 9; r.z += 0.1; r.airTime = 0; r.spin = 0; r.flip = 0; r.flipRate = 0;
  for (let k = 0; k < 108; k++) r.update(1 / 60, inp({ steer: 1, lean: 1 })); // a 360 with the nose press held
  let k = 0;
  while (!r.onGround && k++ < 600) r.update(1 / 60, inp({ lean: 1 }));
  const ctl = player(0.15, 0.1);
  for (let j = 0; j < 90; j++) r.update(1 / 60, inp({ lean: 1, balance: ctl(r) }));
  const lean = r.lean;
  for (let j = 0; j < 30; j++) r.update(1 / 60, inp());
  check('holding the press key through a trick lands into the press, named after the trick', tricks.length === 1 && lean > 0.5 && reports.length === 1 && reports[0].from === tricks[0], `trick ${tricks.join('/')}, lean on the snow ${lean.toFixed(2)}, ${JSON.stringify(reports)}`);
}

console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
