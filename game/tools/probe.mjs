// Minimal probe: load, step small batches, report timing of each step. Finds hangs.
const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.js').then((m) => m.default));
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const dist = path.resolve('dist'); const packs = path.resolve('..', 'packs');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => { const u = decodeURIComponent(req.url.split('?')[0]); const p = u.startsWith('/packs/') ? path.join(packs, u.slice(7)) : path.join(dist, u); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ args: ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('console', (m) => console.log('console.' + m.type() + ':', m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('crash', () => console.log('PAGE CRASHED'));
await page.goto(`http://localhost:${port}/index.html?pack=synth&headless&lowgfx`);
await page.waitForFunction(() => window.__step, null, { timeout: 60000 });
const log = (...a) => { console.log(new Date().toISOString().slice(11, 19), ...a); };
for (let i = 0; i < 12; i++) {
  const t0 = Date.now();
  const r = await page.evaluate(() => { const t = performance.now(); window.__step(5, 1 / 60); const s = window.__sim; return { ms: (performance.now() - t) / 5, chunks: s.terrain.stats.chunks, builds: s.terrain.stats.builds, tris: s.terrain.stats.triangles, trees: s.veg.stats.instances, fine: s.pack.fine.loadedCount, mid: s.pack.mid.loadedCount, far: s.pack.far.loadedCount, mem: performance.memory ? (performance.memory.usedJSHeapSize / 1e6).toFixed(0) : '?' }; });
  log('batch', i, 'wall', Date.now() - t0, 'ms', JSON.stringify(r));
  await page.waitForTimeout(400);
}
await page.keyboard.down('ArrowUp');
for (let i = 0; i < 6; i++) {
  const t0 = Date.now();
  const r = await page.evaluate(() => { const t = performance.now(); window.__step(20, 1 / 60); const s = window.__sim; return { ms: (performance.now() - t) / 20, speed: s.rider.speed.toFixed(1), x: s.rider.x.toFixed(0), y: s.rider.y.toFixed(0), onGround: s.rider.onGround, chunks: s.terrain.stats.chunks, trees: s.veg.stats.instances }; });
  log('ride', i, 'wall', Date.now() - t0, JSON.stringify(r));
}
const dataUrl = await page.evaluate(() => window.__shot());
fs.writeFileSync('shots/probe.png', Buffer.from(dataUrl.split(',')[1], 'base64'));
log('shot written');
await browser.close(); server.close();
