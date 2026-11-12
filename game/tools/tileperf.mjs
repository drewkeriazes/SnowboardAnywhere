// FEAT-229 step 1: the fine (1 m height), mask and dir (2 m) tiles from load to riding at the start, and over
// a ride. node tools/tileperf.mjs [pack] [seconds] [--straight] [--track] [--emulate-coarse | --look4] [--shots <dir>] [--headed | --gpu | --cpu]   (after `npx vite build`)
// Load: frames stepped back to back with the warm-up's budgets (warmUp.ts) until nothing is in flight or
// building, then a restart at the spawn (R held). Ride: ArrowUp held with carves alternating every 1.5 s (--straight: none; --track prints the
// rider every second), stepped at 1/60 s in real-time batches.
// Reports per set: tiles resident, fetched, bytes, and decode times (TileStats: createImageBitmap wall time,
// main-thread copy and conversion). Every request() is attributed to who made it: a terrain chunk (by its
// vertex spacing) or anything else (prefetch around the rider, the spawn box, lifts). "4-8 m only" tiles
// were never asked for by anything but 4 and 8 m chunks: the ones a 4 m height set would take off fine.
// --emulate-coarse drops the 4 and 8 m chunks' fine requests (they build from mid instead): the most a 4 m set
// could save in load time, as its own few tiles are not fetched.
// --look4 keeps today's loading but builds 4 and 8 m chunks from a 4 m box average of the fine tiles (bilinear
// between 4 m cell means): how the ring would look with the set. --shots <dir> saves the frame when the load
// settles and every 10 s of the ride (start.png, t10.png, ...), the same moments in every mode.
// FEAT-230 --get <catalog.json> [--mbps N] [--full]: first install the pack the way the resort picker's Download does
// (get_pack.mjs, into packs/ or SHOT_PACKS, replacing what is there), from the zips the catalog names (local files;
// with --mbps served over HTTP at that rate), then load and ride it. With a boot zip in the entry the page loads as
// soon as the boot zip is in and the rest downloads behind the ride (--full: the one zip, as before FEAT-230).
// Reports the time to first ride (download and unzip, then page load to settled), when the rest landed, and how
// much of the ride physics spent on coarser heights; a ride ends by waiting for the rest and checking the chunks
// rebuilt with it.
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';
import { getPack, readCatalog } from './get_pack.mjs';

const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null;
const valued = new Set(['--shots', '--get', '--mbps']);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const shoot = async (name) => {
  if (!shotsDir) return;
  const url = await page.evaluate(() => window.__shot());
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
};
const pack = positional[0] ?? 'vail';
const seconds = Number(positional[1] ?? 60);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));

// ---- FEAT-230 --get: install the pack from a catalog first, as the resort picker's Download does
let get = null;
if (opt('--get')) {
  const catFile = path.resolve(opt('--get'));
  const catalog = await readCatalog(catFile);
  const mbps = Number(opt('--mbps') ?? 0);
  let zipServer = null;
  if (mbps > 0) {
    // the zips over HTTP at mbps megabits a second (a token bucket per response), as from a release
    const files = new Map();
    const bps = (mbps * 1e6) / 8;
    zipServer = http.createServer(async (req, res) => {
      const f = files.get(decodeURIComponent(req.url.slice(1)));
      if (!f) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(f).size });
      const t0 = performance.now();
      let sent = 0;
      for await (const c of fs.createReadStream(f, { highWaterMark: 1 << 16 })) {
        sent += c.length;
        const wait = (sent / bps) * 1000 - (performance.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (!res.write(c)) await new Promise((r) => res.once('drain', r));
      }
      res.end();
    });
    await new Promise((r) => zipServer.listen(0, '127.0.0.1', r));
    for (const e of [...(catalog.resorts ?? []), ...(catalog.test ?? [])]) {
      for (const part of [e.pack, e.pack?.boot, e.pack?.rest]) {
        if (!part?.url || /^https?:/.test(part.url)) continue;
        const name = path.basename(part.url);
        files.set(name, path.resolve(path.dirname(catFile), part.url));
        part.url = `http://127.0.0.1:${zipServer.address().port}/${encodeURIComponent(name)}`;
      }
    }
  }
  const full = args.includes('--full');
  // a fresh install every run: what is there goes first (never through a link: that would empty its target)
  const dest = path.join(PACKS, pack);
  if (fs.existsSync(dest)) {
    if (fs.lstatSync(dest).isSymbolicLink()) { console.log(`--get: ${dest} is a link; point SHOT_PACKS at a folder of your own`); process.exit(1); }
    fs.rmSync(dest, { recursive: true, force: true });
  }
  get = { mbps, full, t0: performance.now(), bootMs: -1, restMs: -1, boot: 0, rest: 0, error: null };
  let ready;
  const bootIn = new Promise((r) => { ready = r; });
  get.done = getPack(pack, {
    packsDir: PACKS, catalog, force: true, full,
    onProgress: (p) => { if (p.phase === 'rest' && get.bootMs < 0) { get.bootMs = performance.now() - get.t0; get.boot = p.boot; ready(); } },
  }).then((res) => {
    get.restMs = performance.now() - get.t0;
    if (get.bootMs < 0) { get.bootMs = get.restMs; get.boot = res.bytes; } else get.rest = res.rest;
    ready();
    zipServer?.close();
  }, (e) => { get.error = String(e.message ?? e); ready(); zipServer?.close(); });
  await bootIn;
  if (get.error) { console.log(`get: ${get.error}`); process.exit(1); }
  get.pageT0 = performance.now();
  console.log(`get: ${get.restMs < 0 ? 'boot zip' : 'pack'} in after ${(get.bootMs / 1000).toFixed(1)} s (${(get.boot / 1e6).toFixed(1)} MB${mbps ? ` at ${mbps} Mbit/s` : ', local files'}); loading the page`);
}

