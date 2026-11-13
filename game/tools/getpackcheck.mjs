// FEAT-242 getpackcheck: `npm run get -- --from <dir>` (copyPack in get_pack.mjs) on throwaway packs in a temp folder:
// what it copies and leaves out, what it replaces and refuses, that the source pack is never touched, and that a
// plain `get` will not replace a --from copy without --force, and (BUG-106) that it does replace an older-format
// catalog pack but not an older local build. BUG-095: the swap of both (--from and a getPack install from a small
// zip) tries a locked rename again and, locked for good, puts the old pack back. BUG-096: readCatalog's contents
// API read and its raw URL fallback (stub fetch), and that the servers' Download reads the catalog afresh while the
// listing is cached. BUG-109: the API read sends GITHUB_TOKEN (the API only), and `--save-catalog` writes the
// catalog CI's jobs read. Node only (no pack, no browser, no network); exits 1 on a failure.
//   node tools/getpackcheck.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { copyPack, getPack, localPacks, PACK_FORMAT, readCatalog } from './get_pack.mjs';
import http from 'node:http';
import { packDownloads, packFiles } from './pack_routes.mjs';

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
ok(JSON.parse(fs.readFileSync(path.join(packs, 'rel', '.catalog.json'), 'utf8')).status === 'ok' && localPacks(packs).rel.status === 'ok', "get: the marker keeps the catalog's status and localPacks lists it (FEAT-248: the Preview badge)");
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

// BUG-096 readCatalog: the contents API first, the raw URL on any failure, SA_CATALOG / a src as is (stub fetch, no network)
const API = 'https://api.test/contents/catalog.json', RAW = 'https://raw.test/main/catalog.json';
const cat = (v) => ({ resorts: [{ slug: 'vail', pack: { version: v } }] });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const stub = (answers) => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, accept: init?.headers?.accept, auth: init?.headers?.authorization }); const a = answers[url]; if (a instanceof Error) throw a; return a(); };
  return { calls, fetch };
};
const warns = [];
const opts = (s, token = '') => ({ api: API, raw: RAW, fetch: s.fetch, warn: (m) => warns.push(m), token });
delete process.env.SA_CATALOG;
let s = stub({ [API]: () => json(cat(2)), [RAW]: () => json(cat(1)) });
let c = await readCatalog(undefined, opts(s));
ok(c.resorts[0].pack.version === 2 && s.calls.length === 1 && s.calls[0].accept === 'application/vnd.github.raw', 'catalog from the contents API (raw media type), raw URL not read');
for (const [why, api] of [['403 rate limit', () => json({ message: 'rate limit' }, 403)], ['429', () => json({}, 429)],
  ['offline', new TypeError('fetch failed')], ['not a catalog', () => json({ type: 'file', content: 'e30=' })]]) {
  s = stub({ [API]: api, [RAW]: () => json(cat(1)) }); warns.length = 0;
  c = await readCatalog(undefined, opts(s));
  ok(c.resorts[0].pack.version === 1 && s.calls.at(-1).url === RAW && warns.length === 1, `API ${why}: falls back to the raw URL with a warning`);
}
s = stub({ [API]: () => json({}, 403), [RAW]: () => json({}, 503) });
try { await readCatalog(undefined, opts(s)); ok(false, 'both fail: throws'); } catch (e) { ok(/HTTP 503/.test(e.message), `both fail: throws the raw error: ${e.message}`); }
const catFile = path.join(t, 'catalog.json'); fs.writeFileSync(catFile, JSON.stringify(cat(7)));
process.env.SA_CATALOG = catFile; s = stub({});
ok((await readCatalog(undefined, opts(s))).resorts[0].pack.version === 7 && !s.calls.length, 'SA_CATALOG file: read as is, nothing fetched');
delete process.env.SA_CATALOG;
s = stub({ 'https://mirror.test/c.json': () => json(cat(5)) });
ok((await readCatalog('https://mirror.test/c.json', opts(s))).resorts[0].pack.version === 5 && s.calls.length === 1, 'a src URL (--catalog): read as is, no API');
// BUG-109: a token (GITHUB_TOKEN in CI) goes to the API only: not to the raw fallback, not to a src URL
ok(!s.calls[0].auth, 'no token: no authorization header');
s = stub({ [API]: () => json({}, 403), [RAW]: () => json(cat(1)) });
await readCatalog(undefined, opts(s, 'tkn'));
ok(s.calls[0].auth === 'Bearer tkn' && s.calls[1].url === RAW && !s.calls[1].auth, 'token: sent to the API, not to the raw URL fallback');
s = stub({ 'https://mirror.test/c.json': () => json(cat(5)) });
await readCatalog('https://mirror.test/c.json', opts(s, 'tkn'));
ok(!s.calls[0].auth, 'token: not sent to a src URL');
// BUG-109 `--save-catalog <file>`: the catalog it read, written for CI's jobs (SA_CATALOG file here, so no network)
const saved = path.join(t, 'saved.json');
const run = spawnSync(process.execPath, [fileURLToPath(new URL('./get_pack.mjs', import.meta.url)), '--save-catalog', saved],
  { encoding: 'utf8', env: { ...process.env, SA_CATALOG: catFile } });
