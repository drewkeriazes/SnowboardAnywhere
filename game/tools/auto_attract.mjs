// FEAT-175 step 4: the main menu for a resort with no hand-made one, from the shots MapPacker's gen_content.py
// generated into the pack (packs/<pack>/attract/shots.json, the menu uses the first; index.json marked generated).
//   node tools/auto_attract.mjs <pack> [--no-ride] [--no-stills] [--variants N] [--riders N]   (after `npx vite build`; on Drew's GPU)
// It writes into the pack's own attract/ (never game/public/attract):
//   stills  each shot rendered as the menu shows it, 1920 x 1080 in its conditions (as tools/shoot_attract.mjs): the
//           first is the menu's still, <shot>.jpg with its look key in index.json (the game shows it only for this
//           meta.build); every shot also goes to game/shots/auto-attract/<pack>/<n>-<shot>.jpg to look at
//   ride    ghost takes down the start run (meta.start.run, from the start, 1.5 km at most) ridden headless by the
//           ghost_lines.mjs bot (tools/ghost_lines/page.mjs ride, ghost_lines.config.json), N variants of N riders,
//           <shot>-start-run[-v<n>]-<i>.json, listed under ghosts and shotGhosts; a rerun replaces them
//   frames  the menu with the new riders at a few times, game/shots/auto-attract/<pack>/menu-t<s>.png
// The game's own hand-made entry in game/public/attract/index.json (Vail, Breckenridge) wins in the game; for those
// this tool still renders the pack's generated menu (its page is served a manifest without that entry), for a look.
// docs/developer-guide.md > Generated resort content.
import { launchBrowser } from './browser.mjs';
import { DIST, PACKS, REPO } from './paths.mjs';
import { lookCode } from './attract_look.mjs';
import * as P from './ghost_lines/page.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const pack = argv.find((a, i) => !a.startsWith('--') && !['--variants', '--riders'].includes(argv[i - 1]));
if (!pack) { console.log('usage: node tools/auto_attract.mjs <pack> [--no-ride] [--no-stills] [--variants N] [--riders N]'); process.exit(2); }
if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.log('no game/dist: run `npx vite build` first'); process.exit(2); }
const PACK = path.join(PACKS, pack), ATT = path.join(PACK, 'attract');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
if (!fs.existsSync(path.join(PACK, 'meta.json'))) { console.log(`no pack at ${PACK}`); process.exit(2); }
const meta = readJson(path.join(PACK, 'meta.json'));
if (!meta.attract || !fs.existsSync(path.join(ATT, 'index.json')) || !fs.existsSync(path.join(ATT, 'shots.json'))) {
  console.log(`${pack}: the pack has no generated menu (meta.attract, attract/shots.json): run MapPacker's python pipeline/gen_content.py <pack dir> first`);
  process.exit(2);
}
const index = readJson(path.join(ATT, 'index.json'));
if (!index.generated) { console.log(`${pack}: attract/index.json is hand-made (no generated): left alone`); process.exit(2); }
const shots = readJson(path.join(ATT, 'shots.json'));
if (!shots.length) { console.log(`${pack}: no shots in attract/shots.json`); process.exit(2); }
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b ?? {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a?.[k] === 'object' ? merge(a[k], v) : v; return o; };
const CONFIG = readJson(path.join(REPO, 'game', 'tools', 'ghost_lines.config.json'));
const cfg = merge(CONFIG.defaults, CONFIG.resorts?.[pack]);
const work = path.join(REPO, 'game', 'shots', 'auto-attract', pack);
fs.mkdirSync(work, { recursive: true });
const rel = (p) => path.relative(REPO, p).split(path.sep).join('/');
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const writeData = (f, url) => fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));

// ---- the built game and the pack; the page sees the pack's generated menu, and only shot `only` of it ----
const gameMan = fs.existsSync(path.join(REPO, 'game', 'public', 'attract', 'index.json')) ? readJson(path.join(REPO, 'game', 'public', 'attract', 'index.json')) : {};
if (gameMan[pack]) console.log(`note: ${pack} has a hand-made menu in game/public/attract (the game shows that); rendering the pack's generated one for a look`);
const { [pack]: _hand, ...manWithout } = gameMan;
let only = 0;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); res.end(JSON.stringify(v)); };
  if (u === '/attract/index.json') return json(manWithout);
  if (u === `/packs/${pack}/attract/shots.json`) return json([shots[only]]);
  const [root, r] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
  const p = path.join(root, r);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser(argv);
let failed = 0;