const browser = await launchBrowser(args);
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const warnings = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') warnings.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => warnings.push(`pageerror: ${e.message}`));
// attribution: every request() rectangle on fine / mask / dir, by requester. Installed the moment the game
// assigns __step (GameLoop.start, after __sim and before the first headless frame, whose terrain.update
// already asks for every chunk's tiles).
await page.addInitScript(({ emulate, look4 }) => {
  let stepFn;
  Object.defineProperty(window, '__step', { configurable: true, get: () => stepFn, set: (v) => { stepFn = v; if (!window.__hooked) { window.__hooked = true; window.__readyMs = performance.now(); install(); queueMicrotask(() => { window.__firstFrameMs = performance.now(); }); } } });
  function install() {
  const w = window, s = w.__sim, p = s.pack;
  w.__sets = { fine: p.fine, coarse: p.coarse, mask: p.mask, dir: p.dir, ao: p.ao, moguls: p.moguls };
  w.__life = {}; w.__win = {}; w.__inTerrain = false;
  const keys = (set, x0, y0, x1, y1) => {
    const m = set.meta, out = [];
    const tx0 = Math.max(0, Math.floor((x0 - m.minX) / set.size)), ty0 = Math.max(0, Math.floor((y0 - m.minY) / set.size));
    const tx1 = Math.min(m.tilesX - 1, Math.floor((x1 - m.minX) / set.size)), ty1 = Math.min(m.tilesY - 1, Math.floor((y1 - m.minY) / set.size));
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push(ty * 4096 + tx);
    return out;
  };
  const note = (name, set, label, x0, y0, x1, y1) => {
    for (const k of keys(set, x0, y0, x1, y1)) {
      for (const tab of [w.__life[name], w.__win[name]]) { let l = tab.get(k); if (!l) tab.set(k, (l = new Set())); l.add(label); }
    }
  };
  w.__note = note;
  for (const [name, set] of Object.entries(w.__sets)) {
    if (!set) continue;
    w.__life[name] = new Map(); w.__win[name] = new Map();
    const orig = set.request.bind(set);
    set.request = (x0, y0, x1, y1) => {
      // Terrain.update asks for each chunk's own box; its vertex spacing is the box size over N = 32
      const label = w.__inTerrain ? `c${Math.round((x1 - x0) / 32)}` : 'other';
      note(name, set, label, x0, y0, x1, y1);
      if (emulate && name === 'fine' && (label === 'c4' || label === 'c8')) return false;
      return orig(x0, y0, x1, y1);
    };
  }
  if (look4 && p.fine) {
    // the 4 m set's look: cell means of 4 x 4 fine samples, bilinear between cell centres
    const f = p.fine, C = 4, x0 = f.meta.minX, y0 = f.meta.minY, orig = p.height.bind(p);
    const NX = Math.ceil(f.meta.tilesX * f.size / C), NY = Math.ceil(f.meta.tilesY * f.size / C), cache = new Float32Array(NX * NY).fill(NaN);
    const cell = (i, j) => {
      if (i < 0 || j < 0 || i >= NX || j >= NY) return NaN;
      const c = cache[j * NX + i]; if (!Number.isNaN(c)) return c;
      let a = 0; for (let v = 0; v < C; v++) for (let u = 0; u < C; u++) { const h = f.sampleNearest(x0 + i * C + u + 0.5, y0 + j * C + v + 0.5); if (Number.isNaN(h)) return NaN; a += h; }
      return (cache[j * NX + i] = a / (C * C));
    };
    p.height = (x, y, res, bumps = true) => {
      if (res < 4 || res > 8 || !f.contains(x, y)) return orig(x, y, res, bumps);
      const fx = (x - x0) / C - 0.5, fy = (y - y0) / C - 0.5, i = Math.floor(fx), j = Math.floor(fy), ax = fx - i, ay = fy - j;
      const h00 = cell(i, j), h10 = cell(i + 1, j), h01 = cell(i, j + 1), h11 = cell(i + 1, j + 1);
      if ([h00, h10, h01, h11].some(Number.isNaN)) return orig(x, y, res, bumps);
      return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
    };
  }
  const t = s.terrain, upd = t.update.bind(t);
  t.update = (...a) => { w.__inTerrain = true; try { upd(...a); } finally { w.__inTerrain = false; } };
  // Session asked for the spawn box (+-600 m) before these hooks went in (fine and mask)
  const [sx, sy] = s.map.spawnPos;
  for (const name of ['fine', 'mask']) if (w.__sets[name]) note(name, w.__sets[name], 'other', sx - 600, sy - 600, sx + 600, sy + 600);
  w.__resident = (set) => { let n = 0; for (const v of set.tiles.values()) if (v) n++; return n; };
  w.__snap = () => {
    const o = {};
    for (const [name, set] of Object.entries(w.__sets)) {
      if (!set) continue;
      const st = set.stats;
      o[name] = { resident: w.__resident(set), inFlight: set.inFlight, loads: st.loads, bytes: st.bytes, fetchMs: st.fetchMs, bitmapMs: st.bitmapMs, decodeMs: st.decodeMs, maxDecodeMs: st.maxDecodeMs, logLen: st.log.length };
    }
    return o;
  };
  // resident tiles by what asked for them in the window (since the last reset): fine chunks (1, 2 m), only 4 and 8 m chunks, other, nothing
  w.__classify = () => {
    const o = {};
    for (const [name, set] of Object.entries(w.__sets)) {
      if (!set) continue;
      const c = { fineChunks: 0, coarseOnly: 0, otherOnly: 0, idle: 0, coarseOnlyTiles: [] };
      for (const [k, v] of set.tiles) {
        if (!v) continue;
        const l = w.__win[name].get(k);
        if (!l) { c.idle++; continue; }
        if (l.has('c1') || l.has('c2') || [...l].some((x) => x.startsWith('c') && Number(x.slice(1)) < 1)) c.fineChunks++;
        else if (l.has('other')) c.otherOnly++;
        else { c.coarseOnly++; c.coarseOnlyTiles.push(`${k % 4096}_${Math.floor(k / 4096)}`); }
      }
      o[name] = c;
    }
    return o;
  };
  w.__resetWin = () => { for (const name of Object.keys(w.__win)) w.__win[name] = new Map(); };
  }
}, { emulate: args.includes('--emulate-coarse'), look4: args.includes('--look4') });
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step && window.__hooked, null, { timeout: 120000 });
page.setDefaultTimeout(600000);
const [readyMs, firstFrameMs] = await page.evaluate(() => [window.__readyMs, window.__firstFrameMs]);

