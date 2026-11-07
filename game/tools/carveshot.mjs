// Carve track render check (FEAT-097): tucks to speed, links hard carves left and right, and saves
// shots of the knife-cut line close up, overhead, and looking back up the run from a distance;
// prints the edge amount and the track half width laid down at each turn.
// node tools/carveshot.mjs [pack] [outDir] [--headed] [--ski]   (run after `npx vite build`)
const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.js').then((m) => m.default));
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed') || process.env.SHOT_HEADED === '1';
const ski = args.includes('--ski');
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'synth';
const outDir = positional[1] ?? 'shots-carve';
const dist = DIST, packs = PACKS;
fs.mkdirSync(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [packs, u.slice('/packs/'.length)] : [dist, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const browser = headed
  ? await chromium.launch({ headless: false })
  : await chromium.launch({ args: ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 60000 });
page.setDefaultTimeout(240000);

const ride = (n) => page.evaluate((n) => { for (let i = 0; i < n; i++) window.__step(1, 1 / 60); }, n);
const state = () => page.evaluate(() => {
  const r = window.__sim.rider;
  const phi = Math.atan(r.lateralG * 0.8);
  return { speed: +r.speed.toFixed(2), lateralG: +r.lateralG.toFixed(2), edge: +Math.min(1, Math.abs(phi) / 0.6).toFixed(2), skid: +r.skid.toFixed(2), slipDeg: +(r.slip * 180 / Math.PI).toFixed(0) };
});
/** camera `back` m behind the rider along travel (negative = ahead), `side` m right, `up` m above, looking at a point `ahead` m along travel */
async function shot(label, back, side, up, ahead = 0) {
  const url = await page.evaluate(({ back, side, up, ahead }) => {
    const s = window.__sim, r = s.rider, c = s.cam;
    const prev = c.mode;
    const sp = Math.hypot(r.vx, r.vy);
    const yaw = sp > 0.5 ? Math.atan2(r.vx, r.vy) : r.heading;
    const fx = Math.sin(yaw), fz = -Math.cos(yaw), rgx = -fz, rgz = fx;
    const tx = r.x * 1 + fx * ahead, ty = r.z + 0.1, tz = -r.y + fz * ahead;
    const cx = r.x - fx * back + rgx * side, cz = -r.y - fz * back + rgz * side, cy = r.z + up;
    c.mode = 'free'; c.freePos.set(cx, cy, cz);
    const dx = tx - cx, dy = ty - cy, dz = tz - cz, l = Math.hypot(dx, dy, dz);
    c.yaw = Math.atan2(dx, -dz); c.pitch = Math.asin(dy / l);
    const u = window.__shot();
    c.mode = prev;
    return u;
  }, { back, side, up, ahead });
  fs.writeFileSync(path.join(outDir, `${label}.png`), Buffer.from(url.split(',')[1], 'base64'));
  console.log(label, JSON.stringify(await state()));
}

if (ski) await page.evaluate(() => { const s = window.__sim; s.rider.discipline = 'ski'; s.riderView.setDiscipline('ski'); s.tracks.setDiscipline('ski'); });
await ride(30); await page.waitForTimeout(1500); await ride(30);
await page.keyboard.down('ArrowUp');
for (let i = 0; i < 40; i++) { await ride(15); if ((await state()).speed > 10) break; }
await page.keyboard.up('ArrowUp');
await shot('01_straight', 5, 1.5, 1.2);
// link carves: hold each side long enough to get high on edge
let maxEdge = 0;
for (let t = 0; t < 6; t++) {
  const key = t % 2 ? 'ArrowRight' : 'ArrowLeft';
  await page.keyboard.down(key);
  for (let i = 0; i < 8; i++) { await ride(6); maxEdge = Math.max(maxEdge, (await state()).edge); }
  if (t === 3) await shot('02_mid_carve_close', -1.5, 1.2, 0.8, -3);
  await page.keyboard.up(key);
}
console.log('max edge seen', maxEdge);
await ride(30);
// the rider is now past the turns: look back along the track
await shot('03_track_behind_close', -2, 0.8, 1.0, -6);
await shot('04_track_overhead', 6, 0.2, 10);
await shot('05_track_far_lookback', -40, 3, 6, -10);
console.log('console errors:', errors.length); for (const e of errors.slice(0, 10)) console.log('  ', e.slice(0, 300));
await browser.close();
server.close();
