// On-foot render and gait check (FEAT-067): stops, unstraps (B), walks, sprints, turns, strap back
// in; saves shots of the board carry and the bootprints and prints speed, stamina, foot-IK gap and
// the print spacing per side. node tools/walkcheck.mjs [pack] [outDir] [--headed] [--ski]
// (run after `npx vite build`; SHOT_QUERY="&lowgfx" on software GPUs)
const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.js').then((m) => m.default));
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const headed = args.includes('--headed') || process.env.SHOT_HEADED === '1';
const ski = args.includes('--ski');
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'synth';
const outDir = positional[1] ?? 'shots-walk';
const dist = path.resolve('dist'), packs = path.resolve('..', 'packs');
fs.mkdirSync(outDir, { recursive: true });
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
const browser = headed
  ? await chromium.launch({ headless: false })
  : await chromium.launch({ args: ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 60000 });
page.setDefaultTimeout(240000);

const ride = (n) => page.evaluate((n) => {
  let gap = 0;
  for (let i = 0; i < n; i++) { window.__step(1, 1 / 60); gap = Math.max(gap, window.__sim.riderView.footGap); }
  window.__maxGap = Math.max(window.__maxGap ?? 0, gap);
}, n);
const state = () => page.evaluate(() => {
  const s = window.__sim, r = s.rider;
  return { onFoot: r.onFoot, strap: r.strapState, speed: +r.speed.toFixed(2), stamina: +r.stamina.toFixed(2), tired: r.tired, sink: +r.sink.toFixed(3), slope: +r.slopeDeg.toFixed(0), prints: s.bootprints.stats.prints, maxFootGap: +(window.__maxGap ?? 0).toFixed(4) };
});
async function shot(label, back, side, up, lookUp = 0.9) {
  const st = await page.evaluate(({ back, side, up, lookUp }) => {
    const s = window.__sim, r = s.rider, c = s.cam;
    const prev = c.mode;
    const fx = Math.sin(r.heading), fz = -Math.cos(r.heading), rgx = -fz, rgz = fx;
    const tx = r.x, ty = r.z + lookUp, tz = -r.y;
    const cx = tx - fx * back + rgx * side, cz = tz - fz * back + rgz * side, cy = ty + up;
    c.mode = 'free'; c.freePos.set(cx, cy, cz);
    const dx = tx - cx, dy = ty - cy, dz = tz - cz, l = Math.hypot(dx, dy, dz);
    c.yaw = Math.atan2(dx, -dz); c.pitch = Math.asin(dy / l);
    const url = window.__shot();
    c.mode = prev;
    return url;
  }, { back, side, up, lookUp });
  fs.writeFileSync(path.join(outDir, `${label}.png`), Buffer.from(st.split(',')[1], 'base64'));
  console.log(label, JSON.stringify(await state()));
}
const plants = () => page.evaluate(() => window.__plants.splice(0));
/** spacing between consecutive prints of the same foot, and whether sides alternate */
function spacing(ps) {
  const out = { n: ps.length, alternates: true, stride: [] };
  for (let i = 1; i < ps.length; i++) if (ps[i].side === ps[i - 1].side) out.alternates = false;
  for (const side of [0, 1]) {
    const s = ps.filter((p) => p.side === side);
    const d = [];
    for (let i = 1; i < s.length; i++) d.push(Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y));
    if (d.length) out.stride.push(+(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2));
  }
  return out;
}

if (ski) await page.evaluate(() => { const s = window.__sim; s.rider.discipline = 'ski'; s.riderView.setDiscipline('ski'); });
await page.evaluate(() => {
  window.__plants = [];
  const v = window.__sim.riderView, prev = v.onPlant;
  v.onPlant = (p) => { window.__plants.push({ ...p }); prev?.(p); };
});
await ride(30); await page.waitForTimeout(1500); await ride(10);
// stand on the snow: hold brake to a stop, then press B
await page.keyboard.down('ArrowDown');
for (let i = 0; i < 40; i++) { await ride(10); if ((await state()).speed < 1) break; }
await page.keyboard.up('ArrowDown');
await page.keyboard.press('KeyB');
await ride(20); await shot('01_unstrap_crouch', 0.5, 3.5, 0.8, 0.6);
await ride(15); await shot('02_unstrap_step', 0.5, 3.5, 0.8, 0.6);
await ride(30); await shot('03_carry_front', -3.2, 0.6, 0.3, 1.0);
await shot('04_carry_side', 0.3, 3.2, 0.3, 1.0);
await shot('05_carry_back', 3, 0.8, 0.8, 1.0);
console.log('step-off prints', JSON.stringify(await plants()));
// walk uphill-ish: turn to face up the slope first
await page.evaluate(() => { const r = window.__sim.rider; const n = r.normal; if (Math.hypot(n[0], n[1]) > 0.02) r.heading = Math.atan2(-n[0], -n[1]) + 0.6; });
await ride(30);
await page.evaluate(() => { window.__maxGap = 0; });
await page.keyboard.down('ArrowUp');
await ride(60); await shot('06_walk_side', 0, 3, 0.5, 0.7);
await ride(120);
console.log('walk', JSON.stringify(spacing(await plants())));
await shot('07_walk_prints', 2.5, 1.5, 2.2, 0);
await page.keyboard.down('ShiftLeft');
await ride(60); await shot('08_sprint_side', 0, 3.5, 0.5, 0.7);
await ride(120);
console.log('sprint', JSON.stringify(spacing(await plants())));
await ride(180); // run out of stamina
console.log('after 6 s of sprint', JSON.stringify(await state()));
await page.keyboard.up('ShiftLeft');
await ride(60);
await page.keyboard.up('ArrowUp');
await plants();
await ride(60);
await shot('09_prints_overview', 5, 2, 3.5, 0);
// turn on the spot (adjusting steps)
await page.keyboard.down('ArrowLeft'); await ride(60); await page.keyboard.up('ArrowLeft'); await ride(30);
console.log('turn on the spot', JSON.stringify(spacing(await plants())));
// steep slope: walk straight up the fall line and report
await page.evaluate(() => { const r = window.__sim.rider; const n = r.normal; r.heading = Math.atan2(-n[0], -n[1]); });
await page.keyboard.down('ArrowUp'); await ride(120); console.log('straight up the fall line', JSON.stringify(await state())); await page.keyboard.up('ArrowUp');
await ride(60);
// strap back in and ride off
await page.keyboard.press('KeyB');
await ride(30); await shot('10_strap_in', 0.5, 3.5, 0.8, 0.6);
await ride(40);
console.log('strapped', JSON.stringify(await state()));
await page.keyboard.down('ArrowUp'); await ride(120); await page.keyboard.up('ArrowUp');
await shot('11_riding_again', 6, 2, 1.5);
console.log('errors', errors.length ? errors.slice(0, 10) : 'none');
if (!headed) { await browser.close(); server.close(); }
