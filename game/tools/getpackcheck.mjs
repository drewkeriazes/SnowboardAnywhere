// FEAT-242 getpackcheck: `npm run get -- --from <dir>` (copyPack in get_pack.mjs) on throwaway packs in a temp folder:
// what it copies and leaves out, what it replaces and refuses, that the source pack is never touched, and that a
// plain `get` will not replace a --from copy without --force, and (BUG-106) that it does replace an older-format
// catalog pack but not an older local build. BUG-095: the swap of both (--from and a getPack install from a small
// zip) tries a locked rename again and, locked for good, puts the old pack back. Node only (no pack, no browser);
// exits 1 on a failure.
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
const throws = async (f, re, m) => { try { await f(); ok(false, m + ' (no throw)'); } catch (e) { ok(re.test(e.message), `${m}: ${e.message}`); } };
const isCopy = (s) => { const d = path.join(packs, s); return fs.existsSync(path.join(d, 'meta.json')) && !fs.lstatSync(d).isSymbolicLink(); };
mk(path.join(mp, 'vail'), { slug: 'vail', name: 'Vail', formatVersion: F, build: 'b1' });
mk(path.join(mp, 'old'), { slug: 'old', name: 'Old', formatVersion: F - 1 });

let r = await copyPack(undefined, path.join(mp, 'vail'), { packsDir: packs });
ok(r.slug === 'vail' && isCopy('vail'), 'copies packs/vail, slug from meta.json');
ok(fs.existsSync(path.join(packs, 'vail', 'fine', '0_0.png')), 'tiles copied');
ok(!fs.existsSync(path.join(packs, 'vail', 'debug')) && !fs.existsSync(path.join(packs, 'vail', '.catalog.json')), 'debug/ and dot files left out, as the zip');
ok(JSON.parse(fs.readFileSync(path.join(packs, 'vail', '.from.json'))).from === path.join(mp, 'vail'), '.from.json names the source');
ok(JSON.parse(fs.readFileSync(path.join(packs, 'index.json'))).packs.includes('vail'), 'index lists vail');
ok((await copyPack('vail', path.join(mp, 'vail'), { packsDir: packs })).already, 'same build again: already');
fs.writeFileSync(path.join(mp, 'vail', 'meta.json'), JSON.stringify({ slug: 'vail', name: 'Vail', formatVersion: F, build: 'b2' }));
r = await copyPack('vail', mp, { packsDir: packs });
ok(!r.already && JSON.parse(fs.readFileSync(path.join(packs, 'vail', 'meta.json'))).build === 'b2', 'a rebuild is copied again (packs folder + slug)');
ok(!fs.readdirSync(packs).some((n) => n.includes('incoming') || n.includes('.old')), 'no temp folders left');

await throws(() => copyPack('bigsky', path.join(mp, 'vail'), { packsDir: packs }), /is the vail pack/, 'slug mismatch');
await throws(() => copyPack(undefined, path.join(mp, 'old'), { packsDir: packs }), /rebuild it in MapPacker/, 'old format');
await throws(() => copyPack(undefined, t, { packsDir: packs }), /not a pack/, 'not a pack');
await throws(() => copyPack('vail', path.join(packs, 'vail'), { packsDir: packs }), /own packs/, 'its own pack');

fs.mkdirSync(path.join(packs, 'local'), { recursive: true }); fs.writeFileSync(path.join(packs, 'local', 'meta.json'), `{"slug":"local","formatVersion":${F}}`);
mk(path.join(mp, 'local'), { slug: 'local', formatVersion: F });
await throws(() => copyPack('local', mp, { packsDir: packs }), /built on this PC/, 'a local build needs --force');
ok(await copyPack('local', mp, { packsDir: packs, force: true }) && fs.existsSync(path.join(packs, 'local', '.from.json')), '--force replaces it');

fs.mkdirSync(path.join(packs, 'dl'), { recursive: true }); fs.writeFileSync(path.join(packs, 'dl', 'meta.json'), `{"slug":"dl","formatVersion":${F}}`);
fs.writeFileSync(path.join(packs, 'dl', '.catalog.json'), '{}'); mk(path.join(mp, 'dl'), { slug: 'dl', formatVersion: F });
ok(await copyPack('dl', mp, { packsDir: packs }) && fs.existsSync(path.join(packs, 'dl', '.from.json')) && !fs.existsSync(path.join(packs, 'dl', '.catalog.json')), 'a catalog download is replaced');

// a hand-made link is replaced by a copy, and only the link goes
mk(path.join(mp, 'lk'), { slug: 'lk', formatVersion: F, build: 'x' }); const other = path.join(t, 'other');
mk(other, { slug: 'lk', formatVersion: F });
fs.symlinkSync(other, path.join(packs, 'lk'), process.platform === 'win32' ? 'junction' : 'dir');
await copyPack('lk', mp, { packsDir: packs });
ok(isCopy('lk') && fs.existsSync(path.join(other, 'fine', '0_0.png')), 'a link is replaced by a copy; its target is intact');

