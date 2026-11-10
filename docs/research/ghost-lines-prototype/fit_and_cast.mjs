// Ghost lines prototype, step 2: fit the screenshot's camera, then cast each drawn line onto the terrain.
// node docs/research/ghost-lines-prototype/fit_and_cast.mjs <pack> <in.lines.json> <out.world.json>
//   --top <px>      first row of the game canvas in the screenshot (below the browser bars; 52 or 10 on Drew's PC)
//   --height <px>   canvas height in the screenshot (911 on Drew's PC)
//   --fov <deg>     the shot's vertical fov (AttractShots.ts; 50 for Vail's Back Bowls)
//   --obs '[[x,y],[x,y]]'  where the two landmark points are in the screenshot, left then right
//   --landmark '{"x":-718,"y":495.9,"heading":162,"span":7.1,"above":0.88}'  the points in the world: the two
//                   ends of a landmark's span, `above` metres over the snow (Vail: the gateway's footing tops,
//                   world/Landmarks.ts). A resort without a landmark needs another fit (open question in the README).
// Fits the shot's drift phase k (0..1, shotPose) and the image's horizontal centre (the window may be cropped)
// against the two points. Prints the fit error (6 to 7 px on Vail). Writes per line [x, y, z, ray metres] per pixel.
import fs from 'node:fs';
import { openPage, arg } from './common.mjs';

const [pack, inFile, outFile] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const top = Number(arg('top', 52)), height = Number(arg('height', 911)), fov = Number(arg('fov', 50));
const obs = JSON.parse(arg('obs', '[[1067.5,639],[1315,655]]'));
const lm = JSON.parse(arg('landmark', '{"x":-718,"y":495.9,"heading":162,"span":7.1,"above":0.88}'));
const pxPaths = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const { page, close } = await openPage(pack);
const out = await page.evaluate(async ({ pxPaths, top, height, fov, obs, lm }) => {
  const S = window.__sim, pack = S.pack, cam = S.cam.camera, shot = S.shot;
  const V = cam.position.constructor;
  const f = (height / 2) / Math.tan(fov / 2 * Math.PI / 180), cy = top + height / 2;
  const gz = (x, y) => pack.groundHeight(x, y, 5000);
  const h = lm.heading * Math.PI / 180, ax = Math.cos(h), ay = -Math.sin(h);
  const pts = [[lm.x + ax * lm.span / 2, lm.y + ay * lm.span / 2], [lm.x - ax * lm.span / 2, lm.y - ay * lm.span / 2]];
  const camSpace = (x, y, z) => new V(x, z, -y).applyMatrix4(cam.matrixWorldInverse);
  const setK = (k) => {
    const t = Math.acos(1 - 2 * k) * shot.period / (2 * Math.PI);
    const p = S.shotPose(t); S.eyeAt(p.x, p.y, p.h, p.pitch, p.fov, p.eye); window.__step(1, 0); cam.updateMatrixWorld(); return p;
  };
  // the fine tiles under the camera and well out across the view
  const c0 = S.shotPose(0);
  pack.fine.request(c0.x - 4000, c0.y - 4000, c0.x + 4000, c0.y + 4000);
  for (let i = 0; i < 200 && Number.isNaN(pack.fine.sample(c0.x, c0.y)); i++) { window.__step(1, 1 / 60); await new Promise((r) => setTimeout(r, 50)); }
  for (let i = 0; i < 100; i++) { window.__step(1, 1 / 60); await new Promise((r) => setTimeout(r, 50)); if (!pack.fine.pending?.size) break; }
  let best = null;
  for (let k = 0; k <= 1.0001; k += 0.02) {
    const kk = Math.min(1, k), p = setK(kk);
    const proj = pts.map(([x, y]) => { const c = camSpace(x, y, gz(x, y) + lm.above); return [f * c.x / -c.z, cy - f * c.y / -c.z]; }).sort((a, b) => a[0] - b[0]);
    const cx = (obs[0][0] - proj[0][0] + obs[1][0] - proj[1][0]) / 2;
    const err = Math.hypot(proj[0][0] + cx - obs[0][0], proj[0][1] - obs[0][1], proj[1][0] + cx - obs[1][0], proj[1][1] - obs[1][1]);
    if (!best || err < best.err) best = { k: kk, cx, err, pose: p };
  }
  setK(best.k);
  const world = {};
  for (const [name, line] of Object.entries(pxPaths)) {
    world[name] = [];
    for (const [px, py] of line) {
      const d = new V((px - best.cx) / f, -(py - cy) / f, -1).transformDirection(cam.matrixWorld), o = cam.position;
      let prev = 0;
      for (let s = 1; s < 4000; s += 1) {
        const x = o.x + d.x * s, y = -(o.z + d.z * s), z = o.y + d.y * s, g = gz(x, y);
        if (Number.isFinite(g) && z <= g) {
          let a = prev, b = s;
          for (let i = 0; i < 12; i++) { const m = (a + b) / 2; if (o.y + d.y * m <= gz(o.x + d.x * m, -(o.z + d.z * m))) b = m; else a = m; }
          const hx = o.x + d.x * b, hy = -(o.z + d.z * b);
          world[name].push([+hx.toFixed(2), +hy.toFixed(2), +gz(hx, hy).toFixed(2), Math.round(b)]);
          break;
        }
        prev = s;
      }
    }
  }
  return { best, world };
}, { pxPaths, top, height, fov, obs, lm });
fs.writeFileSync(outFile, JSON.stringify(out.world));
console.log('fit', JSON.stringify({ k: out.best.k, cx: +out.best.cx.toFixed(1), errPx: +out.best.err.toFixed(1) }));
for (const [n, p] of Object.entries(out.world)) {
  if (!p.length) { console.log(n, 'no hits'); continue; }
  const zs = p.map((q) => q[2]), rs = p.map((q) => q[3]);
  console.log(n.padEnd(10), `${p.length} pts, ${Math.min(...rs)}..${Math.max(...rs)} m out, z ${Math.round(Math.min(...zs))}..${Math.round(Math.max(...zs))}`);
}
await close();
