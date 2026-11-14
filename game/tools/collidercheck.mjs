// Collider streaming check (BUG-082): the far tree cells and the rock cells unload when the rider is far away,
// and each takes only its own cylinders out of the collider. Drives Vegetation and Rocks with a far position
// (60 km off, past every tree and rock reach, so the pack's size does not matter) and back, twice, with no
// render, and checks: a landmark-style post (added once, as Landmarks.ts and Buildings.ts add theirs) and every
// cylinder that was there before the trees and rocks streamed in stay put; the collider holds the same count
// after each return; each rock is held once (rocks used to be added again on every return). A pack with no
// rocks (the synthetic mountain) gets a few dozen made up around the start, served in place of rocks/<cell>.bin.
// The static people (FEAT-307) settled first keep their cylinders through every drop too.
// Also prints how long the update that drops the cells takes.
// node tools/collidercheck.mjs [pack] [--headed]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const pack = args.filter((a) => !a.startsWith('--'))[0] ?? 'synth';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css' };
let fakeRocks = null; // { key, data: number[] } once the page has made them up
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (fakeRocks && u === `/packs/${pack}/rocks/${fakeRocks.key}.bin`) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from(new Float32Array(fakeRocks.data).buffer));
    return;
  }
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

// helpers in the page: stream the trees and rocks round (x, y) until nothing is loading and the collider count
// holds still, without the frame loop (which would stream them round the rider again)
await page.evaluate(() => {
  const s = window.__sim, col = s.collider;
  const all = () => [...col.cells.values()].flat();
  const busy = () => s.rocks.pending > 0 || [...s.veg.cells.values()].some((c) => c.loading || c.standState === 1);
  window.__cc = {
    all,
    /** stream round (x, y); the first update's time is the one that drops the cells left behind */
    async at(x, y) {
      const cam = { x, y: 3000, z: -y };
      let t = performance.now();
      s.veg.update(x, y, x, y, cam); s.rocks.update(x, y);
      const first = performance.now() - t;
      let last = -1, still = 0;
      for (let i = 0; i < 600 && still < 8; i++) {
        await new Promise((r) => setTimeout(r, 25));
        s.veg.update(x, y, x, y, cam); s.rocks.update(x, y);
        const n = col.cylinderCount;
        still = !busy() && n === last ? still + 1 : 0;
        last = n;
      }
      return { first, count: col.cylinderCount, settled: still >= 8 };
    },
    /** how many cylinders sit at each of the points [x, y, radius] (a rock held twice reads 2) */
    held(pts) {
      return pts.map(([x, y, r]) => col.near(x, y, 0.01).filter((c) => Math.abs(c[0] - x) < 1e-3 && Math.abs(c[1] - y) < 1e-3 && Math.abs(c[2] - r) < 1e-3).length);
    },
  };
});

const home = await page.evaluate(() => { const r = window.__sim.rider; return { x: r.x, y: r.y }; });
const farX = home.x + 60000, farY = home.y + 60000;

// 0. FEAT-307's static people: the spots nearest the start settled (each at its own spot, with its tiles in) so they
// add their cylinders (held by the spot, never by a cell) before anything is measured; they count among the fixed
// cylinders every drop below must leave alone
const people = await page.evaluate(async ([hx, hy]) => {
  const s = window.__sim, pp = s.people;
  if (!pp) return { n: 0, cyl: 0 };
  const near = [...pp.spots].sort((a, b) => Math.hypot(a.x - hx, a.y - hy) - Math.hypot(b.x - hx, b.y - hy));
  for (const sp of near) {
    if (pp.spots.filter((q) => q.cyl.length).length >= 2) break;
    const R = 400;
    s.pack.fine?.request(sp.x - R, sp.y - R, sp.x + R, sp.y + R); s.pack.mask?.request(sp.x - R, sp.y - R, sp.x + R, sp.y + R);
    for (let i = 0; i < 400 && sp.state === 'planned'; i++) { pp.maintain(sp.x, sp.y); await new Promise((r) => setTimeout(r, 25)); }
  }
  window.__ccPeople = pp.spots.flatMap((q) => q.cyl);
  return { n: pp.spots.filter((q) => q.cyl.length).length, cyl: window.__ccPeople.length };
}, [home.x, home.y]);
console.log(`${people.n} static people settled, ${people.cyl} cylinders`);

// 1. everything streamed out: what is left is the session's fixed cylinders (landmark and building posts)
let r = await page.evaluate(([x, y]) => window.__cc.at(x, y), [farX, farY]);
check('settles far away', r.settled, `${r.count} cylinders`);
const fixedN = r.count;
const fixedIds = await page.evaluate(() => { const a = window.__cc.all(); window.__ccFixed = a; return a.length; });

