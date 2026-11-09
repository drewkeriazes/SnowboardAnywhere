// Deformable snow check (FEAT-044): on a powder day, tucks to speed, links two carves and brakes to a
// stop; saves shots from the chase camera and straight down with the deformation on and off
// (`*_nodeform.png`), and checks that the deformation texture holds a depression under the track,
// that the terrain chunk count does not change with it (no extra split), that the spray spawned
// particles in the turns, and that the console stayed clean.
// node tools/trailcheck.mjs [pack] [outDir] [--headed]   (run after `npx vite build`; exit 1 on a failed check)
const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.js').then((m) => m.default));
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed') || process.env.SHOT_HEADED === '1';
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'synth';
const outDir = positional[1] ?? 'shots-trail';
fs.mkdirSync(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
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
const missing = [];
page.on('console', (m) => { if (m.type() !== 'error') return; (/404/.test(m.text()) ? missing : errors).push(m.text()); }); // a headed browser asks for a favicon the dist has none of
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 90000 });
page.setDefaultTimeout(300000);
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };

// a powder day: new snow on the groomers rides and tracks like powder (FEAT-053)
await page.evaluate(() => {
  const s = window.__sim;
  s.settings.newSnow = 'powder'; s.settings.snowDay = 'fresh'; s.settings.timeOfDay = 9; s.settings.snowDeform = true;
  if (s.settings.quality === 'low') s.settings.quality = 'medium'; // ?lowgfx turns the deformation off with the Low preset; the check needs it on (the other low-graphics fields stay)
  s.applySettings('newSnow');
});
const ride = (n) => page.evaluate((n) => {
  let spawned = 0;
  for (let i = 0; i < n; i++) { window.__step(1, 1 / 60); spawned += window.__sim.riderView.spray.spawned; }
  return spawned;
}, n);
const state = () => page.evaluate(() => {
  const r = window.__sim.rider, t = window.__sim.terrain;
  return { speed: +r.speed.toFixed(2), edgeDeg: +(Math.abs(r.edge) * 180 / Math.PI).toFixed(0), skid: +r.skid.toFixed(2), kind: r.snow.kind, depth: +(r.snow.depth * 100).toFixed(0), chunks: t.stats.chunks, tris: t.stats.triangles };
});
/** camera `back` m behind the rider along travel (negative = ahead), `side` m right, `up` m above, looking at a point `ahead` m along travel */
async function shot(label, back, side, up, ahead = 0) {
  const url = await page.evaluate(({ back, side, up, ahead }) => {
    const s = window.__sim, r = s.rider, c = s.cam;
    const prev = c.mode;
    const sp = Math.hypot(r.vx, r.vy);
    const yaw = sp > 0.5 ? Math.atan2(r.vx, r.vy) : r.heading;
    const fx = Math.sin(yaw), fz = -Math.cos(yaw), rgx = -fz, rgz = fx;
    const tx = r.x + fx * ahead, ty = r.z + 0.1, tz = -r.y + fz * ahead;
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
/** the deformation texture under a point `back` m behind the rider: depression and lip (cm), plus the texture's maxima and filled texel count */
const probe = (back) => page.evaluate((back) => {
  const s = window.__sim, d = s.deform, r = s.rider;
  const px = d.read(s.renderer);
  if (!px) return null;
  const res = d.resolution, size = d.size;
  const sp = Math.hypot(r.vx, r.vy);
  const yaw = sp > 0.5 ? Math.atan2(r.vx, r.vy) : r.heading;
  const x = r.x - Math.sin(yaw) * back, z = -r.y + Math.cos(yaw) * back;
  const u = (x - d.origin.x) / size, v = 1 - (z - d.origin.y) / size;
  const at = (uu, vv) => { const i = (Math.floor(vv * res) * res + Math.floor(uu * res)) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  // the widest reading within half a metre across the track (the point may sit on a lip)
  let best = [0, 0, 0];
  for (let k = -4; k <= 4; k++) {
    const uu = u + Math.cos(yaw) * k * 0.125 / size, vv = v + Math.sin(yaw) * k * 0.125 / size;
    if (uu < 0 || uu >= 1 || vv < 0 || vv >= 1) continue;
    const p = at(uu, vv); if (p[0] > best[0]) best = p;
  }
  let maxR = 0, maxG = 0, filled = 0;
  for (let i = 0; i < px.length; i += 4) { if (px[i] > maxR) maxR = px[i]; if (px[i + 1] > maxG) maxG = px[i + 1]; if (px[i] > 0 || px[i + 1] > 0) filled++; }
  const cm = (b) => +(b / 255 * 50).toFixed(1);
  return { depCm: cm(best[0]), lipCm: cm(best[1]), packed: +(best[2] / 255).toFixed(2), maxDepCm: cm(maxR), maxLipCm: cm(maxG), filled, inWindow: u >= 0 && u < 1 && v >= 0 && v < 1 };
}, back);

await ride(30); await page.waitForTimeout(1500); await ride(30);
console.log('start', JSON.stringify(await state()));
await page.keyboard.down('ArrowUp');
for (let i = 0; i < 40; i++) { await ride(15); if ((await state()).speed > 10) break; }
await page.keyboard.up('ArrowUp');
await shot('01_straight', 5, 1.5, 1.2);
const straight = await probe(3);
console.log('texture behind the board, straight:', JSON.stringify(straight));
// two carves, a hard brake
let spawned = 0, maxEdge = 0;
for (let t = 0; t < 4; t++) {
  const key = t % 2 ? 'ArrowRight' : 'ArrowLeft';
  await page.keyboard.down(key);
  for (let i = 0; i < 8; i++) { spawned += await ride(6); maxEdge = Math.max(maxEdge, (await state()).edgeDeg); }
  if (t === 2) await shot('02_mid_carve', -1.5, 1.4, 0.9, -3);
  await page.keyboard.up(key);
}
const carve = await probe(3);
console.log('texture behind the board, after the carves:', JSON.stringify(carve));
await ride(20);
await shot('03_trench_behind', -2, 0.9, 1.1, -6);
await shot('04_trench_overhead', 4, 0.2, 9);
await page.keyboard.down('ArrowDown');
let stopSpawned = 0;
for (let i = 0; i < 30; i++) { stopSpawned += await ride(6); if ((await state()).speed < 0.5) break; }
await page.keyboard.up('ArrowDown');
await shot('05_stop', 4, 2, 1.5);
const chunksOn = (await state()).chunks;
const stop = await probe(2);
console.log('texture behind the board, after the stop:', JSON.stringify(stop));
// the same views without the deformation (the ribbon alone)
await page.evaluate(() => { const s = window.__sim; s.settings.snowDeform = false; s.applySettings('snowDeform'); });
await ride(3);
await shot('05_stop_nodeform', 4, 2, 1.5);
const chunksOff = (await state()).chunks;
await page.evaluate(() => { const s = window.__sim; s.settings.snowDeform = true; s.applySettings('snowDeform'); });

console.log(`max edge ${maxEdge} deg, spray spawned in the carves ${spawned}, in the stop ${stopSpawned}`);
check('deformation texture holds the trench behind the board', !!carve && carve.inWindow && carve.depCm >= 4, carve ? `${carve.depCm} cm deep, lip ${carve.lipCm} cm, packed ${carve.packed}` : 'no texture');
check('a powder trench is deeper than a groomer groove', !!carve && carve.maxDepCm >= 8, carve ? `max ${carve.maxDepCm} cm, ${carve.filled} texels stamped` : '');
check('the stop leaves a pushed-up ridge', !!stop && stop.maxLipCm >= 1, stop ? `max lip ${stop.maxLipCm} cm` : '');
check('no extra terrain chunks for the deformation', Math.abs(chunksOn - chunksOff) <= 20, `${chunksOn} on, ${chunksOff} off`);
check('spray spawned in the carves', spawned > 50, `${spawned} particles`);
check('spray sheet in the stop', stopSpawned > 50, `${stopSpawned} particles`);
check('no console errors', errors.length === 0, errors.slice(0, 3).map((e) => e.slice(0, 200)).join(' | ') || (missing.length ? `${missing.length} missing resource(s) ignored` : ''));
await browser.close();
server.close();
process.exit(fails.length ? 1 : 0);
