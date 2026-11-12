// FEAT-242 getpackcheck: `npm run get -- --from <dir>` (copyPack in get_pack.mjs) on throwaway packs in a temp folder:
// what it copies and leaves out, what it replaces and refuses, that the source pack is never touched, and that a
// plain `get` will not replace a --from copy without --force. FEAT-230: a boot and a rest zip (written here) go in
// one after the other, the pack is `partial` in packs/index.json in between, a failed rest leaves a playable partial
// pack that the next get finishes, and --full takes the whole zip. Node only (no pack, no browser); exits 1 on a failure.
//   node tools/getpackcheck.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyPack, getPack, localPacks, PACK_FORMAT } from './get_pack.mjs';

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

// a link to the source itself (an old junction to the MapPacker build) is replaced too, from the folder or the link
const lnk = process.platform === 'win32' ? 'junction' : 'dir';
for (const [s, from, m] of [['js', () => path.join(mp, 'js'), '--from <the link target>'], ['jl', () => path.join(packs, 'jl'), '--from packs/<slug>, the link itself']]) {
  mk(path.join(mp, s), { slug: s, formatVersion: F, build: 'x' });
  fs.symlinkSync(path.join(mp, s), path.join(packs, s), lnk);
  copyPack(s, from(), { packsDir: packs });
  ok(isCopy(s) && fs.existsSync(path.join(mp, s, 'debug', 'species.png')), `a link to the source is replaced by a copy (${m}); the source is intact`);
}

// getPack refuses a --from copy without --force
const catalog = { resorts: [{ slug: 'vail', name: 'Vail', status: 'ok', pack: { formatVersion: F, version: 1, sha256: 'bad', url: path.join(t, 'nope.zip'), bytes: 1 } }] };
try { await getPack('vail', { packsDir: packs, catalog }); ok(false, 'getPack refuses a copy'); } catch (e) { ok(/is a copy of/.test(e.message), 'getPack refuses a copy: ' + e.message); }
ok(fs.existsSync(path.join(mp, 'vail', 'debug', 'species.png')), 'the source pack is untouched');
// ---- FEAT-230: boot and rest zips
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** a stored zip of { name: string | Buffer }, as MapPacker's publish_pack.py writes them */
const zipOf = (file, entries) => {
  const parts = [], cd = [];
  let off = 0;
  for (const [name, v] of Object.entries(entries)) {
    const data = Buffer.from(v), nm = Buffer.from(name), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, data); cd.push(ch, nm);
    off += 30 + nm.length + data.length;
  }
  const cdb = Buffer.concat(cd), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(cdb.length, 12); end.writeUInt32LE(off, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, cdb, end]));
  return { url: file, bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
};
const bt = path.join(t, 'bt'), bpacks = path.join(t, 'bpacks');
fs.mkdirSync(bt, { recursive: true });
const bmeta = JSON.stringify({ slug: 'bt', name: 'Boot Test', formatVersion: F, build: 'b1' });
const bootInfo = JSON.stringify({ boot: 1, centres: [[0, 0]], radius: 1000, tiles: { fine: ['0_0'], trees: [] } });
const boot = zipOf(path.join(bt, 'bt-boot.zip'), { 'boot.json': bootInfo, 'features.json': '{}', 'fine/0_0.png': 'f00', 'mid/0_0.png': 'm00', 'meta.json': bmeta });
const rest = zipOf(path.join(bt, 'bt-rest.zip'), { 'fine/1_0.png': 'f10', 'trees/0_0.bin': 't00' });
const whole = zipOf(path.join(bt, 'bt.zip'), { 'boot.json': bootInfo, 'features.json': '{}', 'fine/0_0.png': 'f00', 'fine/1_0.png': 'f10', 'mid/0_0.png': 'm00', 'meta.json': bmeta, 'trees/0_0.bin': 't00' });
const bcat = (restPart = rest) => ({ resorts: [{ slug: 'bt', name: 'Boot Test', status: 'preview', pack: { formatVersion: F, version: 1, ...whole, boot, rest: restPart } }] });
const bindex = () => JSON.parse(fs.readFileSync(path.join(bpacks, 'index.json'), 'utf8'));
const bfile = (rel) => fs.existsSync(path.join(bpacks, 'bt', rel));
let atRest = null;
r = await getPack('bt', { packsDir: bpacks, catalog: bcat(), onProgress: (p) => {
  if (p.phase === 'rest' && !atRest) atRest = { boot: bfile('fine/0_0.png') && bfile('meta.json'), rest: bfile('fine/1_0.png'), partial: bindex().partial, marker: bfile('.partial.json'), local: localPacks(bpacks).bt?.partial };
} });
ok(atRest?.boot && !atRest.rest, 'boot zip in before the rest starts, the rest not yet');
ok(JSON.stringify(atRest?.partial) === '["bt"]' && atRest.marker && atRest.local === true, 'in between: index.json partial ["bt"], .partial.json, localPacks partial');
ok(bfile('fine/1_0.png') && bfile('trees/0_0.bin') && bfile('fine/0_0.png'), 'the rest moved into the pack beside the boot files');
ok(bindex().partial === undefined && !bfile('.partial.json') && !localPacks(bpacks).bt.partial, 'partial cleared once the rest is in');
ok(r.boot === boot.bytes && r.rest === rest.bytes && !r.resumed, `result: boot ${r.boot} B then rest ${r.rest} B`);
ok(!fs.readdirSync(bpacks).some((n) => n.startsWith('.') && n !== '.index.json.tmp') && !fs.existsSync(path.join(bpacks, '.index.json.tmp')), 'no temp files or folders left');
ok((await getPack('bt', { packsDir: bpacks, catalog: bcat() })).already, 'the same release again: already');