// 2. rocks: the pack's own, or made up round the start when it has none
const rocks = await page.evaluate(([hx, hy]) => {
  const s = window.__sim, inst = s.pack.meta.instances;
  // the grid cell nearest the start (a start can sit outside the instance grid), or the nearest the pack lists rocks in,
  // and a spot in it as near the start as it allows
  const cs = inst.cellSize, clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let cx = clamp(Math.floor((hx - inst.minX) / cs), 0, inst.cellsX - 1), cy = clamp(Math.floor((hy - inst.minY) / cs), 0, inst.cellsY - 1);
  if (inst.rockCells?.length) {
    const d = (k) => { const [i, j] = k.split('_').map(Number); return Math.hypot(inst.minX + (i + 0.5) * cs - hx, inst.minY + (j + 0.5) * cs - hy); };
    [cx, cy] = inst.rockCells.reduce((a, b) => (d(b) < d(a) ? b : a)).split('_').map(Number);
  }
  const key = `${cx}_${cy}`;
  const ox = clamp(hx - 60, inst.minX + cx * cs + 20, inst.minX + (cx + 1) * cs - 160), oy = clamp(hy - 60, inst.minY + cy * cs + 20, inst.minY + (cy + 1) * cs - 160);
  const cell = { key, ox, oy, mx: inst.minX + (cx + 0.5) * cs, my: inst.minY + (cy + 0.5) * cs };
  if (inst.rockCells?.length) return { fake: false, key: null, data: null, cell };
  const data = [];
  for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) {
    const x = ox + i * 23.3, y = oy + j * 21.7;
    data.push(x, y, s.pack.terrainHeight(x, y), 1.2 + ((i + j) % 4) * 0.5, i * 0.7, (i + 2 * j) % 3); // x y z size yaw type
  }
  if (inst.rockCells) inst.rockCells.push(key); else inst.rockCells = [key];
  return { fake: true, key, data, cell };
}, [home.x, home.y]);
if (rocks.fake) fakeRocks = { key: rocks.key, data: rocks.data };
console.log(rocks.fake ? `${pack} lists no rocks: ${rocks.data.length / 6} made up in cell ${rocks.key}` : `${pack}'s own rocks`);

// 3. a post in that cell (a tree cell on the synthetic mountain), added once like a landmark's
const post = await page.evaluate(([ox, oy]) => {
  const s = window.__sim, x = ox - 9.5, y = oy - 7.25, z = s.pack.terrainHeight(x, y);
  window.__ccPost = s.collider.add(x, y, 0.45, z - 10, z + 10, 0);
  return [x, y, 0.45];
}, [rocks.cell.ox, rocks.cell.oy]);
let treeCell = false;

/** the rocks' points [x, y, radius] the collider should hold once each: the made-up ones, else that cell's entries
 *  (`all`: every loaded rock cell's) */
const rockPts = (all = false) => page.evaluate(([fake, key, all]) => {
  if (fake) return fake.map((v, i, a) => (i % 6 === 0 && a[i + 3] > 0.9 ? [v, a[i + 1], a[i + 3] * 0.55] : null)).filter(Boolean);
  const cells = [...window.__sim.rocks.cells.entries()].filter(([k]) => all || k === key);
  return cells.flatMap(([, c]) => c.col.map((e) => [e[0], e[1], e[2]]));
}, [rocks.fake ? rocks.data : null, rocks.cell.key, all]);
const fixedKept = () => page.evaluate(() => {
  const now = new Set(window.__cc.all());
  return { fixed: window.__ccFixed.filter((e) => !now.has(e)).length, post: now.has(window.__ccPost), people: window.__ccPeople.filter((e) => !now.has(e)).length };
});

