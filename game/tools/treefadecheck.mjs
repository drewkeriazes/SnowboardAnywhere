// See-through trees (FEAT-155): finds a tall tree on a slope with a clear line up the fall line above
// it and rides the chase camera down toward it. Checks that the tree is still solid 30 m out (past the
// look-ahead), comparing the same frame with the fade on and off; that it turns see-through 12 m out
// (a good share of its pixels change); that the same tree 5 m to either side of the line stays solid
// (it hides nothing but open snow); that its crown fades when it hangs between the camera and the
// rider; that it stays faded
// a quarter second after turning 35 degrees away (the slow look-ahead); that it stays solid right in the board's path (about to be hit); that the fade eases out with the
// setting off and in first person; and the frame time with the fade on and off. Saves on/off shots.
// node tools/treefadecheck.mjs [pack] [outDir] [--headed | --gpu]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'vail';
const outDir = positional[1] ?? 'shots-treefade';
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 90000 });
page.setDefaultTimeout(300000);
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };

/** step frames and wait until the trees and the ground around the rider have streamed in */
async function settle() {
  for (let i = 0; i < 60; i++) {
    const ok = await page.evaluate(() => {
      const s = window.__sim, r = s.rider;
      s.pack.fine?.request(r.x - 400, r.y - 400, r.x + 400, r.y + 400); s.pack.mask?.request(r.x - 400, r.y - 400, r.x + 400, r.y + 400);
      window.__step(3, 1 / 60);
      return s.veg.pending === 0 && !Number.isNaN(s.pack.fine?.sample(r.x, r.y) ?? 0);
    });
    if (ok) return;
    await page.waitForTimeout(300);
  }
}

await settle();

// a tall conifer on a 10 to 30 degree slope, with no other trunk within 2 m of the 40 m line up the fall line above it
const spot = await page.evaluate(() => {
  const s = window.__sim, r = s.rider, gh = (x, y) => s.pack.groundHeight(x, y);
  const trees = [];
  for (const c of s.veg.cells.values()) {
    const d = c.data; if (!d) continue;
    for (let i = 0; i < d.length; i += 6) trees.push([d[i], d[i + 1], d[i + 2], d[i + 3], d[i + 4], d[i + 5]]);
  }
  // away from the base area (lift stations and buildings swing the chase camera), within the streamed trees
  const near = trees.filter((t) => { const d = Math.hypot(t[0] - r.x, t[1] - r.y); return d > 300 && d < 1400 && t[5] === 0 && t[3] >= 10; });
  near.sort((a, b) => Math.hypot(a[0] - r.x, a[1] - r.y) - Math.hypot(b[0] - r.x, b[1] - r.y));
  for (const t of near.slice(0, 4000)) {
    const e = 4, gx = (gh(t[0] + e, t[1]) - gh(t[0] - e, t[1])) / (2 * e), gy = (gh(t[0], t[1] + e) - gh(t[0], t[1] - e)) / (2 * e);
    const g = Math.hypot(gx, gy); if (!(g > Math.tan(10 * Math.PI / 180) && g < Math.tan(30 * Math.PI / 180))) continue;
    const ux = -gx / g, uy = -gy / g; // downhill
    const clear = trees.every((o) => {
      if (o === t) return true;
      const px = o[0] - t[0], py = o[1] - t[1], along = -(px * ux + py * uy), side = Math.abs(px * uy - py * ux);
      // the line above it, and the lines 5 m either side (the beside case), clear of trunks
      return !(along > -3 && along < 42 && (side < 2.5 || Math.abs(side - 5) < 2));
    });
    if (!clear) continue;
    // a second tree well off to the side of the line, level with the first: it should stay solid
    const sideTree = trees.find((o) => { const px = o[0] - t[0], py = o[1] - t[1], along = -(px * ux + py * uy), side = Math.abs(px * uy - py * ux); return o[3] >= 6 && side > 4 && side < 8 && along > 3 && along < 10; }) ?? null;
    return { tree: t, ux, uy, slopeDeg: Math.atan(g) * 180 / Math.PI, sideTree };
  }
  return null;
});
check('found a tall tree with a clear line above it', !!spot, spot ? `tree ${spot.tree[3].toFixed(1)} m at (${spot.tree[0].toFixed(0)}, ${spot.tree[1].toFixed(0)}), ${spot.slopeDeg.toFixed(0)} deg${spot.sideTree ? ', side tree found' : ''}` : '');
if (!spot) { await browser.close(); server.close(); process.exit(1); }

