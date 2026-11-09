// Hard carve check (FEAT-148): rides the Rider physics on exact planes (no pack, no browser) and
// checks the issue's "done when": holding the squat key while steering on a groomer carves a much
// tighter turn than normal steering; committed (already on edge when the press goes in) it bites
// clean; pressed from flat at speed the edge lags, the board skids and bleeds more speed, and badly
// overdone (from flat at 45 mph on a groomer or in tracked-out chop, 34 mph on ice) it washes out onto the butt or the hip; every hard carve slows you;
// deep powder planes instead of washing out; and the squat without steer is just a squat. Normal
// steering is tools/carvecheck.mjs (unchanged).
// node tools/hardcarvecheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hardcarvecheck-')), 'rider.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'sim', 'Rider.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { Rider } = await import(pathToFileURL(out).href);

const D = Math.PI / 180, DT = 1 / 120;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/** plane falling toward +y (north) at `deg` degrees */
function plane(deg) {
  const t = Math.tan(deg * D), k = 1 / Math.hypot(t, 1);
  return {
    mask: null, coarseFallbacks: 0,
    groundHeight: (x, y) => -t * y,
    groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = t * k; o[2] = k; return o; },
  };
}
const input = () => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false });

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

/**
 * Turn 90 degrees of travel on flat ground from `v` m/s heading north. `mode`: 'normal' (steer only),
 * 'committed' (steer 0.35 s onto the edge, then press), 'flat' (press and steer at once). `snow`:
 * 'groomed', 'ice' (a spring refreeze at 7 am) or 'powder' (off-piste after a storm). Returns the path
 * radius over the 90 degrees, the time, the speed lost, the peak skid and lateral g, and any washout.
 * 'offpiste' is tracked-out snow high up at 1 pm (about half powder, a third chop, a fifth ice, 10 cm
 * deep), like the Back Bowls in the play-test video.
 */
function arc(v, mode, { snow = 'groomed', steer = 1 } = {}) {
  const r = new Rider(plane(0), null);
  r.surface.groomed = snow === 'powder' ? 0 : 1;
  if (snow === 'ice') { r.snowWorld.day = 'spring'; r.snowWorld.hour = 7; }
  if (snow === 'powder') { r.snowWorld.day = 'fresh'; r.snowWorld.newSnow = 1; }
  if (snow === 'offpiste') { r.surface.groomed = 0; r.snowWorld.zLow = -2500; r.snowWorld.zHigh = 500; }
  r.reset(0, 0, 0); r.vy = v;
  let washed = 0; r.onWashout = (s) => { washed = s; };
  const inp = Object.assign(input(), { steer });
  let t = 0;
  if (mode === 'committed') while (t < 0.35) { r.update(DT, inp); t += DT; }
  const v0 = Math.max(v, r.speed);
  let turned = 0, dist = 0, T = 0, skid = 0, g = 0, prev = Math.atan2(r.vx, r.vy), hard = 0;
  while (turned < 90 * D && T < 4 && r.crashed <= 0) {
    inp.squat = mode !== 'normal';
    r.update(DT, inp); T += DT;
    const d = Math.atan2(r.vx, r.vy);
    turned += Math.abs(wrap(d - prev)); dist += r.speed * DT; prev = d;
    skid = Math.max(skid, r.skid); g = Math.max(g, Math.abs(r.lateralG)); hard = Math.max(hard, r.hardCarve);
  }
  return { R: dist / turned, T, lost: 1 - r.speed / v0, skid, g, washed, crashSide: r.crashSide, hard, snowKind: r.snow.kind, edge: Math.abs(r.edge) / D };
}
const show = (label, o) => console.log(`  ${label.padEnd(30)} R ${o.R.toFixed(1)} m, 90 deg in ${o.T.toFixed(2)} s, ${(100 * o.lost).toFixed(0)}% speed lost, skid ${o.skid.toFixed(2)}, ${o.g.toFixed(2)} g${o.washed ? `, WASHOUT ${o.washed > 0 ? 'toeside' : 'heelside'}` : ''}`);