let homeN = null;
for (let trip = 1; trip <= 2; trip++) {
  r = await page.evaluate(([x, y]) => window.__cc.at(x, y), [home.x, home.y]);
  const pts = await rockPts();
  const held = await page.evaluate((p) => window.__cc.held(p), await rockPts(true));
  const k = await fixedKept();
  check(`back home (${trip}): settles`, r.settled, `${r.count} cylinders`);
  check(`back home (${trip}): rocks loaded`, pts.length > 0, `${pts.length} solid rocks`);
  check(`back home (${trip}): each rock held once`, held.every((n) => n === 1), `held ${[...new Set(held)].sort().join('/')} times`);
  check(`back home (${trip}): the post and the fixed cylinders are there`, k.post && k.fixed === 0, `post ${k.post}, ${k.fixed} of ${fixedIds} fixed missing`);
  if (homeN === null) { homeN = r.count; treeCell = await page.evaluate((key) => (window.__sim.veg.cells.get(key)?.data?.length ?? 0) > 0, rocks.cell.key); }
  else check(`back home (${trip}): the same count as the first time`, r.count === homeN, `${r.count} vs ${homeN}`);

  // 1.8 km past the cell: the rocks stay loaded (2.5 km) while the tree cell drops on Low (?lowgfx: 600 m trees); a
  // whole-cell clear took the rocks' cylinders with it
  r = await page.evaluate(([x, y]) => window.__cc.at(x, y), [rocks.cell.mx + 1800, rocks.cell.my]);
  const near = await page.evaluate((p) => window.__cc.held(p), pts);
  const n = await fixedKept();
  check(`1.8 km off (${trip}): the rocks still solid`, r.settled && near.every((v) => v === 1), `held ${[...new Set(near)].sort().join('/')} times`);
  check(`1.8 km off (${trip}): the post and the fixed cylinders stay`, n.post && n.fixed === 0, `post ${n.post}, ${n.fixed} of ${fixedIds} fixed missing`);
  // 4.5 km past it: the rocks drop, the tree cells may stay (they do on High, 9 km); the rocks must leave the collider
  r = await page.evaluate(([x, y]) => window.__cc.at(x, y), [rocks.cell.mx + 4500, rocks.cell.my]);
  const away = await page.evaluate((p) => window.__cc.held(p), pts);
  const m = await fixedKept();
  check(`4.5 km off (${trip}): the rocks left the collider`, r.settled && away.every((n) => n === 0), `held ${[...new Set(away)].sort().join('/')} times`);
  check(`4.5 km off (${trip}): the post and the fixed cylinders stay`, m.post && m.fixed === 0, `post ${m.post}, ${m.fixed} of ${fixedIds} fixed missing`);
  r = await page.evaluate(([x, y]) => window.__cc.at(x, y), [home.x, home.y]);
  const back = await page.evaluate((p) => window.__cc.held(p), pts);
  check(`back from 4.5 km (${trip}): each rock held once`, back.every((n) => n === 1) && r.count === homeN, `held ${[...new Set(back)].sort().join('/')} times, ${r.count} cylinders vs ${homeN}`);

  r = await page.evaluate(([x, y]) => window.__cc.at(x, y), [farX, farY]);
  const f = await fixedKept();
  console.log(`     dropping the cells took ${r.first.toFixed(1)} ms (the update that unloads ${homeN - fixedN - 1} trunk, stem and rock cylinders)`);
  check(`far away (${trip}): trees and rocks gone, only the fixed cylinders and the post left`, r.count === fixedN + 1, `${r.count} cylinders, want ${fixedN + 1}`);
  check(`far away (${trip}): the post and the fixed cylinders stay`, f.post && f.fixed === 0, `post ${f.post}, ${f.fixed} of ${fixedIds} fixed missing`);
  check(`far away (${trip}): the static people's cylinders stay`, f.people === 0, `${f.people} of ${people.cyl} missing`);
}
// the removal itself, on a copy: every cell's own trunks added to a new collider, then removed cell by cell
const rm = await page.evaluate(async ([x, y]) => {
  await window.__cc.at(x, y);
  const s = window.__sim, C = s.collider.constructor, c = new C(), lists = [];
  for (const cell of s.veg.cells.values()) if (cell.own?.length) lists.push(cell.own.map((e) => c.add(e[0], e[1], e[2], e[3], e[4], e[5])));
  const n = c.cylinderCount, t = performance.now();
  for (const l of lists) c.removeAll(l);
  return { n, cells: lists.length, ms: performance.now() - t, left: c.cylinderCount };
}, [home.x, home.y]);
console.log(`     removing ${rm.n} trunks from ${rm.cells} cells, a cell at a time: ${rm.ms.toFixed(1)} ms`);
check('removeAll leaves nothing behind', rm.left === 0 && rm.n > 0, `${rm.left} of ${rm.n} left`);
check('the start streamed trees into the collider', homeN > fixedN + 1 + (rocks.fake ? rocks.data.length / 6 : 0), `${homeN} at home, ${fixedN} fixed`);
check('the post stands in a tree cell', treeCell, rocks.cell.key);
check('static people settled (their cylinders checked through every drop)', people.cyl > 0, `${people.n} placed, ${people.cyl} cylinders`);
check('the post is a cylinder at its point', (await page.evaluate((p) => window.__cc.held([p]), post))[0] === 1);
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 300));

await page.close();
await browser.close();
server.close();
if (fails.length) { console.log(`${fails.length} check(s) failed`); process.exit(1); }
console.log('all checks passed');