// ---- load: back-to-back frames with the warm-up budgets until three quiet frames (as warmUp.ts)
const load = await page.evaluate(async () => {
  const w = window, s = w.__sim, p = s.pack, t = s.terrain;
  t.budgetMs = 12; t.maxBuilds = 64; s.veg.budgetMs = 12;
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const busy = () => [p.fine, p.coarse, p.mid, p.far, p.mask, p.ao, p.dir, p.moguls].reduce((n, x) => n + (x?.inFlight ?? 0), 0) + t.pending + s.veg.pending;
  const t0 = performance.now();
  let first = -1, quiet = 0, frames = 0;
  while (performance.now() - t0 < 30000) {
    w.__step(1, 1 / 60); frames++;
    if (first < 0) first = performance.now();
    quiet = busy() === 0 ? quiet + 1 : 0;
    if (quiet >= 3) break;
    await frame();
  }
  t.budgetMs = 4; t.maxBuilds = 10; s.veg.budgetMs = 3;
  return { t0, first, settled: performance.now(), frames, timedOut: quiet < 3 };
});
// the rider rode on during the load frames, whose number varies: restart at the spawn now everything is in
// (hold R, as ridecheck.mjs), so every run and mode starts from the same frame on the same data
await page.evaluate(() => window.__step(1, 1 / 60));
await page.keyboard.down('KeyR');
const restarted = await page.evaluate(() => {
  const s = window.__sim; let prev = s.rider.steps;
  for (let i = 1; i <= 120; i++) { window.__step(1, 1 / 60); if (s.rider.steps < prev) return true; prev = s.rider.steps; }
  return false;
});
await page.keyboard.up('KeyR');
if (!restarted) console.log('WARNING: holding R never restarted the run; the start is wherever the rider got to during the load');
// steady state at the start: one second of frames for the window
await page.evaluate(() => { window.__resetWin(); window.__step(60, 1 / 60); });
await shoot('start');
const startSnap = await page.evaluate(() => window.__snap());
const startClass = await page.evaluate(() => window.__classify());
const startLog = await page.evaluate(() => Object.fromEntries(Object.entries(window.__sets).filter(([, s]) => s).map(([n, s]) => [n, s.stats.log.slice()])));

