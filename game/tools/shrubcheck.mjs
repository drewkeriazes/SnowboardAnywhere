// Shrub physics and snowpack check (FEAT-159): rides the Rider physics on an exact 15 degree plane (no
// pack, no browser) through brush and into a young conifer's trunk, and checks the snowpack depth model:
//   - a willow clump standing 1.5 m above the snow costs a little speed (0.1 to 1 m/s at 12 m/s), no
//     deflection and no crash, and the board reads brush under it while inside
//   - the same clump buried (its top under the board) costs nothing
//   - a young conifer standing over 1.5 m is a trunk: the rider is stopped by it
//   - the snowpack is deeper high up and on north faces, thinner on low south faces, gone in July, and
//     ?snowdepth (the override) sets it everywhere
// node tools/shrubcheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrubcheck-'));
const entry = path.join(dir, 'entry.ts');
fs.writeFileSync(entry, ['Rider', 'Collider', 'Snowpack'].map((m) => `export * from ${JSON.stringify(path.join(GAME, 'src', 'sim', `${m}.ts`).replace(/\\/g, '/'))};`).join('\n'));
const out = path.join(dir, 'sim.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { Rider, Collider, snowpackState, snowpackDepth, aspectOf } = await import(pathToFileURL(out).href);

const D = Math.PI / 180;
const DEG = 15, T = Math.tan(DEG * D), K = 1 / Math.hypot(T, 1);
/** a plane falling toward +y (north) at DEG degrees */
const plane = {
  mask: null, coarseFallbacks: 0,
  groundHeight: (x, y) => -T * y,
  groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = T * K; o[2] = K; return o; },
};
const input = () => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false });
const DT = 1 / 120;

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

/** ride straight down from y 0 at 12 m/s until y reaches `to`; returns the rider and the most brush felt */
function ride(collider, to = 40) {
  const r = new Rider(plane, collider);
  r.surface.groomed = 1;
  r.reset(0, 0, 0);
  r.vy = 12; r.vz = -T * 12;
  let brush = 0, t = 0;
  while (r.y < to && t < 8) { r.update(DT, input()); brush = Math.max(brush, r.surface.shrub); t += DT; }
  return { r, brush, t };
}

// ---- brush: a willow clump (4 stems in a 2 m patch) across the line at y 18..22, 1.5 m above the snow
const clump = (c, up) => { for (const [x, y] of [[0, 18], [0.6, 19.5], [-0.5, 20.5], [0.2, 22]]) c.addBrush(x, y, 0.9, -T * y + up, 0.8); };
const clear = ride(new Collider());
const willow = new Collider(); clump(willow, 1.5);
const thru = ride(willow);
const loss = clear.r.speed - thru.r.speed;
check('willow clump slows a little', loss > 0.1 && loss < 1, `${clear.r.speed.toFixed(2)} m/s clear, ${thru.r.speed.toFixed(2)} through the willow (loss ${loss.toFixed(2)})`);
check('the board feels the brush', thru.brush > 0.4, `surface.shrub peak ${thru.brush.toFixed(2)}`);
check('no deflection or crash in brush', Math.abs(thru.r.x - clear.r.x) < 0.05 && thru.r.crashed <= 0, `x ${thru.r.x.toFixed(3)} vs ${clear.r.x.toFixed(3)}, crashed ${thru.r.crashed.toFixed(2)}`);
const buried = new Collider(); clump(buried, -0.5); // well under: a 0.9 m clump on 15 degrees drops 0.24 m across its downhill side
const under = ride(buried);
check('buried willow costs nothing', Math.abs(clear.r.speed - under.r.speed) < 1e-6 && under.brush === 0, `${under.r.speed.toFixed(3)} m/s, brush ${under.brush}`);

// ---- a young conifer standing 2.2 m above the snow: a trunk (radius 0.12 m) on the line at y 20
const tree = new Collider();
const zg = -T * 20;
tree.add(0, 20, 0.12, zg - 1, zg + 2.2);
const hit = ride(tree, 25);
check('a tall young conifer is a trunk', hit.r.y < 21 || hit.r.crashed > 0 || Math.abs(hit.r.x) > 0.3, `y ${hit.r.y.toFixed(2)}, x ${hit.r.x.toFixed(2)}, crashed ${hit.r.crashed.toFixed(2)}, speed ${hit.r.speed.toFixed(2)}`);
// and one the snow has buried below 1.5 m: its entry switched off in place (as Shrubs does)
const low = new Collider();
const e = low.add(0, 20, 0.12, zg - 1, zg + 2.2);
e[3] = e[4] = -1e9;
const pass = ride(low);
check('a switched-off trunk lets the board by', Math.abs(pass.r.speed - clear.r.speed) < 1e-6, `${pass.r.speed.toFixed(3)} m/s`);
const gone = new Collider();
const e2 = gone.add(0, 20, 0.12, zg - 1, zg + 2.2), b2 = gone.addBrush(0, 20, 0.5, zg + 1, 1);
gone.remove(e2); gone.removeBrush(b2);
check('remove and removeBrush clear them', gone.count === 0 && gone.brushAt(0, 20, zg, 0.35) === 0, `count ${gone.count}`);

// ---- the snowpack
const feb = snowpackState(2, 'mid', 0), jul = snowpackState(7, 'mid', 0);
const flat = [0, 0], south = aspectOf(0, -0.4), north = aspectOf(0, 0.4); // a 22 degree slope facing south / north
const d = (st, z, a) => snowpackDepth(st, z, a[0], a[1]);
check('deeper high up', d(feb, 3400, flat) > 1.5 && d(feb, 2450, flat) < 0.7, `Feb flat: ${d(feb, 2450, flat).toFixed(2)} m at 2,450 m, ${d(feb, 3000, flat).toFixed(2)} at 3,000, ${d(feb, 3400, flat).toFixed(2)} at 3,400`);
check('low south faces thin, north faces deeper', d(feb, 2500, south) < 0.45 && d(feb, 2500, north) > d(feb, 2500, flat), `Feb 2,500 m: south ${d(feb, 2500, south).toFixed(2)}, flat ${d(feb, 2500, flat).toFixed(2)}, north ${d(feb, 2500, north).toFixed(2)}`);
check('spring takes more off the south faces', d(snowpackState(2, 'spring', 0), 2500, south) < d(feb, 2500, south), `${d(snowpackState(2, 'spring', 0), 2500, south).toFixed(2)} m`);
check('new snow adds', d(snowpackState(2, 'mid', 1), 3000, flat) - d(feb, 3000, flat) > 0.3, `+${(d(snowpackState(2, 'mid', 1), 3000, flat) - d(feb, 3000, flat)).toFixed(2)} m after a storm`);
check('July is bare', d(jul, 3000, flat) === 0, `${d(jul, 3000, flat)} m`);
check('the override sets one depth', d(snowpackState(2, 'mid', 1, 0.5), 3400, south) === 0.5, `${d(snowpackState(2, 'mid', 1, 0.5), 3400, south)} m`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
