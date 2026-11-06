// Feature check: minimap, full map drop-in, buildings, rocks, lift ride and skip.
// node tools/shoot_features.mjs [pack] [outDir]
import pw from '/opt/npm-tools/node_modules/playwright/index.js';
const { chromium } = pw;
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const pack = process.argv[2] ?? 'synth';
const outDir = process.argv[3] ?? 'shots-features';
const dist = path.resolve('dist');
fs.mkdirSync(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.bin': 'application/octet-stream', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(dist, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(dist) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ args: ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const extra = process.env.SHOT_QUERY ?? '';
await page.goto(`http://localhost:${port}/index.html?pack=${pack}&headless${extra}`);
await page.waitForFunction(() => (window).__step, null, { timeout: 60000 });
page.setDefaultTimeout(240000);

async function settle(frames, label, full = false) {
  for (let i = 0; i < 6; i++) { await page.evaluate((n) => (window).__step(n, 1 / 60), Math.ceil(frames / 6)); await page.waitForTimeout(400); }
  const stats = await page.evaluate(() => { const s = (window).__sim; return { x: +s.rider.x.toFixed(0), y: +s.rider.y.toFixed(0), z: +s.rider.z.toFixed(0), speed: +s.rider.speed.toFixed(1), riding: s.liftRide.riding, up: +s.liftRide.up.toFixed(0), nearby: s.liftRide.nearby?.feature.name ?? null, mapOpen: s.map.fullOpen, fine: s.pack.fine?.loadedCount }; });
  // full page screenshot includes the DOM minimap/map overlays
  await page.screenshot({ path: path.join(outDir, `${label}.png`) });
  console.log(label, JSON.stringify(stats));
}

await settle(30, '01_start_minimap');
await page.keyboard.press('KeyM');
await settle(10, '02_full_map');
// drop in 30 m below the lift bottom terminal via the map pick handler
const bottom = await page.evaluate(() => { const l = (window).__sim.lifts.all[0]; return l.bottom; });
console.log('lift bottom', bottom);
await page.evaluate(([x, y]) => (window).__sim.map.onPick(x, y - 25), bottom);
await settle(40, '03_dropped_near_lift');
// ride toward the terminal by tuck for a moment is unreliable on a synth slope; teleport close and board
await page.evaluate(([x, y]) => { const s = (window).__sim; s.rider.reset(x, y - 6, 0); s.cam.snapTo(s.rider); }, bottom);
await settle(10, '04_at_terminal');
await page.keyboard.press('KeyE');
await settle(240, '05_riding_lift');
await page.keyboard.press('KeyE');
await settle(30, '06_skipped_to_top');
await page.keyboard.down('ArrowUp');
await settle(120, '07_riding_down_from_top');
await page.keyboard.up('ArrowUp');
// look at the base buildings and rocks from the air
await page.evaluate(([x, y]) => { const s = (window).__sim; s.cam.mode = 'free'; s.cam.yaw = Math.PI; s.cam.pitch = -0.45; s.cam['freePos'].set(x, s.pack.groundHeight(x, y - 120) + 60, -(y - 120)); }, bottom);
await settle(60, '08_base_buildings');
await page.evaluate(() => { const s = (window).__sim; const st = s.pack.meta.start; s.cam.yaw = 0; s.cam.pitch = -0.5; s.cam['freePos'].set(st.x, s.pack.groundHeight(st.x, st.y - 60) + 25, -(st.y - 60)); });
await settle(60, '09_rocks');
console.log('console issues:', errors.length);
for (const e of errors.slice(0, 15)) console.log('  ', e.slice(0, 300));
await browser.close();
server.close();
