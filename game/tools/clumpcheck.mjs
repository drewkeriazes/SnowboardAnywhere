// Far forest clump impostors (FEAT-292, world/trees/clumps.ts): loads a pack on the Low preset and checks that
//   - a pack with cover levels gets its clumps: the stand atlases bake, every block in reach is placed, clumps draw
//     (a pack without cover levels has none, and the check says so and passes: nothing can place them)
//   - the clump material compiles with no shader message, in both depth paths (EXT_conservative_depth and plain
//     gl_FragDepth), and the clumps change pixels on screen
//   - the handover has no hole and no double forest: the tree impostors dissolve out where the clumps dissolve in, no
//     tree cell is loaded past it, and the terrain's canopy lift starts where the clumps end
//   - the stands are built from the pack's own species (meta.vegetation) and the shares add up
//   - a change to High (Settings > Graphics > Apply) moves the band at once: every clump it needs is already placed
// node tools/clumpcheck.mjs [pack] [--headed | --gpu | --cpu]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
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
const browser = await launchBrowser(args);
const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
const SHADER = /WebGLProgram|WebGLShader|Shader Error|GLSL|VALIDATE_STATUS|Program Info Log|shader compil/i;
const shaderMsgs = [], errors = [];
page.on('console', (m) => {
  if (m.type() !== 'error' && m.type() !== 'warning') return;
  if (SHADER.test(m.text())) shaderMsgs.push(m.text().slice(0, 1500));
  else if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 300));
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// ?lowgfx: the Low preset, where the drawn trees end at 600 m and the clumps carry the rest
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&lowgfx&weather=clear&time=12${(process.env.SHOT_QUERY ?? '').replace('&lowgfx', '')}`);
await page.waitForFunction(() => window.__step, null, { timeout: 120000 });
page.setDefaultTimeout(600000);
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };

/** stream without drawing (as the loading screen does) until nothing is pending, then draw `frames` frames */
async function settle(frames = 1) {
  for (let i = 0; i < 400; i++) {
    const left = await page.evaluate(() => {
      const s = window.__sim, p = s.pack, t = s.terrain, v = s.veg, c = s.cam.camera;
      c.updateMatrixWorld();
      const cp = c.position;
      t.update(cp.x, -cp.z, cp.y);
      v.update(s.rider.x, s.rider.y, s.rider.x, s.rider.y, cp);
      return [p.fine, p.mid, p.far, p.mask].reduce((n, x) => n + (x?.inFlight ?? 0), 0) + (t.pending ?? 0) + v.pending;
    });
    if (left === 0) break;
    await page.waitForTimeout(50);
  }
  await page.evaluate((n) => window.__step(n, 1 / 60), frames);
}
await settle(2);

const info = await page.evaluate(() => {
  const s = window.__sim, c = s.veg.clumps;
  return { cover: !!s.pack.cover, levels: s.pack.meta.cover?.levels.map((l) => l.name) ?? [], clumps: !!c, vegetation: s.pack.meta.vegetation ?? null };
});
if (!info.cover) {
  check('a pack without cover levels has no clumps', !info.clumps, 'nothing to place them from; the far forest is the ground\'s timber tone');
  console.log(`${pack} has no cover levels: the rest of the check needs a pack with them`);
} else {
  const st = await page.evaluate(() => {
    const s = window.__sim, c = s.veg.clumps, m = c.mesh.material, u = s.terrain.material.userData.uniforms;
    const inst = s.pack.meta.instances, cam = s.cam.camera.position;
    let farCell = 0;
    for (const cell of s.veg.cells.values()) {
      const cx = inst.minX + (cell.cx + 0.5) * inst.cellSize, cy = inst.minY + (cell.cy + 0.5) * inst.cellSize;
      farCell = Math.max(farCell, Math.min(Math.hypot(cx - s.rider.x, cy - s.rider.y)) - inst.cellSize * 0.71);
    }
    return {
      ready: c.ready, busy: c.busy, stats: { ...c.stats }, visible: c.mesh.visible, count: c.mesh.geometry.instanceCount, conservative: c.conservative,
      defines: Object.keys(m.defines ?? {}), band: c.band.value.toArray(), imp: s.veg.kit.bands.imp.value.toArray(),
      uClump: u.uClump.value.toArray(), lift: u.uLiftNear.value, farCell, mix: c.mix, cam: [cam.x, cam.y, cam.z],
    };
  });
  check('the stand atlases are baked and every block placed', st.ready && st.busy === 0, `${st.stats.trees} trees in the patches, ${st.stats.blocks} blocks, bake ${st.stats.bakeMs} ms in ${st.stats.bakeSteps} steps`);
  check('clumps draw', st.visible && st.count > 0 && st.count === st.stats.clumps, `${st.count} clumps, ${(st.stats.bytes / 2 ** 20).toFixed(1)} MB`);
  check('the stands use the pack\'s species', st.mix.length > 0 && Math.abs(st.mix.reduce((n, m) => n + m[1], 0) - 1) < 1e-6 && st.mix.every((m) => m[0] !== 2),
    `${st.mix.map((m) => `species ${m[0]} ${(m[1] * 100).toFixed(0)}%`).join(', ')}${info.vegetation ? '' : ' (no meta.vegetation: the region\'s mix)'}`);
  // the handover: the impostors' out band is the clumps' in band, the terrain steps its timber back there and lifts past them
  const [in0, in1, out0, out1] = st.band;
  check('the tree impostors dissolve out where the clumps dissolve in', Math.abs(st.imp[2] - in0) < 0.5 && Math.abs(st.imp[3] - in1) < 0.5, `clumps in ${in0.toFixed(0)}..${in1.toFixed(0)} m, impostors out ${st.imp[2].toFixed(0)}..${st.imp[3].toFixed(0)} m`);
  check('no tree cell is loaded past the handover', st.farCell <= in1 + 101, `farthest cell ${st.farCell.toFixed(0)} m, handover ends ${in1.toFixed(0)} m`);
  check('the terrain hands its canopy to the clumps', st.uClump[3] === 1 && Math.abs(st.uClump[0] - (in0 + in1) / 2) < 0.5 && Math.abs(st.lift - out1) < 0.5, `uClump ${st.uClump.map((v) => +v.toFixed(2)).join(', ')}, canopy lift from ${st.lift.toFixed(0)} m, clumps end ${out1.toFixed(0)} m`);

  // on screen: the same frame with the clumps hidden differs
  const px = await page.evaluate(() => {
    const s = window.__sim, c = s.veg.clumps, gl = s.renderer.getContext();
    const grab = () => { const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, b = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
    // look along the fall line from 300 m up so forest past the trees is in view on any pack
    const r = s.rider;
    s.eyeAt(r.x, r.y, (r.heading * 180) / Math.PI, -12, 60, 300);
    window.__step(1, 1 / 60);
    s.renderer.render(s.scene, s.cam.camera);
    const a = grab();
    c.mesh.visible = false;
    s.renderer.render(s.scene, s.cam.camera);
    const b = grab();
    c.mesh.visible = true;
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
    return { changed: n, total: a.length / 4, count: c.mesh.geometry.instanceCount };
  });
  await settle(1);
  const px2 = px.changed > 0 ? px : await page.evaluate(() => ({ changed: 0, total: 1, count: window.__sim.veg.clumps.mesh.geometry.instanceCount }));
  check('the clumps change the picture', px2.changed > 50, `${px2.changed} of ${px2.total} pixels differ with them hidden`);

  // the other depth path compiles too (the extension's define flipped; without the extension only the plain path exists)
  const other = await page.evaluate(() => {
    const s = window.__sim, m = s.veg.clumps.mesh.material;
    const had = 'CONSERVATIVE' in m.defines;
    if (!s.veg.clumps.conservative) return { had, flipped: false };
    if (had) delete m.defines.CONSERVATIVE; else m.defines.CONSERVATIVE = '';
    m.needsUpdate = true;
    window.__step(1, 1 / 60);
    if (had) m.defines.CONSERVATIVE = ''; else delete m.defines.CONSERVATIVE;
    m.needsUpdate = true;
    window.__step(1, 1 / 60);
    return { had, flipped: true };
  });
  check('the clump material compiles', shaderMsgs.length === 0, `${st.conservative ? 'conservative depth' : 'plain gl_FragDepth (no EXT_conservative_depth here)'}${other.flipped ? ' and the other path' : ''}${shaderMsgs.length ? `: ${shaderMsgs[0]}` : ''}`);

  // Settings > Graphics > Apply to High: the band moves out with the trees, and nothing is left to place
  const hi = await page.evaluate(() => {
    const s = window.__sim, c = s.veg.clumps, before = { near: c.band.value.y, packs: c.stats.packs, blocks: c.stats.blocks };
    Object.assign(s.settings, { quality: 'high', treeDensity: 1, forestDensity: 1 });
    s.applySettings('quality');
    const cp = s.cam.camera.position;
    s.veg.update(s.rider.x, s.rider.y, s.rider.x, s.rider.y, cp);
    return { before, near: c.band.value.y, busy: c.busy, packs: c.stats.packs, blocks: c.stats.blocks, imp: s.veg.kit.bands.imp.value.toArray(), band: c.band.value.toArray() };
  });
  check('a change to High moves the handover out', hi.near > hi.before.near + 500 && Math.abs(hi.imp[3] - hi.band[1]) < 0.5, `handover ends ${hi.before.near.toFixed(0)} m on Low, ${hi.near.toFixed(0)} m on High`);
  check('and finds every clump placed', hi.busy === 0 && hi.blocks === hi.before.blocks && hi.packs === hi.before.packs + 1, `${hi.busy} blocks to place, one repack`);
}
check('no page errors', errors.length === 0, errors[0] ?? '');
await browser.close();
server.close();
if (fails.length) { console.log(`\nFAILED: ${fails.join('; ')}`); process.exit(1); }
console.log('\nclumpcheck passed');
