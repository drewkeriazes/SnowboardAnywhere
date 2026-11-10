// FEAT-181: a resort's main menu, from no backdrop to a still and ghost riders following lines drawn on it.
//   node tools/ghost_lines.mjs <pack>                 the wizard: picks up where the resort got to (rerun any time)
//   node tools/ghost_lines.mjs <pack> <step> [image]  one step: shot | still | lines [image] | ride | check | status
// (after `npx vite build`; on Drew's GPU.) The steps:
//   shot   opens the game headed in the eye camera (?debug): fly to a view, Shift+P, name it (writes
//          game/public/attract/<pack>/shots.json; a new shot replaces the old one and the riders made for it)
//   still  renders the menu still (shoot_attract.mjs) and a clean frame to draw on, draw-<shot>.png (1920 x 1080,
//          no UI, the drift at its start), and opens its folder: draw downhill lines on it in Paint, one colour per
//          line (a colour can be used twice, far apart), and save
//   lines  reads the drawing (or [image]: any snip of the menu, fitted to the game's own frames) and writes
//          lines.png, each line found numbered: check it, or fix the drawing and rerun
//   ride   casts each line onto the terrain, rides it with the rider physics, adds partners, writes the takes
//          (game/public/attract/<pack>/<shot>-<line>-<i>.json, listed in index.json under ghosts and shotGhosts)
//          --riders N (every line), --per "red:3,blue:1:ski,yellow-2:3:1ski,pink:0" (by colour or line name),
//          --trial (write the takes to the work folder only)
//   check  the still against the live menu (shoot_attract.mjs --compare), the report per line, the gap between
//          every two takes, the draw calls with and without the new riders, and the menu headed (--no-open: not)
// Work files: game/shots/ghost-lines/<pack>/<shot>/ (gitignored). Tunables: tools/ghost_lines.config.json.
// docs/developer-guide.md > Ghost riders from lines drawn on the menu; the method: docs/research/ghost-lines-prototype/.
import { launchBrowser } from './browser.mjs';
import { DIST, PACKS, REPO } from './paths.mjs';
import { fitShot, alignRender, extractLines, grey, edges, resize } from './ghost_lines/image.mjs';
import { readIndex, writeIndex, readShots, handleShotPost, handleTakePost } from './attract_files.mjs';
import * as P from './ghost_lines/page.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';

const STEPS = ['shot', 'still', 'lines', 'ride', 'check', 'status'];
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const VALUED = ['riders', 'per'];
const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.includes((argv[i - 1] ?? '').replace(/^--/, '')));
const [pack, stepArg, imageArg] = pos;
if (!pack || (stepArg && !STEPS.includes(stepArg))) {
  console.log(`usage: node tools/ghost_lines.mjs <pack> [${STEPS.join(' | ')}] [image] [--riders N] [--per "red:3,blue:1:ski"] [--trial] [--no-open]`);
  process.exit(2);
}
if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.log('no game/dist: run `npx vite build` first'); process.exit(2); }
if (!fs.existsSync(path.join(PACKS, pack, 'meta.json'))) { console.log(`no pack at packs/${pack}`); process.exit(2); }

// ---- the config: defaults, then the resort's overrides ----
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b ?? {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a?.[k] === 'object' ? merge(a[k], v) : v; return o; };
const CONFIG = JSON.parse(fs.readFileSync(path.join(REPO, 'game', 'tools', 'ghost_lines.config.json'), 'utf8'));
const cfg = merge(CONFIG.defaults, CONFIG.resorts?.[pack]);

const ATTRACT = path.join(REPO, 'game', 'public', 'attract');
const rel = (p) => path.relative(REPO, p).split(path.sep).join('/');
const shotNow = () => readShots(ATTRACT, pack)[0] ?? null;
const workDir = (shot) => path.join(REPO, 'game', 'shots', 'ghost-lines', pack, shot.id);
const mtime = (f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v) + '\n');
const writePng = (f, url) => fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
const rgba = (r) => ({ w: r.w, h: r.h, data: new Uint8Array(Buffer.from(r.b64, 'base64')) });
const openFolder = (d) => { if (process.platform === 'win32' && !flag('no-open')) spawn('explorer.exe', [d], { detached: true, stdio: 'ignore' }).unref(); };

