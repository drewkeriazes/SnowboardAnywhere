// Before / after render comparison: two builds (an old commit's saved build, this worktree's dist/, any dist folder),
// each with its own pack, shot from the SAME world camera on the GPU, written as a slider page with the two stills
// side by side under it. Also keeps baselines: an old commit built once and its pack, kept untracked for later compares.
//
//   node tools/compare.mjs --a baseline:aaa8454 --b here --shot back-bowls          (after `npx vite build`)
//   node tools/compare.mjs --a here --b dist:dist-exp --b-query "&myFlag" --view aerial --pack vail
//   node tools/compare.mjs baseline <git ref> [--name N] [--pack-release vail-v1] [--slug vail] [--from-dist D] [--from-pack P]
//   node tools/compare.mjs baselines                                                (list them)
//
// Sides (--a, --b; a is the left / "before"):
//   here             this worktree's game/dist (build it first), packs from SHOT_PACKS or the repo's packs/
//   dist:<path>      another build folder (relative to game/), same packs
//   baseline:<name>  <baselines>/<name>/dist with <baselines>/<name>/packs (made by `baseline` below)
//   --a-packs / --b-packs <dir>   a packs folder for that side (a folder holding <slug>/meta.json), e.g. MapPacker's packs/
//   --a-query / --b-query "&k=v"  URL parameters for that side (a build's experiment flag)
//   --a-settings / --b-settings k=v,k=v   saved-settings fields seeded before load (forestDensity=0, treeDensity=0.6 ...)
//   --a-label / --b-label         the caption (default: the baseline's commit and date, or this worktree's HEAD)
// Camera (one of): --shot <id> (attract/<pack>/shots.json, pose at the start of its drift, and the shot's conditions on
//   builds that have them), --view <label> (tools/canopy-views.json), --at x,y,h,pitch,fov,eye (pack metres, degrees,
//   eye metres over the snow), or --chase x,y,h[,speed] (BUG-125: the rider held at x, y heading h degrees, riding
//   at speed m/s (default 8), seen from the chase camera with see-through trees on; the ride camera and the tree fade
//   are what a still shows). Default: the pack's first menu shot. --pack <slug> (default vail).
// The ground differs between packs, so the reference side (b, or --ref a) is shot first at its eye height, and the other
// side is pinned to that camera's world height: both stills come from the exact same point. Each side's camera is
// logged in compare.json so the match can be checked.
// Output: game/shots/compare/<name>/ (gitignored; --out <dir>, --name <name>): a.jpg, b.jpg, compare.json, index.html.
// Gotchas paid for (see .claude/skills/render-compare/SKILL.md): wait for the terrain to finish building (old builds cap
// chunk builds per frame; an early still shows see-through ground), keep re-pinning the eye while tiles land, real GPU only.
import { launchBrowser } from './browser.mjs';
import { DIST, PACKS, GAME, REPO } from './paths.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const run = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim();
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// Baselines live at the MAIN checkout (shared by every worktree), gitignored: <main>/baselines, or SBA_BASELINES.
function mainCheckout() {
  try { return path.resolve(path.dirname(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO }))); } catch { return REPO; }
}
const BASELINES = process.env.SBA_BASELINES ? path.resolve(process.env.SBA_BASELINES) : path.join(mainCheckout(), 'baselines');

if (argv[0] === 'baselines') { listBaselines(); process.exit(0); }
if (argv[0] === 'baseline') { await makeBaseline(); process.exit(0); }
await compare();

// ---------------------------------------------------------------------------------------------------------------------
function listBaselines() {
  if (!fs.existsSync(BASELINES)) { console.log(`no baselines yet (${BASELINES})`); return; }
  for (const n of fs.readdirSync(BASELINES)) {
    const f = path.join(BASELINES, n, 'baseline.json');
    if (!fs.existsSync(f)) continue;
    const b = readJson(f);
    console.log(`${n.padEnd(14)} ${b.commit} ${b.date}  packs: ${(b.packs ?? []).join(', ') || 'none'}  ${b.subject ?? ''}`);
  }
}

