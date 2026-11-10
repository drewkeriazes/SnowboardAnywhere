// FEAT-128: render the main menu's backdrop still for each resort, from the exact pose of its shot
// (world/AttractShots.ts), so the menu has a picture while the session loads behind it.
// node tools/shoot_attract.mjs [pack ...] [--gpu | --headed]   (run after `npx vite build`; on Drew's GPU)
// Writes game/public/attract/<pack>/<shot id>.jpg at 1920 x 1080. Re-run when a shot, the terrain or the far forest changes.
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS, REPO } from './paths.mjs';

const args = process.argv.slice(2);
const packs = args.filter((a) => !a.startsWith('--'));
if (!packs.length) packs.push('vail');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' };
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
let failed = 0;
for (const pack of packs) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&cam=eye${process.env.SHOT_QUERY ?? ''}`);
  await page.waitForFunction(() => window.__step, null, { timeout: 120000 });
  page.setDefaultTimeout(300000);
  await page.evaluate(() => window.__step(1, 1 / 60)); // __sim is filled by the first frame
  const shot = await page.evaluate(() => window.__sim.shot);
  await page.evaluate((s) => window.__sim.eyeAt(s.x, s.y, s.h, s.pitch, s.fov, s.eye), shot);
  // step until the tiles have streamed in and the terrain stops rebuilding (as shoot_spots.mjs)
  let quiet = 0;
  for (let i = 0; i < 100 && quiet < 3; i++) {
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
  const jpg = await page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/jpeg', 0.82);
  }, url);
  const dir = path.join(REPO, 'game', 'public', 'attract', pack);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${shot.id}.jpg`);
  fs.writeFileSync(out, Buffer.from(jpg.split(',')[1], 'base64'));
  // list it in the manifest, so the menu asks only for stills that exist
  const manFile = path.join(REPO, 'game', 'public', 'attract', 'index.json');
  const man = fs.existsSync(manFile) ? JSON.parse(fs.readFileSync(manFile, 'utf8')) : {};
  const e = (man[pack] ??= {});
  e.stills = [...new Set([...(e.stills ?? []), shot.id])];
  e.ghosts ??= [];
  fs.writeFileSync(manFile, JSON.stringify(man, null, 2) + '\n');
  console.log(`${pack}/${shot.id}`, JSON.stringify({ x: shot.x, y: shot.y, h: shot.h, pitch: shot.pitch, fov: shot.fov, eye: shot.eye }), '->', path.relative(REPO, out).split(path.sep).join('/'), errors.length ? `errors: ${errors.join(' | ')}` : '');
  if (errors.length) failed++;
  await page.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
