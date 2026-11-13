// FEAT-278: far forest canopy comparison. Shoots the same fixed views for one build (a candidate branch or main)
// at each time of day and size, per graphics preset, and records what each still cost.
// node tools/canopy_compare.mjs <pack> <outDir> [--views tools/canopy-views.json] [--presets high,medium,low]
//   [--times 12,7.6] [--sizes 1920x1080,2560x1440] [--only view,view] [--weather clear] [--frames 30] [--no-shots] [--gpu | --headed]
//   (after `npx vite build`; SHOT_DIST=<dist> serves another build, SHOT_PACKS=<dir> another packs folder,
//    SHOT_QUERY="&canopy=shell" adds URL parameters, e.g. a candidate's flag)
// Writes <outDir>/<preset>/<view>-<time>h-<W>x<H>.png and <outDir>/stats.json, and prints per still: the GPU-synced
// frame time (median of --frames frames, each finished with a readPixels), draw calls and triangles, the trees'
// share of both (the same frame with the tree group hidden), and an estimate of the scene's GPU memory (every
// geometry's buffers and every texture's pixels reachable from the scene, counted once). A candidate can publish
// its own numbers on window.__canopy (for example { buildMs, tiles, bytes }): they are copied into the stats.
// Auto quality is off and the preset's fields are seeded into the saved settings before the page loads, so every
// build is shot at the same settings; the weather is forced (default clear) so the light matches.
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS, GAME } from './paths.mjs';

const args = process.argv.slice(2);
const valued = new Set(['--views', '--presets', '--times', '--sizes', '--only', '--weather', '--frames']);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const [pack = 'vail', outDir = 'shots-canopy'] = positional;
const viewsFile = opt('--views', path.join(GAME, 'tools', 'canopy-views.json'));
const presets = opt('--presets', 'high').split(',');
const times = opt('--times', '12,7.6').split(',').map(Number);
const sizes = opt('--sizes', '1920x1080,2560x1440').split(',').map((s) => s.split('x').map(Number));
const only = opt('--only', null)?.split(',') ?? null;
const weather = opt('--weather', 'clear');
const frames = Number(opt('--frames', 30));
const shots = !args.includes('--no-shots');
const views = JSON.parse(fs.readFileSync(viewsFile, 'utf8')).filter((v) => !only || only.includes(v.label));
fs.mkdirSync(outDir, { recursive: true });

/** the graphics presets as Settings > Graphics sets them (ui/Settings.ts applyQuality), pixel ratio 1 */
const PRESETS = {
  high: { quality: 'high', shadows: true, treeDensity: 1, forestDensity: 1 },
  medium: { quality: 'medium', shadows: true, treeDensity: 0.6, forestDensity: 0.6 },
  low: { quality: 'low', shadows: false, treeDensity: 0.3, forestDensity: 0.35 },
};

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const browser = await launchBrowser(args);

const statsFile = path.join(outDir, 'stats.json');
const all = fs.existsSync(statsFile) ? JSON.parse(fs.readFileSync(statsFile, 'utf8')) : {};
all.build = { dist: DIST, query: process.env.SHOT_QUERY ?? '', when: new Date().toISOString() };

const settle = async (page) => {
  // step until the tiles have streamed in and the terrain stops rebuilding (as aerial.mjs)
  let quiet = 0;
  for (let i = 0; i < 150 && quiet < 3; i++) {
    await page.evaluate(() => window.__step(4, 1 / 60));
    await page.waitForTimeout(200);
    const busy = await page.evaluate(() => {
      const s = window.__sim, p = s.pack;
      const pend = [p.fine, p.mid, p.far, p.mask].reduce((n, t) => n + (t?.pending?.size ?? 0), 0);
      const veg = [...(s.veg.cells?.values?.() ?? [])].filter((c) => c.loading).length;
      return pend + veg + s.terrain.stats.builds + (window.__canopy?.busy ?? 0);
    });
    quiet = busy === 0 ? quiet + 1 : 0;
  }
};

