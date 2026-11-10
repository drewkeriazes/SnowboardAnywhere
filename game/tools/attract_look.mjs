// FEAT-177: the main menu still's look key. `code` hashes the source files that change what the backdrop shot
// looks like (LOOK below; line endings normalised, so a Windows checkout and CI agree); shoot_attract.mjs records
// it per still in game/public/attract/index.json with the pack's `meta.build`.
//   node game/tools/attract_look.mjs            print the current code key and each still's recorded one
//   node game/tools/attract_look.mjs --check --base <ref>
//       CI (checks.yml > repo-rules): a GitHub warning for each still whose key no longer matches when the PR
//       changes a LOOK file. A reminder, never a failure: CI has no GPU and no Vail pack to render it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** repo paths (folders taken whole) whose changes show in the menu's backdrop shot */
export const LOOK = [
  'game/src/terrain',
  'game/src/world/trees',
  ...['Sky', 'Atmosphere', 'Clouds', 'Sun', 'SunClock', 'Vegetation', 'Landmarks', 'Rocks', 'SnowCover', 'scattering', 'SceneRender', 'AttractShots']
    .map((f) => `game/src/world/${f}.ts`),
];
export const MANIFEST = 'game/public/attract/index.json';

function files(rel) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return [];
  if (!fs.statSync(abs).isDirectory()) return [rel];
  return fs.readdirSync(abs).sort().flatMap((n) => files(`${rel}/${n}`));
}

/** a resort's shots (FEAT-181: data, not code): its own, so another resort's new shot doesn't stale this one's still */
const shotsFile = (slug) => `game/public/attract/${slug}/shots.json`;

/** the code half of a resort's look key: sha256 over each LOOK file's path and text and the resort's shots.json, first 16 hex digits */
export function lookCode(slug) {
  const h = crypto.createHash('sha256');
  for (const f of [...LOOK.flatMap(files), ...(slug ? files(shotsFile(slug)) : [])].sort()) {
    h.update(f + '\0');
    h.update(fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n'));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

/** a file the PR changed is a LOOK file */
const isLook = (f) => LOOK.some((l) => f === l || f.startsWith(l + '/')) || /^game\/public\/attract\/[^/]+\/shots\.json$/.test(f);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const man = JSON.parse(fs.readFileSync(path.join(REPO, MANIFEST), 'utf8'));
  const stale = [];
  const codes = {};
  for (const [slug, e] of Object.entries(man)) {
    const code = (codes[slug] = lookCode(slug));
    for (const id of e.stills ?? []) {
      const look = e.looks?.[id];
      if (look?.code !== code) stale.push(`${slug}/${id}`);
      if (!args.includes('--check')) console.log(`${slug}/${id}: recorded ${look ? `${look.code} (pack build ${look.pack || 'none'})` : 'no look key'}${look?.code === code ? '' : ', stale'}`);
    }
  }
  if (!args.includes('--check')) { console.log(`current code keys: ${Object.entries(codes).map(([k, v]) => `${k} ${v}`).join(', ')}`); process.exit(0); }
  const bi = args.indexOf('--base');
  const base = bi >= 0 ? args[bi + 1] : 'origin/main';
  let changed = [];
  try { changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* no base: judge by the key alone */ }
  const touched = changed.filter(isLook);
  if (stale.length && (touched.length || !changed.length)) {
    const packs = [...new Set(stale.map((s) => s.split('/')[0]))].join(' ');
    console.log(`::warning file=${MANIFEST}::Main menu still is stale (${stale.join(', ')}): ${touched.length ? `this PR changes the look (${touched.slice(0, 4).join(', ')}${touched.length > 4 ? ', ...' : ''}) but not the still` : 'its look key no longer matches the code'}. On Drew's PC: cd game && npx vite build && node tools/shoot_attract.mjs ${packs} --gpu, then commit the JPEG and index.json.`);
  }
  console.log(`attract look: code ${Object.entries(codes).map(([k, v]) => `${k} ${v}`).join(', ')}; ${stale.length ? `stale: ${stale.join(', ')}` : 'stills up to date'}${touched.length ? `; look files changed: ${touched.length}` : ''}`);
}
