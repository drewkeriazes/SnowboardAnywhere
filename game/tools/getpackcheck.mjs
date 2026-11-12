// FEAT-242 getpackcheck: `npm run get -- --from <dir>` (copyPack in get_pack.mjs) on throwaway packs in a temp folder:
// what it copies and leaves out, what it replaces and refuses, that the source pack is never touched, and that a
// plain `get` will not replace a --from copy without --force. BUG-096: readCatalog's contents API read and its raw
// URL fallback (stub fetch), and that the servers' Download reads the catalog afresh while the listing is cached.
// Node only (no pack, no browser, no network); exits 1 on a failure.
//   node tools/getpackcheck.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { copyPack, getPack, PACK_FORMAT, readCatalog } from './get_pack.mjs';
import { packDownloads } from './pack_routes.mjs';

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

// BUG-096 readCatalog: the contents API first, the raw URL on any failure, SA_CATALOG / a src as is (stub fetch, no network)
const API = 'https://api.test/contents/catalog.json', RAW = 'https://raw.test/main/catalog.json';
const cat = (v) => ({ resorts: [{ slug: 'vail', pack: { version: v } }] });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const stub = (answers) => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, accept: init?.headers?.accept }); const a = answers[url]; if (a instanceof Error) throw a; return a(); };
  return { calls, fetch };
};
const warns = [];
const opts = (s) => ({ api: API, raw: RAW, fetch: s.fetch, warn: (m) => warns.push(m) });
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
fs.rmSync(t, { recursive: true, force: true });
console.log(fails ? `getpackcheck: ${fails} failed` : 'getpackcheck: all passed');
process.exitCode = fails ? 1 : 0;
