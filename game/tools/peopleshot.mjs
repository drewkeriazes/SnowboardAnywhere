// Static people stills and ride check (FEAT-307) on a real pack, from the chase camera:
//   picks planned people (a pair dead centre, a pair to the side, a sitter), streams the tiles round each until it
//   settles, stands the rider uphill of it on the fall line and shoots (near and far), then rides the rider
//   into it at 12 m/s and checks it is stopped like any obstacle (a square hit crashes). Prints the in-game
//   counts (planned, settled, dropped) along the way.
// node tools/peopleshot.mjs [pack] [outDir] [--gpu | --headed]     (needs `npx vite build`; SHOT_PACKS for another packs folder)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'vail';
const outDir = path.resolve(positional[1] ?? 'shots-people');
fs.mkdirSync(outDir, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

const browser = await launchBrowser(args);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless${process.env.SHOT_QUERY ?? ''}`);
  await page.waitForFunction(() => window.__step && window.__sim, null, { timeout: 120000 });
  page.setDefaultTimeout(300000);
  await page.evaluate(() => {
    const s = window.__sim;
    s.settings.timeOfDay = 13; s.settings.snowDay = 'mid'; s.settings.newSnow = 'none';
    s.applySettings('newSnow'); s.setWeather(null);
  });
  const plan = await page.evaluate(() => window.__sim.people.spots.map((s) => ({ ...s.plan })));
  console.log(`${pack}: ${plan.length} people planned`);

  /** hold the rider at (x, y) facing h (deg) while the tiles, trees and people round it stream in */
  const hold = async (x, y, h, frames = 40, until = null) => {
    await page.evaluate(([x, y]) => { const s = window.__sim, R = 700; s.pack.fine?.request(x - R, y - R, x + R, y + R); s.pack.mask?.request(x - R, y - R, x + R, y + R); }, [x, y]);
    for (let i = 0; i < frames; i++) {
      const done = await page.evaluate(([x, y, h, i, until]) => {
        const s = window.__sim;
        s.rider.reset(x, y, h * Math.PI / 180);
        s.rider.z = s.pack.groundHeight(x, y);
        s.cam.snapTo(s.rider);
        window.__step(1, 1 / 60);
        const quiet = i >= 8 && (s.veg?.pending ?? 0) === 0 && (s.pack.fine?.inFlight ?? 0) === 0 && (s.pack.mask?.inFlight ?? 0) === 0;
        if (!quiet) return false;
        if (!until) return i >= 20;
        const sp = s.people.spots.find((q) => q.plan.id === until);
        return sp.state !== 'planned' && (sp.state === 'dropped' || !!sp.mesh);
      }, [x, y, h, i, until]);
      if (done) return true;
      await page.waitForTimeout(150);
    }
    return false;
  };

  /** settle one planned spot (the rider 40 m up its run line), then return where it stands */
  const settle = async (p) => {
    const hx = -p.dx * 40, hy = -p.dy * 40;
    await hold(p.x + hx, p.y + hy, Math.atan2(p.dx, p.dy) * 180 / Math.PI, 160, p.id);
    return page.evaluate((id) => { const s = window.__sim.people, sp = s.spots.find((q) => q.plan.id === id); return { state: sp.state, ...(s.list().find((q) => q.id === id) ?? {}) }; }, p.id);
  };

  const picks = [];
  const add = (label, pred) => { for (const p of plan) if (pred(p) && !picks.some((q) => q.p.id === p.id)) { picks.push({ label, p }); return; } };
  add('pair-centre', (p) => p.kind === 'pair' && p.center);
  add('pair-side', (p) => p.kind === 'pair' && !p.center);
  add('sitter', (p) => p.kind === 'sitter');
  // more of each, in case the first is dropped (in the trees, on rock, below a rollover)
  for (let k = 0; k < 3; k++) { add(`pair-centre`, (p) => p.kind === 'pair' && p.center); add(`pair-side`, (p) => p.kind === 'pair' && !p.center); add(`sitter`, (p) => p.kind === 'sitter'); }

  const done = new Set(), closeups = [];
  for (const { label, p } of picks) {
    if (done.has(label)) continue;
    const at = await settle(p);
    console.log(`${label} ${p.id} on ${p.runName ?? '(unnamed)'}: ${at.state}${at.x !== undefined ? ` at ${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.slope.toFixed(1)} deg` : ''}`);
    if (at.state !== 'placed' || at.x === undefined) continue;
    done.add(label);
    closeups.push({ label, at });
    const h = Math.atan2(at.fx, at.fy) * 180 / Math.PI; // down the fall line, toward the person
    for (const [tag, back, side] of [['near', 7, 3], ['far', 20, 5]]) {
      // uphill of it on the fall line, a little to the side so the rider doesn't cover it
      const nx = at.fy, ny = -at.fx;
      const x = at.x - at.fx * back + nx * side, y = at.y - at.fy * back + ny * side;
      // facing down the fall line (not at it), so the chase camera sees past the rider to it
      await hold(x, y, h, 40);
      const file = path.join(outDir, `${label}-${tag}.png`);
      const url = await page.evaluate(() => window.__shot());
      fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
      console.log(`  still ${file}`);
    }
    // ride straight into it down the fall line from 14 m above, at 12 m/s
    const hit = await page.evaluate(([at, h]) => {
      const s = window.__sim, r = s.rider, pack = s.pack, h0 = h * Math.PI / 180;
      const x0 = at.x - at.fx * 14, y0 = at.y - at.fy * 14;
      r.reset(x0, y0, h0);
      const n0 = pack.groundNormal(x0, y0);
      r.z = pack.groundHeight(x0, y0);
      r.vx = Math.sin(h0) * 12; r.vy = Math.cos(h0) * 12; r.vz = -(r.vx * n0[0] + r.vy * n0[1]) / Math.max(0.2, n0[2]);
      const inp = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false, skate: false, lean: 0, balance: 0 };
      let crashed = 0, wall = '', closest = Infinity, air = 0, before = 0, after = -1;
      const near = s.people && r.collider ? r.collider.near(at.x, at.y, 3).length : -1;
      for (let i = 0; i < 120 * 5; i++) {
        const v0 = r.speed;
        r.lastHit = '';
        r.update(1 / 120, inp);
        crashed = Math.max(crashed, r.crashed);
        if (!wall && r.lastHit) { wall = r.lastHit; before = v0; after = r.speed; }
        // how far past it along the fall line
        const along = (r.x - at.x) * at.fx + (r.y - at.y) * at.fy;
        const dd = Math.hypot(r.x - at.x, r.y - at.y);
        if (dd < closest) { closest = dd; air = r.onGround ? 0 : r.z - pack.groundHeight(r.x, r.y); }
        if (along > 8) break;
      }
      const along = (r.x - at.x) * at.fx + (r.y - at.y) * at.fy;
      return { crashed, wall, before, after, along, closest, air, near, speed: r.speed };
    }, [at, h]);
    check(`${label}: riding into it stops the rider like any obstacle`, hit.crashed > 0 || (hit.wall === 'wall' && hit.after < 0.5 * hit.before), `crashed ${hit.crashed.toFixed(2)}, first hit ${hit.wall || 'none'} at ${hit.before.toFixed(1)} m/s (${hit.after.toFixed(1)} after), ended ${hit.along.toFixed(1)} m along the fall line from it, speed ${hit.speed.toFixed(1)} m/s, passed ${hit.closest.toFixed(2)} m from it ${hit.air > 0 ? `${hit.air.toFixed(2)} m in the air` : 'on the snow'}, ${hit.near} colliders there`);
  }
  // close-ups from the eye camera (the chase camera is done with): 6 m off, from the side and from below
  for (const { label, at } of closeups) {
    for (const [tag, ox, oy] of [['side', -at.fy * 6, at.fx * 6], ['below', at.fx * 7, at.fy * 7]]) {
      const x = at.x + ox, y = at.y + oy, h = Math.atan2(at.x - x, at.y - y) * 180 / Math.PI;
      await page.evaluate(([x, y, h]) => window.__sim.eyeAt(x, y, h, -4, 45, 1.3), [x, y, h]);
      for (let i = 0; i < 12; i++) { await page.evaluate(() => window.__step(1, 1 / 60)); await page.waitForTimeout(80); }
      const file = path.join(outDir, `${label}-close-${tag}.png`);
      const url = await page.evaluate(() => window.__shot());
      fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
      console.log(`  still ${file}`);
    }
  }
  for (const l of ['pair-centre', 'pair-side', 'sitter']) check(`a ${l} settled and shot`, done.has(l), done.has(l) ? 'yes' : 'none of the picks settled');
  const st = await page.evaluate(() => window.__sim.people.stats);
  console.log(`in game: ${JSON.stringify(st)}`);
  if (errors.length) console.log(`page errors:\n  ${errors.slice(0, 10).join('\n  ')}`);
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
