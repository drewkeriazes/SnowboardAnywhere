// CI stills, shader compile and scene budget check (FEAT-172). One page load on a pack (the synthetic
// mountain in CI), always at ?lowgfx, clear sky, noon:
//  1. compiles every material in the scene under a few weathers (renderer.compile) and fails on any
//     GLSL error or warning the console gets (a broken onBeforeCompile patch, the kind behind BUG-009);
//  2. for each fixed view, waits until no tile, terrain chunk or tree cell is pending, resets the rider
//     to the spawn and saves a still, with that frame's renderer.info (draw calls, triangles, geometries,
//     textures, programs); the JS heap after a gc() at the end.
// Writes <outDir>/<view>.png and <outDir>/stats.json. tools/ci/stills_report.py compares two of these
// (main and the PR) and posts the before / after comment. Exit code 1 on a shader message or page error.
// node tools/cishot.mjs [pack] [outDir] [--gpu | --cpu | --headed]   (run after `npx vite build`; SHOT_DIST serves another build)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'synth';
const outDir = positional[1] ?? 'shots-ci';
const SETTLE_MS = 120000; // per view: give up waiting for the streaming after this and say so in stats.json
fs.mkdirSync(outDir, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));

const t0 = Date.now();
const browser = await launchBrowser(args, ['--enable-precise-memory-info', '--js-flags=--expose-gc']);
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const SHADER = /WebGLProgram|WebGLShader|Shader Error|GLSL|VALIDATE_STATUS|Program Info Log|shader compil/i;
const shaderMsgs = [], consoleIssues = [], pageErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error' && m.type() !== 'warning') return;
  const t = `${m.type()}: ${m.text()}`;
  (SHADER.test(t) ? shaderMsgs : consoleIssues).push(t.slice(0, 2000));
});
page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&lowgfx&weather=clear&time=12${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 120000 });
page.setDefaultTimeout(600000);
const spawn = await page.evaluate(() => { const r = window.__sim.rider; return { x: r.x, y: r.y, heading: r.heading }; });

/**
 * Wait until nothing is streaming or building; false on timeout. Drawing is what is slow on a runner's
 * software renderer, so most of the wait streams without drawing, as the loading screen does
 * (session/warmUp.ts: terrain and trees updated directly, with big build budgets), and only a drawn frame
 * that leaves nothing pending ends it (the frame also runs the prefetch, which asks for the mask tiles).
 */
async function settle(ms = SETTLE_MS) {
  const tEnd = Date.now() + ms;
  const pending = () => page.evaluate(() => {
    const s = window.__sim, p = s.pack;
    const tiles = [p.fine, p.mid, p.far, p.mask, p.ao, p.dir, p.moguls].reduce((n, t) => n + (t?.inFlight ?? 0), 0);
    return tiles + (s.terrain.pending ?? 0) + (s.veg.pending ?? 0);
  });
  while (Date.now() < tEnd) {
    let quiet = 0;
    while (quiet < 3 && Date.now() < tEnd) {
      const left = await page.evaluate(() => {
        const s = window.__sim, p = s.pack, t = s.terrain, v = s.veg, c = s.cam.camera;
        const keep = [t.budgetMs, t.maxBuilds, v.budgetMs];
        t.budgetMs = 50; t.maxBuilds = 64; v.budgetMs = 50;
        c.updateMatrixWorld();
        const cp = c.position;
        t.update(cp.x, -cp.z, cp.y);
        // RideFrame.streaming: trees around the rider, or around the camera when it is off the rider
        // (the look-ahead point is the position itself: the rider stands at the spawn for every still)
        const free = s.cam.mode === 'free', fx = free ? cp.x : s.rider.x, fy = free ? -cp.z : s.rider.y;
        v.update(fx, fy, fx, fy, cp);
        [t.budgetMs, t.maxBuilds, v.budgetMs] = keep;
        const tiles = [p.fine, p.mid, p.far, p.mask, p.ao, p.dir, p.moguls].reduce((n, x) => n + (x?.inFlight ?? 0), 0);
        return tiles + (t.pending ?? 0) + (v.pending ?? 0);
      });
      quiet = left === 0 ? quiet + 1 : 0;
      await page.waitForTimeout(100);
    }
    await page.evaluate(() => window.__step(1, 1 / 60));
    if (await pending() === 0) return true;
  }
  return false;
}

// the cold start streams the whole spawn area: wait for it once, longer than a view's settle
const warm = await settle(3 * SETTLE_MS);

