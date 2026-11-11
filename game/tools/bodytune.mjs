// FEAT-220 tuning harness: prints the tables in docs/research/dual-stick-body.md from the real code, so
// they can be regenerated whenever sim/rider/tuning.ts or EdgeModel.ts changes. Not a pass / fail check
// (that is tools/bodycheck.mjs once FEAT-220 is built).
// - Baseline: the real balance() with today's constants (auto lean), a 15 deg groomer mid-turn (gIn = 0).
// - Analog press: the real Rider on flat groomed snow, the edge already at 45 deg and full steer, with the
//   hard carve and the squat held at depth d (today the key drives both to 1; d = 1 is today's ride).
//   Run until 90 deg of turn, a washout, or 3 s.
// - Body trim: the proposed lean offset and tip meter (doc section 2) on top of the real balance() arc,
//   the real snow grip (Rider.snow after one step) and grip()'s full-edge hold. Steady edge, no hard carve.
// node tools/bodytune.mjs
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { GAME } from './paths.mjs';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bodytune-')), 'sim.mjs');
await build({
  stdin: { contents: "export { Rider } from './Rider'; export { balance } from './rider/EdgeModel'; export * from './rider/tuning';", resolveDir: path.join(GAME, 'src', 'sim'), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
});
const T = await import(pathToFileURL(out).href);
const { Rider, balance, FEEL, G, PHI_MAX, HARD_IN, SQUAT_IN, STEP } = T;
const F = FEEL.board, D = Math.PI / 180;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const load = (a) => Math.hypot(1, a / G); // the g the rider feels: gravity plus the turn
const f1 = (x) => (x >= 20 ? x.toFixed(0) : x.toFixed(1));
const row = (cells) => `| ${cells.join(' | ')} |`;

function plane(deg) {
  const t = Math.tan(deg * D), k = 1 / Math.hypot(t, 1);
  return { mask: null, coarseFallbacks: 0, groundHeight: (x, y) => -t * y, groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = t * k; o[2] = k; return o; } };
}
const input = () => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false });

// ---- Baseline: auto lean
const NZ = Math.cos(15 * D);
console.log('### Baseline (auto lean): R, load g. balance() on a 15 deg groomer, gIn = 0\n');
console.log(row(['Speed', 'Edge 30', 'Edge 45', 'Edge 60', 'Edge 72']));
console.log(row(['---', '---', '---', '---', '---']));
for (const v of [5, 8.3, 16]) {
  console.log(row([`${v} m/s`, ...[30, 45, 60, 72].map((e) => { const a = balance(e * D, v, 1, F, PHI_MAX, NZ, 0); return `R ${f1(v * v / a)} m, ${load(a).toFixed(1)} g`; })]));
}

// ---- Analog press: the real Rider, hard carve and squat held at depth d
/** set `key` so the Rider's own ease this step lands on min(target, where it was + one step's ease) */
function holdAt(r, key, target, easeT) {
  const next = Math.min(target, r[key] + STEP / easeT);
  r[key] = next - STEP / easeT;
}
function press(v, d, edge0 = 45) {
  const r = new Rider(plane(0), null);
  r.surface.groomed = 1;
  r.reset(0, 0, 0); r.vy = v; r.edge = edge0 * D;
  let washed = 0; r.onWashout = () => { washed = 1; };
  const inp = Object.assign(input(), { steer: 1, squat: true });
  let turned = 0, dist = 0, t = 0, skid = 0, prev = Math.atan2(r.vx, r.vy), H = 0, sq = 0;
  while (turned < 90 * D && t < 3 && !washed) {
    r.hardCarve = H; r.squat = sq;
    holdAt(r, 'hardCarve', d, HARD_IN); holdAt(r, 'squat', d, SQUAT_IN);
    r.update(STEP, inp); t += STEP;
    H = r.hardCarve; sq = r.squat;
    const dir = Math.atan2(r.vx, r.vy);
    turned += Math.abs(wrap(dir - prev)); dist += r.speed * STEP; prev = dir;
    skid = Math.max(skid, r.skid);
  }
  return { R: dist / Math.max(turned, 1e-6), t, washed, skid };
}
const DEPTHS = [0, 0.25, 0.5, 0.75, 1];
const cell = (o) => `${o.washed ? `**washout ${o.t.toFixed(2)} s**` : `R ${f1(o.R)} m, safe`}${o.skid > 0.3 ? `, skid ${o.skid.toFixed(2)}` : ''}`;
for (const [edge0, what] of [[45, 'committed (the edge already at 45 deg)'], [0, 'from flat (press and steer together)']]) {
  console.log(`\n### Analog press, ${what}: R over the turn, washout time or safe, peak skid past 0.3. Real Rider, flat groomer, full steer\n`);
  console.log(row(['Speed', ...DEPTHS.map((d) => (d ? `d ${d}` : 'no press'))]));
  console.log(row(['---', ...DEPTHS.map(() => '---')]));
  for (const v of [10, 14, 18, 20, 22]) console.log(row([`${v} m/s`, ...DEPTHS.map((d) => cell(press(v, d, edge0)))]));
}

