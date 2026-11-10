// FEAT-156: render the procedural tree kit on its own and check its budgets. Bundles
// tools/treeshot/scene.ts with esbuild (no game build or pack needed), opens it in Chromium and writes:
//   lineup.png          every species x variant at LOD0 on snow, a 1.8 m rider and a 5 m grid; front and back light
//   lods-<species>.png  LOD0 | LOD1 | LOD2 | impostor at the same framing (front and side light)
//   distance.png        a row from 20 m to 2 km with the real LOD bands, and tiles either side of each band edge
//   lineup-snow-<l>.png the lineup at snow load 0.5, 1 and as snow ghosts (FEAT-157)
//   snow-<species>.png  LOD0 | LOD1 | LOD2 | impostor per snow level (bare, 0.5, 1, ghost), spruce, fir and Douglas-fir by default
// and prints the triangles per species per LOD, the texture memory and the build times; exit 1 when a
// budget is broken (LOD0 600 conifers / 400 aspen / 200 krummholz and snags, LOD1 96, LOD2 8, textures 24 MB,
// generation 150 ms).
// node tools/treeshot.mjs [outDir] [--headed | --gpu | --cpu] [--only=lineup,lods,distance,snow] [--species=0,3]
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GAME } from './paths.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const outDir = positional[0] ?? 'shots-trees';
const only = (args.find((a) => a.startsWith('--only='))?.slice(7) ?? 'lineup,lods,distance,snow').split(',');
fs.mkdirSync(outDir, { recursive: true });

const esbuild = await import('esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'treeshot-'));
await esbuild.build({ entryPoints: [path.join(GAME, 'tools', 'treeshot', 'scene.ts')], bundle: true, format: 'esm', outfile: path.join(tmp, 'treeshot.js'), platform: 'browser', target: 'es2020', logLevel: 'warning' });
fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><meta charset="utf-8"><title>treeshot</title><script type="module" src="treeshot.js"></script>');
const server = http.createServer((req, res) => {
  const p = path.join(tmp, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!p.startsWith(tmp) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const browser = await launchBrowser(args);
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html`);
await page.waitForFunction(() => window.treeshot?.ready, null, { timeout: 120000 });
page.setDefaultTimeout(300000);

const save = async (name, fn, arg) => {
  const url = await page.evaluate(([f, a]) => window.treeshot[f](a), [fn, arg]);
  fs.writeFileSync(path.join(outDir, name), Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote', path.join(outDir, name));
};
const stats = await page.evaluate(() => window.treeshot.stats());
if (args.includes('--times')) console.log('atlas draw / read / mips ms', stats.atlasTimes?.map((t) => t.toFixed(0)).join(' / '));
const species = stats.triangles.map((t) => t.species);
const lodsOf = args.find((a) => a.startsWith('--species='))?.slice(10).split(',').map(Number);
if (only.includes('atlas')) await save('atlas.png', 'atlas');
if (only.includes('impostors')) await save('impostors.png', 'impostorAtlas');
if (only.includes('lineup')) await save('lineup.png', 'lineup');
if (only.includes('lods')) for (let s = 0; s < species.length; s++) if (!lodsOf || lodsOf.includes(s)) await save(`lods-${species[s].toLowerCase().replace(/[^a-z]+/g, '-')}.png`, 'lods', s);
if (only.includes('distance')) await save('distance.png', 'distance');
if (only.includes('snow')) {
  for (const l of [0.5, 1, 'ghost']) await save(`lineup-snow-${l}.png`, 'lineup', l);
  for (const s of lodsOf ?? [0, 3, 5]) await save(`snow-${species[s].toLowerCase().replace(/[^a-z]+/g, '-')}.png`, 'snowLods', s);
}
if (only.includes('snow')) {
  // FEAT-157: near vs far at each snow level: the share of the tree that reads as snow and its brightness
  const rows = await page.evaluate(() => window.treeshot.snowStats());
  console.log('\nsnow per LOD (share of the tree that reads as snow / mean brightness 0..255)');
  console.log('species              level            LOD0         LOD1         LOD2         impostor');
  for (let i = 0; i < rows.length; i += 4) {
    const cells = rows.slice(i, i + 4).map((r) => `${(r.snow * 100).toFixed(0).padStart(3)}% / ${r.luma.toFixed(0).padStart(3)}`);
    console.log(`${rows[i].species.padEnd(20)} ${rows[i].level.padEnd(16)} ${cells.join('   ')}`);
  }
}

// budgets
const fails = [];
console.log('\ntriangles per tree (largest variant)');
console.log('species              LOD0  LOD1  LOD2  impostor');
for (const t of stats.triangles) {
  console.log(`${t.species.padEnd(20)} ${String(t.lod0).padStart(4)}  ${String(t.lod1).padStart(4)}  ${String(t.lod2).padStart(4)}  ${String(t.impostor).padStart(8)}`);
  const cap0 = /aspen/.test(t.species) ? 400 : /krummholz|snag/.test(t.species) ? 200 : 600;
  if (t.lod0 > cap0) fails.push(`${t.species} LOD0 ${t.lod0} > ${cap0}`);
  if (t.lod1 > 96) fails.push(`${t.species} LOD1 ${t.lod1} > 96`);
  if (t.lod2 > 8) fails.push(`${t.species} LOD2 ${t.lod2} > 8`);
}
const mb = (stats.textureBytes.atlas + stats.textureBytes.impostors) / (1024 * 1024);
console.log(`\ntexture memory: atlas ${(stats.textureBytes.atlas / 1048576).toFixed(1)} MB + impostors and snow mask ${(stats.textureBytes.impostors / 1048576).toFixed(1)} MB = ${mb.toFixed(1)} MB (budget 24)`);
const gen = stats.ms.atlas + stats.ms.geometry;
console.log(`generation: atlas ${stats.ms.atlas.toFixed(0)} ms + geometry ${stats.ms.geometry.toFixed(0)} ms = ${gen.toFixed(0)} ms (budget 150); impostor bake ${stats.ms.bake.toFixed(0)} ms`);
if (mb > 24) fails.push(`texture memory ${mb.toFixed(1)} MB > 24`);
if (gen > 150) fails.push(`generation ${gen.toFixed(0)} ms > 150`);
if (errors.length) { console.log('\nbrowser errors:'); for (const e of errors.slice(0, 20)) console.log(' ', e); }
for (const f of fails) console.log('FAIL', f);
console.log(fails.length ? `\n${fails.length} budget(s) broken` : '\nall budgets met');

await browser.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails.length || errors.some((e) => e.startsWith('pageerror') || /error/i.test(e.slice(0, 6))) ? 1 : 0);
