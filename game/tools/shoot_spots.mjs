// Re-shoot the game side of every real vs game pair (DATA-008) with the eye camera.
// node tools/shoot_spots.mjs [pack] [spot-slug ...] [--headed | --gpu] [--size 1280x720]
//   reads ../docs/compare/<pack>/<spot>/spot.json and writes eye-<view>.png next to it.
//   Pose per view: the saved `eye` pose (from the P key) if any, else x / y / h from
//   tools/gmaps2game.py --add, else the spot's game x / y and the Street View heading.
//   Weather per view: the view's `weather`, else the spot's `weather` (e.g. "overcast" to match an
//   overcast photo, FEAT-078), else the page's own (SHOT_QUERY="&weather=..." or the default).
//   Needs `npx vite build` first. Software GPU: SHOT_QUERY="&lowgfx".
const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.js').then((m) => m.default));
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const headed = args.includes('--headed') || process.env.SHOT_HEADED === '1';
const gpu = args.includes('--gpu');
const sizeArg = args[args.indexOf('--size') + 1];
const [vw, vh] = args.includes('--size') ? sizeArg.split('x').map(Number) : [1280, 720];
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--size');
const pack = positional[0] ?? 'vail';
const only = positional.slice(1);
const compareDir = path.resolve('..', 'docs', 'compare', pack);
const dist = path.resolve('dist');
const packs = path.resolve('..', 'packs');

const spots = fs.readdirSync(compareDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (only.length === 0 || only.includes(d.name)) && fs.existsSync(path.join(compareDir, d.name, 'spot.json')))
  .map((d) => ({ slug: d.name, spec: JSON.parse(fs.readFileSync(path.join(compareDir, d.name, 'spot.json'), 'utf8')) }));
if (spots.length === 0) { console.log(`no spots under ${compareDir}`); process.exit(1); }

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.jpg': 'image/jpeg' };
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

const browser = headed
  ? await chromium.launch({ headless: false })
  : gpu ? await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] })
  : await chromium.launch({ args: ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const first = spots[0].spec;
await page.goto(`http://localhost:${port}/index.html?pack=${pack}&headless&cam=eye&x=${first.game?.x ?? 0}&y=${first.game?.y ?? 0}${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 120000 });
page.setDefaultTimeout(300000);

let n = 0;
for (const { slug, spec } of spots) {
  for (const v of spec.views ?? []) {
    const e = v.eye ?? {};
    const pose = {
      x: e.x ?? v.x ?? spec.game?.x, y: e.y ?? v.y ?? spec.game?.y, h: e.h ?? v.h ?? v.heading ?? 0,
      pitch: e.pitch ?? v.pitch ?? 0, fov: e.fov ?? v.fov ?? 75, eye: e.eye ?? 1.7,
    };
    if (pose.x == null || pose.y == null) { console.log(`${slug}/${v.id}: no position, skipped`); continue; }
    const weather = v.weather ?? spec.weather ?? null;
    await page.evaluate((w) => window.__sim.setWeather(w), weather);
    await page.evaluate((p) => window.__sim.eyeAt(p.x, p.y, p.h, p.pitch, p.fov, p.eye), pose);
    // step until terrain, mask and tree tiles have streamed in and the terrain stops rebuilding
    // (a fixed wait leaves half-built LOD skirts and floating trees in the shot)
    let quiet = 0;
    for (let i = 0; i < 80 && quiet < 3; i++) {
      await page.evaluate(() => window.__step(4, 1 / 60));
      await page.waitForTimeout(250);
      const busy = await page.evaluate(() => {
        const s = window.__sim, p = s.pack;
        const pend = [p.fine, p.mid, p.far, p.mask].reduce((n, t) => n + (t?.pending?.size ?? 0), 0);
        const veg = [...(s.veg.cells?.values?.() ?? [])].filter((c) => c.loading).length;
        return pend + veg + s.terrain.stats.builds;
      });
      quiet = busy === 0 ? quiet + 1 : 0;
    }
    const url = await page.evaluate(() => window.__shot());
    const out = path.join(compareDir, slug, `eye-${v.id}.png`);
    fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
    console.log(`${slug}/${v.id}`, JSON.stringify(pose), weather ? `weather=${weather}` : '', '->', path.relative(path.resolve('..'), out).split(path.sep).join('/'));
    n++;
  }
}
console.log(`${n} views shot; console errors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log('  ', e.slice(0, 300));
if (headed) { console.log('headed: close the browser window to exit'); await page.waitForEvent('close', { timeout: 0 }).catch(() => {}); }
await browser.close();
server.close();