// ---- the built game, served with the attract endpoints (the shot step posts here) ----
/** the build serves its own copy of public/: give it the attract files as they are now */
const syncDist = () => fs.cpSync(ATTRACT, path.join(DIST, 'attract'), { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
let server = null, base = '';
async function serve() {
  if (server) return;
  syncDist();
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/__attract/shot') { res.on('finish', syncDist); return handleShotPost(ATTRACT, req, res); }
    if (req.method === 'POST' && req.url === '/__attract/save') { res.on('finish', syncDist); return handleTakePost(ATTRACT, req, res); }
    const u = decodeURIComponent(req.url.split('?')[0]);
    const [root, r] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
    const p = path.join(root, r);
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
let browser = null;
const headless = async () => (browser ??= await launchBrowser(argv.filter((a) => a !== '--headed')));
/** a headless game page on the shot (its conditions, the ghosts hidden), streamed in and settled */
async function shotPage(width = 1920, height = 1080) {
  await serve();
  const page = await (await headless()).newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(600000);
  await page.goto(`${base}/index.html?pack=${pack}&headless&cam=eye${process.env.SHOT_QUERY ?? ''}`);
  await page.waitForFunction(() => window.__step, null, { timeout: 120000 });
  await page.evaluate(() => window.__step(1, 1 / 60));
  const info = await page.evaluate(P.setup);
  let quiet = 0;
  for (let i = 0; i < 120 && quiet < 3; i++) {
    await page.evaluate(() => window.__step(4, 1 / 60));
    await page.waitForTimeout(250);
    quiet = (await page.evaluate(P.busy)) === 0 ? quiet + 1 : 0;
  }
  return { page, info, errors };
}
/** a blank page for decoding and drawing images (no game needed) */
const blankPage = async () => (await headless()).newPage();
async function done(code = 0) { await browser?.close(); server?.close(); process.exit(code); }
/** run another tool (shoot_attract.mjs), its output through; resolves to its exit code */
const runTool = (args) => new Promise((r) => spawn(process.execPath, args, { cwd: path.join(REPO, 'game'), stdio: 'inherit' }).on('exit', r));

// ---- step: shot ----
async function stepShot() {
  await serve();
  const before = mtime(path.join(ATTRACT, pack, 'shots.json'));
  const b = await launchBrowser(['--headed']);
  const page = await b.newPage({ viewport: null });
  await page.goto(`${base}/index.html?pack=${pack}&debug&cam=eye`);
  console.log(`\nshot: the game is open in the eye camera. Click it, then mouse to look, WASD to move, Q / E for height, [ ] to zoom.
      Frame the menu's backdrop (the title sits top left, the cards along the bottom) and press Shift+P, name it and save.
      Waiting for the shot (close the window to stop)...`);
  let closed = false;
  b.on('disconnected', () => { closed = true; });
  while (!closed && mtime(path.join(ATTRACT, pack, 'shots.json')) === before) await new Promise((r) => setTimeout(r, 500));
  if (!closed) { await new Promise((r) => setTimeout(r, 1500)); await b.close(); }
  const s = shotNow();
  if (mtime(path.join(ATTRACT, pack, 'shots.json')) === before || !s) { console.log('no shot saved'); return false; }
  console.log(`shot saved: ${s.id} (${s.place}${s.region ? `, ${s.region}` : ''}) at x ${s.x}, y ${s.y}, heading ${s.h}, pitch ${s.pitch}, fov ${s.fov}, ${s.eye} m up`);
  return true;
}

// ---- step: still ----
async function stepStill(shot) {
  console.log(`\nstill: rendering ${pack}/${shot.id}`);
  if (await runTool(['tools/shoot_attract.mjs', pack, '--gpu'])) { console.log('shoot_attract.mjs failed'); return false; }
  const dir = workDir(shot);
  fs.mkdirSync(dir, { recursive: true });
  const { page } = await shotPage(1920, 1080);
  await page.evaluate(P.poseAt, 0);
  await page.evaluate(() => window.__step(3, 0));
  const g = await page.evaluate(P.grab);
  await page.close();
  const clean = path.join(dir, 'clean.png'), draw = path.join(dir, `draw-${shot.id}.png`);
  const drawn = fs.existsSync(draw) && mtime(draw) > mtime(clean) + 1000;
  writePng(clean, g.png);
  if (drawn) console.log(`kept your drawing ${rel(draw)} (delete it for a fresh one); the clean frame is ${rel(clean)}`);
  else { fs.copyFileSync(clean, draw); fs.utimesSync(clean, new Date(), new Date(Date.now() - 5000)); }
  console.log(`\nDraw on ${draw}\n  in Paint: downhill lines, one colour per line (a colour can be used twice, far apart; black works too),\n  from where a rider should start to where they finish. Save it (PNG), then rerun: node tools/ghost_lines.mjs ${pack}`);
  openFolder(dir);
  return true;
}

// ---- step: lines ----
async function stepLines(shot, image) {
  const dir = workDir(shot), clean = path.join(dir, 'clean.png');
  image = path.resolve(image ?? path.join(dir, `draw-${shot.id}.png`));
  if (!fs.existsSync(image)) { console.log(`no image at ${image}`); return false; }
  console.log(`\nlines: reading ${image}`);
  if (/\.jpe?g$/i.test(image)) console.log('  note: a JPEG breaks thin strokes up (compression shifts their colour); a PNG is better');
  const page = await blankPage();
  const url = `data:image/${/\.png$/i.test(image) ? 'png' : 'jpeg'};base64,${fs.readFileSync(image).toString('base64')}`;
  const img = rgba(await page.evaluate(P.decode, url));
  // the tool's own drawing frame: no fitting (the clean frame is the render); any other image: fit it
  let fit = null, ref = null, rw = 0, rh = 0;
  if (fs.existsSync(clean)) {
    const c = rgba(await page.evaluate(P.decode, `data:image/png;base64,${fs.readFileSync(clean).toString('base64')}`));
    if (c.w === img.w && c.h === img.h) {
      const a = edges(resize(grey(img), img.w / 4, img.h / 4)), b = edges(resize(grey(c), c.w / 4, c.h / 4));
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0; const n = a.g.length;
      for (let i = 0; i < n; i++) { sa += a.g[i]; sb += b.g[i]; saa += a.g[i] ** 2; sbb += b.g[i] ** 2; sab += a.g[i] * b.g[i]; }
      const ncc = (sab - sa * sb / n) / Math.sqrt((saa - sa * sa / n) * (sbb - sb * sb / n));
      if (ncc > 0.6) { fit = { k: 0, s: 1, ox: 0, oy: 0, score: +ncc.toFixed(3), own: true }; ref = c; rw = c.w; rh = c.h; console.log(`  the tool's drawing frame (match ${ncc.toFixed(3)}): no fitting needed`); }
    }
  }
  await page.close();
  if (!fit) {
    // a snip: the shot rendered across the drift, wider than any window, matched for scale, offset and phase
    const { page: wide, info: wi } = await shotPage(cfg.fit.renderWidth, 1080);
    const renders = [];
    for (let i = 0; i < cfg.fit.phases; i++) {
      const k = +(i / (cfg.fit.phases - 1)).toFixed(3);
      await wide.evaluate(P.poseAt, k);
      await wide.evaluate(() => window.__step(3, 0));
      renders.push({ k, img: rgba(await wide.evaluate(P.grab)) });
    }
    await wide.close();
    const t0 = Date.now();
    fit = fitShot(img, renders, { sMin: cfg.fit.sMin, sMax: cfg.fit.sMax, log: (s) => console.log(`    ${s}`) });
    ref = renders.find((r) => r.k === fit.k).img; rw = wi.w; rh = wi.h;
    console.log(`  fitted the snip: drift phase k ${fit.k}, ${fit.s.toFixed(4)} image px per game px (the game ${Math.round(rh * fit.s)} px tall), its corner at (${Math.round(fit.ox)}, ${Math.round(fit.oy)}), match ${fit.score.toFixed(3)} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    if (fit.score < cfg.fit.minMatch) console.log(`  warning: a weak match (under ${cfg.fit.minMatch}): is this ${pack}'s menu shot? Check lines.png`);
  }
  const aligned = alignRender(img, ref, fit);
  const { jpeg, ...ex } = cfg.extract;
  const { lines, dropped } = extractLines(img, aligned, /\.jpe?g$/i.test(image) ? { ...ex, ...jpeg } : ex);
  for (const d of dropped) console.log(`  left out: ${d.colour} at ${d.box.join(',')}: ${d.why}`);
  console.log(`\n  #  line        colour   length  box (x0,y0,x1,y1)`);
  lines.forEach((l, i) => console.log(`  ${String(i + 1).padStart(2)} ${l.name.padEnd(11)} ${l.colour.padEnd(8)} ${String(l.length).padStart(5)} px  ${l.box.join(',')}`));
  const p2 = await blankPage();
  writePng(path.join(dir, 'lines.png'), await p2.evaluate(P.overlay, { url, lines, rides: [], box: fit.own ? null : aligned.box }));
  await p2.close();
  writeJson(path.join(dir, 'lines.json'), { image, url: fit.own ? null : image, fit, rw, rh, lines });
  console.log(`\n  ${lines.length} line${lines.length === 1 ? '' : 's'}; check ${rel(path.join(dir, 'lines.png'))}`);
  return lines.length > 0;
}

// ---- step: ride ----
function parsePer(s) {
  return Object.fromEntries((s || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [name, n, ski] = x.split(':').map((y) => y.trim().toLowerCase());
    const count = Number(n);
    if (!name || !Number.isInteger(count) || count < 0) throw new Error(`--per: can't read "${x}" (name:count[:ski | :<k>ski])`);
    const skis = !ski ? 0 : ski === 'ski' ? count : Number(ski.replace(/ski$/, ''));
    if (!Number.isInteger(skis) || skis < 0 || skis > count) throw new Error(`--per: can't read the skis in "${x}"`);
    return [name, { count, skis }];
  }));
}
async function stepRide(shot) {
  const dir = workDir(shot), lf = path.join(dir, 'lines.json');
  if (!fs.existsSync(lf)) { console.log(`no lines yet: run the lines step first`); return false; }
  const L = readJson(lf), trial = flag('trial');
  const riders = Math.max(0, Math.round(Number(opt('riders', cfg.group.riders))));
  const per = parsePer(opt('per', ''));
  const unknown = Object.keys(per).filter((n) => !L.lines.some((l) => l.name === n || l.colour === n));
  if (unknown.length) console.log(`warning: --per names no line: ${unknown.join(', ')} (lines: ${L.lines.map((l) => l.name).join(', ')})`);
  console.log(`\nride: ${L.lines.length} lines on ${pack}/${shot.id}${trial ? ' (trial: the takes stay in the work folder)' : ''}`);
  const { page, info, errors } = await shotPage(L.rw, L.rh);
  await page.evaluate(P.poseAt, L.fit.k);
  const world = await page.evaluate(P.cast, { lines: L.lines, fit: L.fit, rw: L.rw, rh: L.rh, cfg: cfg.cast });
  writeJson(path.join(dir, 'world.json'), world);
  // who rides each line: the riders of a line differ, and differ from the line before; far lines in bright outfits
  const plan = {};
  let prev = [];
  L.lines.forEach((l, li) => {
    const hits = world[l.name], rule = per[l.name] ?? per[l.colour];
    const count = rule ? rule.count : riders, skis = rule ? rule.skis : 0;
    const far = hits.length && hits.map((q) => q[3]).sort((a, b) => a - b)[hits.length >> 1] > cfg.outfits.farM;
    const pool = far ? cfg.outfits.bright : cfg.outfits.all;
    const turned = [...pool.slice(li % pool.length), ...pool.slice(0, li % pool.length)]; // a different lead outfit line to line
    const order = [...turned.filter((o) => !prev.includes(o)), ...turned.filter((o) => prev.includes(o))];
    const rs = Array.from({ length: count }, (_, i) => ({ outfit: order[i % order.length], discipline: i >= count - skis ? 'ski' : 'board', goofy: (li + i) % 3 === 1 }));
    prev = rs.map((r) => r.outfit);
    plan[l.name] = { riders: rs, side: li % 2 ? -1 : 1 };
    const d = hits.map((q) => q[3]);
    console.log(`  ${l.name.padEnd(11)} ${hits.length}/${l.px.length} cells on the terrain${hits.length ? `, ${Math.min(...d)}..${Math.max(...d)} m out` : ''}; ${count} rider${count === 1 ? '' : 's'}${skis ? ` (${skis} on skis)` : ''}`);
  });
  const rides = await page.evaluate(P.ride, { world, plan, cfg });
  // the takes: <shot>-<line>-<i>.json; a rerun replaces this shot's generated takes (recorded take-* never)
  const out = trial ? path.join(dir, 'trial') : path.join(ATTRACT, pack);
  fs.mkdirSync(out, { recursive: true });
  const man = readIndex(ATTRACT), e = (man[pack] ??= {});
  if (!trial) {
    const old = e.shotGhosts?.[shot.id] ?? [];
    for (const f of old) fs.rmSync(path.join(out, f), { force: true });
    e.ghosts = (e.ghosts ?? []).filter((f) => !old.includes(f));
    if (old.length) console.log(`  removed the ${old.length} takes made for ${shot.id} before`);
  }
  const written = [];
  for (const r of rides) {
    if (r.skipped) continue;
    r.group.forEach((g, i) => {
      const who = plan[r.name].riders[i], t0 = g.samples[0].t;
      const take = { version: 1, pack, discipline: who.discipline, stance: who.goofy ? 'goofy' : 'regular', outfit: who.outfit, backdrop: true, shot: shot.id, build: info.build,
        samples: g.samples.map((s) => Object.fromEntries(Object.entries({ ...s, t: s.t - t0 }).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v]))) };
      const file = `${shot.id}-${r.name}-${i + 1}.json`;
      fs.writeFileSync(path.join(out, file), JSON.stringify(take) + '\n');
      written.push(file);
    });
  }
  if (!trial) {
    e.ghosts = [...e.ghosts, ...written];
    e.shotGhosts = { ...(e.shotGhosts ?? {}), [shot.id]: written };
    writeIndex(ATTRACT, man);
  }
  console.log(`  wrote ${written.length} takes to ${rel(out)}/${trial ? '' : ' (listed in game/public/attract/index.json)'}`);
  // the picture: each line and its lead's ride (solid where the shot sees it, from where the menu goes live)
  await page.evaluate(P.poseAt, L.fit.k);
  const ok = rides.filter((r) => !r.skipped);
  const proj = await page.evaluate(P.project, { paths: ok.map((r) => r.group[0].samples.map((s) => [s.x, s.y, s.z])), fit: L.fit, rw: L.rw, rh: L.rh });
  const url = L.url ? `data:image/${/\.png$/i.test(L.url) ? 'png' : 'jpeg'};base64,${fs.readFileSync(L.url).toString('base64')}` : `data:image/png;base64,${fs.readFileSync(L.image).toString('base64')}`;
  writePng(path.join(dir, 'ride.png'), await page.evaluate(P.overlay, { url, lines: L.lines, rides: ok.map((r, i) => ({ name: r.name, pts: proj[i], vis: r.group[0].vis })), box: null }));
  await page.close();
  const report = rides.map((r) => (r.skipped ? r : { ...r, group: r.group.map(({ samples, vis, ...g }) => ({ ...g, dur: +(samples.at(-1).t - samples[0].t).toFixed(1), who: plan[r.name].riders[g.rider - 1] })) }));
  writeJson(path.join(dir, trial ? 'report-trial.json' : 'report.json'), { shot: shot.id, trial, files: written, rides: report, errors });
  const bad = printReport(report);
  console.log(`  pictures: ${rel(path.join(dir, 'ride.png'))} (each line and its lead's ride: solid dots where the shot sees it)`);
  if (errors.length) console.log(`  page errors: ${errors.slice(0, 5).join(' | ')}`);
  return { bad: bad + errors.length, written };
}

/** the per-line report; returns how many things to look at */
function printReport(rides) {
  let bad = 0;
  const G = cfg.group, K = cfg.check;
  console.log('\n  line        rider outfit         riding         length  in view  start                    end                 nearest  crashes  reached  line used');
  for (const r of rides) {
    if (r.skipped) { console.log(`  ${r.name.padEnd(11)} skipped: ${r.skipped}`); bad++; continue; }
    r.group.forEach((g, i) => {
      const lead = i === 0;
      console.log(`  ${(lead ? r.name : '').padEnd(11)} ${String(g.rider).padStart(5)} ${g.who.outfit.padEnd(14)} ${`${g.who.discipline} ${g.who.goofy ? 'goofy' : 'regular'}`.padEnd(14)} ${g.dur.toFixed(1).padStart(5)} s ${g.inView.toFixed(1).padStart(6)} s  ${g.start.padEnd(24)} ${g.end.padEnd(19)} ${String(g.nearest).padStart(5)} m ${(lead ? String(r.lead.crashes) : '').padStart(8)} ${(lead ? r.lead.reached : '').padStart(8)}  ${lead ? r.lead.line : ''}`);
      if (g.startNear) { console.log(`              ^ starts in view ${g.nearest} m from the camera`); bad++; }
    });
    if (r.lead.crashes) { console.log(`              ^ ${r.name}: the lead crashed ${r.lead.crashes} time(s)`); bad++; }
    // a far line's riders may hardly show (Drew: that's how it is); said, not counted
    if (r.group.every((g) => g.inView < 1)) console.log(`              (${r.name}: on screen under a second: too far or hidden from the shot)`);
    if (r.pair) {
      const pairOk = r.pair[0] >= K.pairMinM && r.pair[1] <= K.pairMaxM, gapOk = r.minGap >= G.minGapM;
      console.log(`              gap: lead to rider 2 ${r.pair[0]}..${r.pair[1]} m, closest two ${r.minGap} m${r.loosened ? ` (formation loosened ${r.loosened}x)` : ''}${pairOk && gapOk ? '' : '  <- check'}`);
      if (!gapOk) bad++;
    }
  }
  return bad;
}

// ---- step: check ----
async function stepCheck(shot) {
  const dir = workDir(shot), rf = path.join(dir, 'report.json');
  console.log(`\ncheck: ${pack}/${shot.id}`);
  const compare = await runTool(['tools/shoot_attract.mjs', pack, '--gpu', '--compare']);
  syncDist();
  const man = readIndex(ATTRACT), e = man[pack] ?? {}, mine = e.shotGhosts?.[shot.id] ?? [], all = e.ghosts ?? [];
  const { page, info, errors } = await shotPage(1920, 1080);
  // every take ridden on this build of the pack? (a rebuilt pack can leave riders floating or sunk)
  const paths = await page.evaluate(P.takePaths, { files: all });
  const stale = paths.filter((p) => p.build !== null && p.build !== info.build);
  if (stale.length) console.log(`  warning: ${stale.length} takes were ridden on another build of the pack (${[...new Set(stale.map((p) => p.build))].join(', ')}; now ${info.build || 'none'}): ${stale.slice(0, 4).map((p) => p.file).join(', ')}${stale.length > 4 ? ', ...' : ''}`);
  // the gap between every two takes while both ride in frame (all start together; this shot's against each other and the rest)
  const close = [];
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const a = paths[i], b = paths[j];
    if (!mine.includes(a.file) && !mine.includes(b.file)) continue;
    let best = { d: Infinity, t: 0 };
    for (let k = 0; k < Math.min(a.pts.length, b.pts.length); k++) { if (!a.pts[k][2] || !b.pts[k][2]) continue; const d = Math.hypot(a.pts[k][0] - b.pts[k][0], a.pts[k][1] - b.pts[k][1]); if (d < best.d) best = { d, t: k * 0.1 }; }
    if (best.d < cfg.check.takeGapM) close.push(`${a.file} and ${b.file} ${best.d.toFixed(1)} m at ${best.t.toFixed(1)} s`);
  }
  console.log(close.length ? `  takes closer than ${cfg.check.takeGapM} m while both are in frame: ${close.join('; ')}` : `  no two takes (this shot's against every other) closer than ${cfg.check.takeGapM} m while both are in frame`);
  // the menu with and without this shot's riders: frames and draw calls
  const longest = Math.max(1, ...paths.filter((p) => mine.includes(p.file)).map((p) => p.pts.length / 10));
  const times = cfg.check.times.filter((t) => t < longest);
  const pv = await page.evaluate(P.preview, { before: all.filter((f) => !mine.includes(f)), after: mine, times });
  pv.frames.forEach((f) => writePng(path.join(dir, `menu-t${f.t}.png`), f.png));
  await page.close();
  const adds = pv.frames.map((f) => f.calls - f.callsBefore);
  console.log(`  draw calls at 1920 x 1080 (menu at t: all ${pv.count} takes / without this shot's ${mine.length}): ${pv.frames.map((f) => `${f.t} s ${f.calls} / ${f.callsBefore} (+${f.calls - f.callsBefore})`).join(', ')}; the new riders add up to ${Math.max(0, ...adds)}`);
  console.log(`  frames: ${rel(dir)}/menu-t{${times.join(',')}}.png`);
  let bad = (compare ? 1 : 0) + errors.length + close.length;
  if (fs.existsSync(rf)) { console.log('\n  the ride (from the ride step):'); bad += printReport(readJson(rf).rides); }
  if (errors.length) console.log(`  page errors: ${errors.slice(0, 5).join(' | ')}`);
  console.log(`\n${compare ? 'FAIL: the still does not match the live menu (above)' : 'ok: the still matches the live menu'}; ${bad ? `${bad} thing(s) to look at` : 'nothing else to look at'}`);
  if (!flag('no-open')) {
    await serve();
    const b = await launchBrowser(['--headed']);
    const p = await b.newPage({ viewport: null });
    await p.goto(`${base}/index.html?pack=${pack}`);
    console.log(`\nThe menu is open: watch the riders. Close the window when done.`);
    await new Promise((r) => b.on('disconnected', r));
  }
  return bad === 0;
}

