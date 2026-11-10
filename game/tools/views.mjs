// Stills from fixed free-camera spots, for look checks (rock, snow lighting, horizon).
// node tools/views.mjs <pack> <outDir> <views.json> [--headed | --gpu | --cpu] (GPU choice: tools/browser.mjs)
// views.json: [{ "label": "orient", "x": 700, "y": -1650, "above": 3, "yaw": 80, "pitch": 5 }, ...]
//   x, y pack metres; above = metres over the ground; yaw = compass degrees (0 north, 90 east); pitch degrees.
// Same server and SHOT_QUERY handling as tools/shoot.mjs; lowgfx is added automatically on a software GPU.
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed') || process.env.SHOT_HEADED === '1';
const [pack = 'vail', outDir = 'shots-views', viewsFile] = args.filter((a) => !a.startsWith('--'));
if (!viewsFile) { console.error('usage: node tools/views.mjs <pack> <outDir> <views.json> [--headed]'); process.exit(1); }
const views = JSON.parse(fs.readFileSync(viewsFile, 'utf8'));
const dist = DIST;
const packs = PACKS;
fs.mkdirSync(outDir, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [packs, u.slice('/packs/'.length)] : [dist, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const first = views[0];
await page.goto(`http://localhost:${port}/index.html?pack=${pack}&headless&x=${first.x}&y=${first.y}${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 60000 });
page.setDefaultTimeout(240000);
// SHOT_EVAL: JavaScript run in the page once before the views (tweak uniforms, settings)
if (process.env.SHOT_EVAL) await page.evaluate(process.env.SHOT_EVAL);

for (const v of views) {
  const place = () => page.evaluate((v) => {
    const s = window.__sim;
    s.cam.mode = 'free';
    s.cam.yaw = v.yaw * Math.PI / 180; s.cam.pitch = (v.pitch ?? 0) * Math.PI / 180;
    s.cam['freePos'].set(v.x, s.pack.groundHeight(v.x, v.y) + (v.above ?? 3), -v.y);
    // free mode streams terrain, trees and rocks around the camera; the rider stays at the start
  }, v);
  // terrain builds 10 chunks a frame and tiles stream in: give each view ~200 frames
  for (let i = 0; i < 10; i++) {
    await place();
    await page.evaluate(() => window.__step(20, 1 / 60));
    await page.waitForTimeout(600);
  }
  await place();
  const dataUrl = await page.evaluate(() => window.__shot());
  fs.writeFileSync(path.join(outDir, `${v.label}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
  const st = await page.evaluate((v) => { const s = window.__sim; const c = s.cam.camera.position; return { chunks: s.terrain.stats.chunks, tris: s.terrain.stats.triangles, mode: s.cam.mode, cam: [+c.x.toFixed(0), +(-c.z).toFixed(0), +c.y.toFixed(1)], ground: +s.pack.groundHeight(v.x, v.y).toFixed(1) }; }, v);
  console.log(v.label, JSON.stringify(st));
  // SHOT_PROBE: an expression evaluated in the page after each view, printed (debugging)
  if (process.env.SHOT_PROBE) console.log('  probe', JSON.stringify(await page.evaluate(process.env.SHOT_PROBE)));
}

console.log('console issues:', errors.length);
for (const e of errors.slice(0, 15)) console.log('  ', e.slice(0, 300));
if (headed) {
  console.log('headed: close the browser window to exit');
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
}
await browser.close();
server.close();
