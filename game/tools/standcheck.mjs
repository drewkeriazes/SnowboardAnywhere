// Stand density stems (FEAT-074): generates a cell's stems from a synthetic stand image (no pack, no
// browser) and checks:
//   - the count matches the stand's chance per 4 m cell (the expected stems, within 3 %)
//   - the same image gives the same stems every time (seeded by position)
//   - a lower density keeps a subset of the stems a higher one draws (the Forest setting thins, never moves)
//   - every stem stays in its 4 m cell, at the stand's height (0.75 to 1 times it) and species
//   - the ground height is the stored one, interpolated: on a 30 degree plane within 5 cm
//   - no stems where the chance is 0, none at density 0
//   - FEAT-298, a pack with crown widths: each stem's crown is the species radius times the cell's width factor
//     (lower half B / 100) times its own draw (mean 1, within the jitter); a species that does not widen keeps the
//     factor without a draw; a cell with no factor byte reads 1; the stems themselves are the same as without widths
// node tools/standcheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standcheck-'));
const out = path.join(dir, 'stands.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'world', 'trees', 'stands.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { generateStems } = await import(pathToFileURL(out).href);

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

// a 1 km cell at (2000, -1000): the west half a closed stand (chance 0.9), a 40 m strip of open run down the
// middle, the east half a sparse stand (0.3); 15 m spruce in the west, 22 m fir (3) in the east; ground on a
// 30 degree plane rising to the north
const size = 250, res = 4, minX = 2000, minY = -1000, zBase = 2300, zScale = 32, hStep = 0.25;
const T = Math.tan(30 * Math.PI / 180), ground = (x, y) => 2800 + T * (y - minY);
const px = new Uint8ClampedArray(size * size * 2 * 4);
let expected = 0;
const chanceAt = (j) => (j < 115 ? 0.9 : j < 125 ? 0 : 0.3);
for (let i = 0; i < size; i++) {
  for (let j = 0; j < size; j++) {
    const o = (i * size + j) * 4, p = chanceAt(j);
    px[o] = Math.round(p * 255); px[o + 1] = Math.round((j < 125 ? 15 : 22) / hStep); px[o + 2] = j < 125 ? 0 : 3; px[o + 3] = 255;
    expected += Math.round(p * 255) / 255;
    const y = minY + size * res - (i + 0.5) * res, q = Math.round((ground(0, y) - zBase) * zScale);
    const ob = ((size + i) * size + j) * 4;
    px[ob] = q >> 8; px[ob + 1] = q & 255; px[ob + 3] = 255;
  }
}
const g = { px, size, res, minX, minY, zBase, zScale, hStep };
// FEAT-298: the stand image with width factors in the lower half's B: 1.4 in the west, none (0) in the east
const pxW = px.slice();
for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) pxW[((size + i) * size + j) * 4 + 2] = j < 125 ? 140 : 0;
const gW = { ...g, px: pxW };

const full = generateStems(g, 1);
const n = full.length / 6;
check('stem count follows the chance', Math.abs(n - expected) / expected < 0.03, `${n} stems, ${expected.toFixed(0)} expected`);
const again = generateStems(g, 1);
check('the same stems every time', again.length === full.length && again.every((v, i) => v === full[i]), `${again.length / 6} stems on the second run`);
const key = (a, i) => `${a[i * 6].toFixed(3)},${a[i * 6 + 1].toFixed(3)}`;
const fullSet = new Set(Array.from({ length: n }, (_, i) => key(full, i)));
const half = generateStems(g, 0.5), nh = half.length / 6;
let inFull = 0;
for (let i = 0; i < nh; i++) if (fullSet.has(key(half, i))) inFull++;
check('a lower density is a subset', inFull === nh && Math.abs(nh / n - 0.5) < 0.03, `${nh} stems at 0.5 (${(nh / n * 100).toFixed(1)} %), ${inFull} of them also at 1`);

let outside = 0, badH = 0, badSp = 0, onRun = 0, zErr = 0;
for (let i = 0; i < n; i++) {
  const b = i * 6, x = full[b], y = full[b + 1];
  const j = Math.floor((x - minX) / res), r = Math.floor((minY + size * res - y) / res);
  if (j < 0 || j >= size || r < 0 || r >= size) { outside++; continue; }
  if (j >= 115 && j < 125) onRun++;
  const h = j < 125 ? 15 : 22, sp = j < 125 ? 0 : 3;
  if (full[b + 3] < 0.75 * h - 0.2 || full[b + 3] > h + 0.2) badH++;
  if (full[b + 5] !== sp || full[b + 4] !== 0) badSp++;
  zErr = Math.max(zErr, Math.abs(full[b + 2] - ground(x, y)));
}
check('stems stay in their cell, off the open strip', outside === 0 && onRun === 0, `${outside} outside the cell, ${onRun} on the run`);
check('height and species from the stand', badH === 0 && badSp === 0, `${badH} heights and ${badSp} species or crowns off`);
check('ground height interpolated', zErr < 0.05, `worst ${zErr.toFixed(3)} m on a 30 degree plane`);
check('density 0 draws nothing', generateStems(g, 0).length === 0, `${generateStems(g, 0).length / 6} stems`);

// FEAT-298: crown widths
const SPR = 0.13, FIR = 0.1, cw = { open: 0.16, cover: [0.1, 0.5], jitter: 0.35, widen: [0, 3, 5, 9], k: Array(10).fill(1) };
const wide = generateStems(gW, 1, cw);
check('crown widths keep the same stems', wide.length === full.length && wide.every((v, i) => (i % 6 === 4 ? true : v === full[i])), `${wide.length / 6} stems`);
let wSum = 0, wN = 0, wLo = Infinity, wHi = 0, eastOff = 0;
const cwNo = { ...cw, widen: [3] };
const noDraw = generateStems(gW, 1, cwNo);
let noDrawOff = 0;
for (let i = 0; i < n; i++) {
  const b = i * 6, west = wide[b + 5] === 0;
  const k = wide[b + 4] / ((west ? SPR : FIR) * wide[b + 3]);
  if (west) { const d = k / 1.4; wSum += d; wN++; wLo = Math.min(wLo, d); wHi = Math.max(wHi, d); if (Math.abs(noDraw[b + 4] / (SPR * noDraw[b + 3]) - 1.4) > 1e-3) noDrawOff++; }
  else if (k < 0.65 - 1e-3 || k > 1.35 + 1e-3) eastOff++;
}
check('a stem widens by its cell factor and its own draw', wN > 0 && Math.abs(wSum / wN - 1) < 0.02 && wLo >= 0.65 - 1e-3 && wHi <= 1.35 + 1e-3,
  `west draw mean ${(wSum / wN).toFixed(3)}, ${wLo.toFixed(3)} to ${wHi.toFixed(3)} on factor 1.4`);
check('no factor byte reads 1, a non-widening species takes no draw', eastOff === 0 && noDrawOff === 0, `${eastOff} east stems off factor 1 x draw, ${noDrawOff} undrawn spruce off 1.4`);
check('without crown widths the crown stays 0', generateStems(gW, 1).every((v, i) => i % 6 !== 4 || v === 0), "the species' own");

if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
console.log('all stand checks passed');
