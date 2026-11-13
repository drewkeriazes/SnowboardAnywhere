// Air time check (FEAT-277): how often the rider leaves the snow riding ordinary groomers and cat tracks,
// so a change to the takeoff rule (followGround in sim/rider/Jumps.ts) can be checked for side effects.
// Picks fixed spots from the pack's features.json with a seeded search: groomers (runs tagged groomed,
// 8 to 28 deg along the line) and cat tracks (roads, catwalks, traverses and connectors, 2 to 10 deg),
// each on the downhill part of its line; a candidate whose start the mask says is off the groomed snow
// or under trees is skipped (the next one is taken, in a fixed order). From each spot it rides, from
// --v0 along the line, (a) a straight tuck down the line and (b) linked carves either side of it, render
// free (physics only, one 1/120 s step at a time so no air is missed), and counts the takeoffs (on the
// snow, then not), the airs over 0.15 s, the longest air, the total air time, the distance and the
// crashes. No jump input is ever given. A takeoff is "terrain" (followGround let go), "ramp" (a collider
// ramp, a rock) or "wall" (knocked off by a wall or trunk in the 0.5 s before); terrain/km is the number
// a takeoff rule change moves. A measurement, not a pass/fail check: exit 0 unless it cannot run.
//
// node tools/aircheck.mjs [pack] [--dist <dir>] [--packs <dir>] [--headed] [--seed N] [--groomers N]
//   [--tracks N] [--secs S] [--v0 M/S] [--list] [--json <file>] [--max-takeoffs-per-km N]
//   pack      slug under the packs folder (default synth)
//   --dist    the game build to serve (default game/dist of this checkout; run `npx vite build` first)
//   --packs   the packs folder (default ../packs of this checkout, or SHOT_PACKS)
//   --seed, --groomers, --tracks   the spot search: seed 613, 16 groomer and 10 cat track spots
//   --secs, --v0   each ride: 15 s from 10 m/s
//   --list    print every air over 0.15 s and every crash with where it happened, to go and look
//   --json    write the spots, per-ride results and totals to a file (to diff two builds)
//   --max-takeoffs-per-km   exit 1 when the terrain takeoffs per km over all rides are more than N
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST as DEFAULT_DIST, PACKS as DEFAULT_PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const VALUED = new Set(['--dist', '--packs', '--seed', '--groomers', '--tracks', '--secs', '--v0', '--json', '--max-takeoffs-per-km']);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : def; };
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]));
const pack = positional[0] ?? 'synth';
const DIST = path.resolve(opt('--dist', DEFAULT_DIST));
const PACKS = path.resolve(opt('--packs', DEFAULT_PACKS));
const SEED = Number(opt('--seed', 613));
const N_GROOM = Number(opt('--groomers', 16));
const N_TRACK = Number(opt('--tracks', 10));
const SECS = Number(opt('--secs', 15));
const V0 = Number(opt('--v0', 10));
const LIST = args.includes('--list');
const JSON_OUT = opt('--json', null);
const MAX_TPK = opt('--max-takeoffs-per-km', null);
const AIR_MIN = 0.15;

const packDir = path.join(PACKS, pack);
if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error(`no build at ${DIST} (run npx vite build)`); process.exit(2); }
if (!fs.existsSync(path.join(packDir, 'meta.json'))) { console.error(`no pack at ${packDir}`); process.exit(2); }
console.log(`build ${DIST}\npack  ${packDir}`);