/** ride down toward the tree at `speed` for n frames, holding the line */
const ride = (n, speed, stopAt = -Infinity) => page.evaluate(([n, speed, sp, stopAt]) => {
  const s = window.__sim, r = s.rider, h = Math.atan2(sp.ux, sp.uy);
  for (let i = 0; i < n && (sp.tree[0] - r.x) * sp.ux + (sp.tree[1] - r.y) * sp.uy > stopAt; i++) { r.heading = h; r.vx = sp.ux * speed; r.vy = sp.uy * speed; r.edge = 0; window.__step(1, 1 / 60); }
  const px = sp.tree[0] - r.x, py = sp.tree[1] - r.y;
  return { dist: Math.hypot(px, py), along: px * sp.ux + py * sp.uy, side: px * sp.uy - py * sp.ux, speed: r.speed, crashed: r.crashed, onFoot: r.onFoot };
}, [n, speed, spot, stopAt]);
const place = (back) => page.evaluate(([back, sp]) => {
  const s = window.__sim, r = s.rider;
  r.reset(sp.tree[0] - sp.ux * back, sp.tree[1] - sp.uy * back, Math.atan2(sp.ux, sp.uy));
  s.cam.mode = 'chase'; s.settings.seeThroughTrees = true;
}, [back, spot]);

/** the same frame with the fade off and on; the share of a tree's screen box that changed, and the shots */
async function onOff(label, tree) {
  const res = await page.evaluate(async (tree) => {
    const s = window.__sim, u = s.treeFadeUniforms;
    // a frame with a near-zero step: nothing moves between the two, only the fade differs
    const still = () => { window.__step(1, 1e-6); return s.renderer.domElement.toDataURL('image/png'); };
    // off: the strength at 0 for one frame (the setting stays on, so the lane keeps its eased state)
    s.settings.seeThroughTrees = true; u.uFadeK.value = 0; const off = still();
    u.uFadeK.value = 1; const on = still();
    const box = (t) => {
      const cam = s.cam.camera, P = cam.position.constructor;
      const pts = [];
      const w = Math.max(t[3] * 0.9, t[4] * 3.2) * 0.22;
      const rt = new P().setFromMatrixColumn(cam.matrixWorld, 0); rt.y = 0; rt.normalize();
      for (const fy of [0.05, 0.5, 0.95]) for (const dx of [-w, w]) {
        const v = new P(t[0] + rt.x * dx, t[2] - 0.3 + t[3] * fy, -t[1] + rt.z * dx).project(cam);
        if (v.z < 1) pts.push(v);
      }
      if (pts.length < 2) return null;
      const W = s.renderer.domElement.width, H = s.renderer.domElement.height;
      const xs = pts.map((p) => (p.x + 1) / 2 * W), ys = pts.map((p) => (1 - p.y) / 2 * H);
      const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(W, Math.ceil(Math.max(...xs)));
      const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H, Math.ceil(Math.max(...ys)));
      return x1 - x0 >= 3 && y1 - y0 >= 3 ? [x0, y0, x1 - x0, y1 - y0] : null;
    };
    const load = (url) => new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.src = url; });
    const [a, b] = await Promise.all([load(off), load(on)]);
    const cv = document.createElement('canvas'); cv.width = a.width; cv.height = a.height; const g = cv.getContext('2d', { willReadFrequently: true });
    const changed = (bx) => {
      if (!bx) return null;
      g.drawImage(a, 0, 0); const A = g.getImageData(...bx).data;
      g.drawImage(b, 0, 0); const B = g.getImageData(...bx).data;
      let n = 0; for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 24) n++;
      return n / (A.length / 4);
    };
    const tb = box(tree.main), sb = tree.side ? box(tree.side) : null;
    return { off, on, main: changed(tb), side: changed(sb), mainBox: tb, sideBox: sb };
  }, tree);
  fs.writeFileSync(path.join(outDir, `${label}_off.png`), Buffer.from(res.off.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(outDir, `${label}_on.png`), Buffer.from(res.on.split(',')[1], 'base64'));
  return res;
}

