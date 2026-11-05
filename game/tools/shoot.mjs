// Render and ride check: serves dist/ and ../packs, loads the sim, steps frames, saves screenshots.
// node tools/shoot.mjs [pack] [outDir] [--headed]
//   default: headless Chromium on SwiftShader (no GPU needed; add SHOT_QUERY="&lowgfx" for big packs)
//   --headed (or SHOT_HEADED=1): visible window on the real GPU; stays open at the end until you close it
// Local: game/node_modules (npm i). Cloud sandbox: preinstalled copy under /opt/npm-tools.
const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.js').then((m) => m.default));
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const headed = args.includes('--headed') || process.env.SHOT_HEADED === '1';
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'synth';
const outDir = positional[1] ?? 'shots';
const dist = path.resolve('dist');
const packs = path.resolve('..', 'packs');
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
const port = server.address().port;

const browser = headed
  ? await chromium.launch({ headless: false })
  : await chromium.launch({ args: ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const extra = process.env.SHOT_QUERY ?? '';
await page.goto(`http://localhost:${port}/index.html?pack=${pack}&headless${extra}`);
await page.waitForFunction(() => (window).__step, null, { timeout: 60000 });
page.setDefaultTimeout(240000);
const t = await page.evaluate(() => { const t0 = performance.now(); (window).__step(1, 1/60); return performance.now() - t0; });
console.log('first frame ms', t.toFixed(0));
const t2 = await page.evaluate(() => { const t0 = performance.now(); (window).__step(5, 1/60); return (performance.now() - t0) / 5; });
console.log('frame ms', t2.toFixed(0));

async function settle(frames, label) {
  // step a few frames, wait for tiles, repeat
  for (let i = 0; i < 6; i++) {
    await page.evaluate((n) => (window).__step(n, 1 / 60), Math.ceil(frames / 6));
    await page.waitForTimeout(500);
  }
  const stats = await page.evaluate(() => { const s = (window).__sim; return { chunks: s.terrain.stats.chunks, tris: s.terrain.stats.triangles, trees: s.veg.stats.instances, x: s.rider.x, y: s.rider.y, z: s.rider.z, speed: s.rider.speed, onGround: s.rider.onGround, fine: s.pack.fine?.loadedCount, mid: s.pack.mid?.loadedCount, far: s.pack.far?.loadedCount }; });
  const dataUrl = await page.evaluate(() => (window).__shot());
  fs.writeFileSync(path.join(outDir, `${label}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(label, JSON.stringify(stats));
}

await settle(30, '01_start');
// ride: hold tuck for a while
await page.keyboard.down('ArrowUp');
await settle(240, '02_tuck_4s');
await page.keyboard.up('ArrowUp');
await page.keyboard.down('ArrowRight');
await settle(120, '03_carve_right');
await page.keyboard.up('ArrowRight');
await page.keyboard.down('ArrowLeft');
await settle(120, '04_carve_left');
await page.keyboard.up('ArrowLeft');
await page.keyboard.down('Space');
await settle(40, '05_charge');
await page.keyboard.up('Space');
await settle(30, '06_jump');
await settle(300, '07_later');
// camera modes
await page.keyboard.press('KeyM');
await page.keyboard.press('KeyC'); await page.keyboard.press('KeyC');
await settle(20, '08_far_cam_map');
// free fly: look at the mountain from the valley
await page.evaluate(() => { const s = (window).__sim; s.cam.mode = 'free'; s.cam.yaw = Math.PI; s.cam.pitch = 0.12; s.cam['freePos'].set(300, s.pack.groundHeight(300, 2200) + 40, -2200); });
await settle(40, '09_free_view_from_valley');
await page.evaluate(() => { const s = (window).__sim; s.cam.yaw = 0; s.cam.pitch = -0.35; s.cam['freePos'].set(0, s.pack.groundHeight(0, -1500) + 60, 1500); });
await settle(40, '10_free_view_from_summit');

console.log('console issues:', errors.length);
for (const e of errors.slice(0, 15)) console.log('  ', e.slice(0, 300));
if (headed) {
  console.log('headed: close the browser window to exit');
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
}
await browser.close();
server.close();
