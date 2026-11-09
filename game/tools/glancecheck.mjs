// Look behind check (BUG-057): rides the synthetic mountain at speed and, in each camera (first person,
// helmet, chase, close, far, cine), holds look behind (G) for 1.2 s and lets go. First person and the
// helmet cam must look back up the hill above level (they looked down into the snow rising behind you)
// with the run above in the top of the frame. The chase cameras must sit on the downhill side with the
// rider in the lower part of the frame and the centre of the view on the run well above the rider (they
// rose over the rider and looked down at the snow). Letting go must swing back to looking ahead without
// a jump. Steps the physics and the cameras without rendering, so it runs in seconds on a software GPU.
// node tools/glancecheck.mjs [pack] [--headed]   (run after `npx vite build`; exit 1 on a failed check)
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
const deg = (a) => (a * 180 / Math.PI).toFixed(1);

const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('response', (res) => { if (res.status() >= 400) errors.push(`${res.status()} ${res.url()}`); });
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&lowgfx${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 60000 });
page.setDefaultTimeout(240000);

/**
 * Step n 60 Hz frames of the rider (tucked, straight) and the current camera the way main.ts drives it,
 * with look behind held or not. Returns the last frame: the view's pitch (rad, + up), the view against
 * the direction of travel (flat, + ahead, - back), the largest frame-to-frame turn of the view (rad),
 * the slope rising behind the rider (rad), where the rider sits in the frame (NDC y, -1 bottom), the
 * distance (m, flat) from the rider to where the centre of the view meets the snow (Infinity: sky), and
 * whether a ray near the top of the frame clears the snow within 150 m.
 */
const ride = (n, glance) => page.evaluate(([n, glance]) => {
  const s = window.__sim, r = s.rider, v = s.riderView, cam = s.cam, c = cam.camera, pk = s.pack;
  const input = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false };
  const eye = c.position.clone(), dir = c.position.clone(), prev = c.position.clone();
  let maxTurn = 0;
  c.getWorldDirection(prev);
  for (let i = 0; i < n; i++) {
    r.update(1 / 60, input);
    r.applyRenderPose(); v.update(r, 1 / 60, false);
    cam.glance = glance;
    if (cam.firstPerson) cam.updateFirstPerson(r, 1 / 60, false, false, 0, 0, v.eye(eye));
    else { cam.freeLook(false, 1 / 60, 0, 0, glance); cam.update(r, 1 / 60, false); }
    r.restoreSimPose();
    c.updateMatrixWorld(true);
    c.getWorldDirection(dir);
    maxTurn = Math.max(maxTurn, Math.acos(Math.min(1, dir.dot(prev))));
    prev.copy(dir);
  }
  const sp = Math.hypot(r.vx, r.vy) || 1, ux = r.vx / sp, uy = r.vy / sp;
  const fl = Math.hypot(dir.x, dir.z) || 1;
  const along = (dir.x * ux + -dir.z * uy) / fl;
  const pitch = Math.asin(dir.y);
  const gb = pk.groundHeight(r.x - ux * 25, r.y - uy * 25);
  const slopeBehind = Math.atan2(gb - r.z, 25);
  // first snow along a ray from the camera, flat distance from the rider; Infinity when it clears 300 m
  const hit = (d) => {
    const p = c.position;
    for (let t = 0.5; t < 300; t += 0.5) {
      const x = p.x + d.x * t, y = p.y + d.y * t, z = p.z + d.z * t;
      if (y < pk.groundHeight(x, -z)) return Math.hypot(x - r.x, -z - r.y);
    }
    return Infinity;
  };
  const centre = hit(dir);
  // a ray 80% of the way to the top of the frame
  const half = c.fov * Math.PI / 360, top = dir.clone().applyAxisAngle(dir.clone().cross(c.up).normalize(), half * 0.8);
  const topClear = hit(top) > 150;
  const rp = c.worldToLocal(c.position.clone().set(r.x, r.z + 1, -r.y));
  const riderY = rp.z < 0 ? (rp.y / -rp.z) / Math.tan(half) : NaN;
  return { pitch, along, maxTurn, slopeBehind, riderY, centre, topClear, speed: r.speed, crashed: r.crashed, onGround: r.onGround };
}, [n, glance]);

// the tiles under the start stream in, then speed up straight down the fall line
await page.evaluate(() => { window.__sim.cam.mode = 'chase'; });
for (let i = 0; i < 6; i++) { await ride(30, false); await page.waitForTimeout(500); }
let s = await ride(60, false);
for (let i = 0; i < 20 && s.speed < 10; i++) s = await ride(30, false);
console.log(`riding at ${s.speed.toFixed(1)} m/s, the slope behind rises ${deg(s.slopeBehind)} deg`);
// each camera starts from this spot and speed, so the run does not flatten out by the last one
const start = await page.evaluate(() => { const r = window.__sim.rider; return { x: r.x, y: r.y, z: r.z, vx: r.vx, vy: r.vy, vz: r.vz, heading: r.heading }; });

for (const mode of ['fp', 'helmet', 'chase', 'close', 'far', 'cine']) {
  console.log(`---- ${mode}`);
  await page.evaluate(([m, st]) => { const s = window.__sim; s.cam.mode = m; Object.assign(s.rider, st); s.cam.snapTo(s.rider); }, [mode, start]);
  const fwd = await ride(90, false);
  const g = await ride(72, true);
  const back = await ride(90, false);
  const at = `pitch ${deg(g.pitch)} deg, view to travel ${g.along.toFixed(2)}, slope behind ${deg(g.slopeBehind)} deg, speed ${g.speed.toFixed(1)}, crashed ${g.crashed.toFixed(2)}`;
  // the cinematic camera trails off to one side, so it looks ahead at an angle
  check(`${mode}: riding, looks ahead`, fwd.along > (mode === 'cine' ? 0.5 : 0.8), `view to travel ${fwd.along.toFixed(2)}, pitch ${deg(fwd.pitch)} deg`);
  check(`${mode}: look behind turns round`, g.along < -0.7, at);
  if (mode === 'fp' || mode === 'helmet') {
    check(`${mode}: looks up the hill behind, not down into the snow`, g.pitch > 3 * Math.PI / 180, at);
    check(`${mode}: the run above in the top of the frame`, g.topClear, at);
  } else {
    check(`${mode}: the rider low in the frame`, g.riderY > -0.9 && g.riderY < -0.05, `rider at NDC y ${g.riderY.toFixed(2)}; ${at}`);
    check(`${mode}: the centre of the view on the run above the rider`, g.centre > 15, `${Number.isFinite(g.centre) ? g.centre.toFixed(1) + ' m' : 'sky'} from the rider; ${at}`);
  }
  check(`${mode}: letting go looks ahead again`, back.along > (mode === 'cine' ? 0.5 : 0.8), `view to travel ${back.along.toFixed(2)}`);
  // the swing round is a quick ease (about 28 deg in the first frame), never a cut
  check(`${mode}: smooth both ways`, Math.max(g.maxTurn, back.maxTurn) < 0.6, `largest turn in a frame ${deg(Math.max(g.maxTurn, back.maxTurn))} deg`);
}
await page.evaluate(() => { window.__step(1, 1 / 60); });
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 300));
if (process.env.SHOT_OUT) await page.screenshot({ path: path.join(process.env.SHOT_OUT, 'glance.png') });
await page.close();
await browser.close();
server.close();
if (fails.length) { console.log(`${fails.length} check(s) failed`); process.exit(1); }
console.log('all checks passed');
