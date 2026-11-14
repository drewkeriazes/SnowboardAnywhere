// Snow conditions check (FEAT-053): drops the rider on a set of spots (Vail by default) at a given
// hour, weather and Snow conditions setting, steps the physics without rendering, and reports the
// snow kind and weights, the speed reached running the fall line for 12 s, the turn radius of a full
// carve at about 12 m/s, and whether a stopped rider gets going again. Checks that a groomer is
// faster than a north-facing powder face, that powder turns wider, that spring-morning ice holds
// less than the same groomer at 1 pm, and that chop rattles where powder does not. BUG-084: also
// reloads with ?time=7 on "Resort default" and checks the snow follows the URL hour like the sun does
// (spring-morning ice on Simba), and that "Resort default" alone still reads the 1 pm snow.
// node tools/snowcheck.mjs [pack] [--headed]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed') || process.env.SHOT_HEADED === '1';
const pack = args.filter((a) => !a.startsWith('--'))[0] ?? 'vail';
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
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };

/** Vail spots: run midpoints with the downhill heading (degrees), from the pack's features and mask */
const SPOTS = {
  vail: [
    { id: 'simba13', name: 'Simba groomer 1 pm', x: -3420, y: 2317, h: 321, hour: 13, day: 'mid', weather: null },
    { id: 'simbaDefault', name: 'Simba groomer on Resort default', x: -3420, y: 2317, h: 321, hour: 'pack', day: 'mid', weather: null },
    { id: 'simba7s', name: 'Simba groomer 7 am spring', x: -3420, y: 2317, h: 321, hour: 7, day: 'spring', weather: 'clear' },
    { id: 'simbaStorm', name: 'Simba groomer in a storm, powder day', x: -3420, y: 2317, h: 321, hour: 13, day: 'mid', weather: 'storm', newSnow: 'powder' },
    { id: 'prima13', name: 'Prima Browns Face (N, open) 1 pm', x: -734, y: 1728, h: 20, hour: 13, day: 'mid', weather: null },
    { id: 'wild9', name: 'Wildcard (NW) 9 am', x: -2453, y: 661, h: 315, hour: 9, day: 'mid', weather: null },
    { id: 'wild13', name: 'Wildcard (NW) 1 pm', x: -2453, y: 661, h: 315, hour: 13, day: 'mid', weather: null },
    { id: 'trees14', name: 'Steep and Deep trees 2 pm', x: 1827, y: -3506, h: 325, hour: 14, day: 'mid', weather: null },
    { id: 'chicken15', name: 'Chicken Yard (SE, open) 3 pm', x: -698, y: -612, h: 160, hour: 15, day: 'mid', weather: null },
    { id: 'chicken9', name: 'Chicken Yard (SE, open) 9 am', x: -698, y: -612, h: 160, hour: 9, day: 'mid', weather: null },
    { id: 'golden15', name: 'Tea Cup Glades (S, low, open) 3 pm', x: 235, y: -1831, h: 80, hour: 15, day: 'mid', weather: null },
    { id: 'goldenSpring', name: 'Tea Cup Glades 4:30 pm spring', x: 235, y: -1831, h: 80, hour: 16.5, day: 'spring', weather: 'clear' },
    { id: 'twoElk13', name: 'Two Elk Connector ridge 1 pm', x: 3676, y: -222, h: 114, hour: 13, day: 'mid', weather: null },
  ],
};
const spots = SPOTS[pack];
if (!spots) { console.error(`no spots for pack ${pack}`); process.exit(2); }

