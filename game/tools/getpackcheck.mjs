// FEAT-242 getpackcheck: `npm run get -- --from <dir>` (copyPack in get_pack.mjs) on throwaway packs in a temp folder:
// what it copies and leaves out, what it replaces and refuses, that the source pack is never touched, and that a
// plain `get` will not replace a --from copy without --force. Node only (no pack, no browser); exits 1 on a failure.
//   node tools/getpackcheck.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyPack, getPack, PACK_FORMAT } from './get_pack.mjs';

const F = PACK_FORMAT;
const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
const mp = path.join(t, 'mp', 'packs'), packs = path.join(t, 'packs');
const mk = (dir, meta) => {
  fs.mkdirSync(path.join(dir, 'fine'), { recursive: true }); fs.mkdirSync(path.join(dir, 'debug'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta)); fs.writeFileSync(path.join(dir, 'fine', '0_0.png'), 'x');
  fs.writeFileSync(path.join(dir, 'debug', 'species.png'), 'd'); fs.writeFileSync(path.join(dir, '.catalog.json'), '{"x":1}');
};
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const throws = (f, re, m) => { try { f(); ok(false, m + ' (no throw)'); } catch (e) { ok(re.test(e.message), `${m}: ${e.message}`); } };
const isCopy = (s) => { const d = path.join(packs, s); return fs.existsSync(path.join(d, 'meta.json')) && !fs.lstatSync(d).isSymbolicLink(); };
mk(path.join(mp, 'vail'), { slug: 'vail', name: 'Vail', formatVersion: F, build: 'b1' });
mk(path.join(mp, 'old'), { slug: 'old', name: 'Old', formatVersion: F - 1 });

let r = copyPack(undefined, path.join(mp, 'vail'), { packsDir: packs });
ok(r.slug === 'vail' && isCopy('vail'), 'copies packs/vail, slug from meta.json');
ok(fs.existsSync(path.join(packs, 'vail', 'fine', '0_0.png')), 'tiles copied');
ok(!fs.existsSync(path.join(packs, 'vail', 'debug')) && !fs.existsSync(path.join(packs, 'vail', '.catalog.json')), 'debug/ and dot files left out, as the zip');
ok(JSON.parse(fs.readFileSync(path.join(packs, 'vail', '.from.json'))).from === path.join(mp, 'vail'), '.from.json names the source');
ok(JSON.parse(fs.readFileSync(path.join(packs, 'index.json'))).packs.includes('vail'), 'index lists vail');
ok(copyPack('vail', path.join(mp, 'vail'), { packsDir: packs }).already, 'same build again: already');
fs.writeFileSync(path.join(mp, 'vail', 'meta.json'), JSON.stringify({ slug: 'vail', name: 'Vail', formatVersion: F, build: 'b2' }));
r = copyPack('vail', mp, { packsDir: packs });
ok(!r.already && JSON.parse(fs.readFileSync(path.join(packs, 'vail', 'meta.json'))).build === 'b2', 'a rebuild is copied again (packs folder + slug)');
ok(!fs.readdirSync(packs).some((n) => n.includes('incoming') || n.includes('.old')), 'no temp folders left');

throws(() => copyPack('bigsky', path.join(mp, 'vail'), { packsDir: packs }), /is the vail pack/, 'slug mismatch');
throws(() => copyPack(undefined, path.join(mp, 'old'), { packsDir: packs }), /rebuild it in MapPacker/, 'old format');
throws(() => copyPack(undefined, t, { packsDir: packs }), /not a pack/, 'not a pack');
throws(() => copyPack('vail', path.join(packs, 'vail'), { packsDir: packs }), /own packs/, 'its own pack');

fs.mkdirSync(path.join(packs, 'local'), { recursive: true }); fs.writeFileSync(path.join(packs, 'local', 'meta.json'), `{"slug":"local","formatVersion":${F}}`);
mk(path.join(mp, 'local'), { slug: 'local', formatVersion: F });
throws(() => copyPack('local', mp, { packsDir: packs }), /built on this PC/, 'a local build needs --force');
ok(copyPack('local', mp, { packsDir: packs, force: true }) && fs.existsSync(path.join(packs, 'local', '.from.json')), '--force replaces it');

fs.mkdirSync(path.join(packs, 'dl'), { recursive: true }); fs.writeFileSync(path.join(packs, 'dl', 'meta.json'), `{"slug":"dl","formatVersion":${F}}`);
fs.writeFileSync(path.join(packs, 'dl', '.catalog.json'), '{}'); mk(path.join(mp, 'dl'), { slug: 'dl', formatVersion: F });
ok(copyPack('dl', mp, { packsDir: packs }) && fs.existsSync(path.join(packs, 'dl', '.from.json')) && !fs.existsSync(path.join(packs, 'dl', '.catalog.json')), 'a catalog download is replaced');

// a hand-made link is replaced by a copy, and only the link goes
mk(path.join(mp, 'lk'), { slug: 'lk', formatVersion: F, build: 'x' }); const other = path.join(t, 'other');
mk(other, { slug: 'lk', formatVersion: F });
fs.symlinkSync(other, path.join(packs, 'lk'), process.platform === 'win32' ? 'junction' : 'dir');
copyPack('lk', mp, { packsDir: packs });
ok(isCopy('lk') && fs.existsSync(path.join(other, 'fine', '0_0.png')), 'a link is replaced by a copy; its target is intact');

// getPack refuses a --from copy without --force
const catalog = { resorts: [{ slug: 'vail', name: 'Vail', status: 'ok', pack: { formatVersion: F, version: 1, sha256: 'bad', url: path.join(t, 'nope.zip'), bytes: 1 } }] };
try { await getPack('vail', { packsDir: packs, catalog }); ok(false, 'getPack refuses a copy'); } catch (e) { ok(/is a copy of/.test(e.message), 'getPack refuses a copy: ' + e.message); }
ok(fs.existsSync(path.join(mp, 'vail', 'debug', 'species.png')), 'the source pack is untouched');
fs.rmSync(t, { recursive: true, force: true });
console.log(fails ? `getpackcheck: ${fails} failed` : 'getpackcheck: all passed');
process.exitCode = fails ? 1 : 0;
