// Carve lean check (FEAT-126): a gentle turn at low speed, then hard linked carves at speed. Prints
// the lean (deg), the hip height and the lowest point of each body part above the snow under the
// board, and saves shots at the deepest toeside and heelside lean (from behind and from the side).
// node tools/leancheck.mjs [pack] [outDir] [--headed] [--ski]   (run after `npx vite build`)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed') || process.env.SHOT_HEADED === '1';
const ski = args.includes('--ski');
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'synth';
const outDir = positional[1] ?? 'shots-lean';
const dist = DIST, packs = PACKS;
fs.mkdirSync(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [packs, u.slice('/packs/'.length)] : [dist, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 60000 });
page.setDefaultTimeout(240000);

if (ski) await page.evaluate(() => { const s = window.__sim; s.rider.discipline = 'ski'; s.riderView.setDiscipline('ski'); s.tracks.setDiscipline('ski'); });

/**
 * Step n frames; every `every` frames measure the lean and the lowest skinned vertex of each body
 * part in the riding frame (y = 0 is the snow plane under the board). Returns the worst values seen
 * and the frame of deepest lean on each side.
 */
const ride = (n, every = 0) => page.evaluate(({ n, every }) => {
  const s = window.__sim, rv = s.riderView, r = s.rider;
  const part = (name) => /Foot/.test(name) ? 'boots' : /Leg$/.test(name) ? 'shins/knees' : /UpLeg/.test(name) ? 'thighs' : name === 'Hips' ? 'seat' : /Hand|ForeArm/.test(name) ? 'hands' : /Arm/.test(name) ? 'upper arms' : 'torso/head';
  const inv = new rv.group.matrixWorld.constructor(), v = new rv.group.position.constructor();
  const out = { maxToe: 0, maxHeel: 0, mins: {}, hipsAtMax: null };
  for (let i = 0; i < n; i++) {
    window.__step(1, 1 / 60);
    if (!every || i % every || !r.onGround || r.crashed > 0) continue;
    const lean = rv.leanAngle * 180 / Math.PI;
    rv.group.updateMatrixWorld(true);
    inv.copy(rv.group.matrixWorld).invert();
    const mins = {};
    rv.rig.body.traverse((m) => {
      if (!m.isSkinnedMesh || !m.visible) return;
      const pos = m.geometry.attributes.position, si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
      for (let k = 0; k < pos.count; k += 2) {
        let best = 0, bw = -1;
        for (let j = 0; j < 4; j++) if (sw.getComponent(k, j) > bw) { bw = sw.getComponent(k, j); best = si.getComponent(k, j); }
        const p = part(m.skeleton.bones[best].name);
        m.getVertexPosition(k, v); v.applyMatrix4(m.matrixWorld).applyMatrix4(inv);
        if (!(p in mins) || v.y < mins[p]) mins[p] = v.y;
      }
    });
    for (const [p, y] of Object.entries(mins)) if (Math.abs(lean) > 30 && (!(p in out.mins) || y < out.mins[p])) out.mins[p] = +y.toFixed(3);
    const hips = rv.rig.bones.Hips.getWorldPosition(v).applyMatrix4(inv).y;
    const raised = +(rv.rig.bones.Hips.position.y - rv.pose.hipsY).toFixed(2); // the snow-clearance lift (m)
    if (lean > out.maxToe) { out.maxToe = lean; out.hipsAtMax = { side: 'toe', hips: +hips.toFixed(2), raised, speed: +r.speed.toFixed(1), latG: +r.lateralG.toFixed(2) }; }
    if (-lean > out.maxHeel) { out.maxHeel = -lean; out.hipsHeel = { side: 'heel', hips: +hips.toFixed(2), raised, speed: +r.speed.toFixed(1), latG: +r.lateralG.toFixed(2) }; }
  }
  out.maxToe = +out.maxToe.toFixed(1); out.maxHeel = +out.maxHeel.toFixed(1);
  return out;
}, { n, every });