// a link to the source itself (an old junction to the MapPacker build) is replaced too, from the folder or the link
const lnk = process.platform === 'win32' ? 'junction' : 'dir';
for (const [s, from, m] of [['js', () => path.join(mp, 'js'), '--from <the link target>'], ['jl', () => path.join(packs, 'jl'), '--from packs/<slug>, the link itself']]) {
  mk(path.join(mp, s), { slug: s, formatVersion: F, build: 'x' });
  fs.symlinkSync(path.join(mp, s), path.join(packs, s), lnk);
  await copyPack(s, from(), { packsDir: packs });
  ok(isCopy(s) && fs.existsSync(path.join(mp, s, 'debug', 'species.png')), `a link to the source is replaced by a copy (${m}); the source is intact`);
}

// getPack refuses a --from copy without --force
const catalog = { resorts: [{ slug: 'vail', name: 'Vail', status: 'ok', pack: { formatVersion: F, version: 1, sha256: 'bad', url: path.join(t, 'nope.zip'), bytes: 1 } }] };
try { await getPack('vail', { packsDir: packs, catalog }); ok(false, 'getPack refuses a copy'); } catch (e) { ok(/is a copy of/.test(e.message), 'getPack refuses a copy: ' + e.message); }
ok(fs.existsSync(path.join(mp, 'vail', 'debug', 'species.png')), 'the source pack is untouched');

// BUG-095: a rename Windows refuses for a while (EPERM / EBUSY / EACCES: a virus scan of the fresh tiles) is tried
// again before the swap gives up; for good, the old pack is put back. `rename` fails the moves it is told to.
const waits = [1, 1, 1];
const flaky = (fails, code, which) => { let n = 0; return { calls: () => n, rename: (a, b) => {
  if (which(a, b) && n++ < fails) throw Object.assign(new Error(`${code}: operation not permitted, rename '${a}' -> '${b}'`), { code });
  fs.renameSync(a, b);
} }; };
const intoDest = (a) => a.endsWith('.incoming'), toOld = (a, b) => b.endsWith('.old');
const leftovers = () => fs.readdirSync(packs).filter((n) => n.includes('incoming') || n.includes('.old'));
const build = (s) => JSON.parse(fs.readFileSync(path.join(packs, s, 'meta.json'))).build;
let said = [];
let fl = flaky(2, 'EPERM', intoDest);
fs.writeFileSync(path.join(mp, 'vail', 'meta.json'), JSON.stringify({ slug: 'vail', name: 'Vail', formatVersion: F, build: 'b3' }));
await copyPack('vail', mp, { packsDir: packs, rename: fl.rename, waits, onWait: (w) => said.push(w) });
ok(build('vail') === 'b3' && fl.calls() === 3 && said.length === 2 && /EPERM .*try 2 of 4/.test(said[0]), `--from: incoming refused twice (EPERM), then in: "${said[0]}"`);
fl = flaky(1, 'EBUSY', toOld); said = [];
fs.writeFileSync(path.join(mp, 'vail', 'meta.json'), JSON.stringify({ slug: 'vail', name: 'Vail', formatVersion: F, build: 'b4' }));
await copyPack('vail', mp, { packsDir: packs, rename: fl.rename, waits, onWait: (w) => said.push(w) });
ok(build('vail') === 'b4' && said.length === 1 && !leftovers().length, '--from: the old pack refused once (EBUSY), then swapped; no temp folders left');
fl = flaky(99, 'EACCES', intoDest);
fs.writeFileSync(path.join(mp, 'vail', 'meta.json'), JSON.stringify({ slug: 'vail', name: 'Vail', formatVersion: F, build: 'b5' }));
await throws(() => copyPack('vail', mp, { packsDir: packs, rename: fl.rename, waits }), /EACCES.*still locked after 4 tries, the old pack is back/, '--from: locked for good gives up');
ok(fl.calls() === 4 && build('vail') === 'b4' && fs.existsSync(path.join(packs, 'vail', 'fine', '0_0.png')) && !leftovers().length, '--from: after 4 tries the old pack is back whole, no temp folders left');
fl = flaky(99, 'ENOENT', intoDest);
await throws(() => copyPack('vail', mp, { packsDir: packs, rename: fl.rename, waits, force: true }), /ENOENT/, '--from: another error is not retried');
ok(fl.calls() === 1 && build('vail') === 'b4', '--from: ... tried once, the old pack is back');

