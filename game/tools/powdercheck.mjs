// Board set down into deep powder (FEAT-152): on a powder day (6 in+ of loose snow) holds the rider at
// a set of speeds and checks how far the board is drawn down into the snow (about 0.7 of the depth when
// slow, less as it planes, a few cm at high speed), the nose-up pitch, the snow cover and the sag held
// ahead of the board; then the same on the groomers with no new snow (nothing changes there), and on
// foot (the boots sit down by the whole boot sink). Saves chase, low side and close front shots at
// each speed, a groomer shot to compare, and an on-foot shot.
// node tools/powdercheck.mjs [pack] [outDir] [--headed | --gpu]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'synth';
const outDir = positional[1] ?? 'shots-powder';
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
const browser = await launchBrowser(args);
const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 90000 });
page.setDefaultTimeout(300000);
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };

/** the day: a powder day, or a mid-season groomer day with no new snow */
const day = (powder) => page.evaluate((powder) => {
  const s = window.__sim;
  s.settings.newSnow = powder ? 'powder' : 'none'; s.settings.snowDay = powder ? 'fresh' : 'mid'; s.settings.timeOfDay = powder ? 10 : 13; s.settings.snowDeform = true;
  if (s.settings.quality === 'low') s.settings.quality = 'medium';
  s.applySettings('newSnow'); s.applySettings('snowDeform');
}, powder);
/** step the whole frame n times holding `speed` m/s along the heading (0: let it be); returns the view's bury state and the snow */
const hold = (n, speed) => page.evaluate(([n, speed]) => {
  const s = window.__sim, r = s.rider;
  for (let i = 0; i < n; i++) {
    if (speed !== null) { r.vx = Math.sin(r.heading) * speed; r.vy = Math.cos(r.heading) * speed; r.edge = 0; }
    window.__step(1, 1 / 60);
  }
  const b = s.riderView.buryState, h = s.riderView.powderHold;
  return { speed: +r.speed.toFixed(1), onGround: r.onGround, kind: r.snow.kind, depth: +r.snow.depth.toFixed(3), noseSink: +r.noseSink.toFixed(2), sink: +b.sink.toFixed(3), pitchDeg: +(b.pitch * 180 / Math.PI).toFixed(1), cover: +b.cover.toFixed(2), hold: +h.k.toFixed(2), bootSink: +r.sink.toFixed(3), onFoot: r.onFoot };
}, [n, speed]);
/** camera `back` m behind the rider along its heading (negative = ahead), `side` m right, `up` m above, looking at the board */
async function shot(label, back, side, up, ahead = 0, lookY = 0) {
  const url = await page.evaluate(({ back, side, up, ahead, lookY }) => {
    const s = window.__sim, r = s.rider, c = s.cam;
    const prev = c.mode;
    const yaw = r.heading;
    const fx = Math.sin(yaw), fz = -Math.cos(yaw), rgx = -fz, rgz = fx;
    const tx = r.x + fx * ahead, ty = r.z + lookY, tz = -r.y + fz * ahead;
    const cx = r.x - fx * back + rgx * side, cz = -r.y - fz * back + rgz * side;
    const gc = s.pack.groundHeight(cx, -cz), cy = Math.max(r.z, Number.isNaN(gc) ? r.z : gc) + up; // never inside the hill
    c.mode = 'free'; c.freePos.set(cx, cy, cz);
    const dx = tx - cx, dy = ty - cy, dz = tz - cz, l = Math.hypot(dx, dy, dz);
    c.yaw = Math.atan2(dx, -dz); c.pitch = Math.asin(dy / l);
    const u = window.__shot();
    c.mode = prev;
    return u;
  }, { back, side, up, ahead, lookY });
  fs.writeFileSync(path.join(outDir, `${label}.png`), Buffer.from(url.split(',')[1], 'base64'));
}

