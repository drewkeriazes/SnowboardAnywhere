// FEAT-128 / FEAT-177: render the main menu's backdrop still for each resort, from the exact pose of its shot
// (world/AttractShots.ts) and in the shot's own conditions (the same ones the live menu draws), so the menu has a
// picture while the session loads behind it and the crossfade to the live view doesn't jump.
// node tools/shoot_attract.mjs [pack ...] [--gpu | --headed] [--compare] [--threshold N]   (after `npx vite build`; on Drew's GPU)
// Writes game/public/attract/<pack>/<shot id>.jpg at 1920 x 1080 and, in index.json, the still's look key (the
// code hash from tools/attract_look.mjs and the pack's meta.build). CI warns when a PR changes the look without it.
//   --compare  then opens the real menu (no headless), grabs the live frame at the crossfade (?menuframe) and diffs
//              it with the still: mean difference per channel (0..255, at 960 x 540) and the share of pixels off by
//              more than 24. Fails over --threshold (mean, default 4). Saves still, live and diff to game/shots/attract-compare/.
import { launchBrowser } from './browser.mjs';
import { lookCode } from './attract_look.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS, REPO } from './paths.mjs';

const args = process.argv.slice(2);
const compare = args.includes('--compare');
const ti = args.indexOf('--threshold');
const threshold = ti >= 0 ? Number(args[ti + 1]) : 4;
const packs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--threshold');
if (!packs.length) packs.push('vail');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await launchBrowser();
const code = lookCode();
const manFile = path.join(REPO, 'game', 'public', 'attract', 'index.json');
let failed = 0;

/** render one pack's still headless, write it and its look key; returns the shot and the JPEG's data URL */
async function shoot(pack) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/index.html?pack=${pack}&headless&cam=eye${process.env.SHOT_QUERY ?? ''}`);
  await page.waitForFunction(() => window.__step, null, { timeout: 120000 });
  page.setDefaultTimeout(300000);
  await page.evaluate(() => window.__step(1, 1 / 60)); // __sim is filled by the first frame
  const shot = await page.evaluate(() => window.__sim.shot);
  // the shot's conditions, as the live menu holds them (Session.ts holdShotConditions), and its pose where the menu
  // goes live: the start of the drift (half the pan left of the shot's heading), not the heading itself
  await page.evaluate((s) => {
    window.__sim.shotConditions?.();
    const p = window.__sim.shotPose?.(0) ?? s;
    window.__sim.eyeAt(p.x, p.y, p.h, p.pitch, p.fov, p.eye);
  }, shot);
  // step until the tiles have streamed in and the terrain stops rebuilding (as shoot_spots.mjs)
  let quiet = 0;
  for (let i = 0; i < 100 && quiet < 3; i++) {
    await page.evaluate(() => window.__step(4, 1 / 60));
    await page.waitForTimeout(250);
    const busy = await page.evaluate(() => {
      const s = window.__sim, p = s.pack;
      const pend = [p.fine, p.mid, p.far, p.mask].reduce((n, t) => n + (t?.pending?.size ?? 0), 0);
      const veg = [...(s.veg.cells?.values?.() ?? [])].filter((c) => c.loading).length;
      return pend + veg + s.veg.pending + s.terrain.stats.builds;
    });
    quiet = busy === 0 ? quiet + 1 : 0;
  }
  // the clouds back to the shot's start, then the one frame the still is (the live menu restarts the shot the same way)
  await page.evaluate(() => window.__sim.shotConditions?.());
  const url = await page.evaluate(() => window.__shot());
  const jpg = await page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/jpeg', 0.82);
  }, url);
  const build = await page.evaluate(() => window.__sim.pack.meta.build ?? '');
  const dir = path.join(REPO, 'game', 'public', 'attract', pack);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${shot.id}.jpg`);
  fs.writeFileSync(out, Buffer.from(jpg.split(',')[1], 'base64'));
  // list it in the manifest, so the menu asks only for stills that exist, with the look it was rendered from
  const man = fs.existsSync(manFile) ? JSON.parse(fs.readFileSync(manFile, 'utf8')) : {};
  const e = (man[pack] ??= {});
  e.stills = [...new Set([...(e.stills ?? []), shot.id])];
  e.ghosts ??= [];
  e.looks = { ...(e.looks ?? {}), [shot.id]: { code, pack: build } };
  fs.writeFileSync(manFile, JSON.stringify(man, null, 2) + '\n');
  console.log(`${pack}/${shot.id}`, JSON.stringify({ x: shot.x, y: shot.y, h: shot.h, pitch: shot.pitch, fov: shot.fov, eye: shot.eye }), JSON.stringify(shot.conditions), '->', path.relative(REPO, out).split(path.sep).join('/'), `look ${code} pack ${build || 'none'}`, errors.length ? `errors: ${errors.join(' | ')}` : '');
  if (errors.length) failed++;
  await page.close();
  return { shot, jpg };
}