// the same through getPack (npm run get and the picker's Download): a catalog pack replaced by a newer release zip
const zipOf = (files) => { // a stored zip, as unzip() reads it (no crc check)
  const parts = [], cd = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name), d = Buffer.from(text), lh = Buffer.alloc(30), ch = Buffer.alloc(46);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(n.length, 26);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, n, d); cd.push(ch, n); off += 30 + n.length + d.length;
  }
  const c = Buffer.concat(cd), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(c.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, c, e]);
};
const zip = zipOf({ 'meta.json': JSON.stringify({ slug: 'rel', name: 'Rel', formatVersion: F, build: 'r2' }), 'fine/0_0.png': 'y' });
fs.writeFileSync(path.join(t, 'rel.zip'), zip);
const relCat = { resorts: [{ slug: 'rel', name: 'Rel', status: 'ok', pack: { formatVersion: F, version: 2, sha256: crypto.createHash('sha256').update(zip).digest('hex'), url: path.join(t, 'rel.zip'), bytes: zip.length } }] };
const installed = () => { // release 1 of rel, as getPack left it
  fs.rmSync(path.join(packs, 'rel'), { recursive: true, force: true }); fs.mkdirSync(path.join(packs, 'rel', 'fine'), { recursive: true });
  fs.writeFileSync(path.join(packs, 'rel', 'meta.json'), JSON.stringify({ slug: 'rel', formatVersion: F, build: 'r1' }));
  fs.writeFileSync(path.join(packs, 'rel', 'fine', '0_0.png'), 'x'); fs.writeFileSync(path.join(packs, 'rel', '.catalog.json'), '{"version":1,"sha256":"old"}');
};
installed(); fl = flaky(3, 'EPERM', intoDest); said = [];
await getPack('rel', { packsDir: packs, catalog: relCat, rename: fl.rename, waits, onProgress: (p) => p.wait && said.push(p) });
ok(build('rel') === 'r2' && said.length === 3 && said.every((p) => p.phase === 'unzip') && !leftovers().length, `get: incoming refused 3 times (EPERM), then in; the waits are reported as { phase: 'unzip', wait }`);
installed(); fl = flaky(99, 'EPERM', intoDest);
try { await getPack('rel', { packsDir: packs, catalog: relCat, rename: fl.rename, waits }); ok(false, 'get: locked for good gives up'); } catch (e) { ok(/EPERM.*the old pack is back/.test(e.message), `get: locked for good gives up: ${e.message}`); }
ok(fl.calls() === 4 && build('rel') === 'r1' && fs.existsSync(path.join(packs, 'rel', 'fine', '0_0.png')) && !leftovers().length && !fs.existsSync(path.join(packs, '.rel.download.zip')), 'get: after 4 tries the old pack is back whole, nothing left behind');

// BUG-106: an older-format pack from the catalog has a version in localPacks (the picker's Update) and getPack goes
// on to download over it without --force; one built here has none ("needs rebuild") and is refused
const p2 = path.join(t, 'p2');
const old = (s, marker) => {
  fs.mkdirSync(path.join(p2, s), { recursive: true }); fs.writeFileSync(path.join(p2, s, 'meta.json'), JSON.stringify({ slug: s, formatVersion: F - 1 }));
  if (marker) fs.writeFileSync(path.join(p2, s, '.catalog.json'), JSON.stringify({ version: 1, sha256: 'old' }));
};
old('dl', true); old('mine', false);
const lp = localPacks(p2);
ok(lp.dl.version === 1 && lp.dl.formatVersion === F - 1, 'an old catalog pack: localPacks has its version');
ok(lp.mine.version === undefined, 'an old local build: localPacks has no version');
const cat2 = { resorts: ['dl', 'mine'].map((s) => ({ slug: s, name: s, status: 'ok', pack: { formatVersion: F, version: 2, sha256: 'bad', url: path.join(t, 'nope.zip'), bytes: 1 } })) };
try { await getPack('dl', { packsDir: p2, catalog: cat2 }); ok(false, 'getPack replaces an old catalog pack'); } catch (e) { ok(!/built on this PC|is a copy/.test(e.message), 'getPack replaces an old catalog pack (gets to the download): ' + e.message); }
ok(JSON.parse(fs.readFileSync(path.join(p2, 'dl', 'meta.json'))).formatVersion === F - 1, 'a failed download leaves the old pack in place');
try { await getPack('mine', { packsDir: p2, catalog: cat2 }); ok(false, 'getPack refuses an old local build'); } catch (e) { ok(/built on this PC/.test(e.message), 'getPack refuses an old local build: ' + e.message); }
fs.rmSync(t, { recursive: true, force: true });
console.log(fails ? `getpackcheck: ${fails} failed` : 'getpackcheck: all passed');
process.exitCode = fails ? 1 : 0;
