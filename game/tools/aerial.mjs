// FEAT-154: aerial stills from the eye camera (the menu's backdrop camera), for far terrain and forest checks.
// node tools/aerial.mjs <pack> <outDir> <poses.json> [variants.json] [--gpu | --headed]   (after `npx vite build`)
//   poses.json: [{ "label": "bowls", "x": -727, "y": 524, "h": 180, "pitch": -18, "fov": 50, "eye": 700 }, ...]
//     x, y pack metres; h heading in degrees clockwise from north; eye = metres above the snow (as AttractShots).
//   variants.json (optional): [{ "label": "base" }, { "label": "noao", "eval": "__sim.terrain.material.userData.uniforms.uAO.value = 0" }]
//     each variant's `eval` runs in the page before its stills (after the previous variant's `undo`, if any).
// Writes <outDir>/<pose>-<variant>.png and prints draw calls, triangles and the GPU frame time per still.
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const [pack = 'vail', outDir = 'shots-aerial', posesFile, variantsFile] = args.filter((a) => !a.startsWith('--'));
if (!posesFile) { console.error('usage: node tools/aerial.mjs <pack> <outDir> <poses.json> [variants.json] [--gpu]'); process.exit(1); }
const poses = JSON.parse(fs.readFileSync(posesFile, 'utf8'));
const variants = variantsFile ? JSON.parse(fs.readFileSync(variantsFile, 'utf8')) : [{ label: 'base' }];
fs.mkdirSync(outDir, { recursive: true });

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

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&cam=eye${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 120000 });
page.setDefaultTimeout(300000);
await page.evaluate(() => window.__step(1, 1 / 60));

for (const v of variants) {
  if (v.eval) await page.evaluate(v.eval);
  for (const s of poses) {
    await page.evaluate((s) => window.__sim.eyeAt(s.x, s.y, s.h, s.pitch, s.fov ?? 50, s.eye), s);
    // step until the tiles have streamed in and the terrain stops rebuilding (as shoot_attract.mjs)
    let quiet = 0;
    for (let i = 0; i < 120 && quiet < 3; i++) {
      await page.evaluate(() => window.__step(4, 1 / 60));
      await page.waitForTimeout(200);
      const busy = await page.evaluate(() => {
        const s = window.__sim, p = s.pack;
        const pend = [p.fine, p.mid, p.far, p.mask].reduce((n, t) => n + (t?.pending?.size ?? 0), 0);
        const veg = [...(s.veg.cells?.values?.() ?? [])].filter((c) => c.loading).length;
        return pend + veg + s.terrain.stats.builds;
      });
      quiet = busy === 0 ? quiet + 1 : 0;
    }
    // frame time: 30 frames, each finished on the GPU (readPixels forces the flush)
    const st = await page.evaluate(() => {
      const s = window.__sim, r = s.renderer, gl = r.getContext();
      const px = new Uint8Array(4);
      window.__step(1, 1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < 30; i++) { window.__step(1, 1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
      const ms = (performance.now() - t0) / 30;
      return { ms: +ms.toFixed(1), calls: r.info.render.calls, tris: r.info.render.triangles, chunks: s.terrain.stats.chunks };
    });
    const url = await page.evaluate(() => window.__shot());
    const file = path.join(outDir, `${s.label}-${v.label}.png`);
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    console.log(`${s.label}-${v.label}`, JSON.stringify(st));
  }
  if (v.undo) await page.evaluate(v.undo);
}
console.log('errors:', errors.length);
for (const e of errors.slice(0, 10)) console.log('  ', e.slice(0, 300));
await browser.close();
server.close();