const onScreen = () => page.evaluate((t) => {
  const s = window.__sim, c = s.cam.camera, V = c.position.constructor;
  const v = new V(t[0], t[2] + t[3] * 0.5, -t[1]).project(c);
  return v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
}, spot.tree);

// 0. 30 m out at 8 m/s (look-ahead 18 m) the tree is not faded yet
await place(38); await settle();
let st = await ride(60, 8, 30);
const far = await onOff('far', { main: spot.tree, side: null });
check('30 m out, past the look-ahead, the tree is still solid', far.main !== null && far.main < 0.02, `${((far.main ?? 0) * 100).toFixed(1)}% of its box changed, ${st.along.toFixed(0)} m ahead`);

// 1. riding down toward the tree, 12 m short of it: the tree ahead fades, one beside the line does not
st = await ride(600, 8, 12);
const ahead = await onOff('ahead', { main: spot.tree, side: spot.sideTree });
console.log('ahead', JSON.stringify({ ...st, main: ahead.main, side: ahead.side, box: ahead.mainBox }));
check('the tree ahead on the line turns see-through', ahead.main !== null && ahead.main > 0.08, `${((ahead.main ?? 0) * 100).toFixed(0)}% of its box changed, ${st.dist.toFixed(0)} m ahead`);
if (spot.sideTree) check('a tree 4 to 8 m beside the line just ahead (open snow behind it) stays solid', ahead.side === null || ahead.side < 0.02, ahead.side === null ? 'off screen' : `${(ahead.side * 100).toFixed(1)}% changed`);

// 1b. a quarter second after turning 35 degrees away, the tree on the old line is still faded (if still on screen)
const swing = await page.evaluate((sp) => {
  const s = window.__sim, r = s.rider, a = Math.atan2(sp.ux, sp.uy) + 35 * Math.PI / 180;
  for (let i = 0; i < 15; i++) { r.heading = a; r.vx = Math.sin(a) * 8; r.vy = Math.cos(a) * 8; window.__step(1, 1 / 60); }
}, spot);
const swingSeen = await onScreen();
const turned = swingSeen ? await onOff('after_turn', { main: spot.tree, side: null }) : null;
check('just after a turn away, the tree on the old line stays faded', !swingSeen || (turned.main !== null && turned.main > 0.08), swingSeen ? `${((turned.main ?? 0) * 100).toFixed(0)}% of its box changed` : 'went off screen (inconclusive)');

// 1c. the same tree 5 m beside the line (open snow behind it, as on a groomer): it stays solid as you come up on it.
// The chase camera's pull-in is off here, so a wall beside the offset line does not swing the view across the tree.
const keepCollider = await page.evaluate(() => { const c = window.__sim.cam; window.__camCollider = c.collider; c.collider = null; return true; });
for (const sideM of [5, -5]) {
  await page.evaluate(([sp, sideM]) => {
    const s = window.__sim, r = s.rider;
    r.reset(sp.tree[0] - sp.ux * 30 + sp.uy * sideM, sp.tree[1] - sp.uy * 30 - sp.ux * sideM, Math.atan2(sp.ux, sp.uy));
  }, [spot, sideM]);
  await settle();
  const b = await ride(600, 8, 8);
  const beside = await onOff(`beside_${sideM > 0 ? 'right' : 'left'}`, { main: spot.tree, side: null });
  // only a plain chase view counts (a wall beside the offset line can push the camera off to one side)
  const riderX = await page.evaluate(() => { const s = window.__sim, r = s.rider, c = s.cam.camera; return new c.position.constructor(r.x, r.z + 1, -r.y).project(c).x; });
  const plain = Math.abs(riderX) < 0.25;
  check(`a tree 5 m ${sideM > 0 ? 'left' : 'right'} of the line, 8 m ahead, stays solid`, !plain || (beside.main !== null && beside.main < 0.02), plain ? `${((beside.main ?? 0) * 100).toFixed(1)}% of its box changed, ${b.along.toFixed(0)} m ahead` : `camera pushed aside (rider at ${riderX.toFixed(2)} across the view), inconclusive`);
}

