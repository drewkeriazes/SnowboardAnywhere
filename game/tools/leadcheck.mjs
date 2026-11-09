// Body lead / board lag check (BUG-056): rides linked carves on the synthetic mountain and, at each
// edge change, finds the frame on which each link of the chain crosses to the new side: the pose the
// head and shoulders are built for, the pose the hips are built for, the body's inclination, the
// physics edge, and the board as drawn. Passes when every change reads shoulders, hips, body,
// physics, board (each no later than the next), the drawn board never rolls past the physics edge on
// the engaged side, and the drawn yaw stays within a few degrees of the physics yaw. --control zeroes
// the leads and the lag (the old look) and only reports.
// node tools/leadcheck.mjs [pack] [--headed] [--control]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed') || process.env.SHOT_HEADED === '1';
const control = args.includes('--control');
const pack = args.filter((a) => !a.startsWith('--'))[0] ?? 'synth';
const dist = DIST, packs = PACKS;
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
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&lowgfx${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 60000 });
page.setDefaultTimeout(240000);

if (control) await page.evaluate(() => { const v = window.__sim.riderView; v.leadUpper = 0; v.leadHips = 0; v.boardLag = 0; });

/** Step n frames at 60 Hz; returns one sample per frame of the chain's signals (plus the physics edge and yaws). */
const ride = (n) => page.evaluate((n) => {
  const s = window.__sim, r = s.rider, v = s.riderView, out = [];
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  for (let i = 0; i < n; i++) {
    window.__step(1, 1 / 60);
    const L = v.leadState;
    out.push({ upper: L.edgeUpper, hips: L.edgeHips, lean: L.lean, edge: r.edge, board: L.boardRoll, phys: L.physRoll, yawLead: L.yawLead, yawErr: wrap(r.boardYaw - v.yawF.x), ground: r.onGround, speed: r.speed });
  }
  return out;
}, n);

const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };

await ride(30); await page.waitForTimeout(1500); await ride(30);
// speed up straight
await page.keyboard.down('ArrowUp');
for (let i = 0; i < 40; i++) { await ride(15); if (await page.evaluate(() => window.__sim.rider.speed) > 12) break; }
await page.keyboard.up('ArrowUp');
// hold one edge until it settles, then switch sides; measure the crossing order at each switch
const CROSS = ['upper', 'hips', 'lean', 'edge', 'board'];
const results = [];
let rollPast = 0, yawErrMax = 0, frames = 0;
await page.keyboard.down('ArrowLeft'); await ride(45);
for (let t = 0; t < 4; t++) {
  const to = t % 2 ? 'ArrowLeft' : 'ArrowRight', from = t % 2 ? 'ArrowRight' : 'ArrowLeft';
  await page.keyboard.up(from); await page.keyboard.down(to);
  const samples = await ride(50);
  const sign = to === 'ArrowRight' ? 1 : -1; // steer right rolls onto the toe (+) edge
  const crossing = {};
  for (const k of CROSS) {
    const i = samples.findIndex((s) => s[k] * sign > 0.02);
    crossing[k] = i < 0 ? null : Math.round(i * 1000 / 60);
  }
  for (const s of samples) {
    frames++;
    if (s.board * s.phys > 0 && Math.abs(s.board) > Math.abs(s.phys) + 1e-6) rollPast = Math.max(rollPast, Math.abs(s.board) - Math.abs(s.phys));
    yawErrMax = Math.max(yawErrMax, Math.abs(s.yawErr));
  }
  results.push(crossing);
  console.log(`switch ${t + 1} (${to}) crossing ms`, JSON.stringify(crossing), `speed ${samples[samples.length - 1].speed.toFixed(1)}`);
}
await page.keyboard.up('ArrowRight'); await page.keyboard.up('ArrowLeft');
// jitter: tap left and right every 8 frames (133 ms) for 3 s; the body must stay smooth (no kinks),
// measured as the worst frame-to-frame change of velocity of each body signal (rad per frame^2)
const jit = [];
for (let t = 0; t < 22; t++) {
  const key = t % 2 ? 'ArrowRight' : 'ArrowLeft';
  await page.keyboard.down(key);
  jit.push(...await page.evaluate((n) => {
    const s = window.__sim, v = s.riderView, out = [];
    for (let i = 0; i < n; i++) { window.__step(1, 1 / 60); const L = v.leadState, p = v.pose; out.push({ lean: L.lean, board: L.boardRoll, yaw: L.yawLead, torsoY: p.torso[1], torsoZ: p.torso[2], hipsZ: p.hipsRot[2], hipsY: p.hipsY }); }
    return out;
  }, 8));
  await page.keyboard.up(key);
}
const kink = {};
for (const k of Object.keys(jit[0])) { let m = 0; for (let i = 2; i < jit.length; i++) m = Math.max(m, Math.abs(jit[i][k] - 2 * jit[i - 1][k] + jit[i - 2][k])); kink[k] = +m.toFixed(4); }
console.log('jitter (worst change of velocity per frame)', JSON.stringify(kink));
const ordered = results.every((c) => CROSS.every((k) => c[k] !== null) && c.upper <= c.hips && c.hips <= c.lean && c.lean <= c.edge && c.edge <= c.board);
const leads = results.every((c) => c.board - c.upper >= 40 && c.board - c.hips >= 20);
if (control) console.log('control run (no lead, no lag): ordered', ordered, 'leads', leads);
else {
  check('every link crosses to the new edge in order (shoulders, hips, body, physics, board)', ordered);
  check('shoulders at least 40 ms and hips at least 20 ms ahead of the board', leads);
}
check('the drawn board never rolls past the physics edge on the engaged side', rollPast < 1e-3, `${(rollPast * 180 / Math.PI).toFixed(2)} deg over`);
// a critically damped follow of a step of 1 rad with a 50 ms lag peaks near 0.03 rad/frame^2 at 60 Hz; the
// old first-order eases on a stepped target kinked at 2 to 3 times that
check('tapping left and right keeps the body smooth (no velocity kinks)', Math.max(kink.lean, kink.yaw, kink.torsoY, kink.torsoZ, kink.hipsZ, kink.board) < 0.04, JSON.stringify(kink));
check('the drawn yaw stays within 15 deg of the physics yaw', yawErrMax < 15 * Math.PI / 180, `max ${(yawErrMax * 180 / Math.PI).toFixed(1)} deg over ${frames} frames`);
console.log('console errors:', errors.length); for (const e of errors.slice(0, 10)) console.log('  ', e.slice(0, 300));
await browser.close();
server.close();
if (fails.length) { console.log(`${fails.length} check(s) failed`); process.exit(1); }