console.log('10 m/s on a groomer:');
const n10 = arc(10, 'normal'), c10 = arc(10, 'committed'), f10 = arc(10, 'flat');
show('normal steering', n10); show('hard carve, committed', c10); show('hard carve, pressed from flat', f10);
check('a hard carve is much tighter than normal steering (under 0.7x the radius)', c10.R < 0.7 * n10.R && f10.R < 0.8 * n10.R, `${c10.R.toFixed(1)} m committed, ${f10.R.toFixed(1)} m from flat vs ${n10.R.toFixed(1)} m`);
check('it pulls about 2.5 g, a lean of about 68 deg', c10.g > 2.2 && c10.g < 2.8, `${c10.g.toFixed(2)} g, lean ${(Math.atan(c10.g) / D).toFixed(0)} deg`);
check('committed it bites clean (little skid), no washout', c10.skid < 0.2 && !c10.washed, `skid ${c10.skid.toFixed(2)}`);
check('pressed from flat at 10 m/s it still holds', !f10.washed, f10.washed ? 'washed out' : 'held');
check('a hard carve slows you more than normal steering', c10.lost > n10.lost, `${(100 * c10.lost).toFixed(0)}% vs ${(100 * n10.lost).toFixed(0)}% per 90 deg`);

console.log('15 m/s on a groomer:');
const n15 = arc(15, 'normal'), c15 = arc(15, 'committed'), f15 = arc(15, 'flat');
show('normal steering', n15); show('hard carve, committed', c15); show('hard carve, pressed from flat', f15);
check('committed at 15 m/s: tighter than normal and no washout', c15.R < 0.8 * n15.R && !c15.washed, `${c15.R.toFixed(1)} m vs ${n15.R.toFixed(1)} m`);
check('pressed from flat the edge lags: it skids (far more than committed) and comes round wider', f15.skid > 2 * c15.skid && f15.skid > 0.4 && f15.R > c15.R, `skid ${f15.skid.toFixed(2)} vs ${c15.skid.toFixed(2)}, R ${f15.R.toFixed(1)} vs ${c15.R.toFixed(1)} m`);
check('the skidded one bleeds more speed than the clean one', f15.lost > c15.lost, `${(100 * f15.lost).toFixed(0)}% vs ${(100 * c15.lost).toFixed(0)}%`);
check('but survives at 15 m/s on a groomer', !f15.washed, f15.washed ? 'washed out' : 'held');

console.log('overdone:');
const f25 = arc(20, 'flat'), f25l = arc(20, 'flat', { steer: -1 }), i20 = arc(15, 'flat', { snow: 'ice' }), ic20 = arc(20, 'committed', { snow: 'ice' }), c25 = arc(25, 'committed');
show('20 m/s (45 mph) groomer, from flat, right', f25); show('20 m/s (45 mph) groomer, from flat, left', f25l); show('25 m/s groomer, committed', c25);
show(`15 m/s (34 mph) ${i20.snowKind}, from flat`, i20); show(`20 m/s ${ic20.snowKind}, committed`, ic20);
check('pressed from flat at 20 m/s (45 mph) it washes out', !!f25.washed && !!f25l.washed, `${f25.washed} / ${f25l.washed}`);
check('a washout goes down on the inside: toeside onto the hip turning right, heelside onto the butt turning left (regular)', f25.washed === 1 && f25.crashSide === 1 && f25l.washed === -1 && f25l.crashSide === -1, `right ${f25.washed} side ${f25.crashSide}, left ${f25l.washed} side ${f25l.crashSide}`);
check('committed at 25 m/s on a groomer still holds', !c25.washed, c25.washed ? 'washed out' : `R ${c25.R.toFixed(1)} m`);
check('ice washes out easily from flat, at 15 m/s (34 mph)', i20.snowKind === 'ice' && !!i20.washed, `${i20.washed}`);
check('committed on ice at 20 m/s holds but skids hard (far more than on a groomer)', !ic20.washed && ic20.skid > 0.6 && ic20.skid > 2 * c25.skid, `${ic20.washed ? 'washed out' : 'held'}, skid ${ic20.skid.toFixed(2)} vs ${c25.skid.toFixed(2)}`);

