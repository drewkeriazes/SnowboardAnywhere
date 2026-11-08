// Riding switch check (FEAT-139): for each stance (regular, then goofy) rides the synthetic mountain,
// lands a 180 and checks the rider rides away switch with the tail leading, drawn without a turn-round
// pop (the drawn yaw never steps more than the spin itself), the rig's toe side on the heading's left
// (regular switch) or right (goofy switch), SWITCH on the HUD and the trick named. Then steers right
// riding switch and checks it turns right with the heel edge drawn engaged (regular) or the toe edge
// (goofy), and lands a second 180 back to the normal stance. Also shows a time-trial ghost riding
// switch on the snow (BUG-059: the ghost threw there) and checks there are no console errors.
// node tools/switchcheck.mjs [pack] [--headed]   (run after `npx vite build`; exit 1 on a failed check)
const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.js').then((m) => m.default));
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed') || process.env.SHOT_HEADED === '1';
const pack = args.filter((a) => !a.startsWith('--'))[0] ?? 'synth';
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
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };
const deg = (a) => (a * 180 / Math.PI).toFixed(0);

for (const stance of ['regular', 'goofy']) {
  console.log(`---- ${stance}`);
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&lowgfx&stance=${stance}${process.env.SHOT_QUERY ?? ''}`);
  await page.waitForFunction(() => window.__step, null, { timeout: 60000 });
  page.setDefaultTimeout(240000);
  const goofy = stance === 'goofy';

  /** Step n 60 Hz frames of the rider physics and the rider view with `steer` held (no render, so it
   *  runs in seconds on a software GPU: the view is scene-graph maths). Per frame: the drawn yaw (pack
   *  convention), the rig's toe side across the heading (+ right), the physics state, the drawn board
   *  roll, and the trick toast. `frame` renders one real frame at the end (the HUD). */
  const ride = (n, steer = 0, frame = false) => page.evaluate(([n, steer, frame]) => {
    const s = window.__sim, r = s.rider, v = s.riderView, out = [];
    const input = { steer, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false };
    for (let i = 0; i < n; i++) {
      r.update(1 / 60, input);
      r.applyRenderPose(); v.update(r, 1 / 60, false); r.restoreSimPose();
      const q = v.group.quaternion, x = q.x, y = q.y, z = q.z, w = q.w;
      // the group's -Z (drawn nose) and +X (the rig's toe side) in three.js world
      const fx = -(2 * (x * z + w * y)), fz = -(1 - 2 * (x * x + y * y));
      const tx = 1 - 2 * (y * y + z * z), tz = 2 * (x * z - w * y);
      const hx = Math.sin(r.heading), hy = Math.cos(r.heading); // pack
      const toe = tx * hy + tz * hx; // the toe side vector (three x, -z = pack north) against the heading's right (hy, -hx) in pack
      out.push({ yaw: Math.atan2(fx, -fz), toe, sw: r.switch, ground: r.onGround, crashed: r.crashed, speed: r.speed, travel: Math.atan2(r.vx, r.vy), heading: r.heading, roll: v.leadState.physRoll, spin: r.spin, hit: r.lastHit, x: r.x, y: r.y, toast: document.getElementById('toast').textContent });
    }
    if (frame) { window.__step(1, 1 / 60); out[out.length - 1].hud = document.getElementById('hud').textContent.includes('SWITCH'); }
    return out;
  }, [n, steer, frame]);
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const maxStep = (ss) => ss.slice(1).reduce((m, s, i) => Math.max(m, Math.abs(wrap(s.yaw - ss[i].yaw))), 0);
  /** jump, spin with `steer` held for `ms`, then ride on until landed and 0.5 s more; also the spin and
   *  the state on the landing frame, for the failure detail */
  const spin = async (steer, ms) => {
    await page.evaluate(() => { const r = window.__sim.rider; r.onGround = false; r.vz = 9; r.z += 0.1; r.airTime = 0; r.spin = 0; r.flip = 0; r.flipRate = 0; });
    let a = await ride(Math.round(ms * 60 / 1000), steer);
    for (let k = 0; k < 60 && !a[a.length - 1].ground; k++) a = a.concat(await ride(10));
    const land = a.findIndex((x) => x.ground);
    const at = land > 0 ? a[land - 1] : null;
    const all = a.concat(await ride(30, 0, true));
    const L = all[all.length - 1];
    L.detail = `air spin ${at ? deg(at.spin) : '?'} deg, crashed ${L.crashed.toFixed(2)}, switch ${L.sw}, HUD ${L.hud}, hits ${[...new Set(all.map((x) => x.hit).filter(Boolean))].join('/') || 'none'}, toast "${L.toast}"`;
    return all;
  };

  for (let i = 0; i < 6; i++) { await ride(30); await page.waitForTimeout(500); } // the tiles under the start stream in
  // speed up straight down the fall line (a tuck)
  let s = await ride(20);
  for (let i = 0; i < 40 && s[s.length - 1].speed < 12; i++) s = await page.evaluate(() => {
    const r = window.__sim.rider, v = window.__sim.riderView, out = [];
    for (let k = 0; k < 15; k++) { r.update(1 / 60, { steer: 0, tuck: true, brake: false, jumpHeld: false, jumpReleased: false, grab: false }); r.applyRenderPose(); v.update(r, 1 / 60, true); r.restoreSimPose(); }
    out.push({ speed: r.speed });
    return out;
  });
  s = await ride(20, 0, true);
  const last = (a) => a[a.length - 1];
  check('rides the normal stance, toe side as the stance has it', !last(s).sw && !last(s).hud && Math.sign(last(s).toe) === (goofy ? -1 : 1), `toe ${last(s).toe.toFixed(2)}, speed ${last(s).speed.toFixed(1)}`);

  const before = last(s).yaw;
  s = await spin(1, 900);
  let L = last(s);
  check('the 180 lands clean', L.ground && L.crashed <= 0, L.detail);
  check('rides away switch', L.sw && L.hud, L.detail);
  check('drawn turned round, tail leading', Math.abs(Math.abs(wrap(L.yaw - before)) - Math.PI) < 0.6, `${deg(wrap(L.yaw - before))} deg`);
  check('no turn-round pop (drawn yaw steps under 12 deg a frame)', maxStep(s) < 12 * Math.PI / 180, `largest ${deg(maxStep(s))} deg`);
  check('toe side flipped across the heading', Math.sign(L.toe) === (goofy ? 1 : -1), `toe ${L.toe.toFixed(2)}`);
  check('trick named', L.toast === (goofy ? 'Frontside 180' : 'Backside 180'), L.toast);

  s = await ride(120);
  check('stays switch on its own (2 s)', s.every((x) => x.sw) && maxStep(s) < 0.05, `largest ${deg(maxStep(s))} deg`);
  const t = await ride(40, 1);
  const turned = wrap(last(t).travel - t[0].travel);
  const roll = t[30].roll;
  check('steer right turns right riding switch', turned > 0.15, `${deg(turned)} deg`);
  check(`on the ${goofy ? 'toe' : 'heel'} edge as drawn`, Math.sign(roll) === (goofy ? 1 : -1), `rig roll ${deg(roll)} deg`);
  s = await ride(60);
  check('still switch before the second jump', last(s).sw && last(s).crashed <= 0, `switch ${last(s).sw}, crashed ${last(s).crashed.toFixed(2)}, speed ${last(s).speed.toFixed(1)}`);

  s = await spin(-1, 900);
  L = last(s);
  check('a second 180 back to the normal stance', !L.sw && !L.hud && L.crashed <= 0, L.detail);
  check('no pop on the way back', maxStep(s) < 12 * Math.PI / 180, `largest ${deg(maxStep(s))} deg`);
  check('switch trick named', L.toast === (goofy ? 'Switch frontside 180' : 'Switch backside 180'), L.toast);

  // BUG-059: a ghost on the snow (riding switch) is drawn with no errors
  const ghost = await page.evaluate(() => {
    const s = window.__sim, r = s.rider, tw = s.trialWorld;
    tw.setEnabled(true);
    try {
      for (let i = 0; i < 20; i++) tw.updateGhost({ t: i / 60, x: r.x + 4, y: r.y, z: r.z, h: r.heading, lg: 0.2, e: 0.4, f: 1 | 8 }, 1 / 60);
      return { ok: tw.ghost.group.visible, err: '' };
    } catch (e) { return { ok: false, err: String(e) }; } finally { tw.setEnabled(false); }
  });
  check('a ghost riding switch on the snow draws without throwing', ghost.ok, ghost.err);
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 300));
  if (process.env.SHOT_OUT) await page.screenshot({ path: path.join(process.env.SHOT_OUT, `switch-${stance}.png`) });
  await page.close();
}
await browser.close();
server.close();
if (fails.length) { console.log(`${fails.length} check(s) failed`); process.exit(1); }
console.log('all checks passed');
