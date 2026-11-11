// Stand density stems (FEAT-074): generates a cell's stems from a synthetic stand image (no pack, no
// browser) and checks:
//   - the count matches the stand's chance per 4 m cell (the expected stems, within 3 %)
//   - the same image gives the same stems every time (seeded by position)
//   - a lower density keeps a subset of the stems a higher one draws (the Forest setting thins, never moves)
//   - every stem stays in its 4 m cell, at the stand's height (0.75 to 1 times it) and species
//   - the ground height is the stored one, interpolated: on a 30 degree plane within 5 cm
//   - no stems where the chance is 0, none at density 0
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

if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
console.log('all stand checks passed');
