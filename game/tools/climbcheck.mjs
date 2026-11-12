// Climb check (BUG-112): walks the Rider on foot straight up exact inclined planes (no pack, no
// browser) in powder and checks the uphill pace does not stack to nothing:
//   - scrambling a 42 degree slope in 11 in of powder, forward held for 5 s, gains at least 1.5 m
//   - with sprint held as well it gains more (sprint works while scrambling)
//   - 9 s at 41.5 degrees in the same snow (the spot in Drew's clip) gains at least 10 ft
//   - steeper is still slower: 37 degrees on groomed snow scrambles faster than 44
//   - past CRAWL_MAX (48 degrees) pushing forward still slips you back down
// Prints the numbers and exits 1 on a failed check. node tools/climbcheck.mjs
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'climbcheck-')), 'rider.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'sim', 'Rider.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { Rider } = await import(pathToFileURL(out).href);

const D = Math.PI / 180, DT = 1 / 120, FT = 0.3048, IN = 0.0254;
/** plane rising toward +y (north) at `deg` degrees; heading 0 walks straight up it */
function plane(deg) {
  const t = Math.tan(deg * D), k = 1 / Math.hypot(t, 1);
  return {
    mask: null, coarseFallbacks: 0, mogulAmp: () => 0,
    groundHeight: (x, y) => t * y,
    groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = -t * k; o[2] = k; return o; },
  };
}
const input = () => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false });

/**
 * On foot at the origin facing up a `deg` plane, forward (and sprint if `sprint`) held for `T` s.
 * `powder`: off-piste under trees with 0.3 of new snow, which snowAt makes 0.28 m (11 in) of powder on
 * this south-facing plane; otherwise groomed. Returns the height gained (m), the snow depth and how
 * much of the time was spent scrambling.
 */
function climb(deg, T, { sprint = false, powder = true } = {}) {
  const r = new Rider(plane(deg), null);
  r.surface.groomed = powder ? 0 : 1; r.surface.canopy = powder ? 0.6 : 0;
  r.snowWorld.newSnow = powder ? 0.3 : 0;
  r.reset(0, 0, 0);
  r.onFoot = true;
  const inp = input();
  inp.tuck = true; inp.grab = sprint;
  const z0 = r.pack.groundHeight(r.x, r.y);
  let t = 0, crawl = 0, sprinted = 0;
  while (t < T) {
    r.update(DT, inp); t += DT;
    if (r.crawling) crawl += DT;
    if (r.sprinting) sprinted += DT;
  }
  return { gain: r.z - z0, depth: r.snow.depth, crawl, sprinted };
}

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }
const m = (v) => `${v.toFixed(2)} m (${(v / FT).toFixed(1)} ft)`;

const walk42 = climb(42, 5), sprint42 = climb(42, 5, { sprint: true });
console.log(`42 deg, ${(walk42.depth / IN).toFixed(1)} in of powder, 5 s: forward ${m(walk42.gain)} (scrambling ${walk42.crawl.toFixed(1)} s), with sprint ${m(sprint42.gain)} (sprinting ${sprint42.sprinted.toFixed(1)} s)`);
check('42 deg in 11 in of powder: 5 s forward gains at least 1.5 m', Math.abs(walk42.depth / IN - 11) < 0.5 && walk42.crawl > 4 && walk42.gain >= 1.5, `${m(walk42.gain)}, ${(walk42.depth / IN).toFixed(1)} in, scrambling ${walk42.crawl.toFixed(1)} s`);
check('sprint speeds up the scramble and drains stamina', sprint42.gain > walk42.gain * 1.2 && sprint42.sprinted > 2, `${m(sprint42.gain)} vs ${m(walk42.gain)}, sprinting ${sprint42.sprinted.toFixed(1)} s`);

const clip = climb(41.5, 9);
check('the clip: 9 s at 41.5 deg in powder gains at least 10 ft', clip.gain >= 10 * FT, m(clip.gain));

const easy = climb(37, 5, { powder: false }), hard = climb(44, 5, { powder: false });
check('steeper is still slower: 37 deg beats 44 deg on groomed', easy.gain / Math.tan(37 * D) > hard.gain / Math.tan(44 * D) * 1.2, `ground pace ${(easy.gain / Math.tan(37 * D) / 5).toFixed(2)} vs ${(hard.gain / Math.tan(44 * D) / 5).toFixed(2)} m/s`);

const tooSteep = climb(48, 5), tooSteepSprint = climb(48, 5, { sprint: true });
check('past CRAWL_MAX (48 deg) forward still slips you back down', tooSteep.gain < 0 && tooSteepSprint.gain < 0, `${m(tooSteep.gain)}, with sprint ${m(tooSteepSprint.gain)}`);

console.log(fails ? `${fails} check(s) failed` : 'all climb checks passed');
process.exit(fails ? 1 : 0);
