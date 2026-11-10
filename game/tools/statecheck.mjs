// Game state check (FEAT-162): drives the session's states with real key presses on the headless build and
// checks each one takes the frame it should and hands back cleanly: riding, the replay viewer (K, Esc), pause
// (Esc), the rewind (hold Backspace, let go), the map (M, Esc, a drop-in, a tool's map.close()), and that the
// riding keys do nothing behind the map and the replay viewer. Pause, the main menu, Quit and the eye link are
// menucheck.mjs; Outrun is outruncheck.mjs.
// node tools/statecheck.mjs [pack] [--headed | --gpu | --cpu]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const pack = args.filter((a) => !a.startsWith('--'))[0] ?? 'synth';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.woff2': 'font/woff2' };
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

const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&lowgfx`);
await page.waitForFunction(() => window.__step && window.__sim, null, { timeout: 120000 });
page.setDefaultTimeout(240000);

const step = (n) => page.evaluate((n) => window.__step(n), n);
const press = async (code) => { await page.keyboard.press(code); await step(1); };
const st = () => page.evaluate(() => {
  const s = window.__sim, r = s.rider;
  return { state: s.state, x: r.x, y: r.y, z: r.z, speed: r.speed, map: s.map.fullOpen, pause: getComputedStyle(document.querySelector('#pause')).display !== 'none', lift: s.liftRide.riding };
});
const moved = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const f = (v) => v.toFixed(2);

check('starts riding', (await st()).state === 'riding', (await st()).state);
// ride a few seconds tucked so there is a recording to replay and rewind along
await page.keyboard.down('KeyW'); await step(300); await page.keyboard.up('KeyW');
const rode = await st();
check('the rider moves while riding', rode.speed > 1, `speed ${f(rode.speed)} m/s`);

// ---- the replay viewer: K opens it (in the frame the key went down), the sim holds still, Esc closes it
await press('KeyK');
const inReplay = await st();
check('K opens the replay viewer', inReplay.state === 'replay', inReplay.state);
await step(60);
const afterReplay = await st();
check('the sim is frozen in the replay viewer', moved(inReplay, afterReplay) < 1e-6, `moved ${f(moved(inReplay, afterReplay))} m`);
await page.keyboard.down('KeyR'); await step(60); await page.keyboard.up('KeyR');
check('restart does nothing in the replay viewer', moved(afterReplay, await st()) < 1e-6 && (await st()).state === 'replay');
await press('Escape');
const outReplay = await st();
check('Esc closes the replay viewer, not into pause', outReplay.state === 'riding' && !outReplay.pause, JSON.stringify({ state: outReplay.state, pause: outReplay.pause }));
await step(30);
check('riding again after the viewer', moved(outReplay, await st()) > 0.1, `moved ${f(moved(outReplay, await st()))} m`);

// ---- pause: Esc opens it over the still world, Esc again resumes
await press('Escape');
const paused = await st();
check('Esc pauses', paused.state === 'paused' && paused.pause, JSON.stringify({ state: paused.state, pause: paused.pause }));
await step(30);
check('nothing moves while paused', moved(paused, await st()) < 1e-6);
await press('Escape');
const resumed = await st();
check('Esc resumes', resumed.state === 'riding' && !resumed.pause, JSON.stringify({ state: resumed.state, pause: resumed.pause }));

// ---- the rewind: hold to scrub back along the recording, let go to carry on from there
await page.keyboard.down('KeyW'); await step(120); await page.keyboard.up('KeyW');
const beforeRewind = await st();
await page.keyboard.down('Backspace'); await step(1);
const rewinding = await st();
check('holding rewind enters the rewind', rewinding.state === 'rewind', rewinding.state);
await step(60);
await page.keyboard.up('Backspace'); await step(1);
const landed = await st();
check('letting go of rewind rides on from an earlier moment', landed.state === 'riding' && moved(beforeRewind, landed) > 1, `${landed.state}, ${f(moved(beforeRewind, landed))} m back`);

// ---- the map: M opens it, the rider holds, riding keys do nothing behind it, M and Esc close it
await press('KeyM');
const inMap = await st();
check('M opens the map', inMap.state === 'map' && inMap.map, JSON.stringify({ state: inMap.state, map: inMap.map }));
await step(30);
const heldMap = await st();
check('the rider holds still under the map', inMap.lift || moved(inMap, heldMap) < 1e-6, `moved ${f(moved(inMap, heldMap))} m`);
await page.keyboard.down('KeyR'); await step(60); await page.keyboard.up('KeyR');
await press('KeyK');
const keysMap = await st();
check('restart and replay do nothing behind the map', keysMap.state === 'map' && moved(heldMap, keysMap) < 1e-6, `${keysMap.state}, moved ${f(moved(heldMap, keysMap))} m`);
await press('KeyM');
check('M closes the map', (await st()).state === 'riding' && !(await st()).map);
await press('KeyM'); await press('Escape');
const escMap = await st();
check('Esc closes the map, not into pause', escMap.state === 'riding' && !escMap.map && !escMap.pause, JSON.stringify({ state: escMap.state, map: escMap.map, pause: escMap.pause }));

// a drop-in from the map puts the rider there and riding takes over; a tool closing the map does too
await press('KeyM');
const drop = await page.evaluate(() => { const s = window.__sim, x = s.rider.x + 40, y = s.rider.y - 40; s.map.onPick(x, y); return { x, y }; });
await step(1);
const dropped = await st();
check('a drop-in from the map rides from there', dropped.state === 'riding' && !dropped.map && moved(drop, dropped) < 2, `${dropped.state}, ${f(moved(drop, dropped))} m from the pick`);
await press('KeyM');
await page.evaluate(() => window.__sim.map.close()); await step(1);
check('a tool closing the map hands back to riding', (await st()).state === 'riding');

check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close(); server.close();
console.log(fails.length ? `${fails.length} check(s) failed` : 'all ok');
process.exit(fails.length ? 1 : 0);
