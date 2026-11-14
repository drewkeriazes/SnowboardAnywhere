// Crash slide check (FEAT-288): on the synthetic mountain, crashes at 20 m/s straight down a steep
// pitch (about 20 deg) and on the flat, stepping the rider physics and the rider view (the ragdoll)
// without rendering, so it runs in seconds even on SwiftShader. Checks the body keeps its speed and
// slides tens of metres down the steep pitch (and less than the cap allows), that the flat crash still
// stops within a few seconds, that the rider never gets up while still moving fast, that the ragdoll
// carries the speed with the sim (its pelvis stays near the sim's slide and travels as far), and that
// the recorded slide plays back as a replay (the ragdoll follows the recorded positions) and as a
// time-trial ghost with the crash flag, with no console errors.
// node tools/crashcheck.mjs [pack] [--headed]   (run after `npx vite build`; exit 1 on a failed check)
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
const browser = await launchBrowser();
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };

const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&lowgfx${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 60000 });
page.setDefaultTimeout(240000);

/**
 * Find a start for each case near the spawn: `steep` a point of 18 to 24 deg whose fall line stays
 * between 12 and 40 deg for 80 m with nothing to hit, `flat` a point under 3 deg with 40 m of flat
 * and nothing to hit toward the east. Returns { x, y, h (the heading to slide along), deg } or null.
 */
const find = (kind) => page.evaluate((kind) => {
  const s = window.__sim, r = s.rider, P = s.pack, C = r.collider;
  const n = [0, 0, 1];
  const slope = (x, y) => Math.acos(Math.min(1, P.groundNormal(x, y, n)[2])) * 180 / Math.PI;
  const clear = (x, y) => !C || !C.resolve(x, y, P.groundHeight(x, y), 1.5);
  let best = null;
  for (let rad = 0; rad <= 600 && !best; rad += 20) {
    for (let a = 0; a < 360; a += rad ? Math.max(3, 600 / rad) : 360) {
      const x = r.x + rad * Math.cos(a * Math.PI / 180), y = r.y + rad * Math.sin(a * Math.PI / 180);
      const d = slope(x, y);
      if (kind === 'steep' ? d < 18 || d > 24 : d > 3) continue;
      P.groundNormal(x, y, n);
      const h = kind === 'steep' ? Math.atan2(n[0], n[1]) : Math.PI / 2;
      let ok = true, px = x, py = y;
      for (let k = 0; k < (kind === 'steep' ? 80 : 40) && ok; k += 2) {
        if (kind === 'steep') { P.groundNormal(px, py, n); const l = Math.hypot(n[0], n[1]) || 1; px += 2 * n[0] / l; py += 2 * n[1] / l; } // follow the fall line
        else { px += 2 * Math.sin(h); py += 2 * Math.cos(h); }
        const dd = slope(px, py);
        ok = (kind === 'steep' ? dd > 12 && dd < 40 : dd < 4) && clear(px, py);
      }
      if (ok && clear(x, y)) { best = { x, y, h, deg: d }; break; }
    }
  }
  return best;
}, kind);

/** put the rider at `at`, let the tiles there stream in, then crash at `v` m/s along its heading and
 *  step 60 Hz frames (physics and view) until up and 0.5 s more; returns the per-frame trace */
const crash = async (at, v) => {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(([x, y, h]) => { const r = window.__sim.rider; r.reset(x, y, h); window.__step(1); }, [at.x, at.y, at.h]);
    await page.waitForTimeout(500);
  }
  return page.evaluate(([x, y, h, v]) => {
    const s = window.__sim, r = s.rider, view = s.riderView, out = [];
    const input = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false };
    r.reset(x, y, h);
    for (let i = 0; i < 10; i++) { r.update(1 / 60, input); r.applyRenderPose(); view.update(r, 1 / 60, false); r.restoreSimPose(); }
    r.vx = Math.sin(h) * v; r.vy = Math.cos(h) * v; r.speed = v;
    r.crash(1.3);
    let up = -1;
    for (let i = 0; i < 60 * 10; i++) {
      r.update(1 / 60, input);
      r.applyRenderPose(); view.update(r, 1 / 60, false); r.restoreSimPose();
      const rd = view.ragdoll, p = rd?.pelvis;
      out.push({ t: (i + 1) / 60, x: r.x, y: r.y, z: r.z, speed: r.speed, crashed: r.crashed > 0, air: r.crashAir, slope: r.slopeDeg, mu: r.crashMu, rag: !!rd?.active, px: p ? p.x : NaN, py: p ? -p.z : NaN, pz: p ? p.y : NaN, h: r.heading });
      if (up < 0 && r.crashed <= 0) up = i;
      if (up >= 0 && i > up + 30) break;
    }
    return out;
  }, [at.x, at.y, at.h, v]);
};

/** summary of a trace: the slide's time, distance, speeds, how close the ragdoll stayed */
const sum = (tr) => {
  const end = tr.findIndex((f) => !f.crashed);
  const slide = end < 0 ? tr : tr.slice(0, end);
  const a = tr[0], b = slide[slide.length - 1];
  const at = (t) => slide.find((f) => f.t >= t)?.speed ?? 0;
  const gaps = slide.filter((f) => f.rag).map((f) => Math.hypot(f.px - f.x, f.py - f.y));
  const firstRag = slide.find((f) => f.rag);
  return {
    t: b.t, dist: Math.hypot(b.x - a.x, b.y - a.y), drop: a.z - b.z, up: b.speed, at1: at(1), at3: at(3), ended: end >= 0,
    gapMean: gaps.reduce((m, g) => m + g, 0) / Math.max(1, gaps.length), gapMax: Math.max(0, ...gaps),
    ragDist: firstRag ? Math.hypot(b.px - firstRag.px, b.py - firstRag.py) : 0, rag: gaps.length, slope: a.slope,
    getUp: end >= 0 && !tr[tr.length - 1].rag,
  };
};
const fmt = (s) => `${s.dist.toFixed(1)} m (${s.drop.toFixed(1)} m down) in ${s.t.toFixed(2)} s, ${s.at1.toFixed(1)} m/s at 1 s, ${s.at3.toFixed(1)} at 3 s, up at ${s.up.toFixed(1)} m/s; ragdoll ${s.ragDist.toFixed(1)} m, off the sim by ${s.gapMean.toFixed(2)} m on average (${s.gapMax.toFixed(2)} at most)`;