/** Build an old commit once (in a temporary worktree, its own npm install) and keep dist/ and a pack under baselines/. */
async function makeBaseline() {
  const ref = argv[1];
  if (!ref) { console.log('usage: node tools/compare.mjs baseline <git ref> [--name N] [--pack-release <tag>] [--slug vail] [--from-dist D] [--from-pack P]'); process.exit(2); }
  const sha = run('git', ['rev-parse', '--short', `${ref}^{commit}`], { cwd: REPO });
  const name = opt('name', sha), dir = path.join(BASELINES, name), slug = opt('slug', 'vail');
  const info = { name, commit: sha, date: run('git', ['log', '-1', '--format=%cd', '--date=format:%Y-%m-%d %H:%M', sha], { cwd: REPO }), subject: run('git', ['log', '-1', '--format=%s', sha], { cwd: REPO }), packs: [], packSource: {} };
  fs.mkdirSync(path.join(dir, 'packs'), { recursive: true });
  const fromDist = opt('from-dist');
  if (fromDist) {
    fs.cpSync(path.resolve(fromDist), path.join(dir, 'dist'), { recursive: true });
    console.log(`dist copied from ${fromDist}`);
  } else if (!fs.existsSync(path.join(dir, 'dist', 'index.html'))) {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), `sba-baseline-${sha}-`));
    fs.rmSync(wt, { recursive: true, force: true });
    console.log(`building ${sha} in ${wt}`);
    run('git', ['worktree', 'add', '--detach', wt, sha], { cwd: REPO });
    try {
      const g = path.join(wt, 'game'), npm = process.platform === 'win32' ? 'npm.cmd' : 'npm', npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      run(npm, [fs.existsSync(path.join(g, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund'], { cwd: g, shell: true });
      run(npx, ['vite', 'build'], { cwd: g, shell: true });
      fs.cpSync(path.join(g, 'dist'), path.join(dir, 'dist'), { recursive: true });
    } finally {
      run('git', ['worktree', 'remove', '--force', wt], { cwd: REPO });
    }
  }
  const fromPack = opt('from-pack'), tag = opt('pack-release');
  const packDir = path.join(dir, 'packs', slug);
  if (fromPack) {
    fs.cpSync(path.resolve(fromPack), packDir, { recursive: true });
    info.packSource[slug] = { from: path.resolve(fromPack) };
  } else if (tag) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-pack-'));
    run('gh', ['release', 'download', tag, '-R', 'drewkeriazes/MapPacker-SnowboardAnywhere', '-p', '*.zip', '-D', tmp]);
    const zip = fs.readdirSync(tmp).find((f) => f.endsWith('.zip'));
    fs.mkdirSync(packDir, { recursive: true });
    if (process.platform === 'win32') run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', path.join(tmp, zip), '-C', packDir]);
    else run('unzip', ['-q', '-o', path.join(tmp, zip), '-d', packDir]);
    fs.rmSync(tmp, { recursive: true, force: true });
    info.packSource[slug] = { release: tag };
  }
  // a zip may hold the pack at its root or under <slug>/
  if (fs.existsSync(path.join(packDir, slug, 'meta.json')) && !fs.existsSync(path.join(packDir, 'meta.json'))) {
    for (const f of fs.readdirSync(path.join(packDir, slug))) fs.renameSync(path.join(packDir, slug, f), path.join(packDir, f));
    fs.rmdirSync(path.join(packDir, slug));
  }
  if (fs.existsSync(path.join(packDir, 'meta.json'))) {
    const m = readJson(path.join(packDir, 'meta.json'));
    info.packSource[slug] = { ...(info.packSource[slug] ?? {}), build: m.build ?? null, version: m.version ?? null };
  }
  const old = fs.existsSync(path.join(dir, 'baseline.json')) ? readJson(path.join(dir, 'baseline.json')) : {};
  info.packs = fs.readdirSync(path.join(dir, 'packs')).filter((p) => fs.existsSync(path.join(dir, 'packs', p, 'meta.json')));
  info.packSource = { ...(old.packSource ?? {}), ...info.packSource };
  info.notes = opt('notes', old.notes ?? '');
  fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify(info, null, 2) + '\n');
  console.log(`baseline ${name} at ${dir}:`, JSON.stringify(info));
}

