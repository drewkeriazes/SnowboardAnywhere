// GPU cost of one build under different URL parameters (or of different builds), measured so that a busy GPU does not
// decide the answer (FEAT-292). One page per variant, all open at once; per view the pages take turns in short bursts
// (a few warm-up frames, then timer queries round the main pass), and each variant's frame cost is a low percentile of
// all its timed frames: another program on the GPU only ever adds time to a frame, so the fast frames are the frame's own
// cost. Wall-clock medians swing by 10 ms between identical runs on Drew's PC; this repeats within about 0.1 ms.
// node tools/gpu_ab.mjs <pack> --variants "main=&noclumps,clumps=" [--presets low,medium,high] [--times 12]
//   [--views tools/canopy-views.json] [--only view,view] [--size 1920x1080] [--rounds 8] [--gpu | --headed]
//   (after `npx vite build`; a variant is name=<query>, or name=<query>@<dist folder> for another build; SHOT_PACKS as the
//    other tools). Prints ms per variant and view and each variant's difference from the first.
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS, GAME } from './paths.mjs';

const args = process.argv.slice(2);
const valued = new Set(['--variants', '--presets', '--times', '--views', '--only', '--size', '--rounds']);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const pack = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]))[0] ?? 'vail';
const variants = opt('--variants', 'main=&noclumps,clumps=').split(',').map((v) => {
  const [name, rest = ''] = v.split('=', 2).length === 2 ? [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)] : [v, ''];
  const [query, dist] = rest.split('@');
  return { name, query, dist: dist ? path.resolve(dist) : DIST };
});
const presets = opt('--presets', 'low').split(',');
const hours = opt('--times', '12').split(',').map(Number);
const only = opt('--only', null)?.split(',') ?? null;
const [W, H] = opt('--size', '1920x1080').split('x').map(Number);
const rounds = Number(opt('--rounds', 8));
const views = JSON.parse(fs.readFileSync(opt('--views', path.join(GAME, 'tools', 'canopy-views.json')), 'utf8')).filter((v) => !only || only.includes(v.label));

/** the graphics presets as Settings > Graphics sets them (ui/Settings.ts applyQuality), pixel ratio 1 */
const PRESETS = {
  high: { quality: 'high', shadows: true, treeDensity: 1, forestDensity: 1 },
  medium: { quality: 'medium', shadows: true, treeDensity: 0.6, forestDensity: 0.6 },
  low: { quality: 'low', shadows: false, treeDensity: 0.3, forestDensity: 0.35 },
};
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.woff2': 'font/woff2' };
/** one server per build folder */
const servers = new Map();
const serve = async (dist) => {
  if (servers.has(dist)) return servers.get(dist);
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [dist, u];
    const p = path.join(root, rel);
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  servers.set(dist, server);
  return server;
};
const browser = await launchBrowser(args);

const settle = async (page) => {
  let quiet = 0;
  for (let i = 0; i < 200 && quiet < 3; i++) {
    await page.evaluate(() => window.__step(4, 1 / 60));
    await page.waitForTimeout(120);
    const busy = await page.evaluate(() => {
      const s = window.__sim, p = s.pack;
      return [p.fine, p.mid, p.far, p.mask].reduce((n, t) => n + (t?.pending?.size ?? 0), 0) + s.veg.pending + s.terrain.stats.builds;
    });
    quiet = busy === 0 ? quiet + 1 : 0;
  }
};

/** a burst on one page: warm-up frames, then `n` frames each inside a timer query; resolves to their GPU ms */
const burst = async (page, n = 16) => {
  const ok = await page.evaluate((n) => {
    const s = window.__sim, gl = s.renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return false;
    for (let i = 0; i < 10; i++) window.__step(1, 1 / 60);
    window.__gq = [];
    for (let i = 0; i < n; i++) {
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q); window.__step(1, 1 / 60); gl.endQuery(ext.TIME_ELAPSED_EXT);
      window.__gq.push(q);
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return true;
  }, n);
  if (!ok) throw new Error('no EXT_disjoint_timer_query_webgl2: run on the real GPU');
  for (let tries = 0; tries < 200; tries++) {
    await page.waitForTimeout(15);
    const ms = await page.evaluate(() => {
      const gl = window.__sim.renderer.getContext();
      if (!window.__gq.every((q) => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE))) return null;
      const t = window.__gq.map((q) => gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      for (const q of window.__gq) gl.deleteQuery(q);
      return t;
    });
    if (ms) return ms;
  }
  throw new Error('timer queries never finished');
};
const low = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.15)]; };

for (const preset of presets) {
  if (!PRESETS[preset]) throw new Error(`unknown preset ${preset}`);
  const pages = [];
  for (const va of variants) {
    const server = await serve(va.dist);
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.log(`${va.name} pageerror: ${e.message.slice(0, 300)}`));
    await page.addInitScript((seed) => { localStorage.setItem('settings', JSON.stringify({ v: 1, ...seed, pixelRatio: 1 })); }, PRESETS[preset]);
    const v0 = views[0];
    await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&cam=eye&x=${v0.x}&y=${v0.y}&h=${v0.h}&weather=clear${va.query}`);
    await page.waitForFunction(() => window.__step, null, { timeout: 180000 });
    page.setDefaultTimeout(600000);
    pages.push(page);
  }
  const sums = variants.map(() => 0);
  let n = 0;
  for (const hour of hours) for (const v of views) {
    for (const page of pages) {
      await page.evaluate(({ v, hour }) => { const s = window.__sim; s.settings.timeOfDay = hour; s.applySettings('conditions'); s.eyeAt(v.x, v.y, v.h, v.pitch ?? 0, v.fov ?? 50, v.eye ?? 1.7); }, { v, hour });
      await settle(page);
    }
    const samples = variants.map(() => []);
    for (let r = 0; r < rounds; r++) {
      const order = pages.map((_, i) => i);
      if (r % 2) order.reverse();
      for (const i of order) samples[i].push(...(await burst(pages[i])));
    }
    const ms = samples.map(low);
    ms.forEach((m, i) => { sums[i] += m; });
    n++;
    console.log(`${preset} ${`${v.label} ${hour}h`.padEnd(20)} ${variants.map((va, i) => `${va.name} ${ms[i].toFixed(2)} ms${i ? ` (${ms[i] >= ms[0] ? '+' : ''}${(ms[i] - ms[0]).toFixed(2)})` : ''}`).join(' | ')}`);
  }
  console.log(`${preset} ${'mean'.padEnd(20)} ${variants.map((va, i) => `${va.name} ${(sums[i] / n).toFixed(2)} ms${i ? ` (${sums[i] >= sums[0] ? '+' : ''}${((sums[i] - sums[0]) / n).toFixed(2)})` : ''}`).join(' | ')}`);
  for (const page of pages) await page.close();
}
await browser.close();
for (const s of servers.values()) s.close();