const steepAt = await find('steep'), flatAt = await find('flat');
check('a steep pitch with a clear fall line near the start', !!steepAt, steepAt ? `${steepAt.deg.toFixed(1)} deg at ${steepAt.x.toFixed(0)}, ${steepAt.y.toFixed(0)}` : 'none');
check('a clear flat near the start', !!flatAt, flatAt ? `${flatAt.deg.toFixed(1)} deg at ${flatAt.x.toFixed(0)}, ${flatAt.y.toFixed(0)}` : 'none');
let steepTrace = null;
if (steepAt) {
  steepTrace = await crash(steepAt, 20);
  const s = sum(steepTrace);
  console.log(`crash at 20 m/s down ${s.slope.toFixed(0)} deg: ${fmt(s)}`);
  check('steep: the body keeps its speed and slides tens of metres down the hill', s.dist > 25 && s.dist < 110 && s.at1 > 8, fmt(s));
  check('steep: the slide ends, by the cap at the latest', s.ended && s.t <= 6.1, `${s.t.toFixed(2)} s`);
  check('steep: never up while still moving fast', s.up < 2.05, `${s.up.toFixed(1)} m/s`);
  check('steep: the ragdoll tumbles the whole slide and carries the speed', s.rag > 0 && s.ragDist > 0.8 * s.dist, `${s.ragDist.toFixed(1)} m against the sim's ${s.dist.toFixed(1)} m`);
  check('steep: the ragdoll stays with the sim (the rider gets up where the body is)', s.gapMean < 2.5 && s.gapMax < 6, `${s.gapMean.toFixed(2)} m on average, ${s.gapMax.toFixed(2)} at most`);
  check('steep: gets up after the slide (the ragdoll lets go)', s.getUp, `ragdoll still active ${!s.getUp}`);
}
if (flatAt) {
  const s = sum(await crash(flatAt, 20));
  console.log(`crash at 20 m/s on the flat (${s.slope.toFixed(1)} deg): ${fmt(s)}`);
  check('flat: a crash on the flat still stops, within a few seconds', s.ended && s.t < 3.5 && s.dist < 30, fmt(s));
  check('flat: never up while still moving fast', s.up < 2.05, `${s.up.toFixed(1)} m/s`);
  check('flat: the ragdoll stays with the sim', s.gapMean < 2.5 && s.gapMax < 6, `${s.gapMean.toFixed(2)} m on average, ${s.gapMax.toFixed(2)} at most`);
}
if (steepTrace) {
  // a replay draws the recorded state on the rider (Replay.overlay: the position and the crash flag)
  // and steps only the view; the ragdoll must follow the recorded slide down the hill
  const rp = await page.evaluate((tr) => {
    const s = window.__sim, r = s.rider, view = s.riderView;
    const save = { x: r.x, y: r.y, z: r.z, vx: r.vx, vy: r.vy, crashed: r.crashed };
    let gap = 0, n = 0, maxGap = 0;
    try {
      for (const f of tr) {
        r.x = f.x; r.y = f.y; r.z = f.z; r.heading = f.h; r.crashed = f.crashed ? 0.5 : 0; r.speed = f.speed;
        view.update(r, 1 / 60, false);
        const p = view.ragdoll?.pelvis;
        if (f.crashed && view.ragdoll?.active) { const g = Math.hypot(p.x - f.x, -p.z - f.y); gap += g; n++; maxGap = Math.max(maxGap, g); }
      }
      return { ok: true, gap: gap / Math.max(1, n), maxGap, n, err: '' };
    } catch (e) { return { ok: false, err: String(e) }; } finally { Object.assign(r, save); }
  }, steepTrace);
  check('a replay of the slide plays: the ragdoll follows the recorded positions', rp.ok && rp.n > 60 && rp.gap < 3 && rp.maxGap < 8, rp.ok ? `${rp.n} frames, ${rp.gap.toFixed(2)} m off on average, ${rp.maxGap.toFixed(2)} at most` : rp.err);
  // a time-trial ghost of the slide (the crash flag set) draws without throwing
  const ghost = await page.evaluate((tr) => {
    const s = window.__sim, tw = s.trialWorld;
    tw.setEnabled(true);
    try {
      tr.forEach((f, i) => tw.updateGhost({ t: i / 60, x: f.x + 4, y: f.y, z: f.z, h: f.h, lg: 0, e: 0, f: 1 | (f.crashed ? 4 : 0) }, 1 / 60));
      return { ok: true, err: '' };
    } catch (e) { return { ok: false, err: String(e) }; } finally { tw.setEnabled(false); }
  }, steepTrace);
  check('a ghost of the slide draws without throwing', ghost.ok, ghost.err);
}
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 300));
if (process.env.SHOT_OUT) await page.screenshot({ path: path.join(process.env.SHOT_OUT, 'crash.png') });
await page.close();
await browser.close();
server.close();
if (fails.length) { console.log(`${fails.length} check(s) failed`); process.exit(1); }
console.log('all checks passed');