/** camera `back` m behind the rider along travel, `side` m right, `up` m above, aimed at the hips */
async function shot(label, back, side, up) {
  const url = await page.evaluate(({ back, side, up }) => {
    const s = window.__sim, r = s.rider, c = s.cam;
    const prev = c.mode;
    const sp = Math.hypot(r.vx, r.vy);
    const yaw = sp > 0.5 ? Math.atan2(r.vx, r.vy) : r.heading;
    const fx = Math.sin(yaw), fz = -Math.cos(yaw), rgx = -fz, rgz = fx;
    const tx = r.x, ty = r.z + 0.5, tz = -r.y;
    const cx = r.x - fx * back + rgx * side, cz = -r.y - fz * back + rgz * side, cy = r.z + up;
    c.mode = 'free'; c.freePos.set(cx, cy, cz);
    const dx = tx - cx, dy = ty - cy, dz = tz - cz, l = Math.hypot(dx, dy, dz);
    c.yaw = Math.atan2(dx, -dz); c.pitch = Math.asin(dy / l);
    const u = window.__shot();
    c.mode = prev;
    return u;
  }, { back, side, up });
  fs.writeFileSync(path.join(outDir, `${label}.png`), Buffer.from(url.split(',')[1], 'base64'));
}
const leanNow = () => page.evaluate(() => +(window.__sim.riderView.leanAngle * 180 / Math.PI).toFixed(1));

await ride(30); await page.waitForTimeout(1500); await ride(30);
// gentle turn: a short tap at low speed
await page.keyboard.down('ArrowUp'); await ride(60); await page.keyboard.up('ArrowUp');
await page.keyboard.down('ArrowLeft'); await ride(8); await page.keyboard.up('ArrowLeft');
const gentle = await ride(40, 2);
console.log('gentle turn', JSON.stringify({ speed: +(await page.evaluate(() => window.__sim.rider.speed)).toFixed(1), maxToe: gentle.maxToe, maxHeel: gentle.maxHeel }));
// speed, then linked hard carves
await page.keyboard.down('ArrowUp');
for (let i = 0; i < 40; i++) { await ride(15); if (await page.evaluate(() => window.__sim.rider.speed) > 14) break; }
await page.keyboard.up('ArrowUp');
const worst = { maxToe: 0, maxHeel: 0, mins: {} };
const shotTaken = { toe: false, heel: false };
for (let t = 0; t < 6; t++) {
  const key = t % 2 ? 'ArrowRight' : 'ArrowLeft';
  await page.keyboard.down(key);
  for (let i = 0; i < 8; i++) {
    const o = await ride(6, 2);
    worst.maxToe = Math.max(worst.maxToe, o.maxToe); worst.maxHeel = Math.max(worst.maxHeel, o.maxHeel);
    for (const [p, y] of Object.entries(o.mins)) if (!(p in worst.mins) || y < worst.mins[p]) worst.mins[p] = y;
    if (o.hipsAtMax) worst.toeAt = worst.toeAt && worst.toeAt.lean >= o.maxToe ? worst.toeAt : { lean: o.maxToe, ...o.hipsAtMax };
    if (o.hipsHeel) worst.heelAt = worst.heelAt && worst.heelAt.lean >= o.maxHeel ? worst.heelAt : { lean: o.maxHeel, ...o.hipsHeel };
    const l = await leanNow();
    for (const [side, deep] of [['toe', l > 50], ['heel', l < -50]]) {
      if (deep && !shotTaken[side]) {
        shotTaken[side] = true;
        await shot(`${side}_behind`, 4, 0, 1.0);
        await shot(`${side}_side_a`, 0.5, -4, 0.8);
        await shot(`${side}_side_b`, 0.5, 4, 0.8);
        console.log(`shot ${side} at lean ${l}`);
      }
    }
  }
  await page.keyboard.up(key);
}
console.log('hard carves', JSON.stringify(worst));
console.log('console errors:', errors.length); for (const e of errors.slice(0, 10)) console.log('  ', e.slice(0, 300));
await browser.close();
server.close();