// 1d. a crown hanging between the camera and the rider (the trunk 2 m beside the line, just passed): it fades
{
  await page.evaluate((sp) => { const r = window.__sim.rider; r.reset(sp.tree[0] - sp.ux * 30 + sp.uy * 2, sp.tree[1] - sp.uy * 30 - sp.ux * 2, Math.atan2(sp.ux, sp.uy)); }, spot);
  await settle();
  const b = await ride(600, 8, -2.5);
  const over = await onOff('crown_over_rider', { main: spot.tree, side: null });
  check('a crown between the camera and the rider fades', over.main !== null && over.main > 0.08, `${((over.main ?? 0) * 100).toFixed(0)}% of its box changed, trunk ${(-b.along).toFixed(1)} m behind the rider`);
}
if (keepCollider) await page.evaluate(() => { window.__sim.cam.collider = window.__camCollider; });

// 2. right in the board's path (inside the next half second at 8 m/s): it stays solid
await place(32); await settle();
st = await ride(600, 8, 3.5);
const hit = await onOff('about_to_hit', { main: spot.tree, side: null });
console.log('about to hit', JSON.stringify({ ...st, main: hit.main }));
check('the tree you are about to hit stays solid', hit.main !== null && hit.main < 0.03, `${((hit.main ?? 0) * 100).toFixed(1)}% of its box changed, ${st.dist.toFixed(1)} m ahead`);

// 3. the setting off and first person ease the fade out; back on, it eases back in
const ease = await page.evaluate(() => {
  const s = window.__sim, u = s.treeFadeUniforms, out = {};
  s.settings.seeThroughTrees = true; window.__step(60, 1 / 60); out.on = u.uFadeK.value;
  s.settings.seeThroughTrees = false; window.__step(4, 1 / 60); out.offSoon = u.uFadeK.value; window.__step(60, 1 / 60); out.off = u.uFadeK.value;
  s.settings.seeThroughTrees = true; window.__step(60, 1 / 60); out.back = u.uFadeK.value;
  s.cam.mode = 'fp'; window.__step(60, 1 / 60); out.fp = u.uFadeK.value;
  s.cam.mode = 'chase'; window.__step(60, 1 / 60);
  return out;
});
console.log('ease', JSON.stringify(ease));
check('the fade is on in the chase camera', ease.on > 0.95 && ease.back > 0.95, `${ease.on.toFixed(2)}, back on ${ease.back.toFixed(2)}`);
check('the setting turns it off (easing out, not snapping)', ease.off === 0 && ease.offSoon > 0.4 && ease.offSoon < 0.99, `after 4 frames ${ease.offSoon.toFixed(2)}, after 1 s ${ease.off}`);
check('off in first person', ease.fp === 0, `${ease.fp}`);

// 4. frame time with the fade on and off (the same spot, rendered frames)
await place(32); await settle(); await ride(60, 6);
const perf = await page.evaluate(() => {
  const s = window.__sim, time = (on) => { s.settings.seeThroughTrees = on; s.treeFadeUniforms.uFadeK.value = on ? 1 : 0; for (let i = 0; i < 10; i++) window.__shot(); const t0 = performance.now(); for (let i = 0; i < 60; i++) window.__shot(); return (performance.now() - t0) / 60; };
  const r = [time(false), time(true), time(false), time(true)];
  return { off: (r[0] + r[2]) / 2, on: (r[1] + r[3]) / 2 };
});
console.log(`frame (render + readback) ${perf.off.toFixed(1)} ms off, ${perf.on.toFixed(1)} ms on`);
check('no console errors', errors.length === 0, errors.slice(0, 3).map((e) => e.slice(0, 200)).join(' | '));
await browser.close();
server.close();
console.log(fails.length ? `\n${fails.length} failed` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