// ---- Body trim: the proposed tip meter (doc section 2, constants as proposed there)
const BODY_TRIM = 35 * D, BODY_CURVE = 1.5, TIP_IN = 10 * D, TIP_OUT = 20 * D, TIP_OUT_EDGE = 40 * D, TIP_OUT_SPEED = 3, TIP_SPAN = 15 * D, TIP_RATE = 1.5;
/** the real snow grip and grip()'s full-edge hold (m/s^2) for a condition */
function hold(snow) {
  const r = new Rider(plane(15), null);
  r.surface.groomed = 1;
  if (snow === 'ice') { r.snowWorld.day = 'spring'; r.snowWorld.hour = 7; }
  r.reset(0, 0, 0); r.vy = 5;
  r.update(STEP, input());
  return { kind: r.snow.kind, turn: r.snow.turn, gripMax: G * (1 + T.GROOMED_BONUS) * r.snow.grip * (F.gripFlat + F.gripEdge) };
}
const SNOW = { groomer: hold('groomer'), ice: hold('ice') };
/** one steady case: trim `s` (stick, -1..1, + into the turn) */
function trimCase(snow, v, edgeDeg, s) {
  const { turn, gripMax } = SNOW[snow];
  const psi = edgeDeg * D, nz = NZ;
  const phiAuto = Math.min(PHI_MAX, psi * (1 - F.angulation));
  const trim = Math.sign(s) * Math.abs(s) ** BODY_CURVE * BODY_TRIM;
  const lean = Math.max(0, Math.min(PHI_MAX, phiAuto + trim));
  // balance() with the lean as an argument (doc section 2, physics step 2): the sidecut's arc, or what
  // the lean holds, and no more than the edge's grip
  const arc = (v * v * turn) / (F.sidecut * Math.cos(psi));
  const a = Math.min(arc, G * nz * Math.tan(lean) * turn, gripMax);
  const phiHold = Math.atan(Math.min(arc, gripMax) / (G * nz));
  const eIn = lean - Math.max(phiAuto, phiHold);
  const eOut = psi > TIP_OUT_EDGE && v > TIP_OUT_SPEED ? phiAuto - lean : 0;
  const fill = (e, tol) => (e > tol ? TIP_RATE * (e - tol) / TIP_SPAN : 0);
  const rin = fill(eIn, TIP_IN), rout = fill(eOut, TIP_OUT);
  const R = v * v / a;
  if (rin > 0) return `**low-side ${(1 / rin).toFixed(1)} s**`;
  if (rout > 0) return `**high-side ${(1 / rout).toFixed(1)} s**`;
  return lean > 0 ? `R ${f1(R)}` : 'upright, no turn';
}
const TRIMS = [0, 10.5, 21, 35, -17.5, -35].map((deg) => Math.sign(deg) * (Math.abs(deg) * D / BODY_TRIM) ** (1 / BODY_CURVE));
const label = (s) => { const deg = Math.sign(s) * Math.abs(s) ** BODY_CURVE * 35; return deg === 0 ? 'Trim 0' : `${deg > 0 ? '+' : ''}${deg.toFixed(1)} deg (stick ${s.toFixed(2)})`; };
console.log(`\n### Body trim: R or the time to a slam. Steady edge, gIn = 0, groomer (${SNOW.groomer.kind}, hold ${(SNOW.groomer.gripMax / G).toFixed(2)} g) and ice (${SNOW.ice.kind}, hold ${(SNOW.ice.gripMax / G).toFixed(2)} g)\n`);
console.log(row(['Case', ...TRIMS.map(label)]));
console.log(row(['---', ...TRIMS.map(() => '---')]));
for (const [snow, v, e] of [['groomer', 2, 30], ['groomer', 5, 45], ['groomer', 10, 60], ['groomer', 16, 60], ['ice', 10, 60], ['ice', 16, 30]]) {
  console.log(row([`${snow === 'ice' ? 'Ice' : 'Groomer'}, ${v} m/s, edge ${e}`, ...TRIMS.map((s) => trimCase(snow, v, e, s))]));
}
fs.rmSync(path.dirname(out), { recursive: true, force: true });
