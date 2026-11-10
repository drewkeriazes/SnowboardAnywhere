// FEAT-156: tree cost at the compare spots. Poses the eye camera like shoot_spots.mjs, waits for the
// tiles, then reports per view: the frame time (median of 30 frames), draw calls and triangles for the
// whole frame (shadow passes included) and for the trees alone (the same frame with the tree group
// hidden, subtracted), and the LOD0 / LOD1 instance counts. A/B a build of main with SHOT_DIST=<dist>.
// node tools/treeperf.mjs [pack] [spot-slug ...] [--headed | --gpu | --cpu]   (after `npx vite build`)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS, REPO } from './paths.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'vail';
const only = positional.slice(1);
const compareDir = path.join(REPO, 'docs', 'compare', pack);
const spots = fs.readdirSync(compareDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (only.length === 0 || only.includes(d.name)) && fs.existsSync(path.join(compareDir, d.name, 'spot.json')))
  .map((d) => ({ slug: d.name, spec: JSON.parse(fs.readFileSync(path.join(compareDir, d.name, 'spot.json'), 'utf8')) }));

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.jpg': 'image/jpeg' };
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
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const first = spots[0].spec;
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&cam=eye&x=${first.game?.x ?? 0}&y=${first.game?.y ?? 0}${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 120000 });
page.setDefaultTimeout(300000);

console.log('view                              frame ms   calls  tris(M)  | trees: calls  tris(M)  lod0  lod1  | calls / tris(M): lod0  lod1  lod2  impostor  shadow');
for (const { slug, spec } of spots) {
  for (const v of spec.views ?? []) {
    const e = v.eye ?? {};
    const pose = { x: e.x ?? v.x ?? spec.game?.x, y: e.y ?? v.y ?? spec.game?.y, h: e.h ?? v.h ?? v.heading ?? 0, pitch: e.pitch ?? v.pitch ?? 0, fov: e.fov ?? v.fov ?? 75, eye: e.eye ?? 1.7 };
    if (pose.x == null) continue;
    await page.evaluate((w) => window.__sim.setWeather(w), v.weather ?? spec.weather ?? null);
    await page.evaluate((p) => window.__sim.eyeAt(p.x, p.y, p.h, p.pitch, p.fov, p.eye), pose);
    let quiet = 0;
    for (let i = 0; i < 80 && quiet < 3; i++) {
      await page.evaluate(() => window.__step(4, 1 / 60));
      await page.waitForTimeout(250);
      const busy = await page.evaluate(() => {
        const s = window.__sim, p = s.pack;
        return [p.fine, p.mid, p.far, p.mask].reduce((n, t) => n + (t?.pending?.size ?? 0), 0) + s.veg.pending + s.terrain.stats.builds;
      });
      quiet = busy === 0 ? quiet + 1 : 0;
    }
    const r = await page.evaluate(() => {
      const s = window.__sim, info = s.renderer.info, gl = s.renderer.getContext();
      info.autoReset = false;
      const frame = () => { info.reset(); const t0 = performance.now(); window.__step(1, 1 / 60); gl.finish(); return { ms: performance.now() - t0, calls: info.render.calls, tris: info.render.triangles }; };
      for (let i = 0; i < 5; i++) frame();
      const runs = []; for (let i = 0; i < 30; i++) runs.push(frame());
      runs.sort((a, b) => a.ms - b.ms);
      const all = frame();
      s.veg.group.visible = false; const none = frame(); s.veg.group.visible = true;
      // FEAT-158: the same split per LOD (each LOD's materials hidden in turn, subtracted; update() re-shows the meshes)
      const by = {};
      for (const lod of ['lod0', 'lod1', 'lod2', 'impostor']) {
        const mats = new Set(s.veg.group.children.filter((m) => m.name.includes(lod)).map((m) => m.material));
        for (const m of mats) m.visible = false;
        const f = frame();
        for (const m of mats) m.visible = true;
        by[lod] = { calls: all.calls - f.calls, tris: all.tris - f.tris };
      }
      // the shadow pass's share of the trees (the frame with the shadow map not redrawn, trees shown and hidden)
      const sm = s.renderer.shadowMap, au = sm.autoUpdate;
      sm.autoUpdate = false; const noSh = frame(); s.veg.group.visible = false; const noShNone = frame(); s.veg.group.visible = true; sm.autoUpdate = au;
      const shadow = { calls: (all.calls - none.calls) - (noSh.calls - noShNone.calls), tris: (all.tris - none.tris) - (noSh.tris - noShNone.tris) };
      info.autoReset = true;
      return { shadow, ms: runs[15].ms, calls: all.calls, tris: all.tris, treeCalls: all.calls - none.calls, treeTris: all.tris - none.tris, lod0: s.veg.stats.lod0 ?? 0, lod1: s.veg.stats.lod1 ?? 0, by };
    });
    console.log(`${(slug + '/' + v.id).padEnd(34)} ${r.ms.toFixed(1).padStart(8)} ${String(r.calls).padStart(7)} ${(r.tris / 1e6).toFixed(2).padStart(8)}  | ${String(r.treeCalls).padStart(11)} ${(r.treeTris / 1e6).toFixed(2).padStart(8)} ${String(r.lod0).padStart(5)} ${String(r.lod1).padStart(5)}  | ${['lod0', 'lod1', 'lod2', 'impostor'].map((k) => `${r.by[k].calls}/${(r.by[k].tris / 1e6).toFixed(2)}`.padStart(10)).join('')}${`${r.shadow.calls}/${(r.shadow.tris / 1e6).toFixed(2)}`.padStart(10)}`);
  }
}
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
await browser.close();
server.close();