console.log('tracked-out off-piste (powder, chop and some ice, 10 cm deep; only deep powder planes):');
const o15 = arc(15, 'flat', { snow: 'offpiste' }), o20 = arc(20, 'flat', { snow: 'offpiste' }), oc20 = arc(20, 'committed', { snow: 'offpiste' });
show(`15 m/s (34 mph) ${o15.snowKind}, from flat`, o15); show(`20 m/s (45 mph) ${o20.snowKind}, from flat`, o20); show(`20 m/s (45 mph) ${oc20.snowKind}, committed`, oc20);
check('off-piste chop washes out from flat at 20 m/s (45 mph) but not at 15 m/s', !!o20.washed && !o15.washed, `${o20.washed ? 'washout' : 'held'} / ${o15.washed ? 'washout' : 'held'}`);
check('committed in off-piste chop holds', !oc20.washed, oc20.washed ? 'washed out' : `skid ${oc20.skid.toFixed(2)}`);

console.log('deep powder:');
const p25 = arc(25, 'flat', { snow: 'powder' });
show(`25 m/s ${p25.snowKind}, from flat`, p25);
check('in deep powder the board planes: a surfy turn, no washout', p25.snowKind === 'powder' && !p25.washed && p25.edge < 70, `edge ${p25.edge.toFixed(0)} deg`);

{
  // the squat alone (no steer) is not a hard carve, nor is a light steer
  const r = new Rider(plane(10), null);
  r.surface.groomed = 1; r.reset(0, 0, 0); r.vy = 12;
  const inp = Object.assign(input(), { squat: true });
  let worst = 0;
  for (let i = 0; i < 120; i++) { r.update(DT, inp); worst = Math.max(worst, r.hardCarve); }
  inp.steer = 0.2;
  for (let i = 0; i < 60; i++) { r.update(DT, inp); worst = Math.max(worst, r.hardCarve); }
  check('squat with no steer (or a light one) is just a squat', worst === 0, `hardCarve ${worst.toFixed(2)}`);
}
/**
 * Linked turns down a 15 deg groomer from 15 m/s for 12 s, a turn every 0.4 s at full steer: 'normal'
 * steers only; 'hard' presses 0.12 s into each turn (once on the new edge) and lets go 0.08 s before
 * the edge change. Returns the mean speed after the first 2 s and the washouts.
 */
function linked(mode) {
  const r = new Rider(plane(15), null);
  r.surface.groomed = 1; r.reset(0, 0, 0); r.vy = 15;
  let washed = 0; r.onWashout = () => { washed++; };
  const inp = input();
  let side = -1, t = 0, sum = 0, n = 0;
  for (let i = 0; i < 12 * 120; i++) {
    const phase = t % 0.4;
    if (phase < DT) side = -side;
    inp.steer = t < 0.35 ? 0.5 * side : side; inp.squat = mode === 'hard' && phase > 0.12 && phase < 0.32;
    r.update(DT, inp); t += DT;
    if (t > 2) { sum += r.speed; n++; }
  }
  return { mean: sum / n, washed };
}
{
  const ln = linked('normal'), lh = linked('hard');
  console.log(`linked turns on a 15 deg groomer from 15 m/s for 12 s: normal ${ln.mean.toFixed(1)} m/s mean, hard carves ${lh.mean.toFixed(1)} m/s mean, ${lh.washed} washouts`);
  check('linked committed hard carves never wash out', lh.washed === 0, `${lh.washed} washouts`);
  check('and hold a lower speed than the same turns steered normally', lh.mean < ln.mean, `${lh.mean.toFixed(1)} vs ${ln.mean.toFixed(1)} m/s`);
}
fs.rmSync(path.dirname(out), { recursive: true, force: true });
console.log(fails ? `${fails} check(s) failed` : 'all hard carve checks passed');
process.exit(fails ? 1 : 0);
