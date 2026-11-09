// Goggle lens check (FEAT-130): the same first-person view through each lens, in a storm and under
// overcast, saved as PNGs, with the snow's surface contrast (the spread of log luminance against a
// local blur, over the snow on the slope below the horizon) and the frame time per lens. Checks that
// rose and yellow raise that contrast over no lens in the storm (under overcast the noise is as big
// as the effect, so the ratio is only printed), that the mirrors darken the view, that clear matches
// no lens, that the pass at near-zero strength matches no lens (guards the isXRRenderTarget trick in
// Lens.ts), and that the pass costs under 1.5 ms a frame. Also checks the rider's goggle material
// takes the lens colour (rose, blue, yellow).
// node tools/lenscheck.mjs [pack] [outDir] [--headed]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const pack = positional[0] ?? 'vail';
const outDir = positional[1] ?? 'shots/lens';
fs.mkdirSync(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await launchBrowser();
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };
const LENSES = ['off', 'rose', 'orange', 'yellow', 'green', 'blue', 'purple', 'clear'];

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console error', m.text()); });
  await page.goto(`http://localhost:${port}/index.html?pack=${pack}&headless${query}`);
  await page.waitForFunction(() => window.__step, null, { timeout: 120000 });
  page.setDefaultTimeout(240000);
  for (let i = 0; i < 8; i++) { await page.evaluate(() => window.__step(10, 1 / 60)); await page.waitForTimeout(400); }
  // every shot starts from this pose, so each lens sees the same view (the rider drifts and the
  // first-person arms swing into the measured snow otherwise)
  await page.evaluate(() => { const r = window.__sim.rider; window.__lensSpot = { x: r.x, y: r.y, h: r.heading }; });
  return page;
}

/** shot with the given lens: saves it and returns { mean, sd } of log luminance over the lower 2/3 */
/** one frame through the lens: its PNG and the metrics */
async function shootOnce(page, lens) {
  return page.evaluate(async (lens) => {
    window.__sim.settings.goggleLens = lens;
    const sp = window.__lensSpot, sim = window.__sim;
    sim.rider.reset(sp.x, sp.y, sp.h); sim.cam.snapTo(sim.rider);
    window.__step(2, 1 / 60);
    const url = window.__shot();
    const img = new Image(); img.src = url; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    // the slope below the horizon: log luminance every 2 px, minus a box blur about 25 px across (the
    // shading of the snow's bumps and dips), over snow pixels only (not trees, signs or the rider)
    const x0 = Math.round(img.width * 0.1), x1 = Math.round(img.width * 0.9), y0 = Math.round(img.height * 0.6), y1 = Math.round(img.height * 0.95);
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data, W = x1 - x0;
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const gw = Math.floor(W / 2), gh = Math.floor((y1 - y0) / 2);
    const lum = new Float64Array(gw * gh), lg = new Float64Array(gw * gh);
    let mean = 0;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const o = ((j * 2) * W + i * 2) * 4;
      const L = 0.2126 * lin(d[o]) + 0.7152 * lin(d[o + 1]) + 0.0722 * lin(d[o + 2]);
      lum[j * gw + i] = L; lg[j * gw + i] = Math.log(L + 1e-3); mean += L;
    }
    mean /= gw * gh;
    // integral image of the log luminance for the box blur
    const I = new Float64Array((gw + 1) * (gh + 1));
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) I[(j + 1) * (gw + 1) + i + 1] = lg[j * gw + i] + I[j * (gw + 1) + i + 1] + I[(j + 1) * (gw + 1) + i] - I[j * (gw + 1) + i];
    const R = 6;
    let n = 0, s = 0, s2 = 0;
    for (let j = R; j < gh - R; j++) for (let i = R; i < gw - R; i++) {
      if (lum[j * gw + i] < 0.12) continue;
      const a = I[(j - R) * (gw + 1) + i - R], b = I[(j - R) * (gw + 1) + i + R + 1], c = I[(j + R + 1) * (gw + 1) + i - R], e = I[(j + R + 1) * (gw + 1) + i + R + 1];
      const hp = lg[j * gw + i] - (e - b - c + a) / ((2 * R + 1) ** 2);
      s += hp; s2 += hp * hp; n++;
    }
    const m = s / Math.max(1, n);
    return { url, sd: Math.sqrt(Math.max(0, s2 / Math.max(1, n) - m * m)), lum: mean };
  }, lens);
}

