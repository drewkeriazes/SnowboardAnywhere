// FEAT-278: a short clip through the far forest handover, to see whether a candidate pops or shimmers as you ride in.
// The eye camera glides down a path (default: The Slot from below the Back Bowls sign) at riding speed, looking at a
// fixed target (default: the middle of the Sun Up Express), one frame per step; the frames are encoded with ffmpeg.
// node tools/canopy_clip.mjs <pack> <out.mp4> [--preset high|medium|low] [--time 12] [--speed 25] [--seconds 20]
//   [--fps 30] [--size 1280x720] [--path x,y;x,y;...] [--look x,y,z] [--eye 1.7] [--weather clear] [--gpu | --headed]
//   (after `npx vite build`; SHOT_DIST / SHOT_PACKS / SHOT_QUERY as canopy_compare.mjs). Needs ffmpeg on PATH.
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const valued = new Set(['--preset', '--time', '--speed', '--seconds', '--fps', '--size', '--path', '--look', '--eye', '--weather']);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const [pack = 'vail', outFile = 'canopy-clip.mp4'] = positional;
const preset = opt('--preset', 'high');
const hour = Number(opt('--time', 12));
const speed = Number(opt('--speed', 25));
const seconds = Number(opt('--seconds', 20));
const fps = Number(opt('--fps', 30));
const [vw, vh] = opt('--size', '1280x720').split('x').map(Number);
const eye = Number(opt('--eye', 1.7));
const weather = opt('--weather', 'clear');
// The Slot (features.json), from just below the sign down past the corner toward Sun Up
const route = opt('--path', '-690,470;-686,445;-675,401;-650,372;-589,353;-547,317;-517,287;-480,240;-399,198;-360,171;-314,133;-237,51;-181,-50')
  .split(';').map((p) => p.split(',').map(Number));
const look = opt('--look', '430,-65,3250').split(',').map(Number);

const PRESETS = {
  high: { quality: 'high', shadows: true, treeDensity: 1, forestDensity: 1 },
  medium: { quality: 'medium', shadows: true, treeDensity: 0.6, forestDensity: 0.6 },
  low: { quality: 'low', shadows: false, treeDensity: 0.3, forestDensity: 0.35 },
};

// position along the route by distance
const segs = [];
let total = 0;
for (let i = 1; i < route.length; i++) { const l = Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]); segs.push([route[i - 1], route[i], total, l]); total += l; }
const at = (d) => {
  d = Math.min(d, total - 1e-3);
  const s = segs.find((g) => d <= g[2] + g[3]) ?? segs[segs.length - 1];
  const t = (d - s[2]) / s[3];
  return [s[0][0] + (s[1][0] - s[0][0]) * t, s[0][1] + (s[1][1] - s[0][1]) * t];
};

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const browser = await launchBrowser(args);
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript((seed) => {
  try { localStorage.setItem('settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('settings') ?? '{}'), v: 1, ...seed, pixelRatio: 1, autoQuality: false })); } catch { /* ignore */ }
}, PRESETS[preset]);
const [x0, y0] = at(0);
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&cam=eye&x=${x0}&y=${y0}&weather=${weather}${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 180000 });
page.setDefaultTimeout(300000);
await page.evaluate((hour) => { window.__sim.settings.timeOfDay = hour; window.__sim.applySettings('conditions'); }, hour);

const pose = (d) => {
  const [x, y] = at(d);
  const h = (Math.atan2(look[0] - x, look[1] - y) * 180) / Math.PI;
  return { x, y, h: (h + 360) % 360 };
};
// settle at the start so the clip begins with the tiles in
const p0 = pose(0);
await page.evaluate(({ p, eye }) => window.__sim.eyeAt(p.x, p.y, p.h, -3, 50, eye), { p: p0, eye });
let quiet = 0;
for (let i = 0; i < 150 && quiet < 3; i++) {
  await page.evaluate(() => window.__step(4, 1 / 60));
  await page.waitForTimeout(200);
  const busy = await page.evaluate(() => {
    const s = window.__sim, p = s.pack;
    return [p.fine, p.mid, p.far, p.mask].reduce((n, t) => n + (t?.pending?.size ?? 0), 0) + [...(s.veg.cells?.values?.() ?? [])].filter((c) => c.loading).length + s.terrain.stats.builds + (window.__canopy?.busy ?? 0);
  });
  quiet = busy === 0 ? quiet + 1 : 0;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-clip-'));
const n = Math.round(seconds * fps);
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const p = pose((i / fps) * speed);
  const pitch = -3;
  const url = await page.evaluate(({ p, pitch, eye, fps }) => {
    window.__sim.eyeAt(p.x, p.y, p.h, pitch, 50, eye);
    window.__step(1, 1 / fps);
    return window.__sim.renderer.domElement.toDataURL('image/jpeg', 0.92);
  }, { p, pitch, eye, fps });
  fs.writeFileSync(path.join(tmp, `f${String(i).padStart(5, '0')}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
}
console.log(`${n} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${((seconds * speed) | 0)} m of ${total | 0} m route`);
const ff = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(tmp, 'f%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', outFile], { stdio: 'inherit' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(ff.status === 0 ? `wrote ${outFile}` : 'ffmpeg failed');
console.log('errors:', errors.length);
for (const e of errors.slice(0, 5)) console.log('  ', e.slice(0, 300));
await browser.close();
server.close();
