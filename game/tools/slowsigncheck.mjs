// SLOW sign placement check (FEAT-306): runs world/slowSignSites.ts in node (no browser, no render) on a
// pack's features.json and checks
//   - signs only on green and blue runs (none on blacks, double blacks, freeride or unrated runs)
//   - each sign in the bottom quarter of its named run (none on the upper part)
//   - sparse: most qualifying runs get none
//   - clear of lift lines, chair mazes, stations and buildings
//   - the same list on a second run (deterministic)
// and prints the signs per difficulty and the list.
// node tools/slowsigncheck.mjs [slug ...]     (default vail; SHOT_PACKS points at another packs folder; exit 1 on a failure)
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { GAME, PACKS } from './paths.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slowsigncheck-'));
const out = path.join(dir, 'sites.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'world', 'slowSignSites.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { slowSignSites, signClear, SLOW_DIFFICULTIES, LOWER_SHARE, OFFSET } = await import(pathToFileURL(out).href);

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

const slugs = process.argv.slice(2).length ? process.argv.slice(2) : ['vail'];
for (const slug of slugs) {
  const file = path.join(PACKS, slug, 'features.json');
  if (!fs.existsSync(file)) { check(`${slug}: features.json`, false, `${file} missing`); continue; }
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`\n${slug}: ${f.runs.length} runs, ${f.lifts.length} lifts (${file})`);
  const sites = slowSignSites(f, slug);
  const per = {};
  for (const s of sites) per[s.difficulty ?? 'null'] = (per[s.difficulty ?? 'null'] ?? 0) + 1;
  const runsBy = {};
  for (const r of f.runs) if (!r.area) runsBy[r.difficulty ?? 'null'] = (runsBy[r.difficulty ?? 'null'] ?? 0) + 1;
  console.log('signs per difficulty:', JSON.stringify(per), ' run ways per difficulty:', JSON.stringify(runsBy));
  for (const s of sites) {
    console.log(`  ${(s.name ?? '(unnamed)').padEnd(28)} ${String(s.difficulty).padEnd(13)} ${s.reason.padEnd(5)} at ${(s.along / s.length * 100).toFixed(0).padStart(3)}% of ${s.length.toFixed(0).padStart(5)} m  (${s.cx.toFixed(0)}, ${s.cy.toFixed(0)}, ${s.cz.toFixed(0)} m)`);
  }
  const bad = sites.filter((s) => !SLOW_DIFFICULTIES.includes(s.difficulty));
  check(`${slug}: green and blue only`, bad.length === 0, bad.length ? bad.map((s) => `${s.name} (${s.difficulty})`).join(', ') : `${sites.length} signs, none on blacks, freeride or unrated`);
  const high = sites.filter((s) => s.along < (1 - LOWER_SHARE) * s.length - 1e-6);
  check(`${slug}: bottom quarter of the run only`, high.length === 0, high.length ? high.map((s) => `${s.name} at ${(s.along / s.length * 100).toFixed(0)}%`).join(', ') : `lowest share ${sites.length ? Math.min(...sites.map((s) => s.along / s.length * 100)).toFixed(0) : '-'}% down the run`);
  const runsWith = new Set(sites.map((s) => s.run)).size;
  const qualifying = f.runs.filter((r) => !r.area && SLOW_DIFFICULTIES.includes(r.difficulty)).length;
  check(`${slug}: sparse`, runsWith <= Math.max(3, qualifying * 0.15), `${runsWith} of ${qualifying} green and blue ways have a sign`);
  const ok = signClear(f);
  const blocked = sites.filter((s) => !ok(s.cx + s.sx * OFFSET, s.cy + s.sy * OFFSET));
  check(`${slug}: clear of lifts and buildings`, blocked.length === 0, blocked.length ? blocked.map((s) => s.name).join(', ') : 'all clear');
  const again = JSON.stringify(slowSignSites(JSON.parse(fs.readFileSync(file, 'utf8')), slug));
  check(`${slug}: deterministic`, again === JSON.stringify(sites), 'the same list on a second load');
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
