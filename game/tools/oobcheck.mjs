// Out of bounds rope and yeti in the game (FEAT-305): loads a pack with ?yetiodds=1, puts the rider 25 m inside the
// boundary rope nearest the spawn facing out, shoots the rope from the chase camera, rides over it and checks the
// toast and the yeti (one wake, one monster drawn), glances back at it, then comes back in and goes out again inside
// the cooldown (no second wake). The render-free half (odds, cooldown, the outline) is tools/boundarycheck.mjs.
//   npx vite build && node tools/oobcheck.mjs [pack] [outDir] [--high] [--headed | --gpu]     (exit code 1 on a failure)
// --at=x,y: the rope span nearest that pack point instead of the one nearest the spawn (an open spot for the still)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'synth';
const at = (args.find((a) => a.startsWith('--at=')) ?? '').slice(5).split(',').map(Number);
const outDir = positional[1] ?? 'shots-oob';
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
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&yetiodds=1${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 60000 });
page.setDefaultTimeout(240000);

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
async function step(frames) { for (let i = 0; i < Math.ceil(frames / 30); i++) { await page.evaluate((n) => window.__step(n, 1 / 60), Math.min(30, frames - i * 30)); await page.waitForTimeout(60); } }
async function shot(label) { const d = await page.evaluate(() => window.__shot()); const f = path.resolve(outDir, `${label}.png`); fs.writeFileSync(f, Buffer.from(d.split(',')[1], 'base64')); console.log('shot', f); }
const state = () => page.evaluate(() => {
  const s = window.__sim, e = s.egg, m = e.sim.nearest;
  return { wakes: e.wakes, on: e.on, phase: e.sim.phase, views: s.monsters.views.size, toast: document.getElementById('toast')?.textContent ?? '',
    posts: s.boundaryRope.posts.count, rope: s.boundaryRope.rope.count, dist: m ? +m.dist.toFixed(1) : null, yeti: m ? [+m.x.toFixed(0), +m.y.toFixed(0), +m.z.toFixed(0), m.mode, +m.speed.toFixed(1)] : null, heading: +s.rider.heading.toFixed(2), speed: +s.rider.speed.toFixed(1), cam: [+s.cam.camera.position.x.toFixed(0), +(-s.cam.camera.position.z).toFixed(0), +s.cam.camera.position.y.toFixed(0)], rider: [+s.rider.x.toFixed(0), +s.rider.y.toFixed(0), +s.rider.z.toFixed(0)] };
});

await step(30);
// the rope span nearest the rider, and the way out across it (in bounds is on the left of a span)
const spot = await page.evaluate((at) => {
  const s = window.__sim, b = s.boundary, r0 = s.rider, [ax, ay] = at.length === 2 && at.every(Number.isFinite) ? at : [r0.x, r0.y];
  if (!b) return null;
  let best = null;
  b.rings.forEach((r, ri) => {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      if (b.open[ri][i] || b.open[ri][(i + 1) % n] || b.open[ri][(i + n - 1) % n]) continue;
      const j = (i + 1) % n, mx = (r[2 * i] + r[2 * j]) / 2, my = (r[2 * i + 1] + r[2 * j + 1]) / 2;
      const d = Math.hypot(mx - ax, my - ay);
      if (!best || d < best.d) { const ex = r[2 * j] - r[2 * i], ey = r[2 * j + 1] - r[2 * i + 1], L = Math.hypot(ex, ey); best = { d, mx, my, nx: ey / L, ny: -ex / L }; }
    }
  });
  return best && { ...best, d: Math.hypot(best.mx - r0.x, best.my - r0.y) };
}, at);
ok(!!spot, `a rope span to cross (${spot ? spot.d.toFixed(0) : '-'} m from the spawn)`);
if (spot) {
  const place = (back) => page.evaluate(({ spot, back }) => {
    const s = window.__sim, r = s.rider, h = Math.atan2(spot.nx, spot.ny);
    const x = spot.mx - spot.nx * back, y = spot.my - spot.ny * back;
    r.reset(x, y, h); r.z = s.pack.groundHeight(x, y) + 0.3; s.cam.snapTo(r);
  }, { spot, back });
  await place(25);
  await step(240); // the fine tiles load and the rope settles on them
  await place(16);
  await step(20);
  const st0 = await state();
  ok(st0.posts > 10 && st0.rope > 20, `rope drawn around the rider (${st0.posts} posts, ${st0.rope} rope pieces)`);
  await shot('01_rope_chase_cam');
  // over the rope: pushed out along the span's normal, about 8 m/s
  for (let k = 0; k < 90; k++) {
    await page.evaluate((spot) => { const r = window.__sim.rider; r.x += spot.nx * 0.14; r.y += spot.ny * 0.14; r.vx = spot.nx * 8; r.vy = spot.ny * 8; window.__step(1, 1 / 60); }, spot);
  }
  const st1 = await state();
  ok(st1.wakes === 1 && st1.on && st1.views === 1, `crossing woke the yeti once (${st1.wakes} wakes, ${st1.views} drawn, ${st1.phase}, ${st1.dist} m back)`);
  ok(st1.toast.includes("Bad boy, that's out of bounds."), `toast: "${st1.toast}"`);
  await step(60);
  // the still: the yeti brought in 18 m behind the rider, so it shows past the trees and the ridge
  await page.evaluate(() => { const s = window.__sim, r = s.rider, m = s.egg.sim.nearest; if (m) { const h = Math.atan2(r.vx, r.vy); m.x = r.x - Math.sin(h) * 18; m.y = r.y - Math.cos(h) * 18; m.z = s.pack.groundHeight(m.x, m.y); m.mode = 'direct'; } });
  await step(2);
  await page.keyboard.down('KeyG');
  await step(30);
  console.log(JSON.stringify(await state()));
  await shot('02_yeti_behind');
  await page.keyboard.up('KeyG');
  // back in and out again inside the cooldown
  await place(10); await step(240);
  for (let k = 0; k < 90; k++) await page.evaluate((spot) => { const r = window.__sim.rider; r.x += spot.nx * 0.2; r.y += spot.ny * 0.2; window.__step(1, 1 / 60); }, spot);
  const st2 = await state();
  ok(st2.wakes === 1, `crossing again inside the cooldown: still ${st2.wakes} wake`);
  // Outrun starts: the egg yeti goes
  await page.evaluate(() => { window.__sim.settings.outrun = { difficulty: 'normal', escape: 'base', gentle: false }; window.__sim.startOutrun(); });
  await step(10);
  const st3 = await state();
  ok(!st3.on, 'starting Outrun ends the egg chase');
  await page.evaluate(() => window.__sim.stopOutrun());
}
ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close(); server.close();
console.log(fails ? `${fails} check(s) failed` : 'all oob checks passed');
process.exit(fails ? 1 : 0);
