// Board set down into loose snow (FEAT-152): on a powder day (40 cm of it at the synth spawn) holds the
// rider at a set of speeds and checks the board sits tail low and nose up in it: the tail about 0.8 of
// the depth down when slow, coming up as it planes (a few cm at high speed), the nose floating near the
// surface while riding and dug in when slow; the snow cover and the sag held ahead of the board; a held
// tail and nose press (the held sag moves to the end that is down); on foot (the boots sit down by the
// whole boot sink); then a day with no new snow (shallow powder sets down less), and in node that the
// groomer, ice and rock depths set nothing down. Saves chase, low side and close front shots at each
// speed, press shots, a shallow-powder pair and an on-foot shot.
// node tools/powdercheck.mjs [pack] [outDir] [--headed | --gpu]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { DIST, GAME, PACKS } from './paths.mjs';

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
  return { speed: +r.speed.toFixed(1), onGround: r.onGround, kind: r.snow.kind, depth: +r.snow.depth.toFixed(3), noseSink: +r.noseSink.toFixed(2), sink: +b.sink.toFixed(3), tail: +(b.sink + 0.72 * Math.sin(b.pitch)).toFixed(3), nose: +(b.sink - 0.72 * Math.sin(b.pitch)).toFixed(3), pitchDeg: +(b.pitch * 180 / Math.PI).toFixed(1), cover: +b.cover.toFixed(2), hold: +h.k.toFixed(2), bootSink: +r.sink.toFixed(3), onFoot: r.onFoot, crashed: +r.crashed.toFixed(2) };
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

// settle at the spawn, then a powder day: deep loose snow under the board
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
check('the snow is deep on the powder day', slow.depth >= 0.3, `${(slow.depth * 100).toFixed(0)} cm, ${slow.kind}`);
const cm = (v) => (v * 100).toFixed(1);
check('slow in powder the tail sits about 0.8 of the depth down', slow.tail >= 0.7 * slow.depth && slow.tail <= 0.91 * slow.depth, `${cm(slow.tail)} cm of ${cm(slow.depth)}`);
check('the tail comes up with speed', mid.tail < slow.tail + 0.005 && plane.tail < mid.tail && fast.tail < plane.tail, [slow, mid, plane, fast].map((s) => cm(s.tail)).join(' > ') + ' cm');
check('about half the slow tail depth by PLANE_SPEED', plane.tail >= 0.35 * plane.depth && plane.tail <= 0.55 * plane.depth, `${cm(plane.tail)} cm of ${cm(plane.depth)}`);
check('a few cm at high speed', fast.tail > 0.01 && fast.tail <= 0.045, `${cm(fast.tail)} cm`);
check('riding, the nose floats near the surface while the tail sinks', [mid, plane].every((s) => s.nose <= 0.3 * s.tail && s.nose < 0.1), [mid, plane].map((s) => `${s.speed} m/s: nose ${cm(s.nose)} tail ${cm(s.tail)} cm`).join(', '));
check('nose up, tail low while riding', mid.pitchDeg >= 5 && mid.pitchDeg <= 12 && plane.pitchDeg >= 4, `${mid.pitchDeg} deg at 5 m/s, ${plane.pitchDeg} at 12`);
check('slow, the nose dig takes the nose down', slow.nose > 0.5 * slow.tail, `nose ${cm(slow.nose)} tail ${cm(slow.tail)} cm at ${slow.speed} m/s (dig ${slow.noseSink})`);
check('neither end goes deeper than 0.9 of the loose snow', [slow, mid, plane, fast].every((s) => Math.max(s.tail, s.nose) <= 0.91 * s.depth), '');
check('snow covers the buried gear and the sag is held ahead of it', slow.cover === 1 && slow.hold === 1, `cover ${slow.cover}, hold ${slow.hold}`);
// presses (balance Off, so they hold): the sag held ahead of the board moves to the end that is down
await page.evaluate(() => { const s = window.__sim; s.settings.pressBalance = 'off'; s.rider.pressMode = 'off'; });
const pressAt = async (key, speed, label) => {
  await page.keyboard.down(key);
  const st = await hold(60, speed);
  const shift = await page.evaluate(() => { const r = window.__sim.rider, h = window.__sim.riderView.powderHold; return +((h.x - r.x) * h.fx + (h.z + r.y) * h.fz).toFixed(2); });
  const lean = await page.evaluate(() => +window.__sim.rider.lean.toFixed(2));
  await shot(`${label}_chase`, 3.2, 0.8, 1.4, 0);
  await shot(`${label}_side`, 0.2, 2.2, 0.35, 0, 0.1);
  await page.keyboard.up(key);
  await hold(30, speed);
  console.log(label, JSON.stringify({ ...st, lean, shift }));
  return { ...st, lean, shift };
};
const tailP = await pressAt('z', 10, 'powder_tailpress_10'), noseP = await pressAt('q', 2, 'powder_nosepress_2');
check('a held tail press leans back and moves the held sag back over the tail', tailP.lean < -0.9 && tailP.shift < -0.3, `lean ${tailP.lean}, shift ${tailP.shift} m`);
check('a held nose press leans forward, digs the nose in and moves the held sag forward', noseP.lean > 0.9 && noseP.shift > 0.3 && noseP.noseSink > slow.noseSink, `lean ${noseP.lean}, shift ${noseP.shift} m, nose dig ${noseP.noseSink} vs ${slow.noseSink} flat at 1.5 m/s`);
await page.evaluate(() => { const s = window.__sim; s.settings.pressBalance = 'on'; s.rider.pressMode = 'on'; });

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
foot = await hold(120, null); // (let the settle step finish)
const soles = await page.evaluate(() => {
  const s = window.__sim, g = s.riderView.gaitState;
  return g ? g.feet.map((f) => [+(s.pack.groundHeight(f.x, f.y) - f.z).toFixed(3), f.planted, +g.speed.toFixed(2)]) : null;
});
console.log('on foot', JSON.stringify(foot), 'soles below the surface (m)', JSON.stringify(soles));
await shot('powder_onfoot_side', 0.2, 2.2, 0.4, 0, 0.2);
check('on foot in powder the boots sit down by the boot sink, under snow', !!soles && soles.every(([d]) => Math.abs(d - foot.bootSink) < 0.01) && foot.cover > 0.9, `soles ${soles?.map(([d]) => d).join(', ')} m vs boot sink ${foot.bootSink}, cover ${foot.cover}`);
await page.evaluate(() => { const r = window.__sim.rider; r.toggleBoard(); });
for (let i = 0; i < 12; i++) { const st = await hold(20, null); if (!st.onFoot) break; }

