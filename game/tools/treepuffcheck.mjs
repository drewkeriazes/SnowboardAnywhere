// Snow off the boughs check (FEAT-217): rides TreeBrush (world/TreeBrush.ts) past trees on flat ground,
// with the real crown profile and the trees' snow load (trees/snow.ts), no pack and no browser:
//   - brushing the edge of a 15 m Engelmann spruce at 10 m/s after a storm drops a puff (clumps and a
//     cloud) on the near side, at and above the contact height, and starts a thump
//   - a mid-winter day without new snow drops less, a snow ghost more, a spring day nothing
//   - aspen, a lodgepole's bare lower trunk and a pass 1 m clear of the crown drop nothing
//   - a second pass through the same tree drops less, and it builds back after RECOVER_S; a replay drops
//     what the live pass did without taking the tree's snow
//   - standing still in a crown drops nothing more after the first touch; no frame passes FRAME_CAP
// node tools/treepuffcheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treepuffcheck-'));
const entry = path.join(dir, 'entry.ts');
const src = (m) => JSON.stringify(path.join(GAME, 'src', 'world', `${m}.ts`).replace(/\\/g, '/'));
fs.writeFileSync(entry, [`export * from ${src('TreeBrush')};`, `export { treeSnowState, setTreeSnow } from ${src('trees/snow')};`].join('\n'));
const out = path.join(dir, 'brush.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { TreeBrush, crownOverlap, treeSnowState, setTreeSnow } = await import(pathToFileURL(out).href);

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

// species ids (trees/species.ts): 0 Engelmann spruce, 1 aspen, 4 lodgepole pine
const RADIUS = { 0: 0.13, 1: 0.17, 4: 0.09 };
const tree = (species, x, y, z = 0, h = 15) => ({ species, x, y, z, h, cr: RADIUS[species] * h });
/** the trees a crown contact is looked up in (what Vegetation.crownContact does over its cells) */
function forest(trees) {
  return {
    crownContact(x, y, z, o) {
      let best = 0;
      const tmp = {};
      for (const t of trees) {
        const k = crownOverlap(t.species, t.x, t.y, t.z, t.h, t.cr, x, y, z, tmp);
        if (k > best) { best = k; Object.assign(o, { x: t.x, y: t.y, z: t.z, h: t.h, cr: t.cr, species: t.species, overlap: k, at: tmp.at, r: tmp.r }); }
      }
      return best > 0;
    },
  };
}
/** counts what comes out, and where (three.js: x east, y up, z = -north) */
function sink() {
  const s = { n: 0, clumps: 0, cloud: 0, xs: 0, ys: [], commits: 0 };
  s.emit = (x, y, z, vx, vy, vz, life, size, kind) => { s.n++; if (kind) s.cloud++; else s.clumps++; s.xs += x; s.ys.push(y); };
  s.commit = () => { s.commits++; };
  return s;
}
const DT = 1 / 60;
/** ride north at `speed` m/s along x = `off`, from y -12 to 12, on ground z (a tree at the origin); returns the particles, the most in a frame and the thump */
function pass(brush, off, speed = 10, z = 0) {
  const r = { x: off, y: -12, z, vx: 0, vy: speed, vz: 0 };
  let n = 0, most = 0, thump = 0;
  while (r.y < 12) { thump = Math.max(thump, brush.update(r, DT)); n += brush.released; most = Math.max(most, brush.released); r.y += speed * DT; }
  return { n, most, thump };
}
const day = (newSnow, kind, month = 2) => setTreeSnow(treeSnowState(newSnow, kind, month, 9, 1));

// ---- after a storm: a puff off the edge of a spruce (crown 1.95 m; the rider's side 1.8 m from the trunk)
day(1, 'fresh');
const spruce = [tree(0, 0, 0)];
let s = sink(), b = new TreeBrush(forest(spruce), s);
const storm = pass(b, 1.8);
check('a storm-loaded spruce puffs', storm.n >= 30, `${storm.n} particles (${s.clumps} clumps, ${s.cloud} cloud), thump ${storm.thump.toFixed(2)}`);
check('clumps and a cloud', s.clumps > 0 && s.cloud > 0 && s.clumps > s.cloud, `${s.clumps} clumps, ${s.cloud} cloud`);
check('a thump on the way in', storm.thump > 0.2, `${storm.thump.toFixed(2)}`);
check('on the near side', s.xs / s.n > 0.4, `mean x ${(s.xs / s.n).toFixed(2)} m (the rider at +1.8)`);
const lo = Math.min(...s.ys), hi = Math.max(...s.ys);
check('from bough height around the rider', lo > -0.01 && hi < 4.5 && hi > 1.5, `heights ${lo.toFixed(2)} .. ${hi.toFixed(2)} m`);
check('no frame over the cap', storm.most <= 96, `most in a frame ${storm.most}`);
check('one upload per puff frame', s.commits > 0 && s.commits <= Math.ceil(24 / 10 / DT), `${s.commits} commits`);

// ---- the second pass drops less, and it builds back
const again = pass(b, 1.8);
check('a second pass drops less', again.n < 0.7 * storm.n, `${again.n} vs ${storm.n}`);
for (let t = 0; t < 300; t += 1) b.update({ x: 50, y: 50, z: 0, vx: 0, vy: 0, vz: 0 }, 1);
const back = pass(b, 1.8);
check('builds back over minutes', back.n > 0.85 * storm.n, `${back.n} after 300 s vs ${storm.n}`);

// ---- a replay of the pass drops what the live one did and leaves the tree's snow alone
{
  day(1, 'fresh');
  const bl = new TreeBrush(forest(spruce), sink());
  const live = pass(bl, 1.8), replay = (() => { const r = { x: 1.8, y: -12, z: 0, vx: 0, vy: 10, vz: 0 }; let n = 0; while (r.y < 12) { bl.update(r, DT, true, false); n += bl.released; r.y += 10 * DT; } return n; })();
  const after = pass(bl, 1.8);
  check('a replay drops what the live pass did', Math.abs(replay - live.n) <= 2, `${replay} replayed vs ${live.n} live`);
  check('and leaves the live memory alone', Math.abs(after.n - again.n) <= 3, `${after.n} on the next live pass, like a second pass (${again.n})`);
}

// ---- the day's load
day(0, 'mid');
const mid = pass(new TreeBrush(forest(spruce), sink()), 1.8);
check('a mid-winter day drops less than a storm', mid.n > 0 && mid.n < 0.7 * storm.n, `${mid.n} vs ${storm.n}`);
const ghostTree = [tree(0, 0, 0, 3600)];
const ghost = pass(new TreeBrush(forest(ghostTree), sink()), 1.8, 10, 3600);
check('a snow ghost drops more', ghost.n > 1.5 * mid.n, `${ghost.n} at 3,600 m vs ${mid.n} below the ghost band`);
day(0, 'spring', 3);
const spring = pass(new TreeBrush(forest(spruce), sink()), 1.8);
check('nothing in spring', spring.n === 0, `${spring.n} particles`);

// ---- what holds no snow, or is out of reach
day(1, 'fresh');
check('aspen holds none', pass(new TreeBrush(forest([tree(1, 0, 0)]), sink()), 1.8).n === 0, 'no needles');
check("a lodgepole's bare trunk", pass(new TreeBrush(forest([tree(4, 0, 0)]), sink()), 0.6).n === 0, 'its crown starts 9.6 m up');
check('clear of the crown', pass(new TreeBrush(forest(spruce), sink()), 3.3).n === 0, '1 m outside');
const deep = pass(new TreeBrush(forest(spruce), sink()), 0.9);
check('deeper in drops more', deep.n > storm.n, `${deep.n} at 0.9 m from the trunk vs ${storm.n} at 1.8 m`);

// ---- standing in a crown
{
  const s2 = sink(), b2 = new TreeBrush(forest(spruce), s2), r = { x: 1.5, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  b2.update(r, DT);
  const first = s2.n;
  for (let i = 0; i < 120; i++) b2.update(r, DT);
  check('standing still drops nothing more', s2.n === first, `${first} on the touch, ${s2.n - first} over 2 s after`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