// ---------------------------------------------------------------------------------------------------------------------
function side(key) {
  const spec = opt(key, key === 'b' ? 'here' : null);
  if (!spec) { console.log(`--${key} missing: here | dist:<path> | baseline:<name>`); process.exit(2); }
  let dist, packs = PACKS, label, kind = spec;
  if (spec === 'here') {
    dist = DIST;
    let head = '';
    try { head = run('git', ['log', '-1', '--format=%h %cd', '--date=format:%Y-%m-%d', 'HEAD'], { cwd: REPO }); } catch { /* not a checkout */ }
    let br = '';
    try { br = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO }); } catch { /* ignore */ }
    label = `${br && br !== 'HEAD' ? `${br} ` : ''}${head}`.trim() || 'this build';
  } else if (spec.startsWith('dist:')) {
    dist = path.resolve(GAME, spec.slice(5)); label = path.basename(dist);
  } else if (spec.startsWith('baseline:')) {
    const n = spec.slice(9), dir = path.join(BASELINES, n);
    if (!fs.existsSync(path.join(dir, 'baseline.json'))) { console.log(`no baseline ${n} in ${BASELINES} (node tools/compare.mjs baselines)`); process.exit(2); }
    const b = readJson(path.join(dir, 'baseline.json'));
    dist = path.join(dir, 'dist'); packs = path.join(dir, 'packs'); label = `${b.commit} ${b.date.slice(0, 10)}`;
  } else { console.log(`--${key} ${spec}: expected here | dist:<path> | baseline:<name>`); process.exit(2); }
  if (opt(`${key}-packs`)) packs = path.resolve(opt(`${key}-packs`));
  if (!fs.existsSync(path.join(dist, 'index.html'))) { console.log(`--${key}: no build at ${dist} (npx vite build first)`); process.exit(2); }
  const settings = Object.fromEntries((opt(`${key}-settings`, '') || '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, Number.isNaN(Number(v)) ? v : Number(v)]; }));
  return { key, spec: kind, dist, packs, label: opt(`${key}-label`, label), query: opt(`${key}-query`, ''), settings };
}

function camera(pack, packsDirs) {
  const chase = opt('chase');
  if (chase) {
    const [x, y, h, speed = 8] = chase.split(',').map(Number);
    return { id: `chase ${x},${y}`, x, y, h, pitch: 0, fov: 0, eye: 0, speed, chase: true, conditions: false };
  }
  const at = opt('at');
  if (at) {
    const [x, y, h, pitch = -5, fov = 50, eye = 1.7] = at.split(',').map(Number);
    return { id: `at ${x},${y}`, x, y, h, pitch, fov, eye, conditions: false };
  }
  const view = opt('view');
  if (view) {
    const v = readJson(path.join(GAME, 'tools', 'canopy-views.json')).find((q) => q.label === view);
    if (!v) { console.log(`no view ${view} in tools/canopy-views.json`); process.exit(2); }
    return { id: view, x: v.x, y: v.y, h: v.h, pitch: v.pitch ?? 0, fov: v.fov ?? 50, eye: v.eye ?? 1.7, conditions: false };
  }
  const files = [path.join(GAME, 'public', 'attract', pack, 'shots.json'), ...packsDirs.map((d) => path.join(d, pack, 'attract', 'shots.json'))];
  const f = files.find((q) => fs.existsSync(q));
  if (!f) { console.log(`no menu shots for ${pack}: give --view or --at`); process.exit(2); }
  const shots = readJson(f), id = opt('shot');
  const s = id ? shots.find((q) => q.id === id) : shots[0];
  if (!s) { console.log(`no shot ${id} in ${f}`); process.exit(2); }
  // the pose where the live menu starts: half the pan left of the heading (world/AttractShots.ts shotPose at t = 0)
  return { id: s.id, x: s.x, y: s.y, h: s.h - (s.pan ?? 0) / 2, pitch: s.pitch, fov: s.fov, eye: s.eye, conditions: true };
}

/** Serve one side's dist and packs; returns { base, close }. */
async function serve(sd, attractFrom) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wasm': 'application/wasm' };
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    let root, rel;
    if (u.startsWith('/packs/')) { root = sd.packs; rel = u.slice(7); }
    else if (u.startsWith('/attract/') && attractFrom && fs.existsSync(path.join(attractFrom, u.slice(9)))) { root = attractFrom; rel = u.slice(9); }
    else { root = sd.dist; rel = u; }
    const p = path.join(root, rel);
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  return { base: `http://localhost:${server.address().port}`, close: () => server.close() };
}

