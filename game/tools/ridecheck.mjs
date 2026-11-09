// Streaming and determinism check (FEAT-051): a straight tuck run from the spawn, ridden twice.
// node tools/ridecheck.mjs [pack] [seconds] [--headed]   (run `npx vite build` first)
// Reports: top speed, physics steps that fell back to a coarser height set, terrain/mask tiles and
// tree cells that arrived late (within LATE_M of the rider), and whether run 2 matches run 1 exactly.
// Frames are stepped at a fixed 1/60 s in real-time batches so tile fetches race the rider as in play.
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'synth';
const seconds = Number(positional[1] ?? 25);
const LATE_M = 150;
const dist = DIST;
const packs = PACKS;
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
const port = server.address().port;
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const warnings = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') warnings.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => warnings.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${port}/index.html?pack=${pack}&headless&lowgfx${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 60000 });
page.setDefaultTimeout(600000);

// hook tile arrivals: a tile landing close to the rider means it was not prefetched in time
await page.evaluate((LATE_M) => {
  const s = window.__sim, w = window;
  w.__late = [];
  const hook = (set, name) => {
    if (!set) return;
    const prev = set.onTileLoaded;
    set.onTileLoaded = (tx, ty) => {
      prev?.(tx, ty);
      const r = w.__sim.rider, x0 = set.meta.minX + tx * set.size, y0 = set.meta.minY + ty * set.size;
      const dx = Math.max(x0 - r.x, 0, r.x - (x0 + set.size)), dy = Math.max(y0 - r.y, 0, r.y - (y0 + set.size));
      if (Math.hypot(dx, dy) < LATE_M) w.__late.push(`${name} ${tx}_${ty} at ${Math.hypot(dx, dy).toFixed(0)} m, ${w.__t < 0 ? 'before the run (spawn load)' : `${w.__t.toFixed(2)} s into the run`}`);
    };
  };
  hook(s.pack.fine, 'fine'); hook(s.pack.mask, 'mask');
}, LATE_M);

async function ride(label) {
  await page.evaluate(() => { const w = window; w.__late = []; w.__treeLate = 0; w.__t = -1; });
  await page.keyboard.press('KeyR');
  await page.evaluate(() => window.__step(1, 1 / 60));
  // the restart frame resets to the spawn; let the area around it load as the game's start wait does
  await page.waitForTimeout(1500);
  // restart again now the spawn tiles are in, so both runs start on the same loaded data
  await page.keyboard.press('KeyR');
  await page.keyboard.down('ArrowUp');
  const track = [];
  const batches = Math.round(seconds * 4);
  for (let b = 0; b < batches; b++) {
    const st = await page.evaluate(() => {
      const w = window; w.__t = Math.max(0, w.__t) ; w.__step(15, 1 / 60); w.__t += 0.25;
      const s = w.__sim, r = s.rider;
      // tree cells near the rider still without data = trees that will pop in
      let missing = 0;
      for (const c of s.veg.cells.values()) {
        if (c.data || c.missing) continue;
        const inst = s.pack.meta.instances, cs = inst.cellSize;
        const cx = inst.minX + (c.cx + 0.5) * cs, cy = inst.minY + (c.cy + 0.5) * cs;
        if (Math.hypot(cx - r.x, cy - r.y) - cs * 0.71 < 150) missing++;
      }
      w.__treeLate += missing ? 1 : 0;
      return [r.x, r.y, r.z, r.vx, r.vy, r.vz, r.heading, r.speed, r.steps, r.coarseSteps, r.crashed, r.surface.rock, r.surface.scree, r.surface.groomed, r.surface.canopy, r.onGround ? 1 : 0, r.edgeAngle, r.skid, r.lateralG, r.jumpCharge];
    });
    track.push(st);
    await page.waitForTimeout(250);
  }
  await page.keyboard.up('ArrowUp');
  const late = await page.evaluate(() => window.__late.slice());
  const treeLate = await page.evaluate(() => window.__treeLate);
  const last = track[track.length - 1];
  const top = Math.max(...track.map((t) => t[7]));
  console.log(`${label}: top ${(top * 2.23694).toFixed(0)} mph, end ${last[0].toFixed(1)}, ${last[1].toFixed(1)}, steps ${last[8]}, coarse steps ${last[9]}, late tiles ${late.length}, batches with tree cells missing near the rider ${treeLate}`);
  for (const l of late.slice(0, 8)) console.log('   late', l);
  return track;
}

const a = await ride('run 1');
const b = await ride('run 2');
let firstDiff = -1;
for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i].some((v, k) => v !== b[i][k])) { firstDiff = i; break; }
if (firstDiff >= 0) { const names = 'x y z vx vy vz heading speed steps coarse crashed rock scree groomed canopy onGround edge skid latG jump'.split(' '); for (const i of [firstDiff - 1, firstDiff]) if (i >= 0) console.log(i, names.map((n, k) => `${n}=${a[i][k]}${a[i][k] !== b[i][k] ? '|' + b[i][k] : ''}`).join(' ')); }
console.log(firstDiff < 0 ? 'replay: identical' : `replay: differs from batch ${firstDiff} (${(firstDiff / 4).toFixed(2)} s): ${JSON.stringify(a[firstDiff].slice(0, 3))} vs ${JSON.stringify(b[firstDiff].slice(0, 3))}`);
console.log('console issues:', warnings.length);
for (const w of warnings.slice(0, 10)) console.log('  ', w.slice(0, 300));
await browser.close();
server.close();