const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
/** load the game, with extra URL parameters (BUG-084: `&time=7`) */
const load = async (extra = '') => {
  await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&lowgfx${extra}${process.env.SHOT_QUERY ?? ''}`);
  await page.waitForFunction(() => window.__step, null, { timeout: 90000 });
  page.setDefaultTimeout(300000);
};
await load();

/** move the rider, set the day, wait for the 1 m tiles under it, and run the page's frame once so main.ts pushes the day into rider.snowWorld */
const place = async (sp) => {
  await page.evaluate(([sp]) => {
    const s = window.__sim;
    s.settings.timeOfDay = sp.hour; s.settings.snowDay = sp.day; s.settings.newSnow = sp.newSnow ?? 'none';
    s.applySettings('newSnow');
    s.setWeather(sp.weather);
    s.rider.reset(sp.x, sp.y, sp.h * Math.PI / 180);
    s.cam.snapTo(s.rider);
    // the tiles under the spot are only requested by the frame loop, which does not run between steps here
    s.pack.fine?.request(sp.x - 600, sp.y - 600, sp.x + 600, sp.y + 600); s.pack.mask?.request(sp.x - 600, sp.y - 600, sp.x + 600, sp.y + 600);
  }, [sp]);
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(([sp]) => { const p = window.__sim.pack; return p.fine && !Number.isNaN(p.fine.sample(sp.x, sp.y)) && p.mask && p.mask.has(sp.x, sp.y); }, [sp]);
    if (ready) break;
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => window.__step(2, 1 / 60));
};
/** step n frames of the physics with the input held; returns the state per 10 frames */
const ride = (n, input = {}) => page.evaluate(([n, input]) => {
  const r = window.__sim.rider, out = [];
  const inp = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, ...input };
  for (let i = 0; i < n; i++) {
    r.update(1 / 60, inp);
    if (i % 10 === 9) out.push({ speed: r.speed, x: r.x, y: r.y, z: r.z, heading: r.heading, travel: Math.atan2(r.vx, r.vy), kind: r.snow.kind, w: [r.snow.groomed, r.snow.powder, r.snow.chop, r.snow.ice, r.snow.slush, r.snow.rock].map((v) => +v.toFixed(2)), grip: r.snow.grip, turn: r.snow.turn, drag: r.snow.drag0 + r.snow.drag1 * 10, depth: r.snow.depth, chop: r.chop, sink: r.noseSink, skid: r.skid, R: r.turnRadius, slope: r.slopeDeg, crashed: r.crashed, onGround: r.onGround, hit: r.lastHit });
  }
  return out;
}, [n, input]);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const results = {};
for (const sp of spots) {
  await place(sp);
  const at = (await ride(10))[0]; // the snow at the spot itself (the runs below wander off it)
  // 1. run the fall line for 12 s from a standstill (steer toward the fall line gently)
  let run = [];
  for (let k = 0; k < 12; k++) {
    const st = await page.evaluate(() => { const r = window.__sim.rider, n = r.normal; return { fall: Math.atan2(n[0], n[1]), heading: r.heading }; });
    const steer = Math.max(-0.4, Math.min(0.4, wrap(st.fall - st.heading) * 1.5));
    run = run.concat(await ride(60, { steer }));
  }
  const top = Math.max(...run.map((s) => s.speed));
  const last = run[run.length - 1];
  const chopPeak = Math.max(...run.map((s) => s.chop));
  const kinds = [...new Set(run.map((s) => s.kind))];
  // 2. a full carve from about 12 m/s: set the speed along the heading and hold steer 1 for 1.5 s
  await page.evaluate(() => { const r = window.__sim.rider, v = 12; r.vx = Math.sin(r.heading) * v; r.vy = Math.cos(r.heading) * v; r.edge = 0; });
  const carve = await ride(90, { steer: 1 });
  const turned = Math.abs(wrap(carve[carve.length - 1].travel - carve[0].travel));
  const Rs = carve.slice(3).map((s) => s.R).filter((R) => Number.isFinite(R));
  const R = Rs.length ? Rs.reduce((a, b) => a + b, 0) / Rs.length : Infinity;
  const skidPeak = Math.max(...carve.map((s) => s.skid));
  // 3. stopped with the board down the fall line: does the rider get going again in 4 s?
  await page.evaluate(() => { const r = window.__sim.rider, n = r.normal; r.vx = r.vy = 0; r.edge = 0; r.heading = Math.atan2(n[0], n[1]); r.squareBoard?.(); });
  const go = await ride(240, { steer: 0 });
  const restart = go[go.length - 1].speed;
  results[sp.id] = { top, kind: at.kind, w: at.w, grip: at.grip, turn: at.turn, depth: at.depth, drag: at.drag, chopPeak, turned, R, skidPeak, restart, slope: go[go.length - 1].slope, sink: Math.max(...go.map((s) => s.sink)), kinds, crashed: run.some((s) => s.crashed > 0) };
  const r = results[sp.id];
  console.log(`${sp.name.padEnd(40)} ${r.kind.padEnd(8)} g${r.w[0]} p${r.w[1]} c${r.w[2]} i${r.w[3]} s${r.w[4]} r${r.w[5]}  slope ${r.slope.toFixed(0)}  top ${r.top.toFixed(1)} m/s  carve ${(r.turned * 180 / Math.PI).toFixed(0)} deg R ${Number.isFinite(r.R) ? r.R.toFixed(0) : 'inf'} m skid ${r.skidPeak.toFixed(2)}  chop ${r.chopPeak.toFixed(2)}  restart ${r.restart.toFixed(1)} m/s sink ${r.sink.toFixed(2)}${r.crashed ? '  CRASHED' : ''}${r.kinds.length > 1 ? '  kinds ' + r.kinds.join('/') : ''}`);
}
// BUG-084: ?time=7 with the setting on Resort default: the snow takes the URL's hour, as the sun does
let urlSnow = null;
if (pack === 'vail') {
  await load('&time=7');
  await place({ x: -3420, y: 2317, h: 321, hour: 'pack', day: 'spring', weather: 'clear' });
  const at = (await ride(10))[0];
  urlSnow = { kind: at.kind, grip: at.grip, hour: await page.evaluate(() => window.__sim.rider.snowWorld.hour) };
  console.log(`${'Simba ?time=7, Resort default, spring'.padEnd(40)} ${at.kind.padEnd(8)} g${at.w[0]} p${at.w[1]} c${at.w[2]} i${at.w[3]} s${at.w[4]} r${at.w[5]}  snow hour ${urlSnow.hour}`);
}
const R = results;
check('Simba groomer reads Groomed at 1 pm', R.simba13.kind === 'groomed');
check('Simba is Ice at 7 am in spring and holds less', R.simba7s.kind === 'ice' && R.simba7s.grip < R.simba13.grip - 0.15, `grip ${R.simba7s.grip.toFixed(2)} vs ${R.simba13.grip.toFixed(2)}`);
check('Resort default reads the same 1 pm snow as the 1 pm setting', R.simbaDefault.kind === R.simba13.kind && Math.abs(R.simbaDefault.grip - R.simba13.grip) < 1e-6, `${R.simbaDefault.kind} grip ${R.simbaDefault.grip.toFixed(2)} vs ${R.simba13.kind} ${R.simba13.grip.toFixed(2)}`);
if (urlSnow) check('?time=7 moves the snow too: Simba is Ice on a spring morning from the URL', urlSnow.hour === 7 && urlSnow.kind === 'ice', `snow hour ${urlSnow.hour}, ${urlSnow.kind} grip ${urlSnow.grip.toFixed(2)}`);
check('ice skids in a carve the groomer holds', R.simba7s.skidPeak > R.simba13.skidPeak + 0.1, `skid ${R.simba7s.skidPeak.toFixed(2)} vs ${R.simba13.skidPeak.toFixed(2)}`);
check('a storm on a powder day makes the groomer soft with more drag', R.simbaStorm.w[1] > 0.3 && R.simbaStorm.drag > R.simba13.drag * 1.2, `p ${R.simbaStorm.w[1]}, drag at 10 m/s ${R.simbaStorm.drag.toFixed(2)} vs ${R.simba13.drag.toFixed(2)}`);
check('the north face is Powder at 1 pm', R.prima13.kind === 'powder', R.prima13.kind);
check('powder turns wider than the groomer', R.prima13.R > R.simba13.R * 1.15, `R ${R.prima13.R.toFixed(0)} vs ${R.simba13.R.toFixed(0)}`);
check('powder does not rattle', R.prima13.chopPeak < 0.1 && R.wild9.chopPeak < 0.1, `chop ${R.prima13.chopPeak.toFixed(2)}, ${R.wild9.chopPeak.toFixed(2)}`);
check('the morning has clearly less chop than the afternoon', R.wild9.w[2] < R.wild13.w[2] - 0.15 && R.chicken9.w[2] < R.chicken15.w[2] - 0.2, `Wildcard c ${R.wild9.w[2]} -> ${R.wild13.w[2]}, Chicken Yard c ${R.chicken9.w[2]} -> ${R.chicken15.w[2]}`);
check('the open south face is Chop at 3 pm and rattles', (R.chicken15.kind === 'chop' || R.golden15.kind === 'chop') && Math.max(R.chicken15.chopPeak, R.golden15.chopPeak) > 0.3, `${R.chicken15.kind} ${R.chicken15.chopPeak.toFixed(2)}, ${R.golden15.kind} ${R.golden15.chopPeak.toFixed(2)}`);
check('the trees are deep powder and the slowest', R.trees14.kind === 'powder' && R.trees14.depth > 0.25, `depth ${(R.trees14.depth * 100).toFixed(0)} cm, top ${R.trees14.top.toFixed(1)}`);
check('a stopped rider gets going again in deep powder on this pitch', R.trees14.restart > 1 || R.trees14.slope < 8, `restart ${R.trees14.restart.toFixed(1)} m/s on ${R.trees14.slope.toFixed(0)} deg, nose sink ${R.trees14.sink.toFixed(2)}`);
check('spring afternoon low is Slush with more drag than the same spot mid-season', R.goldenSpring.kind === 'slush' && R.goldenSpring.drag > R.golden15.drag * 1.3, `${R.goldenSpring.kind}, drag at 10 m/s ${R.goldenSpring.drag.toFixed(2)} vs ${R.golden15.drag.toFixed(2)}`);
check('the high ridge is firmer than the north face', R.twoElk13.w[3] > 0.3, `ice ${R.twoElk13.w[3]} (${R.twoElk13.kind})`);
check('no crashes running the groomer or the open north face (the glades may hit a trunk)', !['simba13', 'simba7s', 'simbaStorm', 'prima13', 'wild9', 'wild13'].some((id) => R[id].crashed), Object.entries(R).filter(([, r]) => r.crashed).map(([id]) => id).join(', '));
const errs = errors.filter((e) => !e.includes('Failed to load resource')); // missing pack tiles are not this check's business
check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 300));
await browser.close();
server.close();
console.log(fails.length ? `\n${fails.length} failed` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