/** Shoot one side. worldZ null = eye metres over this pack's ground (the reference side); else pinned to that height. */
async function shoot(browser, sd, cam, pack, worldZ, outFile) {
  // a here / dist build serves this checkout's current attract/ (the shot data), as shoot_attract.mjs does
  const srv = await serve(sd, sd.spec.startsWith('baseline:') ? null : path.join(GAME, 'public', 'attract'));
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (Object.keys(sd.settings).length) {
    await page.addInitScript((o) => { try { const s = JSON.parse(localStorage.getItem('settings') || '{}'); s.v = s.v ?? 1; Object.assign(s, o); localStorage.setItem('settings', JSON.stringify(s)); } catch { /* no storage */ } }, sd.settings);
  }
  // old builds (before the eye camera) load trees round the rider, so the rider spawns under the camera; current ones
  // read cam=eye; each ignores the other's parameters
  await page.goto(`${srv.base}/index.html?pack=${pack}&headless${cam.chase ? '' : '&cam=eye'}&x=${cam.x}&y=${cam.y}&h=${cam.h}${sd.query}${process.env.SHOT_QUERY ?? ''}`);
  await page.waitForFunction(() => window.__step, null, { timeout: 180000 });
  page.setDefaultTimeout(300000);
  await page.evaluate(() => window.__step(1, 1 / 60));
  const driver = await page.evaluate(() => (typeof window.__sim?.eyeAt === 'function' ? 'eye' : window.__sim?.cam?.updateFree ? 'free' : 'none'));
  if (driver === 'none') throw new Error(`${sd.label}: this build exposes neither __sim.eyeAt nor a free camera`);
  if (cam.conditions && driver === 'eye') await page.evaluate(() => window.__sim.shotConditions?.());
  const pin = () => page.evaluate(([C, Z, drv]) => {
    const s = window.__sim, g = s.pack.groundHeight(C.x, C.y), z = Z ?? (Number.isFinite(g) ? g : 0) + C.eye;
    if (C.chase) {
      // the rider back on the spot every frame of the settle, riding along h, the chase camera behind
      const r = s.rider, a = C.h * Math.PI / 180;
      s.cam.mode = 'chase'; s.settings.seeThroughTrees = true;
      for (let i = 0; i < 4; i++) { r.reset(C.x, C.y, a); r.vx = Math.sin(a) * C.speed; r.vy = Math.cos(a) * C.speed; window.__step(1, 1 / 60); }
      r.reset(C.x, C.y, a); r.vx = Math.sin(a) * C.speed; r.vy = Math.cos(a) * C.speed;
      return z;
    }
    if (drv === 'eye') { s.eyeAt(C.x, C.y, C.h, C.pitch, C.fov, z - (Number.isFinite(g) ? g : 0)); return z; }
    const c = s.cam;
    if (!c.__pinned) {
      // the free camera (aaa8454 era): yaw clockwise from north, its own FOV each frame; hold the pose and FOV
      c.mode = 'free'; const orig = c.updateFree.bind(c);
      c.updateFree = (dt) => { c.freePos.set(c.__pin.x, c.__pin.z, -c.__pin.y); orig(dt, new Set(), 0, 0); c.camera.fov = c.__pin.fov; c.camera.updateProjectionMatrix(); };
      c.__pinned = true;
    }
    c.yaw = C.h * Math.PI / 180; c.pitch = C.pitch * Math.PI / 180; c.__pin = { x: C.x, y: C.y, z, fov: C.fov };
    return z;
  }, [cam, worldZ, driver]);
  await pin();
  // settle: step until nothing is loading or building for 3 checks in a row (at least 20 checks, at most 160)
  let quiet = 0, last = '';
  for (let i = 0; i < 160 && (quiet < 3 || i < 20); i++) {
    await page.evaluate(() => window.__step(4, 1 / 60));
    await page.waitForTimeout(200);
    await pin();
    const st = await page.evaluate(() => {
      const s = window.__sim, p = s.pack;
      const sets = [p.fine, p.mid, p.far, p.mask].filter(Boolean);
      const pend = sets.reduce((n, t) => n + (t.pending?.size ?? 0), 0);
      const loaded = sets.map((t) => t.loadedCount ?? 0).join(',');
      const veg = s.veg?.cells?.values ? [...s.veg.cells.values()].filter((c) => c.loading).length : 0;
      return { busy: pend + veg + (s.veg?.pending ?? 0) + (s.terrain?.stats?.builds ?? 0), loaded };
    });
    quiet = st.busy === 0 && st.loaded === last ? quiet + 1 : 0; last = st.loaded;
  }
  if (cam.conditions && driver === 'eye') await page.evaluate(() => window.__sim.shotConditions?.());
  const z = await pin();
  await page.evaluate(() => window.__step(1, 1 / 60));
  const url = await page.evaluate(() => window.__shot());
  const info = await page.evaluate(([X, Y]) => {
    const s = window.__sim, c = s.cam.camera, d = new c.position.constructor();
    c.getWorldDirection(d);
    const out = { pos: c.position.toArray().map((v) => +v.toFixed(3)), dir: d.toArray().map((v) => +v.toFixed(5)), fov: c.fov, aspect: +c.aspect.toFixed(4), build: s.pack.meta.build ?? null, trees: s.veg?.stats ?? null };
    // drawn crown cover (crown disc area / ground) round the camera, where the build keeps per-tree radii (cell.cr)
    const cells = s.veg?.cells?.values ? [...s.veg.cells.values()] : [];
    if (cells.some((q) => q.cr)) {
      out.crownCover = {};
      for (const R of [250, 600, 1500]) {
        let disc = 0;
        for (const q of cells) {
          if (!q.data || !q.cr) continue;
          for (let i = 0, n = q.data.length / 6; i < n; i++) { const dx = q.data[i * 6] - X, dy = q.data[i * 6 + 1] - Y; if (dx * dx + dy * dy <= R * R) disc += Math.PI * q.cr[i] ** 2; }
        }
        out.crownCover[R] = +(disc / (Math.PI * R * R)).toFixed(3);
      }
    }
    return out;
  }, [cam.x, cam.y]);
  const jpg = await page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/jpeg', 0.9);
  }, url);
  fs.writeFileSync(outFile, Buffer.from(jpg.split(',')[1], 'base64'));
  await page.close(); srv.close();
  return { ...info, driver: cam.chase ? 'chase' : driver, worldZ: z, errors };
}