// ---- ride
const rideT0 = await page.evaluate(() => performance.now());
await page.keyboard.down('ArrowUp');
const track = [];
const batches = Math.round(seconds * 4);
let carve = null;
for (let b = 0; b < batches; b++) {
  const want = Math.floor(b / 6) % 2 === 0 ? 'ArrowLeft' : 'ArrowRight';
  if (!args.includes('--straight') && b >= 8 && want !== carve) { if (carve) await page.keyboard.up(carve); await page.keyboard.down(want); carve = want; }
  const st = await page.evaluate(() => {
    const w = window, s = w.__sim, r = s.rider;
    const a = performance.now(); w.__step(15, 1 / 60); const ms = performance.now() - a;
    const f = s.pack.fine;
    return { x: r.x, y: r.y, z: r.z, speed: r.speed, crashed: r.crashed, state: s.states?.current ?? '', ms, fine: w.__resident(f), fineFlight: f.inFlight, mask: w.__resident(s.pack.mask), dir: s.pack.dir ? w.__resident(s.pack.dir) : 0,
      fineHere: !Number.isNaN(f.sample(r.x, r.y)), partial: s.pack.partial, at: performance.now() };
  });
  track.push(st);
  if ((b + 1) % 40 === 0) await shoot(`t${(b + 1) / 4}`);
  await page.waitForTimeout(Math.max(0, 250 - st.ms));
}
if (carve) await page.keyboard.up(carve);
await page.keyboard.up('ArrowUp');
// FEAT-230: a rest still on its way: wait for it, then for the chunks it makes dirty, with frames running
let afterRest = null;
if (get && !get.full) {
  await get.done;
  afterRest = await page.evaluate(async () => {
    const w = window, s = w.__sim, p = s.pack, t = s.terrain;
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const t0 = performance.now();
    while (p.partial && performance.now() - t0 < 30000) { w.__step(1, 1 / 60); await frame(); }
    const waitedMs = performance.now() - t0;
    const busy = () => [p.fine, p.coarse, p.mid, p.far, p.mask, p.ao, p.dir, p.moguls].reduce((n, x) => n + (x?.inFlight ?? 0), 0) + t.pending + s.veg.pending;
    const fine0 = w.__resident(p.fine);
    let quiet = 0, frames = 0;
    const t1 = performance.now();
    while (performance.now() - t1 < 30000) { w.__step(1, 1 / 60); frames++; quiet = busy() === 0 ? quiet + 1 : 0; if (quiet >= 3) break; await frame(); }
    w.__step(60, 1 / 60);
    const r = s.rider;
    return { completedAt: p.completedAt, waitedMs, partial: p.partial, fine0, fine1: w.__resident(p.fine), settleMs: performance.now() - t1, frames, fineHere: !Number.isNaN(p.fine.sample(r.x, r.y)) };
  });
  await shoot('rest'); // the ride's last spot once the rest is in and the chunks have rebuilt
}
await page.evaluate(() => { window.__resetWin(); window.__step(60, 1 / 60); });
const endSnap = await page.evaluate(() => window.__snap());
const endClass = await page.evaluate(() => window.__classify());
const life = await page.evaluate(() => Object.fromEntries(Object.entries(window.__life).map(([n, m]) => [n, [...m].map(([k, l]) => [k, [...l]])])));
const allLog = await page.evaluate(() => Object.fromEntries(Object.entries(window.__sets).filter(([, s]) => s).map(([n, s]) => [n, s.stats.log.slice()])));