// a groomer day: no new snow, the powder at the spawn is shallow
await day(false);
await hold(30, 0);
const G = {};
for (const v of [1.5, 12]) {
  G[v] = await hold(90, v);
  console.log(`groomer ${v} m/s`, JSON.stringify(G[v]));
}
await shot('groomer_1_5_side', 0.2, 2.2, 0.35, 0, 0.1);
await shot('groomer_1_5_close', -0.6, 1.1, 0.45, 0, 0);
const sh = G[1.5];
check('in shallow powder (no new snow) the board sets down less', sh.depth < 0.15 && sh.tail > 0.3 * sh.depth && sh.tail < slow.tail && G[12].tail < sh.tail, `${cm(sh.depth)} cm ${sh.kind}: tail ${cm(sh.tail)} cm slow, ${cm(G[12].tail)} at 12 m/s (vs ${cm(slow.tail)} in ${cm(slow.depth)} cm)`);
// the groomers, ice and rock (2.5, 0.4 and 0.8 cm loose: SnowConditions K) are drawn exactly as before
const scOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'powdercheck-')), 'snowcover.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'world', 'SnowCover.ts')], bundle: true, format: 'esm', platform: 'node', outfile: scOut, logLevel: 'error' });
const { buryShape } = await import(pathToFileURL(scOut).href);
const firm = [0.025, 0.004, 0.008].flatMap((d) => [0, 1.5, 5, 12, 22].map((v) => buryShape(d, v, 1, 0.72, {})));
check('on a groomer, ice and rock nothing is set down', firm.every((b) => b.sink === 0 && b.pitch === 0 && b.tail === 0 && b.nose === 0), '');
check('no console errors', errors.length === 0, errors.slice(0, 3).map((e) => e.slice(0, 200)).join(' | '));
await browser.close();
server.close();
console.log(fails.length ? `\n${fails.length} failed` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