const measure = (page) => page.evaluate((frames) => {
  const s = window.__sim, r = s.renderer, gl = r.getContext();
  const px = new Uint8Array(4);
  const timed = () => {
    window.__step(1, 1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const ms = [];
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      window.__step(1, 1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    return { ms: ms[Math.floor(ms.length / 2)], calls: r.info.render.calls, tris: r.info.render.triangles };
  };
  const all = timed();
  const trees = s.veg.group ?? s.veg.root ?? null;
  let noTrees = null;
  if (trees) { const was = trees.visible; trees.visible = false; noTrees = timed(); trees.visible = was; window.__step(1, 1 / 60); }
  // scene GPU memory estimate: buffers and texture pixels reachable from the scene, each counted once
  const seenG = new Set(), seenT = new Set();
  let geo = 0, tex = 0;
  const texBytes = (t) => {
    if (!t || seenT.has(t)) return; seenT.add(t);
    const img = t.image, w = img?.width ?? img?.data?.width ?? 0, h = img?.height ?? img?.data?.height ?? 0, d = img?.depth ?? 1;
    const bpp = t.type === 1015 /* Float */ ? 16 : t.type === 1016 /* HalfFloat */ ? 8 : 4;
    tex += w * h * d * bpp * (t.generateMipmaps !== false && t.minFilter >= 1008 ? 4 / 3 : 1);
  };
  s.scene.traverse((o) => {
    const g = o.geometry;
    if (g && !seenG.has(g)) {
      seenG.add(g);
      for (const a of Object.values(g.attributes)) geo += a.array?.byteLength ?? a.data?.array?.byteLength ?? 0;
      if (g.index) geo += g.index.array.byteLength;
    }
    if (o.isInstancedMesh) { geo += o.instanceMatrix.array.byteLength; if (o.instanceColor) geo += o.instanceColor.array.byteLength; }
    for (const m of [].concat(o.material ?? [])) {
      for (const v of Object.values(m)) if (v?.isTexture) texBytes(v);
      for (const u of Object.values(m.uniforms ?? {})) if (u?.value?.isTexture) texBytes(u.value);
    }
  });
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    ms: r2(all.ms), calls: all.calls, trisM: r2(all.tris / 1e6),
    treeMs: noTrees ? r2(all.ms - noTrees.ms) : null, treeCalls: noTrees ? all.calls - noTrees.calls : null, treeTrisM: noTrees ? r2((all.tris - noTrees.tris) / 1e6) : null,
    geoMB: r2(geo / 2 ** 20), texMB: r2(tex / 2 ** 20), programs: r.info.programs?.length ?? null,
    canopy: window.__canopy ? JSON.parse(JSON.stringify({ ...window.__canopy, busy: undefined })) : null,
  };
}, frames);

for (const preset of presets) {
  const seed = PRESETS[preset];
  if (!seed) throw new Error(`unknown preset ${preset}`);
  const [w0, h0] = sizes[0];
  const page = await browser.newPage({ viewport: { width: w0, height: h0 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript((seed) => {
    try {
      const s = JSON.parse(localStorage.getItem('settings') ?? '{}');
      localStorage.setItem('settings', JSON.stringify({ ...s, v: 1, ...seed, pixelRatio: 1, autoQuality: false }));
    } catch { /* ignore */ }
  }, seed);
  const v0 = views[0];
  const t0 = performance.now();
  await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&cam=eye&x=${v0.x}&y=${v0.y}&h=${v0.h}&weather=${weather}${process.env.SHOT_QUERY ?? ''}`);
  await page.waitForFunction(() => window.__step, null, { timeout: 180000 });
  page.setDefaultTimeout(300000);
  await page.evaluate(() => window.__step(1, 1 / 60));
  const loadMs = Math.round(performance.now() - t0);
  const out = path.join(outDir, preset);
  fs.mkdirSync(out, { recursive: true });
  all[preset] ??= {};
  all[preset].loadMs = loadMs;
  all[preset].canopyAtLoad = await page.evaluate(() => (window.__canopy ? JSON.parse(JSON.stringify(window.__canopy)) : null));
  console.log(`${preset}: loaded in ${loadMs} ms${all[preset].canopyAtLoad ? ` canopy ${JSON.stringify(all[preset].canopyAtLoad)}` : ''}`);
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    for (const hour of times) {
      await page.evaluate((hour) => { window.__sim.settings.timeOfDay = hour; }, hour);
      for (const v of views) {
        await page.evaluate((v) => window.__sim.eyeAt(v.x, v.y, v.h, v.pitch ?? 0, v.fov ?? 50, v.eye ?? 1.7), v);
        await settle(page);
        const st = await measure(page);
        const key = `${v.label}-${hour}h-${w}x${h}`;
        if (shots) {
          const url = await page.evaluate(() => { window.__step(1, 1 / 60); return window.__shot(); });
          fs.writeFileSync(path.join(out, `${key}.png`), Buffer.from(url.split(',')[1], 'base64'));
        }
        all[preset][key] = st;
        console.log(`${preset} ${key.padEnd(34)} ${String(st.ms).padStart(6)} ms ${String(st.calls).padStart(5)} calls ${String(st.trisM).padStart(6)} Mtris | trees ${st.treeMs} ms ${st.treeCalls} calls ${st.treeTrisM} Mtris | geo ${st.geoMB} MB tex ${st.texMB} MB${st.canopy ? ` | canopy ${JSON.stringify(st.canopy)}` : ''}`);
      }
    }
  }
  all[preset].errors = errors.slice(0, 20);
  console.log(`${preset} errors: ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log('  ', e.slice(0, 300));
  await page.close();
  fs.writeFileSync(statsFile, JSON.stringify(all, null, 1));
}
await browser.close();
server.close();