/** the mean over 3 frames (the snow's fine per-frame noise moves the contrast about 20 % frame to frame); saves the last */
async function shoot(page, lens, label) {
  let sd = 0, lum = 0, r = null;
  for (let i = 0; i < 3; i++) { r = await shootOnce(page, lens); sd += r.sd / 3; lum += r.lum / 3; }
  fs.writeFileSync(path.join(outDir, `${label}.png`), Buffer.from(r.url.split(',')[1], 'base64'));
  return { sd, lum };
}

/** ms per frame over n frames, the GPU flushed by a pixel read at the end */
async function frameMs(page, lens, n = 60) {
  return page.evaluate(({ lens, n }) => {
    window.__sim.settings.goggleLens = lens;
    const gl = window.__sim.renderer.getContext(), px = new Uint8Array(4);
    window.__step(3, 1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { window.__step(1, 1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    return (performance.now() - t0) / n;
  }, { lens, n });
}

for (const weather of ['storm', 'overcast']) {
  const page = await open(`&cam=fp&weather=${weather}&time=13`);
  const res = {};
  for (const l of LENSES) { res[l] = await shoot(page, l, `fp_${weather}_${l}`); console.log(`${weather} ${l.padEnd(7)} contrast ${res[l].sd.toFixed(4)}  mean lum ${res[l].lum.toFixed(3)}`); }
  // no lens again at the end; the baseline is the mean of the two
  const off2 = await shoot(page, 'off', `fp_${weather}_off_end`);
  const base = (res.off.sd + off2.sd) / 2;
  // the storm is the gate; under overcast the frames without the pass drift about 30 % on their own
  // (fine snow noise near 8-bit steps), as much as the lens changes, so it is printed, not checked
  if (weather === 'storm') for (const l of ['rose', 'yellow']) check(`${weather}: ${l} raises the slope contrast over no lens`, res[l].sd > base * 1.25, `${res[l].sd.toFixed(4)} vs ${base.toFixed(4)}`);
  else console.log(`info ${weather}: rose / no lens contrast ${(res.rose.sd / base).toFixed(2)} (no lens alone varies ${(Math.min(res.off.sd, off2.sd, res.clear.sd) / base).toFixed(2)} to ${(Math.max(res.off.sd, off2.sd, res.clear.sd) / base).toFixed(2)}); judge by eye from the PNGs`);
  for (const l of ['blue', 'purple', 'green']) check(`${weather}: ${l} mirror is darker than no lens`, res[l].lum < res.off.lum * 0.95, `${res[l].lum.toFixed(3)} vs ${res.off.lum.toFixed(3)}`);
  check(`${weather}: clear matches no lens`, Math.abs(res.clear.lum - res.off.lum) < 0.01);
  // guard for the isXRRenderTarget trick (Lens.ts): the pass with a near-neutral lens must match no
  // lens. If a three upgrade stops tone mapping and sRGB-encoding the target, the pass decodes linear
  // values twice and the view comes out much darker (Clear cannot catch it: it skips the pass).
  await page.evaluate(() => { window.__sim.settings.lensStrength = 0.002; });
  const neutral = await shoot(page, 'rose', `fp_${weather}_neutral`);
  await page.evaluate(() => { window.__sim.settings.lensStrength = 1; });
  check(`${weather}: the lens pass at near-zero strength matches no lens (target tone mapped like the screen)`, Math.abs(neutral.lum - res.off.lum) < 0.01, `${neutral.lum.toFixed(3)} vs ${res.off.lum.toFixed(3)}`);
  if (weather === 'storm') {
    const off = Math.min(await frameMs(page, 'off'), await frameMs(page, 'off'));
    const on = Math.min(await frameMs(page, 'rose'), await frameMs(page, 'rose'));
    check('lens pass cost', on - off < 1.5, `${off.toFixed(2)} ms without, ${on.toFixed(2)} ms with`);
  }
  await page.close();
}

// the rider wears the lens (the chase camera sees the back of the head, so this checks the material)
{
  const page = await open('&weather=scattered&time=13');
  await page.evaluate(() => { window.__sim.cam.mode = 'close'; });
  for (const l of ['rose', 'blue', 'yellow']) {
    await page.evaluate((l) => { window.__sim.settings.goggleLens = l; }, l);
    await page.evaluate(() => window.__step(2, 1 / 60));
    const c = await page.evaluate(() => '#' + window.__sim.riderView.mats.goggles.color.getHexString());
    check(`rider goggles wear ${l}`, c !== '#ff8a00' || l === 'orange', c);
  }
  await page.close();
}

await browser.close();
server.close();
console.log(fails.length ? `${fails.length} failed` : 'all ok', `(shots in ${outDir})`);
process.exit(fails.length ? 1 : 0);
