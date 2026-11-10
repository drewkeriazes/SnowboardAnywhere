// Hard carve pose check (BUG-066): no rendering. Steps the physics and the rider view on a groomer
// (the physics pinned to groomed corduroy wherever the spawn is) and measures, in the board's own
// frame, how far the knees, shins and thighs stay above the deck over the board's footprint, plus
// the lean, the hip height along the body line and above the snow, and the inside hand's height. Toeside and heelside hard
// carves from 12 and 18 m/s down the fall line (the deepest lean and the worst clearance while the hard
// carve is in), a plain full carve (no squat) and a straight squat (it must still squat). The lower
// shin inside the boot (within 18 cm of the ankle) is not counted.
// node tools/hardposecheck.mjs [pack] [--headed] [--ski]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'synth';
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
const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 60000 });
page.setDefaultTimeout(240000);
await page.evaluate(() => { for (let i = 0; i < 30; i++) window.__step(1, 1 / 60); });
if (args.includes('--ski')) await page.evaluate(() => { const s = window.__sim; s.rider.discipline = 'ski'; s.riderView.setDiscipline('ski'); s.tracks.setDiscipline('ski'); });

/**
 * One scenario from the current spot: speed `v` along the heading, steer `steer` from the start,
 * the squat key from `pressAt` s (never if < 0), for `T` s. Measures the last `measure` s.
 */
const run = (o) => page.evaluate(({ v, steer, pressAt, T, measure }) => {
  const s = window.__sim, r = s.rider, rv = s.riderView;
  r.pack.mask = null; Object.assign(r.surface, { groomed: 1, rock: 0, scree: 0, canopy: 0 });
  // down the fall line, so the speed holds through the turn
  const gn = r.pack.groundNormal(r.x, r.y), down = Math.atan2(gn[0], gn[1]);
  r.reset(r.x, r.y, down); r.vx = Math.sin(down) * v; r.vy = Math.cos(down) * v;
  // on the snow, following it (reset drops the rider from 0.5 m, and the landing would eat the speed)
  r.z = r.pack.groundHeight(r.x, r.y); r.vz = -(r.vx * gn[0] + r.vy * gn[1]) / gn[2];
  const inp = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false, skate: false, lean: 0, balance: 0 };
  const M4 = rv.group.matrixWorld.constructor, V3 = rv.group.position.constructor;
  const invB = new M4(), invG = new M4(), w = new V3(), fl = new V3(), fr = new V3();
  const part = (name) => /Foot/.test(name) ? 'boots' : /Leg$/.test(name) ? 'shins' : /UpLeg/.test(name) ? 'thighs' : name === 'Hips' ? 'seat' : /Hand|ForeArm/.test(name) ? 'hands' : null;
  const out = { deck: {}, lean: 0, hips: Infinity, hipsSnow: Infinity, hand: Infinity, edge: 0, hard: 0, squat: 0, speed: 0 };
  const DT = 1 / 60, N = Math.round(T / DT), from = N - Math.round(measure / DT);
  let leanSum = 0, n = 0;
  for (let i = 0; i < N; i++) {
    const t = i * DT;
    inp.steer = steer; inp.squat = pressAt >= 0 && t >= pressAt;
    r.update(DT, inp);
    r.applyRenderPose(); rv.update(r, DT, false); r.restoreSimPose();
    if (i < from || r.crashed > 0 || (pressAt >= 0 && steer !== 0 && r.hardCarve < 0.5)) continue;
    rv.group.updateMatrixWorld(true);
    invB.copy(rv.rig.board.matrixWorld).invert(); invG.copy(rv.group.matrixWorld).invert();
    rv.rig.bones.LeftFoot.getWorldPosition(fl); rv.rig.bones.RightFoot.getWorldPosition(fr);
    rv.rig.body.traverse((m) => {
      if (!m.isSkinnedMesh || !m.visible) return;
      const pos = m.geometry.attributes.position, si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
      for (let k = 0; k < pos.count; k++) {
        let best = 0, bw = -1;
        for (let j = 0; j < 4; j++) if (sw.getComponent(k, j) > bw) { bw = sw.getComponent(k, j); best = si.getComponent(k, j); }
        const p = part(m.skeleton.bones[best].name);
        if (!p) continue;
        m.getVertexPosition(k, w); w.applyMatrix4(m.matrixWorld);
        if (p === 'hands') { const y = w.clone().applyMatrix4(invG).y; if (y < out.hand) out.hand = y; continue; }
        if (p === 'boots') continue;
        if (p === 'shins' && Math.min(w.distanceTo(fl), w.distanceTo(fr)) < 0.18) continue; // the lower shin sits in the boot
        w.applyMatrix4(invB); // board frame: deck top at y = 0.022, half width 0.13, nose -z
        if (Math.abs(w.x) > 0.15 || Math.abs(w.z) > 0.75) continue; // over the deck only
        const c = w.y - 0.022;
        if (!(p in out.deck) || c < out.deck[p]) out.deck[p] = c;
      }
    });
    // the hips' height along the body line (the pose's hipsY plus any clearance lift) and above the snow
    out.hips = Math.min(out.hips, rv.rig.bones.Hips.position.y);
    out.hipsSnow = Math.min(out.hipsSnow, rv.rig.bones.Hips.getWorldPosition(w).applyMatrix4(invG).y);
    const ln = rv.leadState.lean; if (Math.abs(ln) > Math.abs(leanSum)) leanSum = ln; n++;
    out.edge = Math.max(out.edge, Math.abs(r.edge)); out.hard = Math.max(out.hard, r.hardCarve); out.squat = Math.max(out.squat, r.squat); out.speed = r.speed;
  }
  for (const k of Object.keys(out.deck)) out.deck[k] = +out.deck[k].toFixed(3);
  return { ...out, lean: +(leanSum * 180 / Math.PI).toFixed(0), hips: +out.hips.toFixed(2), hipsSnow: +out.hipsSnow.toFixed(2), hand: +out.hand.toFixed(2), edge: +(out.edge * 180 / Math.PI).toFixed(0), speed: +out.speed.toFixed(1), crashed: r.crashed > 0 };
}, o);

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }
const fmt = (o) => `${o.speed} m/s at the end, lean ${o.lean} deg, edge ${o.edge} deg, hips ${o.hips} m along the body (${o.hipsSnow} m above the snow), inside hand ${o.hand} m, deck clearance ${JSON.stringify(o.deck)}${o.crashed ? ' CRASHED' : ''}`;
const CLEAR = 0.05; // about 5 cm of skin between the knees, shins and thighs and the deck (the issue's target)