async function compare() {
  const pack = opt('pack', 'vail');
  const A = side('a'), B = side('b');
  const cam = camera(pack, [B.packs, A.packs, PACKS]);
  const name = opt('name', `${pack}-${cam.id}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`).replace(/[^\w.-]+/g, '-');
  const out = path.resolve(opt('out', path.join(GAME, 'shots', 'compare', name)));
  fs.mkdirSync(out, { recursive: true });
  const browser = await launchBrowser(argv.includes('--headed') ? ['--headed'] : ['--gpu']);
  const refKey = opt('ref', 'b');
  const [first, second] = refKey === 'a' ? [A, B] : [B, A];
  console.log(`camera ${cam.id}: x ${cam.x}, y ${cam.y}, h ${cam.h}, pitch ${cam.pitch}, fov ${cam.fov}, eye ${cam.eye} m (reference side ${first.key})`);
  const r1 = await shoot(browser, first, cam, pack, null, path.join(out, `${first.key}.jpg`));
  console.log(`${first.key} ${first.label}: camera ${JSON.stringify(r1.pos)} dir ${JSON.stringify(r1.dir)} [${r1.driver}]${r1.crownCover ? ` crown cover ${JSON.stringify(r1.crownCover)}` : ''}${r1.errors.length ? ` errors: ${r1.errors.join(' | ')}` : ''}`);
  const r2 = await shoot(browser, second, cam, pack, r1.worldZ, path.join(out, `${second.key}.jpg`));
  console.log(`${second.key} ${second.label}: camera ${JSON.stringify(r2.pos)} dir ${JSON.stringify(r2.dir)} [${r2.driver}]${r2.crownCover ? ` crown cover ${JSON.stringify(r2.crownCover)}` : ''}${r2.errors.length ? ` errors: ${r2.errors.join(' | ')}` : ''}`);
  await browser.close();
  const res = { [first.key]: r1, [second.key]: r2 };
  const dp = Math.max(...[0, 1, 2].map((i) => Math.abs(r1.pos[i] - r2.pos[i]))), dd = Math.max(...[0, 1, 2].map((i) => Math.abs(r1.dir[i] - r2.dir[i])));
  // the chase camera's speed FOV eases, so it lands within a hair of the same value on both sides
  const match = dp < 0.01 && dd < 1e-4 && Math.abs(r1.fov - r2.fov) < (cam.chase ? 0.01 : 1e-6);
  console.log(match ? 'cameras match exactly' : `WARNING: cameras differ (position ${dp.toFixed(3)} m, direction ${dd.toExponential(1)})`);
  const meta = { pack, camera: cam, created: new Date().toISOString(), cameraMatch: match, sides: { a: { ...A, result: res.a }, b: { ...B, result: res.b } } };
  fs.writeFileSync(path.join(out, 'compare.json'), JSON.stringify(meta, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'index.html'), sliderPage(meta));
  console.log(`slider: ${path.join(out, 'index.html')}`);
}

