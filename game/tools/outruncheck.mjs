// Outrun check (FEAT-097 to FEAT-101): starts a chase headless, rides, looks back at the monster,
// then teleports into it to play the eat sequence, saving screenshots and state along the way.
// node tools/outruncheck.mjs [pack] [outDir] [--gpu | --headed]
const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.js').then((m) => m.default));
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const gpu = args.includes('--gpu');
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'vail';
const outDir = positional[1] ?? 'shots-outrun';
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
const port = server.address().port;
const browser = headed ? await chromium.launch({ headless: false })
  : gpu ? await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] })
  : await chromium.launch({ args: ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const extra = process.env.SHOT_QUERY ?? '';
await page.goto(`http://localhost:${port}/index.html?pack=${pack}&headless${extra}`);
await page.waitForFunction(() => window.__step, null, { timeout: 60000 });
page.setDefaultTimeout(240000);

const state = () => page.evaluate(() => {
  const s = window.__sim, o = s.outrun, m = o.nearest;
  return { phase: o.phase, t: +o.t.toFixed(1), time: +o.time.toFixed(1), dist: Number.isFinite(o.dist) ? +o.dist.toFixed(1) : null, score: Math.round(o.score), close: o.closeCalls, adr: +o.adrenaline.toFixed(2), boost: o.boosting,
    rider: { x: +s.rider.x.toFixed(0), y: +s.rider.y.toFixed(0), z: +s.rider.z.toFixed(0), speed: +s.rider.speed.toFixed(1) },
    monster: m ? { mode: m.mode, x: +m.x.toFixed(0), y: +m.y.toFixed(0), z: +m.z.toFixed(0), speed: +m.speed.toFixed(1), sight: m.sight, along: +m.along.toFixed(0) } : null,
    n: o.monsters.length, views: s.monsters.views.size, jaw: +([...s.monsters.views.values()][0]?.bones.Jaw.scale.y ?? 0).toFixed(2), base: o.base ? o.base.map((v) => +v.toFixed(0)) : null, card: document.getElementById('outrun-card')?.style.display, hud: document.getElementById('outrun')?.textContent?.slice(0, 80) };
});
async function step(frames, label) {
  for (let i = 0; i < Math.max(1, Math.ceil(frames / 30)); i++) { await page.evaluate((n) => window.__step(n, 1 / 60), Math.min(30, frames)); await page.waitForTimeout(80); }
  const st = await state();
  if (label) { const d = await page.evaluate(() => window.__shot()); fs.writeFileSync(path.join(outDir, `${label}.png`), Buffer.from(d.split(',')[1], 'base64')); }
  console.log(label ?? '-', JSON.stringify(st));
  return st;
}

await step(30, '01_before');
await page.evaluate(() => { window.__sim.settings.outrun = { difficulty: 'normal', escape: 'base', gentle: false }; window.__sim.startOutrun(); });
await step(1, '02_countdown');
await step(200);            // countdown done
await page.keyboard.down('ArrowUp');
await step(60 * 7, '03_headstart_end');
await step(90, '04_spawned');
await page.keyboard.down('KeyG');
await step(60, '05_glance_back');
await page.keyboard.up('KeyG');
for (let i = 0; i < 6; i++) await step(240, `06_chase_${i}`);
await page.keyboard.down('KeyG');
await step(30, '07_glance_late');
await page.keyboard.up('KeyG');
await page.keyboard.up('ArrowUp');
// a lift: teleport to the nearest chair's bottom, board it, ride a while, skip blocked
await page.evaluate(() => { const s = window.__sim; const l = s.lifts.all.find((x) => x.kind === 'chair' || x.kind === 'gondola'); if (l) { const m = s.outrun.nearest; if (m) { m.x = l.bottom[0] - 60; m.y = l.bottom[1] - 60; m.z = s.pack.groundHeight(m.x, m.y); m.mode = 'direct'; m.frustrated = 30; } s.rider.x = l.bottom[0]; s.rider.y = l.bottom[1]; s.rider.z = s.pack.groundHeight(l.bottom[0], l.bottom[1]) + 0.3; s.rider.vx = s.rider.vy = 0; s.rider.speed = 0; s.cam.snapTo(s.rider); } });
await step(10);
await page.keyboard.press('KeyE');
await step(120, '07e_lift_boarded');
await page.keyboard.press('KeyE'); // skip must be blocked while Outrun runs
await step(240, '07f_lift_riding');
// jump the chair near the top so the unload happens, then wait for the monster to finish its climb and drop onto the new trail
await page.evaluate(() => { const s = window.__sim; const l = s.liftRide.lift; if (l) s.liftRide.up = s.lifts.rideLength(l) - 25; });
await step(90, '07g_lift_unloaded');
for (let i = 0; i < 20; i++) { const st = await step(60); if (st.monster && st.monster.mode !== 'lift') break; }
await step(30, '07h_after_lift');
// put the rider 28 m ahead of the monster and look back at it
await page.evaluate(() => { const s = window.__sim, m = s.outrun.nearest; if (m) { const h = m.heading; s.rider.x = m.x + Math.sin(h) * 28; s.rider.y = m.y + Math.cos(h) * 28; s.rider.z = s.pack.groundHeight(s.rider.x, s.rider.y) + 0.3; s.rider.vx = Math.sin(h) * 12; s.rider.vy = Math.cos(h) * 12; s.cam.snapTo(s.rider); } });
await page.keyboard.down('KeyG');
await step(40, '07b_glance_close');
await step(30, '07c_glance_closer');
await page.keyboard.up('KeyG');
await page.keyboard.down('ArrowUp');
await step(120, '07d_after');
await page.keyboard.up('ArrowUp');
// a boost if there is adrenaline, else grant it
await page.evaluate(() => { window.__sim.outrun.adrenaline = 1; });
await page.keyboard.press('KeyQ');
await step(60, '08_boost');
// teleport the rider in front of the monster to get caught
await page.evaluate(() => { const s = window.__sim, m = s.outrun.nearest; if (m) { s.rider.x = m.x; s.rider.y = m.y; s.rider.z = m.z + 0.5; s.rider.vx = s.rider.vy = 0; } });
await step(5, '09_contact');
for (let i = 0; i < 28; i++) await step(15, `10_eat_${String(i).padStart(2, '0')}`);
await step(60, '11_card');
const issues = errors.filter((e) => !/404|favicon/.test(e));
console.log('console issues', issues.length, issues.slice(0, 12));
if (!headed) { await browser.close(); server.close(); }
