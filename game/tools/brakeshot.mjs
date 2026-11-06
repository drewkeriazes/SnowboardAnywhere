// Hockey-stop render check (FEAT-065): tucks to speed, holds brake to a stop, and saves shots of
// the board swung across, the spray and the scraped track; prints the board angle and speed.
// node tools/brakeshot.mjs [pack] [outDir] [--headed] [--ski]   (run after `npx vite build`)
const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.js').then((m) => m.default));
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { guardOutDir } from './outdir.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed') || process.env.SHOT_HEADED === '1';
const ski = args.includes('--ski');
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'synth';
const outDir = positional[1] ?? 'shots-brake';
const dist = path.resolve('dist'), packs = path.resolve('..', 'packs');
guardOutDir(outDir);
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
  const off = Math.atan2(Math.sin(r.boardYaw - Math.atan2(r.vx, r.vy)), Math.cos(r.boardYaw - Math.atan2(r.vx, r.vy))) * 180 / Math.PI;
  return { speed: +r.speed.toFixed(2), boardOffTravel: r.speed > 0.5 ? +off.toFixed(0) : null, brakeAcc: +r.brakeAcc.toFixed(1), scrape: +r.scrape.toFixed(2), side: r.brakeSide, slope: +r.slopeDeg.toFixed(0), footGap: +window.__sim.riderView.footGap.toFixed(4) };
});
/**
 * Shot from a camera placed relative to the rider: `back` m behind along the travel direction
 * (negative = ahead), `side` m to the right of it, `up` m above; looking at the rider.
 */
async function shot(label, back, side, up) {
  const st = await page.evaluate(({ back, side, up }) => {
    const s = window.__sim, r = s.rider, c = s.cam;
    const prev = c.mode;
    const sp = Math.hypot(r.vx, r.vy);
    const yaw = sp > 0.5 ? Math.atan2(r.vx, r.vy) : r.heading;
    const fx = Math.sin(yaw), fz = -Math.cos(yaw), rgx = -fz, rgz = fx; // three.js forward and right
    const tx = r.x, ty = r.z + 0.6, tz = -r.y;
    const cx = tx - fx * back + rgx * side, cz = tz - fz * back + rgz * side, cy = ty + up;
    c.mode = 'free'; c.freePos.set(cx, cy, cz);
    const dx = tx - cx, dy = ty - cy, dz = tz - cz, l = Math.hypot(dx, dy, dz);
    c.yaw = Math.atan2(dx, -dz); c.pitch = Math.asin(dy / l);
    const url = window.__shot();
    c.mode = prev;
    return url;
  }, { back, side, up });
  fs.writeFileSync(path.join(outDir, `${label}.png`), Buffer.from(st.split(',')[1], 'base64'));
  console.log(label, JSON.stringify(await state()));
}

if (ski) await page.evaluate(() => { const s = window.__sim; s.rider.discipline = 'ski'; s.riderView.setDiscipline('ski'); });
await ride(30); await page.waitForTimeout(1500); await ride(30);
await page.keyboard.down('ArrowUp');
for (let i = 0; i < 40; i++) { await ride(15); if ((await state()).speed > 12) break; }
await page.keyboard.up('ArrowUp');
await shot('01_running', 6, 2, 1.5);
await page.keyboard.down('ArrowDown');
await ride(12); await shot('02_swing', 5, 2.5, 1.2);
await ride(12); await shot('03_stop_side', 0.5, 5, 1.0);
await ride(6); await shot('04_stop_front', -6, 1.5, 1.2);
for (let i = 0; i < 60; i++) { await ride(6); if ((await state()).speed < 0.3) break; }
await ride(20); await shot('05_stopped', 4, 3, 1.5);
await page.keyboard.up('ArrowDown');
await ride(120); await shot('06_standing_after_release', 4, 3, 1.5);
await shot('07_track_overhead', 8, 0.5, 9);
console.log('console errors:', errors.length); for (const e of errors.slice(0, 10)) console.log('  ', e.slice(0, 300));
await browser.close();
server.close();