// ---------------------------------------------------------------- spots (deterministic: features.json + seed)
const features = JSON.parse(fs.readFileSync(path.join(packDir, 'features.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(packDir, 'meta.json'), 'utf8'));
const fineB = meta.terrain.fine ?? meta.bounds;
const inFine = (x, y) => x > fineB.minX + 50 && x < fineB.maxX - 50 && y > fineB.minY + 50 && y < fineB.maxY - 50;
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(SEED);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
/** the line resampled every 5 m (x, y, z), downhill first */
function resample(pts) {
  let p = pts.map((q) => [q[0], q[1], q[2] ?? 0]);
  if (p[0][2] < p[p.length - 1][2]) p = p.reverse();
  const out = [p[0]];
  let carry = 0;
  for (let i = 1; i < p.length; i++) {
    const [ax, ay, az] = p[i - 1], [bx, by, bz] = p[i], L = Math.hypot(bx - ax, by - ay);
    let s = 5 - carry;
    while (s <= L) { const t = s / L; out.push([ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t]); s += 5; }
    carry = L - (s - 5);
  }
  return out;
}
const TRACK_RE = /catwalk|cat ?track|road|skiway|traverse|connector|\bway\b|parkway|cut ?-?off|street|run ?out/i;
const NOT_PISTE = /nordic|rail trail|creek trail|5k|10k/i;
const cands = { groomer: [], track: [] };
for (const [i, r] of features.runs.entries()) {
  if (r.area || !r.points || r.points.length < 2 || NOT_PISTE.test(r.name ?? '')) continue;
  const line = resample(r.points);
  const L = (line.length - 1) * 5;
  if (L < 300) continue;
  const grade = Math.atan2(line[0][2] - line[line.length - 1][2], L) * 180 / Math.PI;
  const named = TRACK_RE.test(r.name ?? '');
  const c = { i, name: r.name ?? `run ${i}`, difficulty: r.difficulty, groomed: !!r.groomed, line, L, grade };
  if (named && grade >= 2 && grade <= 10) cands.track.push(c);
  else if (!named && grade >= 8 && grade <= 28 && (r.groomed || r.difficulty === 'easy' || r.difficulty === 'intermediate' || r.difficulty === 'novice')) cands.groomer.push({ ...c, pref: r.groomed ? 0 : 1 });
}
// runs tagged groomed first, then untagged easy and intermediate ones (some packs tag few)
const tagged = cands.groomer.filter((c) => c.pref === 0), untagged = cands.groomer.filter((c) => c.pref === 1);
/** pick n spots from a pool: shuffled runs round-robin (up to 3 spots a run when the pool is small), each
 *  at a random point with 250 m of line still below it, inside the 1 m set */
function pick(pool, n, kind) {
  const runs = shuffle(pool.slice()), spots = [];
  for (let round = 0; round < 3 && spots.length < n; round++) {
    for (const c of runs) {
      if (spots.length >= n) break;
      if (round > 0 && runs.length * round >= n) break;
      // one road split into many OSM ways is still one road: at most 2 spots a name on the first pass
      if (round === 0 && spots.filter((s) => s.name === c.name).length >= 2) continue;
      for (let tries = 0; tries < 8; tries++) {
        const maxK = Math.max(0, c.line.length - 1 - 50);
        const k = Math.floor(rand() * (maxK + 1));
        const [x, y] = c.line[k];
        if (!inFine(x, y)) continue;
        // the 250 m below the spot drops at the kind's pitch (a run's line can flatten or climb at its foot)
        const e = c.line[Math.min(c.line.length - 1, k + 50)], drop = Math.atan2(c.line[k][2] - e[2], Math.hypot(e[0] - x, e[1] - y)) * 180 / Math.PI;
        if (drop < (kind === 'groomer' ? 6 : 1.5)) continue;
        if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < 150)) continue;
        const ahead = c.line[Math.min(c.line.length - 1, k + 4)];
        const h = Math.atan2(ahead[0] - x, ahead[1] - y);
        spots.push({ kind, name: c.name, difficulty: c.difficulty, x: Math.round(x), y: Math.round(y), h: +(h * 180 / Math.PI).toFixed(0), grade: +c.grade.toFixed(1), line: c.line.slice(k).map((q) => [+q[0].toFixed(1), +q[1].toFixed(1)]) });
        break;
      }
    }
  }
  return spots;
}
// three candidates per spot wanted: the page skips one whose start is off the groomed mask or under trees
// (OSM lines drift off the lidar's cut), in this order, so the same pack and seed give the same spots
const pending = { groomer: pick(tagged, N_GROOM * 3, 'groomer'), track: pick(cands.track, N_TRACK * 3, 'track') };
pending.groomer.push(...pick(untagged, N_GROOM * 3, 'groomer').filter((s) => !pending.groomer.some((q) => Math.hypot(q.x - s.x, q.y - s.y) < 150)));
const want = { groomer: N_GROOM, track: N_TRACK };
if (!pending.groomer.length && !pending.track.length) { console.error('no groomer or cat track spots found in features.json'); process.exit(2); }
console.log(`seed ${SEED}: ${tagged.length} groomed and ${untagged.length} untagged groomer and ${cands.track.length} cat track lines, ${pending.groomer.length} and ${pending.track.length} candidate spots`);
const spotLine = (s) => `  ${s.id.padEnd(4)} ${s.kind.padEnd(8)} ${s.name.slice(0, 34).padEnd(34)} ${String(s.difficulty).padEnd(12)} x ${String(s.x).padStart(6)} y ${String(s.y).padStart(6)} h ${String(s.h).padStart(4)} deg  line ${s.grade} deg, ${(s.line.length - 1) * 5} m below`;
const spots = [];

// ---------------------------------------------------------------- server and page
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.wasm': 'application/wasm' };
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
const browser = await launchBrowser(args);
let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&lowgfx${process.env.SHOT_QUERY ?? ''}`);
  await page.waitForFunction(() => window.__step && window.__sim, null, { timeout: 120000 });
  page.setDefaultTimeout(300000);
  await page.evaluate(() => {
    const s = window.__sim;
    s.settings.timeOfDay = 13; s.settings.snowDay = 'mid'; s.settings.newSnow = 'none';
    s.applySettings('newSnow'); s.setWeather(null);
  });

  /** move the rider to the spot, load the 1 m heights and the mask over the ride, and let the frame loop
   *  stream the trees, rocks and shrubs (colliders) around it; returns what is under the spot */
  const place = async (sp) => {
    await page.evaluate(([sp]) => {
      const s = window.__sim, R = 700;
      s.rider.reset(sp.x, sp.y, sp.h * Math.PI / 180);
      s.cam.snapTo(s.rider);
      s.pack.fine?.request(sp.x - R, sp.y - R, sp.x + R, sp.y + R); s.pack.mask?.request(sp.x - R, sp.y - R, sp.x + R, sp.y + R);
    }, [sp]);
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      ready = await page.evaluate(([sp]) => { const p = window.__sim.pack; return !!p.fine && !Number.isNaN(p.fine.sample(sp.x, sp.y)) && p.fine.inFlight === 0 && (!p.mask || (p.mask.has(sp.x, sp.y) && p.mask.inFlight === 0)); }, [sp]);
      if (!ready) await page.waitForTimeout(250);
    }
    // the frame loop streams the vegetation around the rider; hold the rider on the spot while it does
    let settled = false;
    for (let i = 0; i < 40 && !settled; i++) {
      settled = await page.evaluate(([sp, i]) => {
        const s = window.__sim;
        s.rider.reset(sp.x, sp.y, sp.h * Math.PI / 180);
        window.__step(1, 1 / 60);
        return i >= 3 && (s.veg?.pending ?? 0) === 0 && (s.shrubs?.pending ?? 0) === 0 && s.pack.fine.inFlight === 0;
      }, [sp, i]);
      if (!settled) await page.waitForTimeout(200);
    }
    return page.evaluate(([sp]) => { const p = window.__sim.pack, m = p.mask ? p.mask.sample(sp.x, sp.y) : [0, 0, 0, 0]; return { ready: !Number.isNaN(p.fine.sample(sp.x, sp.y)), groomed: m[2], canopy: m[3] }; }, [sp]);
  };

  /** one ride from the spot: `mode` 'tuck' (straight down the line, tucked) or 'carve' (linked carves
   *  either side of it). Steps the physics one 1/120 s step per call (as update(1/60) does two), so no
   *  takeoff or landing is missed between frames. */
  const ride = (sp, mode) => page.evaluate(([sp, mode, SECS, V0, AIR_MIN]) => {
    const s = window.__sim, r = s.rider, pack = s.pack;
    const h0 = sp.h * Math.PI / 180;
    r.reset(sp.x, sp.y, h0);
    // start on the snow at V0 along the line, moving with the surface (reset drops the rider 0.5 m above it)
    const n0 = pack.groundNormal(sp.x, sp.y);
    r.z = pack.groundHeight(sp.x, sp.y);
    r.vx = Math.sin(h0) * V0; r.vy = Math.cos(h0) * V0; r.vz = -(r.vx * n0[0] + r.vy * n0[1]) / Math.max(0.2, n0[2]);
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const line = sp.line;
    let idx = 0, side = 1, sideT = 0;
    const inp = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false };
    const st = { dist: 0, takeoffs: 0, terrain: 0, ramps: 0, airs: 0, longest: 0, airTotal: 0, maxHeight: 0, crashes: 0, crashWhy: [], top: 0, onPiste: 0, steps: 0, offLine: 0, list: [], hits: {} };
    // the air is timed here in steps (land() zeroes r.airTime on the landing step)
    let lastWall = -1e9;
    let wasGround = r.onGround, wasCrashed = false, airStart = null, airH = 0, airSteps = 0, px = r.x, py = r.y;
    const closeAir = () => {
      const t = airSteps / 120;
      st.airTotal += t; st.longest = Math.max(st.longest, t); st.maxHeight = Math.max(st.maxHeight, airH);
      if (t > AIR_MIN) { st.airs++; st.list.push({ ...airStart, air: +t.toFixed(2), height: +airH.toFixed(2) }); }
      airStart = null; airH = 0; airSteps = 0;
    };
    const frames = Math.round(SECS * 60);
    for (let f = 0; f < frames; f++) {
      // steer: pure pursuit on the line, a look-ahead point about a second out; past its end, the fall line
      let best = Infinity;
      for (let k = Math.max(0, idx - 4); k < Math.min(line.length, idx + 60); k++) { const d = Math.hypot(line[k][0] - r.x, line[k][1] - r.y); if (d < best) { best = d; idx = k; } }
      if (best > 40) st.offLine++;
      const spd = Math.hypot(r.vx, r.vy);
      const la = Math.round(Math.max(12, spd * 1.0) / 5);
      let want;
      if (idx + la < line.length) { const q = line[idx + la]; want = Math.atan2(q[0] - r.x, q[1] - r.y); }
      else { const n = r.normal; want = Math.atan2(n[0], n[1]); }
      const travel = spd > 1 ? Math.atan2(r.vx, r.vy) : r.heading;
      if (mode === 'tuck') { inp.tuck = true; inp.steer = Math.max(-1, Math.min(1, 2 * wrap(want - travel))); }
      else {
        // linked carves: drive to 35 deg off the line on one side, then the other
        const target = want + side * 0.6;
        const err = wrap(target - travel);
        inp.tuck = false; inp.steer = Math.max(-1, Math.min(1, 3 * err));
        sideT += 1 / 60;
        if ((sideT > 0.5 && Math.abs(err) < 0.12) || sideT > 2.5) { side = -side; sideT = 0; }
      }
      for (let k = 0; k < 2; k++) {
        r.lastHit = '';
        r.update(1 / 120, inp);
        st.steps++;
        st.dist += Math.hypot(r.x - px, r.y - py); px = r.x; py = r.y;
        st.top = Math.max(st.top, r.speed);
        if (r.lastHit && r.lastHit !== 'ramp') st.hits[r.lastHit] = (st.hits[r.lastHit] ?? 0) + 1;
        if (r.lastHit === 'wall' || r.lastHit === 'graze') lastWall = st.steps;
        if (r.surface.groomed > 0.5) st.onPiste++;
        const crashed = r.crashed > 0;
        if (crashed && !wasCrashed) {
          // why: the collision (wall, catch), else a landing (on the step the rider came down), else on the snow (a washout)
          const why = r.lastHit || (!wasGround && r.onGround ? 'landing' : !r.onGround ? 'air' : 'snow');
          st.crashes++; st.crashWhy.push(why);
          st.list.push({ crash: why, t: +(st.steps / 120).toFixed(2), x: +r.x.toFixed(0), y: +r.y.toFixed(0), speed: +r.speed.toFixed(1), slope: +r.slopeDeg.toFixed(0), air: why === 'landing' ? +(airSteps / 120).toFixed(2) : 0 });
        }
        wasCrashed = crashed;
        if (wasGround && !r.onGround) {
          // why: a collider ramp (a rock), knocked off by a wall or trunk in the last 0.5 s, else the ground itself (followGround)
          const why = r.lastHit === 'ramp' ? 'ramp' : st.steps - lastWall < 60 ? 'wall' : 'terrain';
          st.takeoffs++;
          if (why === 'ramp') st.ramps++;
          if (why === 'terrain') st.terrain++;
          airStart = { x: +r.x.toFixed(0), y: +r.y.toFixed(0), speed: +Math.hypot(r.vx, r.vy).toFixed(1), slope: +r.slopeDeg.toFixed(0), why };
        }
        if (!r.onGround) { airSteps++; airH = Math.max(airH, r.z - pack.groundHeight(r.x, r.y, r.z)); }
        if (!wasGround && r.onGround && airStart) closeAir();
        wasGround = r.onGround;
      }
    }
    if (!r.onGround && airStart) closeAir();
    st.coarse = r.coarseSteps; st.endSpeed = r.speed;
    return st;
  }, [sp, mode, SECS, V0, AIR_MIN]);

  const rows = [];
  const skipped = [];
  const have = (kind) => spots.filter((s) => s.kind === kind).length;
  async function rideSpot(sp, at, kind, mark) {
    sp.id = `${kind === 'groomer' ? 'G' : 'T'}${have(kind) + 1}${mark}`;
    sp.offMask = !!mark;
    spots.push(sp);
    console.log(spotLine(sp));
    for (const mode of ['tuck', 'carve']) {
      const st = await ride(sp, mode);
      rows.push({ sp, mode, at, st });
      const flags = [!at.ready ? 'NO 1m TILE' : '', at.canopy > 0.5 ? `canopy ${at.canopy.toFixed(2)}` : '', st.coarse ? `coarse ${st.coarse} steps` : '', st.offLine > SECS * 30 ? 'left the line' : '', st.crashes ? `crash ${st.crashWhy.join('/')}` : '', st.ramps ? `${st.ramps} ramp` : '', Object.keys(st.hits).length ? `hits ${Object.entries(st.hits).map(([k, v]) => `${k} ${v}`).join(' ')}` : '', st.endSpeed < 2 ? `stopped (${st.endSpeed.toFixed(1)} m/s at the end)` : ''].filter(Boolean).join(', ');
      console.log(`${sp.id.padEnd(4)} ${mode.padEnd(5)} ${sp.name.slice(0, 26).padEnd(26)} ${(st.dist / 1000).toFixed(2).padStart(5)} km  top ${st.top.toFixed(1).padStart(4)}  takeoffs ${String(st.takeoffs).padStart(3)} (terrain ${String(st.terrain).padStart(2)})  airs>${AIR_MIN} ${String(st.airs).padStart(3)}  longest ${st.longest.toFixed(2)} s  air ${st.airTotal.toFixed(2).padStart(5)} s  high ${st.maxHeight.toFixed(2)} m  piste ${(100 * st.onPiste / st.steps).toFixed(0).padStart(3)}%  g ${at.groomed.toFixed(2)}${flags ? '  ' + flags : ''}`);
      if (LIST) for (const a of st.list) console.log(a.crash ? `        crash (${a.crash}) at ${a.t} s, x ${a.x} y ${a.y} at ${a.speed} m/s on ${a.slope} deg${a.air ? ` after ${a.air} s in the air` : ''}`
        : `        air ${a.air.toFixed(2)} s  ${a.height.toFixed(2)} m high  from x ${a.x} y ${a.y} at ${a.speed} m/s on ${a.slope} deg (${a.why})`);
    }
  }
  for (const kind of ['groomer', 'track']) {
    // first the candidates on the groomed mask in the open; if too few (a pack whose mask leaves runs
    // ungroomed), then the open ones off it, marked * (the rider rides them as ungroomed snow)
    const off = [];
    for (const sp of pending[kind]) {
      if (have(kind) >= want[kind]) break;
      const at = await place(sp);
      if (!at.ready || at.groomed < 0.5 || at.canopy > 0.5) {
        skipped.push(`${sp.name} (${sp.x}, ${sp.y}): ${!at.ready ? 'no 1 m tile' : `groomed ${at.groomed.toFixed(2)}, canopy ${at.canopy.toFixed(2)}`}`);
        if (at.ready && at.canopy <= 0.5) off.push(sp);
        continue;
      }
      await rideSpot(sp, at, kind, '');
    }
    for (const sp of off) {
      if (have(kind) >= want[kind]) break;
      await rideSpot(sp, await place(sp), kind, '*');
    }
  }

  // ---------------------------------------------------------------- totals
  const sum = (rs) => {
    const km = rs.reduce((a, r) => a + r.st.dist, 0) / 1000;
    const t = (k) => rs.reduce((a, r) => a + r.st[k], 0);
    return { rides: rs.length, km, takeoffs: t('takeoffs'), terrain: t('terrain'), airs: t('airs'), longest: Math.max(0, ...rs.map((r) => r.st.longest)), airTotal: t('airTotal'), crashes: t('crashes'), ramps: t('ramps') };
  };
  const groups = [['groomer tuck', (r) => r.sp.kind === 'groomer' && r.mode === 'tuck'], ['groomer carve', (r) => r.sp.kind === 'groomer' && r.mode === 'carve'], ['track tuck', (r) => r.sp.kind === 'track' && r.mode === 'tuck'], ['track carve', (r) => r.sp.kind === 'track' && r.mode === 'carve'], ['groomers', (r) => r.sp.kind === 'groomer'], ['cat tracks', (r) => r.sp.kind === 'track'], ['all', () => true]];
  console.log(`\ntotals (${pack}, ${SECS} s rides from ${V0} m/s):`);
  console.log(`  ${'group'.padEnd(14)} rides     km  takeoffs/km  terrain/km  airs>${AIR_MIN}/km  longest s  air s/km  takeoffs  terrain  airs  crashes`);
  const totals = {};
  for (const [name, f] of groups) {
    const rs = rows.filter(f);
    if (!rs.length) continue;
    const g = totals[name] = sum(rs);
    const per = (v) => (g.km > 0 ? v / g.km : 0);
    console.log(`  ${name.padEnd(14)} ${String(g.rides).padStart(5)} ${g.km.toFixed(2).padStart(6)} ${per(g.takeoffs).toFixed(1).padStart(12)} ${per(g.terrain).toFixed(1).padStart(11)} ${per(g.airs).toFixed(1).padStart(13)} ${g.longest.toFixed(2).padStart(10)} ${per(g.airTotal).toFixed(2).padStart(9)} ${String(g.takeoffs).padStart(9)} ${String(g.terrain).padStart(8)} ${String(g.airs).padStart(5)} ${String(g.crashes).padStart(8)}`);
  }
  console.log(`\nspots (${pack}, seed ${SEED}; * = off the groomed mask, ridden to make up the count):`);
  for (const s of spots) console.log(spotLine(s));
  if (skipped.length) console.log(`${skipped.length} candidate(s) off the groomed mask or under trees: ${skipped.join('; ')}`);
  const errs = errors.filter((e) => !e.includes('Failed to load resource'));
  if (errs.length) console.log(`\nconsole errors: ${errs.slice(0, 3).join(' | ').slice(0, 400)}`);
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ pack, dist: DIST, seed: SEED, secs: SECS, v0: V0, spots: spots.map(({ line, ...s }) => s), rides: rows.map((r) => ({ id: r.sp.id, mode: r.mode, at: r.at, ...r.st })), totals }, null, 1));
    console.log(`wrote ${JSON_OUT}`);
  }
  if (MAX_TPK != null && totals.all && totals.all.km > 0 && totals.all.terrain / totals.all.km > Number(MAX_TPK)) {
    console.log(`FAIL ${(totals.all.terrain / totals.all.km).toFixed(1)} terrain takeoffs/km is over --max-takeoffs-per-km ${MAX_TPK}`);
    exitCode = 1;
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(exitCode);