const cases = [];
for (const v of [12, 18]) for (const [side, steer] of [['toeside', 1], ['heelside', -1]]) {
  const o = await run({ v, steer, pressAt: 0.25, T: 0.6, measure: 0.25 });
  console.log(`hard carve ${side} ${v} m/s: ${fmt(o)}`);
  cases.push({ v, side, o });
}
const plainToe = await run({ v: 12, steer: 1, pressAt: -1, T: 0.75, measure: 0.3 });
console.log(`plain full carve toeside 12 m/s: ${fmt(plainToe)}`);
const squat = await run({ v: 8, steer: 0, pressAt: 0, T: 1.2, measure: 0.3 });
console.log(`straight squat 8 m/s: ${fmt(squat)}`);

for (const { v, side, o } of cases) {
  const worst = Math.min(o.deck.shins ?? 1, o.deck.thighs ?? 1, o.deck.seat ?? 1);
  check(`${side} ${v} m/s: no knee, shin or thigh through the deck`, worst >= CLEAR, `${(worst * 100).toFixed(1)} cm clear`);
  check(`${side} ${v} m/s: laid over toward the snow (60 deg or more)`, Math.abs(o.lean) >= 60 && o.hard > 0.9, `${o.lean} deg`);
  check(`${side} ${v} m/s: a long line, not folded onto the board (hips at least 0.45 m up the body line)`, o.hips >= 0.45, `${o.hips} m`);
}
check('a straight squat still squats (hips well below a hard carve, no hard carve)', squat.hips < Math.min(...cases.map((c) => c.o.hips)) - 0.08 && squat.hard === 0, `${squat.hips} m vs ${Math.min(...cases.map((c) => c.o.hips))} m, hard ${squat.hard}`);
console.log('console errors:', errors.length); for (const e of errors.slice(0, 5)) console.log('  ', e.slice(0, 300));
if (errors.length) fails++;
await browser.close();
server.close();
console.log(fails ? `${fails} check(s) failed` : 'all hard carve pose checks passed');
process.exit(fails ? 1 : 0);