/** open the real menu, grab the live frame at the crossfade and diff it with the still */
async function compareLive(pack, shot, still) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(`${base}/index.html?pack=${pack}&menuframe${process.env.SHOT_QUERY ?? ''}`);
  await page.waitForFunction(() => window.__menuFrame, null, { timeout: 300000, polling: 250 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const settle = await page.evaluate(() => performance.getEntriesByName('menu settle')[0]?.duration ?? null);
  const live = await page.evaluate(() => window.__menuFrame);
  const shown = await page.evaluate(() => document.querySelector('#menu .still')?.getAttribute('src') ?? '');
  const r = await page.evaluate(async ([a, b]) => {
    const load = async (src) => { const i = new Image(); i.src = src; await i.decode(); return i; };
    const W = 960, H = 540;
    const px = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; };
    const ia = await load(a), ib = await load(b);
    const da = px(ia), db = px(ib);
    const diff = document.createElement('canvas'); diff.width = W; diff.height = H;
    const dg = diff.getContext('2d'), dd = dg.createImageData(W, H);
    let sum = 0, off = 0;
    for (let i = 0; i < da.length; i += 4) {
      const dr = Math.abs(da[i] - db[i]), dgr = Math.abs(da[i + 1] - db[i + 1]), dbl = Math.abs(da[i + 2] - db[i + 2]);
      const d = Math.max(dr, dgr, dbl);
      sum += dr + dgr + dbl;
      if (d > 24) off++;
      const v = Math.min(255, d * 4); dd.data[i] = v; dd.data[i + 1] = v * 0.3; dd.data[i + 2] = 0; dd.data[i + 3] = 255;
    }
    dg.putImageData(dd, 0, 0);
    return { mean: sum / (W * H * 3), off: off / (W * H), live: `${ib.naturalWidth} x ${ib.naturalHeight}`, diff: diff.toDataURL('image/png') };
  }, [still, live]);
  const out = path.join(REPO, 'game', 'shots', 'attract-compare');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${pack}-${shot.id}-still.jpg`), Buffer.from(still.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(out, `${pack}-${shot.id}-live.png`), Buffer.from(live.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(out, `${pack}-${shot.id}-diff.png`), Buffer.from(r.diff.split(',')[1], 'base64'));
  // no ghost on screen at the crossfade (they are not in the still); each then rides in from out of frame, or fades
  // in where its take starts in frame (AttractGhosts: from / to, fadeIn / fadeOut)
  const atFade = await page.evaluate(() => window.__menuFrameGhosts);
  const ghosts = await page.evaluate(() => window.__sim.ghosts.ghosts.map((g) => ({ from: +g.from.toFixed(1), to: +g.to.toFixed(1), dur: +g.dur.toFixed(1), fadeIn: g.fadeIn, fadeOut: g.fadeOut })));
  console.log(`${atFade ? 'FAIL' : 'ok  '} ${atFade ? 'a ghost is' : 'no ghost'} in frame at the crossfade; ${ghosts.length} takes: ${ghosts.map((g, i) => `#${i + 1} ${g.from}..${g.to} s of ${g.dur} ${g.fadeIn ? 'fades in (starts in frame)' : 'rides in'}, ${g.fadeOut ? 'fades out (ends in frame)' : 'rides out'}`).join('; ')}`);
  const ok = r.mean <= threshold && !errors.length && !!shown && !atFade;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pack}/${shot.id} still vs live at the crossfade (${secs} s in, ${settle !== null ? `${(settle / 1000).toFixed(1)} s settling after the warm-up, ` : ''}live frame ${r.live}${shown ? '' : ', the menu showed no still'}): mean ${r.mean.toFixed(2)} / 255 (threshold ${threshold}), ${(r.off * 100).toFixed(1)}% of pixels off by > 24${errors.length ? `; errors: ${errors.join(' | ')}` : ''}`);
  console.log(`     shots: ${path.relative(REPO, out).split(path.sep).join('/')}/${pack}-${shot.id}-{still,live,diff}.*`);
  if (!ok) failed++;
  await page.close();
}

for (const pack of packs) {
  const { shot, jpg } = await shoot(pack);
  if (compare) {
    // the build serves its own copy of public/: put the fresh still and manifest in it, so the menu shows this still
    const d = path.join(DIST, 'attract');
    fs.mkdirSync(path.join(d, pack), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'game', 'public', 'attract', pack, `${shot.id}.jpg`), path.join(d, pack, `${shot.id}.jpg`));
    fs.copyFileSync(manFile, path.join(d, 'index.json'));
    await compareLive(pack, shot, jpg);
  }
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
