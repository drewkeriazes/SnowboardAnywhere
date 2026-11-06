// Rider close-up check (FEAT-048): rides through stand, tuck, carves, jump, crash and the ski
// variant; records the worst boot-to-binding gap every frame and saves side-view shots.
// node tools/rider.mjs [pack] [outDir] [--headed]   (run after `npx vite build`)
const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.js').then((m) => m.default));
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const headed = args.includes('--headed') || process.env.SHOT_HEADED === '1';
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'synth';
const outDir = positional[1] ?? 'shots-rider';
const dist = path.resolve('dist'), packs = path.resolve('..', 'packs');
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

let worst = 0;
/** step n frames one at a time, tracking the worst foot gap */
async function ride(n) {
  const w = await page.evaluate((n) => { let w = 0; for (let i = 0; i < n; i++) { window.__step(1, 1 / 60); w = Math.max(w, window.__sim.riderView.footGap); } return w; }, n);
  worst = Math.max(worst, w);
  return w;
}
/** side view: camera `dist` m off the rider's toe side (+right), a little ahead, at hip height */
async function shot(label, side = 1, dist = 3.2) {
  const st = await page.evaluate(({ side, dist }) => {
    const s = window.__sim, r = s.rider, c = s.cam;
    const prev = c.mode;
    const rx = r.x, ry = -r.y, rz = r.z + 0.9; // three.js frame
    const fx = Math.sin(r.heading), fz = -Math.cos(r.heading), rgx = -fz, rgz = fx;
    const cx = rx + rgx * dist * side + fx * 0.8, cz = ry + rgz * dist * side + fz * 0.8, cy = rz + 0.3;
    c.mode = 'free'; c.freePos.set(cx, cy, cz);
    const dx = rx - cx, dy = rz - cy, dz = ry - cz, l = Math.hypot(dx, dy, dz);
    c.yaw = Math.atan2(dx, -dz); c.pitch = Math.asin(dy / l);
    const url = window.__shot();
    c.mode = prev;
    return { url, gap: s.riderView.footGap, onGround: r.onGround, crashed: r.crashed, speed: r.speed, latG: r.lateralG, edge: r.edgeAngle };
  }, { side, dist });
  fs.writeFileSync(path.join(outDir, `${label}.png`), Buffer.from(st.url.split(',')[1], 'base64'));
  delete st.url;
  console.log(label, JSON.stringify(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v]))));
}

await ride(30); await page.waitForTimeout(1500); await ride(30);
await shot('01_stand_toe'); await shot('02_stand_heel', -1);
await page.keyboard.down('ArrowUp'); await ride(150); await shot('03_tuck'); await page.keyboard.up('ArrowUp');
await page.keyboard.down('ArrowRight'); await ride(50); await shot('04_carve_right'); await page.keyboard.up('ArrowRight');
await page.keyboard.down('ArrowLeft'); await ride(60); await shot('05_carve_left', -1); await page.keyboard.up('ArrowLeft');
await page.keyboard.down('Space'); await ride(40); await shot('06_charge'); await page.keyboard.up('Space');
await ride(8); await shot('07_air');
for (let i = 0; i < 40; i++) { await ride(3); if (await page.evaluate(() => window.__sim.rider.landingShock > 0.2)) break; }
await shot('08_land');
// crash: force one through the sim's own state
await page.evaluate(() => { window.__sim.rider.crashed = 1.5; });
await ride(20); await shot('09_crash');
await ride(120);
// skier
await page.evaluate(() => { const s = window.__sim; s.rider.discipline = 'ski'; s.riderView.setDiscipline('ski'); });
await ride(30); await shot('10_ski_stand');
await page.keyboard.down('ArrowUp'); await ride(90); await shot('11_ski_tuck'); await page.keyboard.up('ArrowUp');
await page.keyboard.down('ArrowRight'); await ride(50); await shot('12_ski_carve'); await page.keyboard.up('ArrowRight');
// first person, close camera
await page.evaluate(() => { const s = window.__sim; s.rider.discipline = 'board'; s.riderView.setDiscipline('board'); s.cam.mode = 'close'; });
await ride(40);
fs.writeFileSync(path.join(outDir, '13_close_cam.png'), Buffer.from((await page.evaluate(() => window.__shot())).split(',')[1], 'base64'));
console.log('worst foot gap (m):', worst.toFixed(4));
console.log('console errors:', errors.length); for (const e of errors.slice(0, 10)) console.log('  ', e.slice(0, 300));
await browser.close();
server.close();