function sliderPage(m) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const c = m.camera, a = m.sides.a, b = m.sides.b;
  const sub = (s) => `${esc(s.spec)} · pack ${esc(s.result.build ?? '?')}${s.query ? ` · ${esc(s.query)}` : ''}${Object.keys(s.settings).length ? ` · ${esc(JSON.stringify(s.settings))}` : ''}${s.result.crownCover ? ` · crown cover ${esc(Object.entries(s.result.crownCover).map(([r, v]) => `${v} @${r} m`).join(', '))}` : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.pack)} ${esc(c.id)} compare</title>
<style>
:root{--bg:#14161a;--fg:#eef2f8;--dim:#9aa6b6}
body{margin:0;background:var(--bg);color:var(--fg);font:15px system-ui,sans-serif;padding:16px}
.wrap{position:relative;max-width:1600px;margin:auto;aspect-ratio:16/9;overflow:hidden;user-select:none;cursor:ew-resize;touch-action:none}
.wrap img{position:absolute;inset:0;width:100%;height:100%;display:block}
#top{clip-path:inset(0 50% 0 0)}
#bar{position:absolute;top:0;bottom:0;left:50%;width:3px;background:#fff;box-shadow:0 0 6px #0008}
.tag{position:absolute;top:10px;padding:4px 10px;background:#000a;border-radius:4px;font-weight:600;max-width:46%}
.l{left:10px}.r{right:10px;text-align:right}
.pair{max-width:1600px;margin:14px auto 0;display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pair figure{margin:0}.pair img{width:100%;display:block;border-radius:4px}
.pair figcaption,p{color:var(--dim);font-size:13px;margin-top:6px;line-height:1.4}
p{max-width:1600px;margin:10px auto}
@media (max-width:700px){.pair{grid-template-columns:1fr}}
</style></head><body>
<div class="wrap" id="w"><img src="b.jpg" alt="after"><img id="top" src="a.jpg" alt="before"><div id="bar"></div>
<div class="tag l">${esc(a.label)}</div><div class="tag r">${esc(b.label)}</div></div>
<p>${esc(m.pack)} · ${esc(c.id)} · world camera ${esc(JSON.stringify(b.result.pos))}, heading ${c.h}°, pitch ${c.pitch}°, fov ${c.fov}° · ${m.cameraMatch ? 'cameras match exactly' : 'WARNING: cameras differ'} · drag or ←/→</p>
<div class="pair">
<figure><img src="a.jpg" alt=""><figcaption><b>${esc(a.label)}</b><br>${sub(a)}</figcaption></figure>
<figure><img src="b.jpg" alt=""><figcaption><b>${esc(b.label)}</b><br>${sub(b)}</figcaption></figure>
</div>
<script>
const w=document.getElementById('w'),t=document.getElementById('top'),bar=document.getElementById('bar');let f=.5,drag=false;
const set=v=>{f=Math.min(1,Math.max(0,v));t.style.clipPath='inset(0 '+(100-f*100)+'% 0 0)';bar.style.left=f*100+'%'};
const mv=e=>{const r=w.getBoundingClientRect();set((e.clientX-r.left)/r.width)};
w.addEventListener('pointerdown',e=>{drag=true;mv(e)});addEventListener('pointerup',()=>drag=false);addEventListener('pointermove',e=>drag&&mv(e));
addEventListener('keydown',e=>{if(e.key==='ArrowLeft')set(f-.05);if(e.key==='ArrowRight')set(f+.05)});
</script></body></html>
`;
}