// 1. shader compile: every material in the scene, under cumulus, a storm (snowfall) and clear sky
const compile = await page.evaluate(() => {
  const s = window.__sim, out = [];
  for (const w of ['scattered', 'storm', 'clear']) {
    s.setWeather(w);
    window.__step(1, 1 / 60); // the frame itself compiles what it draws; compile() then covers what it did not
    const t = performance.now();
    if (s.scene) s.renderer.compile(s.scene, s.cam.camera); // builds before FEAT-172 have no __sim.scene
    out.push({ weather: w, ms: Math.round(performance.now() - t) });
  }
  return { passes: out, programs: s.renderer.info.programs?.length ?? 0 };
});

// 2. fixed views. `place` runs in the page after the rider is back at the spawn: it sets the camera.
const views = [
  { name: '01_spawn_chase', place: 'chase' },
  { name: '02_rider_side', place: 'side' },
  { name: '03_down_the_fall_line', place: 'down' },
  { name: '04_from_the_valley', place: 'valley' },
  { name: '05_from_the_summit', place: 'summit' },
];
async function place(kind) {
  await page.evaluate(({ kind, spawn }) => {
    const s = window.__sim, r = s.rider, c = s.cam;
    r.reset(spawn.x, spawn.y, spawn.heading);
    s.tracks?.clear?.(); s.bootprints?.clear?.(); // the settle frames' tracks would differ run to run
    const look = (cx, cy, cz, tx, ty, tz) => {
      c.mode = 'free'; c.freePos.set(cx, cy, cz);
      const dx = tx - cx, dy = ty - cy, dz = tz - cz, l = Math.hypot(dx, dy, dz);
      c.yaw = Math.atan2(dx, -dz); c.pitch = Math.asin(dy / l);
    };
    // three.js frame: x east, y up, z = -north
    const rx = r.x, rz = -r.y, ry = r.z;
    const fx = Math.sin(r.heading), fz = -Math.cos(r.heading);
    if (kind === 'chase') { c.mode = 'chase'; c.snapTo(r); }
    else if (kind === 'side') look(rx - fz * 3.2 + fx * 0.8, ry + 1.2, rz + fx * 3.2 + fz * 0.8, rx, ry + 0.9, rz);
    else if (kind === 'down') look(rx - fx * 12, ry + 6, rz - fz * 12, rx + fx * 60, ry - 25, rz + fz * 60);
    else if (kind === 'valley') { c.mode = 'free'; c.yaw = Math.PI; c.pitch = 0.12; c.freePos.set(300, s.pack.groundHeight(300, 2200) + 40, -2200); }
    else if (kind === 'summit') { c.mode = 'free'; c.yaw = 0; c.pitch = -0.35; c.freePos.set(0, s.pack.groundHeight(0, -1500) + 60, 1500); }
  }, { kind, spawn });
}
const stats = [];
for (const v of views) {
  const tv = Date.now();
  await place(v.place);
  await page.evaluate(() => window.__step(1, 1 / 60)); // a frame moves the camera to where place() put it
  const settled = await settle();
  await place(v.place); // the settle frames moved the rider; put it (and the camera) back
  const st = await page.evaluate(() => {
    const ri = window.__sim.renderer.info;
    ri.autoReset = false; ri.reset(); // count the whole frame (cloud and shadow passes too), not just its last render call
    const url = window.__shot();
    const out = { url, calls: ri.render.calls, triangles: ri.render.triangles, points: ri.render.points, lines: ri.render.lines, geometries: ri.memory.geometries, textures: ri.memory.textures, programs: ri.programs?.length ?? 0 };
    ri.autoReset = true;
    return out;
  });
  fs.writeFileSync(path.join(outDir, `${v.name}.png`), Buffer.from(st.url.split(',')[1], 'base64'));
  delete st.url;
  const secs = Math.round((Date.now() - tv) / 1000);
  stats.push({ name: v.name, settled, secs, ...st });
  console.log(v.name, settled ? '' : '(still streaming)', `${secs} s`, JSON.stringify(st));
}
const heapMB = await page.evaluate(() => { window.gc?.(); return +((performance.memory?.usedJSHeapSize ?? 0) / 1048576).toFixed(1); });
const gpu = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });

const result = { pack, gpu, seconds: Math.round((Date.now() - t0) / 1000), warmSettled: warm, compile, views: stats, heapMB, shaderMessages: shaderMsgs, pageErrors, consoleIssues: consoleIssues.slice(0, 30) };
fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify(result, null, 2));
console.log(`compile ${JSON.stringify(compile)}, heap ${heapMB} MB, ${result.seconds} s`);
console.log(`shader messages: ${shaderMsgs.length}, page errors: ${pageErrors.length}, other console issues: ${consoleIssues.length}`);
for (const m of [...shaderMsgs, ...pageErrors].slice(0, 10)) console.log('  ', m.slice(0, 600));
await browser.close();
server.close();
process.exit(shaderMsgs.length || pageErrors.length ? 1 : 0);