// ---- report
const f1 = (v) => v.toFixed(1), mb = (b) => (b / 1048576).toFixed(1);
console.log(`pack ${pack}, ${seconds} s ride${args.includes('--emulate-coarse') ? ', EMULATED: no fine tiles for 4 and 8 m chunks' : ''}${args.includes('--look4') ? ', LOOK4: 4 and 8 m chunks from a 4 m box average' : ''}`);
console.log(`page load to session ready (__step) ${f1(readyMs)} ms, its first frame done ${f1(firstFrameMs)} ms, tool's first frame ${f1(load.first)} ms, settled ${f1(load.settled)} ms after ${load.frames} frames${load.timedOut ? ' (TIMED OUT at 30 s)' : ''}`);
const d = (a, b, k) => (a?.[k] ?? 0) - (b?.[k] ?? 0);
const setLine = (name, log, from, to) => {
  const ls = log.filter((l) => l.t >= from && l.t < to);
  if (!ls.length) return `  ${name.padEnd(5)} 0 tiles`;
  const sum = (k) => ls.reduce((n, l) => n + l[k], 0), max = (k) => Math.max(...ls.map((l) => l[k]));
  const last = Math.max(...ls.map((l) => l.t));
  return `  ${name.padEnd(5)} ${String(ls.length).padStart(4)} tiles  ${mb(sum('bytes')).padStart(6)} MB  decode (main) ${f1(sum('decodeMs')).padStart(7)} ms, ${f1(sum('decodeMs') / ls.length)} per tile, max ${f1(max('decodeMs'))}  |  bitmap ${f1(sum('bitmapMs') / ls.length)} ms/tile  fetch ${f1(sum('fetchMs') / ls.length)} ms/tile  |  last at ${f1(last)} ms`;
};
console.log(`load (to settled):`);
for (const n of Object.keys(startLog)) console.log(setLine(n, startLog[n], 0, load.settled));
console.log(`ride (${seconds} s):`);
for (const n of Object.keys(allLog)) console.log(setLine(n, allLog[n], rideT0, Infinity));
for (const [label, snap, cls] of [['start (steady)', startSnap, startClass], ['ride end (steady)', endSnap, endClass]]) {
  console.log(`${label}:`);
  for (const n of Object.keys(snap)) {
    const c = cls[n];
    console.log(`  ${n.padEnd(5)} resident ${String(snap[n].resident).padStart(3)}: wanted by 1-2 m chunks ${c.fineChunks}, only by 4-8 m chunks ${c.coarseOnly}, only by prefetch / spawn / lifts ${c.otherOnly}, by nothing ${c.idle}`);
  }
  console.log(`  fine tiles only for 4-8 m chunks: ${cls.fine.coarseOnlyTiles.join(' ')}`);
}
if (args.includes('--track')) for (let i = 0; i < track.length; i += 4) { const t = track[i]; console.log(`  t ${i / 4} s  ${f1(t.x)}, ${f1(t.y)}, ${f1(t.z)}  ${f1(t.speed * 3.6)} km/h  crashed ${t.crashed}  fine ${t.fine} (${t.fineFlight} in flight)`); }
const peak = Math.max(...track.map((t) => t.fine));
const dist = track.reduce((n, t, i) => n + (i ? Math.hypot(t.x - track[i - 1].x, t.y - track[i - 1].y) : 0), 0);
const top = Math.max(...track.map((t) => t.speed));
console.log(`ride: ${f1(dist)} m, top ${f1(top * 3.6)} km/h, crashed in ${track.filter((t) => t.crashed).length} batches, fine resident peak ${peak}, mask peak ${Math.max(...track.map((t) => t.mask))}, dir peak ${Math.max(...track.map((t) => t.dir))}`);
const bms = track.map((t) => t.ms / 15).sort((a, b) => a - b);
console.log(`ride frame ms (15-frame batch means): median ${f1(bms[bms.length >> 1])}, p95 ${f1(bms[Math.floor(bms.length * 0.95)])}, max ${f1(bms[bms.length - 1])}`);
// every tile fetched over the whole run, by what ever asked for it
console.log('whole run (load and ride), every tile fetched, by what ever asked for it:');
for (const n of Object.keys(allLog)) {
  const req = new Map(life[n]);
  const groups = { fineChunks: [], coarseOnly: [], otherOnly: [] };
  for (const l of allLog[n]) {
    const r = req.get(l.ty * 4096 + l.tx) ?? [];
    const g = r.some((x) => x === 'c1' || x === 'c2' || (x.startsWith('c') && Number(x.slice(1)) < 1)) ? 'fineChunks' : r.includes('other') || !r.length ? 'otherOnly' : 'coarseOnly';
    groups[g].push(l);
  }
  const tot = allLog[n].reduce((s, l) => s + l.decodeMs + 0, 0), totB = allLog[n].reduce((s, l) => s + l.bytes, 0);
  const desc = (ls) => `${ls.length} tiles, ${mb(ls.reduce((s, l) => s + l.bytes, 0))} MB, decode ${f1(ls.reduce((s, l) => s + l.decodeMs, 0))} ms`;
  const cb = groups.coarseOnly.reduce((s, l) => s + l.bytes, 0), cd = groups.coarseOnly.reduce((s, l) => s + l.decodeMs, 0);
  console.log(`  ${n.padEnd(5)} ${allLog[n].length} tiles (${mb(totB)} MB, decode ${f1(tot)} ms). 1-2 m chunks: ${desc(groups.fineChunks)}; prefetch / spawn / lifts only: ${desc(groups.otherOnly)}; 4-8 m chunks only: ${desc(groups.coarseOnly)} = ${(100 * groups.coarseOnly.length / Math.max(1, allLog[n].length)).toFixed(0)}% of tiles, ${(100 * cb / Math.max(1, totB)).toFixed(0)}% of bytes, ${(100 * cd / Math.max(1e-9, tot)).toFixed(0)}% of decode`);
}
if (get) {
  const s1 = (ms) => (ms / 1000).toFixed(1);
  const ride = get.bootMs / 1000 + load.settled / 1000;
  console.log(`get (${get.full ? 'full zip' : 'boot then rest'}${get.mbps ? `, ${get.mbps} Mbit/s` : ', local files'}): ${get.full ? 'pack' : 'boot zip'} ${(get.boot / 1e6).toFixed(1)} MB downloaded and unzipped in ${s1(get.bootMs)} s`
    + (get.full ? '' : `, rest ${(get.rest / 1e6).toFixed(1)} MB in at ${s1(get.restMs)} s`));
  console.log(`time to first ride: ${s1(get.bootMs)} s download + ${s1(load.settled)} s page load to settled = ${ride.toFixed(1)} s`);
  if (!get.full) {
    const rideStart = track[0]?.at ?? 0;
    const restInRide = afterRest?.completedAt > 0 ? (afterRest.completedAt - rideStart) / 1000 : null;
    const part = track.filter((t) => t.partial);
    // the rider's own spot: 1 m heights there, or physics rides the coarse (4 m) set until the rest is in
    const coarse = track.filter((t) => !t.fineHere);
    console.log(`rest landed ${restInRide === null ? 'never' : restInRide < 0 ? `${(-restInRide).toFixed(1)} s before the ride started` : `${restInRide.toFixed(1)} s into the ride`}; ride batches while partial ${part.length} of ${track.length}; rider off the 1 m heights in ${coarse.length} batches (${coarse.filter((t) => t.partial).length} while partial)`);
    if (part.length) { const l = part[part.length - 1]; console.log(`  last partial batch at ${f1(l.x)}, ${f1(l.y)}, ${f1(Math.hypot(l.x - track[0].x, l.y - track[0].y))} m from the ride's start`); }
    if (afterRest) console.log(`after the rest: partial ${afterRest.partial}, fine resident ${afterRest.fine0} -> ${afterRest.fine1}, settled in ${s1(afterRest.settleMs)} s (${afterRest.frames} frames), 1 m heights under the rider ${afterRest.fineHere}`);
  }
}
console.log('console issues:', warnings.length);
for (const w of warnings.slice(0, 10)) console.log('  ', w.slice(0, 300));
await browser.close();
server.close();