// a rest that fails (bad sha256) leaves the boot pack in place and partial; the next get fetches only the rest
fs.rmSync(bpacks, { recursive: true, force: true });
try { await getPack('bt', { packsDir: bpacks, catalog: bcat({ ...rest, sha256: '0'.repeat(64) }) }); ok(false, 'a bad rest is refused'); } catch (e) { ok(/sha256/.test(e.message), 'a bad rest is refused: ' + e.message); }
ok(bfile('meta.json') && !bfile('fine/1_0.png') && JSON.stringify(bindex().partial) === '["bt"]', 'after it the boot pack is still there and still partial');
ok(!fs.existsSync(path.join(bpacks, '.bt.rest')) && !fs.existsSync(path.join(bpacks, '.bt.rest.zip')), 'the failed rest left no temp files');
let phases = [];
r = await getPack('bt', { packsDir: bpacks, catalog: bcat(), onProgress: (p) => phases.push(p.phase) });
ok(r.resumed && !phases.includes('download') && bfile('fine/1_0.png') && bindex().partial === undefined, 'get again: only the rest is fetched, then the pack is whole');

// --full takes the one zip even with a boot zip in the catalog
fs.rmSync(bpacks, { recursive: true, force: true });
phases = [];
r = await getPack('bt', { packsDir: bpacks, catalog: bcat(), full: true, onProgress: (p) => phases.push(p.phase) });
ok(r.bytes === whole.bytes && !phases.includes('rest') && bfile('trees/0_0.bin') && bindex().partial === undefined, '--full: the whole zip, never partial');
// a catalog entry without boot and rest (packs published before FEAT-230) installs as before
fs.rmSync(bpacks, { recursive: true, force: true });
const plain = bcat(); delete plain.resorts[0].pack.boot; delete plain.resorts[0].pack.rest;
r = await getPack('bt', { packsDir: bpacks, catalog: plain });
ok(r.bytes === whole.bytes && bfile('fine/1_0.png') && bindex().partial === undefined, 'an entry without boot and rest: the whole zip');

fs.rmSync(t, { recursive: true, force: true });
console.log(fails ? `getpackcheck: ${fails} failed` : 'getpackcheck: all passed');
process.exitCode = fails ? 1 : 0;