ok(run.status === 0 && !run.stdout && JSON.parse(fs.readFileSync(saved, 'utf8')).resorts[0].pack.version === 7, `--save-catalog writes the catalog and prints nothing (exit ${run.status}${run.stderr ? `: ${run.stderr.trim()}` : ''})`);

// BUG-096 packDownloads: the listing's catalog is cached, a Download reads it afresh (falling back to the cached one)
const call = (h, method, url, body) => new Promise((resolve) => {
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method, url, headers: { 'content-type': 'application/json', host: 'x' } });
  const res = { statusCode: 0, setHeader() {}, end(b) { resolve({ code: this.statusCode, body: JSON.parse(b) }); } };
  h(req, res, () => resolve({ code: 'next' }));
});
const settle = async (h, slug) => { for (;;) { const j = (await call(h, 'GET', `/__packs/job?slug=${slug}`)).body; if (j.phase === 'done' || j.phase === 'error') return j; await new Promise((r) => setTimeout(r, 20)); } };
let reads = 0, failing = false;
const reader = async () => {
  if (failing) throw new Error('offline');
  reads++;
  return { resorts: [{ slug: 'fresh', name: 'Fresh', status: 'ok', pack: { formatVersion: F, version: reads, sha256: 'x', url: path.join(t, `fresh-v${reads}.zip`), bytes: 1 } }] };
};
let h = packDownloads(packs, { readCatalog: reader });
await call(h, 'GET', '/__packs/catalog'); const listed = await call(h, 'GET', '/__packs/catalog');
ok(reads === 1 && listed.body.catalog.resorts[0].pack.version === 1, 'the listing is cached: one read for two opens');
ok((await call(h, 'POST', '/__packs/get', { slug: 'fresh' })).code === 202 && reads === 2, 'a Download reads the catalog afresh');
let j = await settle(h, 'fresh');
ok(/fresh-v2\.zip/.test(j.error ?? ''), `the Download installs the fresh release (v2), not the listed v1: ${j.error}`);
ok((await call(h, 'GET', '/__packs/catalog')).body.catalog.resorts[0].pack.version === 2 && reads === 2, 'the fresh read refreshes the listing');
failing = true;
ok((await call(h, 'POST', '/__packs/get', { slug: 'fresh' })).code === 202, 'a Download whose fresh read fails starts anyway');
j = await settle(h, 'fresh');
ok(/fresh-v2\.zip/.test(j.error ?? ''), 'it uses the cached catalog');
h = packDownloads(packs, { readCatalog: reader });
const refused = await call(h, 'POST', '/__packs/get', { slug: 'fresh' });
ok(refused.code === 400 && /offline/.test(refused.body.error) && (await call(h, 'GET', '/__packs/job?slug=fresh')).code === 404, 'no catalog at all: 400, and no job is left behind');
{ // FEAT-248: GET /__packs/local is what is on disk, with no catalog read (the main menu's Preview badge)
  fs.writeFileSync(path.join(packs, 'rel', '.catalog.json'), JSON.stringify({ version: 1, sha256: 'old', status: 'preview' }));
  const before = reads; const loc = await call(h, 'GET', '/__packs/local');
  ok(loc.code === 200 && loc.body.formatVersion === F && loc.body.local.rel?.status === 'preview' && reads === before, '/__packs/local: the packs on disk and their catalog status, no catalog read');
}
// BUG-095: a pack file request the browser drops mid-file must not leave the file open in the server. Windows then
// refuses to rename the pack folder, and the picker's Update over it fails with EPERM until the server stops (on
// Linux, CI, the rename works either way; the check bites on Windows)
{
  const lp = path.join(t, 'locks');
  fs.mkdirSync(path.join(lp, 'big', 'cover'), { recursive: true });
  fs.writeFileSync(path.join(lp, 'big', 'cover', 'mid.png'), Buffer.alloc(8 << 20, 1));
  const files = packFiles(lp);
  const srv = http.createServer((req, res) => files(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  await new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${srv.address().port}/packs/big/cover/mid.png`, (res) => { res.once('data', () => req.destroy()); });
    req.on('close', resolve); req.on('error', () => {});
  });
  await new Promise((r) => setTimeout(r, 300));
  let moved = false;
  try { fs.renameSync(path.join(lp, 'big'), path.join(lp, '.big.old')); moved = true; } catch (e) { moved = e.code; }
  ok(moved === true, `packFiles: a request dropped mid-file leaves the pack folder free to rename (${moved})`);
  srv.close();
}
fs.rmSync(t, { recursive: true, force: true });
console.log(fails ? `getpackcheck: ${fails} failed` : 'getpackcheck: all passed');
process.exitCode = fails ? 1 : 0;