// settle at the spawn, then a powder day: the snow under the board is 6 in or more
await hold(30, 0); await page.waitForTimeout(1500); await hold(30, 0);
await day(true);
await hold(20, 0);
const speeds = [1.5, 5, 12, 22];
const P = {};
for (const v of speeds) {
  P[v] = await hold(90, v); // 1.5 s at the speed: the 0.3 s ease has settled
  console.log(`powder ${v} m/s`, JSON.stringify(P[v]));
  await shot(`powder_${String(v).replace('.', '_')}_chase`, 3.2, 0.8, 1.4, 0);
  await shot(`powder_${String(v).replace('.', '_')}_side`, 0.2, 2.2, 0.35, 0, 0.1);
  await shot(`powder_${String(v).replace('.', '_')}_close`, -0.6, 1.1, 0.45, 0, 0);
}
const slow = P[1.5], mid = P[5], plane = P[12], fast = P[22];
check('the snow is 6 in or deeper on the powder day', slow.depth >= 0.17, `${(slow.depth * 100).toFixed(0)} cm, ${slow.kind}`);
check('slow in powder the board sits about 0.7 of the depth down', slow.sink >= 0.55 * slow.depth && slow.sink <= 0.72 * slow.depth, `${(slow.sink * 100).toFixed(1)} cm of ${(slow.depth * 100).toFixed(0)}`);
check('the board planes up with speed', mid.sink < slow.sink + 0.005 && plane.sink < mid.sink && fast.sink < plane.sink, [slow, mid, plane, fast].map((s) => (s.sink * 100).toFixed(1)).join(' > ') + ' cm');
check('about half the slow sink by PLANE_SPEED', plane.sink >= 0.25 * plane.depth && plane.sink <= 0.45 * plane.depth, `${(plane.sink * 100).toFixed(1)} cm of ${(plane.depth * 100).toFixed(0)}`);
check('a few cm at high speed', fast.sink > 0.01 && fast.sink <= 0.045, `${(fast.sink * 100).toFixed(1)} cm`);
check('nose up, tail low while riding', mid.pitchDeg >= 4 && mid.pitchDeg <= 10 && plane.pitchDeg >= 3, `${mid.pitchDeg} deg at 5 m/s, ${plane.pitchDeg} at 12`);
check('the tail never goes deeper than the loose snow', [slow, mid, plane, fast].every((s) => s.sink + 0.72 * Math.sin(Math.max(0, s.pitchDeg) * Math.PI / 180) <= 0.91 * s.depth), '');
check('snow covers the buried gear and the sag is held ahead of it', slow.cover === 1 && slow.hold === 1, `cover ${slow.cover}, hold ${slow.hold}`);
// in the air the board comes up out of the snow
const air = await page.evaluate(() => {
  const s = window.__sim, r = s.rider;
  r.z += 1.5; r.vz = 3; r.onGround = false;
  window.__step(25, 1 / 60);
  const b = s.riderView.buryState;
  return { onGround: r.onGround, sink: b.sink, cover: b.cover };
});
check('in the air the board comes up out of the snow', air.onGround || air.sink < 0.01, `sink ${(air.sink * 100).toFixed(1)} cm, ${air.onGround ? 'landed already' : 'airborne'}`);
await hold(60, 1.5);

// on foot in the same powder: stop, unstrap, stand
await hold(30, 0.01);
await page.evaluate(() => { const r = window.__sim.rider; r.vx = r.vy = 0; r.toggleBoard(); });
let foot = null;
for (let i = 0; i < 12; i++) { foot = await hold(20, null); if (foot.onFoot) break; }
foot = await hold(40, null);
const soles = await page.evaluate(() => {
  const s = window.__sim, g = s.riderView.gaitState;
  return g ? g.feet.map((f) => +(s.pack.groundHeight(f.x, f.y) - f.z).toFixed(3)) : null;
});
console.log('on foot', JSON.stringify(foot), 'soles below the surface (m)', JSON.stringify(soles));
await shot('powder_onfoot_side', 0.2, 2.2, 0.4, 0, 0.2);
check('on foot in powder the boots sit down by the boot sink, under snow', !!soles && soles.every((d) => Math.abs(d - foot.bootSink) < 0.01) && foot.cover > 0.9, `soles ${soles?.join(', ')} m vs boot sink ${foot.bootSink}, cover ${foot.cover}`);
await page.evaluate(() => { const r = window.__sim.rider; r.toggleBoard(); });
for (let i = 0; i < 12; i++) { const st = await hold(20, null); if (!st.onFoot) break; }

// the groomers with no new snow: nothing is set down
await day(false);
await hold(30, 0);
const G = {};
for (const v of [1.5, 12]) {
  G[v] = await hold(90, v);
  console.log(`groomer ${v} m/s`, JSON.stringify(G[v]));
}
await shot('groomer_1_5_side', 0.2, 2.2, 0.35, 0, 0.1);
await shot('groomer_1_5_close', -0.6, 1.1, 0.45, 0, 0);
check('under 6 in the board is drawn on the snow as before', [G[1.5], G[12]].every((s) => s.depth < 0.15 ? s.sink === 0 && s.pitchDeg === 0 && s.cover === 0 && s.hold === 0 : true), [G[1.5], G[12]].map((s) => `${(s.depth * 100).toFixed(1)} cm ${s.kind}: sink ${s.sink}`).join(', '));
check('the groomer is under 6 in', G[1.5].depth < 0.15, `${(G[1.5].depth * 100).toFixed(1)} cm`);
check('no console errors', errors.length === 0, errors.slice(0, 3).map((e) => e.slice(0, 200)).join(' | '));
await browser.close();
server.close();
console.log(fails.length ? `\n${fails.length} failed` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