function status(shot) {
  const man = readIndex(ATTRACT)[pack] ?? {};
  if (!shot) { console.log(`${pack}: no menu shot yet (step: shot)`); return; }
  const dir = workDir(shot);
  console.log(`${pack}: shot ${shot.id} (${shot.place}); still ${man.stills?.includes(shot.id) ? 'rendered' : 'not rendered'}; drawing ${fs.existsSync(path.join(dir, `draw-${shot.id}.png`)) ? rel(path.join(dir, `draw-${shot.id}.png`)) : 'none'}; lines ${fs.existsSync(path.join(dir, 'lines.json')) ? readJson(path.join(dir, 'lines.json')).lines.length : 'not read'}; takes ${man.shotGhosts?.[shot.id]?.length ?? 0}`);
}

// ---- the wizard, or one step ----
let shot = shotNow();
if (stepArg) {
  if (stepArg === 'shot') { const ok = await stepShot(); await done(ok ? 0 : 1); }
  if (stepArg === 'status') { status(shot); await done(0); }
  if (!shot) { console.log(`${pack} has no menu shot yet: node tools/ghost_lines.mjs ${pack} shot`); await done(1); }
  if (stepArg === 'still') await done((await stepStill(shot)) ? 0 : 1);
  if (stepArg === 'lines') await done((await stepLines(shot, imageArg)) ? 0 : 1);
  if (stepArg === 'ride') { const r = await stepRide(shot); await done(r && !r.bad ? 0 : 1); }
  if (stepArg === 'check') await done((await stepCheck(shot)) ? 0 : 1);
}
if (!shot) { if (!(await stepShot())) await done(1); shot = shotNow(); }
const dir = workDir(shot), clean = path.join(dir, 'clean.png'), draw = path.join(dir, `draw-${shot.id}.png`), lf = path.join(dir, 'lines.json');
if (!fs.existsSync(clean) || !readIndex(ATTRACT)[pack]?.stills?.includes(shot.id)) { await stepStill(shot); await done(0); }
if (mtime(draw) <= mtime(clean) + 1000) { console.log(`${pack}/${shot.id}: draw downhill lines on ${draw} (Paint), save it, then rerun.`); openFolder(dir); await done(0); }
if (mtime(lf) < mtime(draw)) {
  if (!(await stepLines(shot))) await done(1);
  if (!process.stdin.isTTY) { console.log(`\nLook at lines.png, then: node tools/ghost_lines.mjs ${pack} ride  (or fix the drawing and rerun)`); await done(0); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question('\nRide these lines? [Y/n] ')).trim().toLowerCase();
  rl.close();
  if (a && a !== 'y' && a !== 'yes') { console.log('Fix the drawing and rerun.'); await done(0); }
}
const rf = path.join(dir, 'report.json');
if (mtime(rf) < mtime(lf)) { const r = await stepRide(shot); if (!r) await done(1); }
else status(shot);
await done((await stepCheck(shot)) ? 0 : 1);