/** a headless game page on the shot (its conditions, the ghosts hidden), streamed in and settled */
async function shotPage() {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url().replace(base, '')}`); });
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

// ---- the stills ----
const code = lookCode(pack);
if (!flag('no-stills')) {
  for (let i = 0; i < shots.length; i++) {
    only = i;
    const s = shots[i];
    const { page, info, errors } = await shotPage();
    if (info.shot?.id !== s.id) { console.log(`  ${s.id}: the page shows ${info.shot?.id ?? 'no shot'} (is the game build older than FEAT-175?)`); failed++; await page.close(); continue; }
    await page.evaluate(P.poseAt, 0);
    await page.evaluate(() => window.__sim.shotConditions?.());
    const url = await page.evaluate(() => window.__shot());
    const jpg = await page.evaluate(async (src) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/jpeg', 0.82);
    }, url);
    await page.close();
    writeData(path.join(work, `${i + 1}-${s.id}.jpg`), jpg);
    if (i === 0) {
      writeData(path.join(ATT, `${s.id}.jpg`), jpg);
      index.stills = [s.id];
      index.looks = { [s.id]: { code, pack: info.build } };
      writeJson(path.join(ATT, 'index.json'), index);
    }
    console.log(`${i + 1}. ${s.id} (${s.place}): x ${s.x}, y ${s.y}, heading ${s.h}, pitch ${s.pitch}, ${s.eye} m up -> ${rel(path.join(work, `${i + 1}-${s.id}.jpg`))}${i === 0 ? ` and the menu still ${rel(path.join(ATT, `${s.id}.jpg`))} (build ${info.build || 'none'})` : ''}${errors.length ? `; page errors: ${errors.slice(0, 3).join(' | ')}` : ''}`);
    if (errors.length) failed++;
  }
}
only = 0;

// ---- the ghosts: the start run, ridden by the bot ----
/** the start run from the start on down, every 4 m, at most 1.5 km: [[x, y]] */
function startLine() {
  const f = readJson(path.join(PACK, 'features.json')), st = meta.start;
  if (!st?.run) return null;
  let best = null;
  const segDist = (pts) => Math.min(...pts.slice(1).map((b, i) => { const a = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1e-9, t = Math.max(0, Math.min(1, ((st.x - a[0]) * dx + (st.y - a[1]) * dy) / L)); return Math.hypot(st.x - a[0] - t * dx, st.y - a[1] - t * dy); }));
  for (const r of f.runs) if (r.name === st.run && !r.area && r.points.length >= 2) { const d = segDist(r.points); if (!best || d < best.d) best = { d, r }; }
  if (!best) return null;
  let pts = best.r.points;
  if (pts[0][2] < pts[pts.length - 1][2]) pts = [...pts].reverse();
  // nearest vertex to the start, then every 4 m down
  let i0 = 0, bd = Infinity;
  pts.forEach((q, i) => { const d = Math.hypot(q[0] - st.x, q[1] - st.y); if (d < bd) { bd = d; i0 = i; } });
  const out = [[st.x, st.y]];
  let carry = 0;
  for (let i = i0; i < pts.length - 1 && carry < 1500; i++) {
    const a = i === i0 ? [st.x, st.y] : pts[i], b = pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let s = 4; s <= L; s += 4) out.push([a[0] + (b[0] - a[0]) * s / L, a[1] + (b[1] - a[1]) * s / L]);
    carry += L;
  }
  return out;
}

if (!flag('no-ride')) {
  const line = startLine();
  if (!line) { console.log(`ride: no start run (meta.start.run ${meta.start?.run ?? 'none'}): no ghosts`); failed++; }
  else {
    const shot = shots[0];
    const { page, info, errors } = await shotPage();
    // the line on the ground, with its distance from the camera (what the bot's waypoints space by)
    const world = { 'start-run': await page.evaluate(async (pts) => {
      const S = window.__sim, pack = S.pack, cam = S.cam.camera;
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      pack.fine.request(Math.min(...xs) - 50, Math.min(...ys) - 50, Math.max(...xs) + 50, Math.max(...ys) + 50);
      for (let i = 0; i < 400; i++) { window.__step(1, 0); if (pts.every(([x, y]) => !Number.isNaN(pack.fine.sample(x, y)))) break; await new Promise((r) => setTimeout(r, 50)); }
      const p0 = S.shotPose(0); S.eyeAt(p0.x, p0.y, p0.h, p0.pitch, p0.fov, p0.eye); window.__step(1, 0); cam.updateMatrixWorld();
      return pts.map(([x, y]) => { const z = pack.groundHeight(x, y, 9000); return [+x.toFixed(2), +y.toFixed(2), +z.toFixed(2), Math.round(cam.position.distanceTo(new cam.position.constructor(x, z, -y)))]; });
    }, line) };
    const riders = Math.max(1, Math.round(Number(opt('riders', cfg.group.riders))));
    const V = Math.max(1, Math.round(Number(opt('variants', cfg.group.variants ?? 3))));
    const hits = world['start-run'], d = hits.map((q) => q[3]).sort((a, b) => a - b);
    const pool = d[d.length >> 1] > cfg.outfits.farM ? cfg.outfits.bright : cfg.outfits.all;
    const plan = { 'start-run': { variants: Array.from({ length: V }, (_, v) => ({ straight: false,
      riders: Array.from({ length: riders }, (_, i) => ({ outfit: pool[(i + v * riders) % pool.length], discipline: 'board', goofy: (i + v) % 3 === 1 })),
      side: v % 2 ? -1 : 1, shift: [0, 1, -1][v % 3] * (1 + Math.floor(v / 3)), phase: v / V })) } };
    console.log(`\nride: ${meta.start.run} from the start, ${hits.length} points, ${d[0]}..${d[d.length - 1]} m from ${shot.id}'s camera; ${V} variants of ${riders} riders`);
    const rides = await page.evaluate(P.ride, { world, plan, cfg });
    // the old takes made for this shot go; recorded take-* files are never in shotGhosts
    const old = index.shotGhosts?.[shot.id] ?? [];
    for (const f of old) fs.rmSync(path.join(ATT, f), { force: true });
    index.ghosts = (index.ghosts ?? []).filter((f) => !old.includes(f));
    // timing as ghost_lines.mjs ride: the variants share a cycle (the longest ride + restS) and set off a share of it apart
    const ok = rides.filter((r) => !r.skipped);
    const longest = Math.max(0, ...ok.flatMap((r) => r.group.map((g) => g.samples.at(-1).t - g.samples[0].t)));
    const every = +(longest + cfg.group.restS).toFixed(2), step = every / V;
    const written = [];
    for (const r of ok) r.group.forEach((g, i) => {
      const who = plan['start-run'].variants[r.v].riders[i], t0 = g.samples[0].t;
      const take = { version: 1, pack, discipline: who.discipline, stance: who.goofy ? 'goofy' : 'regular', outfit: who.outfit, backdrop: true, shot: shot.id, build: info.build,
        ...(V > 1 ? { delay: +(r.v * step).toFixed(2), every } : {}),
        samples: g.samples.map((s) => Object.fromEntries(Object.entries({ ...s, t: s.t - t0 }).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v]))) };
      const file = `${shot.id}-start-run${V > 1 ? `-v${r.v + 1}` : ''}-${i + 1}.json`;
      fs.writeFileSync(path.join(ATT, file), JSON.stringify(take) + '\n');
      written.push(file);
    });
    index.ghosts = [...index.ghosts, ...written];
    index.shotGhosts = { ...(index.shotGhosts ?? {}), [shot.id]: written };
    writeJson(path.join(ATT, 'index.json'), index);
    console.log('  variant rider outfit          length  in view  start                    end                 nearest  crashes  reached');
    for (const r of rides) {
      if (r.skipped) { console.log(`  v${r.v + 1}: skipped, ${r.skipped}`); failed++; continue; }
      r.group.forEach((g, i) => {
        const dur = g.samples.at(-1).t - g.samples[0].t, who = plan['start-run'].variants[r.v].riders[i];
        console.log(`  ${i ? '      ' : `v${r.v + 1}    `} ${String(g.rider).padStart(5)} ${who.outfit.padEnd(14)} ${dur.toFixed(1).padStart(5)} s ${g.inView.toFixed(1).padStart(6)} s  ${g.start.padEnd(24)} ${g.end.padEnd(19)} ${String(g.nearest).padStart(5)} m ${(i ? '' : String(r.lead.crashes)).padStart(8)} ${(i ? '' : r.lead.reached).padStart(8)}`);
      });
      if (r.lead.crashes) failed++;
    }
    const inView = ok.reduce((n, r) => n + r.group.reduce((m, g) => m + g.inView, 0), 0);
    console.log(`  wrote ${written.length} takes to ${rel(ATT)}/ (listed in its index.json); ${inView.toFixed(0)} rider-seconds in view${inView < 5 ? ': the shot hardly sees the start run' : ''}`);
    // the menu with them, a few frames
    const pv = await page.evaluate(P.preview, { before: [], after: written, times: cfg.check.times.slice(0, 3), dir: `./packs/${pack}/attract/` });
    pv.frames.forEach((f) => writeData(path.join(work, `menu-t${f.t}.png`), f.png));
    console.log(`  menu frames with the riders: ${rel(work)}/menu-t{${cfg.check.times.slice(0, 3).join(',')}}.png (${pv.count} takes loaded)`);
    if (errors.length) { console.log(`  page errors: ${errors.slice(0, 5).join(' | ')}`); failed++; }
    await page.close();
  }
}
await browser.close();
server.close();
console.log(failed ? `\n${failed} thing(s) to look at (above)` : '\nok');
process.exit(failed ? 1 : 0);
