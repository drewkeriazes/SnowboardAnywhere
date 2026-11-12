// FEAT-222 `npm run get <slug>` (node tools/get_pack.mjs <slug> [--force] [--sha256] [--catalog <url|file>] | --list):
// download a published resort pack into packs/<slug>. Reads catalog.json from the resorts repo
// (drewkeriazes/MapPacker-SnowboardAnywhere, written by MapPacker-SnowboardAnywhere/pipeline/publish_pack.py), downloads the release zip in
// Node (GitHub release assets send no CORS headers, so the page can't), checks its sha256 and pack format against
// this game's, unzips it next to packs/<slug> and swaps it in, then rewrites packs/index.json.
// The dev and host servers (vite.config.ts /__packs/*) call getPack() for the resort picker's Download button.
// A pack this tool installed carries packs/<slug>/.catalog.json, so a newer release replaces it on its own; a pack
// built here (no marker) is only replaced with --force. SA_CATALOG overrides the catalog URL (tests).
// FEAT-241: the catalog's `test` list holds test packs the picker never shows (the synthetic pack CI runs on,
// `npm run get synth`), one entry per pack format: findEntry picks the one this game reads. `--sha256` prints the
// sha256 of the zip it would install, for CI's cache key.
// FEAT-242 `npm run get [<slug>] -- --from <pack dir>`: copy a pack built in the MapPacker checkout (its
// packs/<slug>, or that packs/ folder) into packs/<slug>, to ride a fresh build before it is published. Run it again
// after a rebuild there. Like a pack built here, get <slug> replaces the copy with the published pack only with --force.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { GAME, PACKS } from './paths.mjs';

export const RESORTS_REPO = 'drewkeriazes/MapPacker-SnowboardAnywhere';
export const CATALOG_URL = `https://raw.githubusercontent.com/${RESORTS_REPO}/main/catalog.json`;
export const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const MARKER = '.catalog.json';
const FROM_MARKER = '.from.json'; // FEAT-242: a pack copied in with --from: { from, build, copied }
const STALL_MS = 60_000;

/** The pack format this checkout's client reads (PACK_FORMAT in src/pack/format.ts). */
export const PACK_FORMAT = (() => {
  const m = /PACK_FORMAT\s*=\s*(\d+)/.exec(fs.readFileSync(path.join(GAME, 'src', 'pack', 'format.ts'), 'utf8'));
  if (!m) throw new Error('PACK_FORMAT not found in src/pack/format.ts');
  return Number(m[1]);
})();

const isUrl = (s) => /^https?:\/\//.test(s);

/** catalog.json from the resorts repo (or SA_CATALOG / a file path). */
export async function readCatalog(src = process.env.SA_CATALOG || CATALOG_URL) {
  if (!isUrl(src)) return JSON.parse(fs.readFileSync(src, 'utf8'));
  const r = await fetch(src, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`catalog: HTTP ${r.status} from ${src}`);
  return r.json();
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

/** What is on disk: per pack folder with a meta.json, its format, build and (if this tool installed it) release. */
export function localPacks(packsDir = PACKS) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(packsDir); } catch { return out; }
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const meta = readJson(path.join(packsDir, n, 'meta.json'));
    if (!meta) continue;
    const mark = readJson(path.join(packsDir, n, MARKER));
    out[n] = { name: meta.name ?? n, formatVersion: meta.formatVersion ?? 0, build: meta.build ?? null, ...(mark ? { version: mark.version } : {}) };
  }
  return out;
}

/** packs/index.json, as packwriter.index_packs (MapPacker-SnowboardAnywhere/pipeline/packwriter.py) writes it. */
export function writePackIndex(packsDir = PACKS) {
  const local = localPacks(packsDir);
  const packs = Object.keys(local).sort();
  const names = Object.fromEntries(packs.map((p) => [p, local[p].name]));
  fs.writeFileSync(path.join(packsDir, 'index.json'), JSON.stringify({ packs, names }, null, 1));
}

/** Why a catalog pack can't be installed by this game, or null. */
export function formatProblem(entry) {
  const f = entry?.pack?.formatVersion ?? 0;
  if (f < PACK_FORMAT) return `the published ${entry.slug} pack is format ${f}, this game reads ${PACK_FORMAT}: it needs a rebuild and a new release`;
  if (f > PACK_FORMAT) return `the published ${entry.slug} pack is format ${f}, newer than this game's ${PACK_FORMAT}: update the game (git pull)`;
  return null;
}

/**
 * The catalog entry for `slug`: a resort, else a test pack (FEAT-241). Of several (a test pack has one per pack
 * format), the one at this game's PACK_FORMAT, else the first, which formatProblem then explains.
 */
export function findEntry(catalog, slug) {
  const all = [...(catalog.resorts ?? []), ...(catalog.test ?? [])].filter((r) => r.slug === slug && r.pack);
  if (!all.length) {
    const have = (catalog.resorts ?? []).map((r) => r.slug).join(', ') || 'none';
    throw new Error(`${slug} is not in the catalog (published: ${have})`);
  }
  return all.find((r) => r.pack.formatVersion === PACK_FORMAT) ?? all[0];
}

/** Install `slug` from the catalog. onProgress({ phase: 'download' | 'unzip' | 'done', received, total }). */
export async function getPack(slug, { packsDir = PACKS, catalog, force = false, onProgress = () => {} } = {}) {
  if (!SLUG.test(slug)) throw new Error(`not a resort slug: ${slug}`);
  catalog ??= await readCatalog();
  const entry = findEntry(catalog, slug);
  const problem = formatProblem(entry);
  if (problem) throw new Error(problem);
  const dest = path.join(packsDir, slug);
  const old = path.join(packsDir, `.${slug}.old`);
  // a run killed between the two renames of the swap left the pack only as .<slug>.old: put it back first
  if (fs.existsSync(old) && !fs.existsSync(dest)) fs.renameSync(old, dest);
  const mark = readJson(path.join(dest, MARKER));
  if (fs.existsSync(dest)) {
    if (fs.lstatSync(dest).isSymbolicLink()) throw new Error(`packs/${slug} is a link to ${fs.realpathSync(dest)}: run get there, or remove the link`);
    if (mark?.sha256 === entry.pack.sha256 && fs.existsSync(path.join(dest, 'meta.json'))) {
      onProgress({ phase: 'done', received: 0, total: 0, already: true });
      return { slug, version: entry.pack.version, already: true };
    }
    const copied = readJson(path.join(dest, FROM_MARKER));
    if (copied && !force) throw new Error(`packs/${slug} is a copy of ${copied.from} (get --from): --force replaces it with the published pack`);
    if (!mark && !force) throw new Error(`packs/${slug} is a pack built on this PC, not one from the catalog: --force replaces it (it is deleted)`);
  }

  fs.mkdirSync(packsDir, { recursive: true });
  const zipFile = path.join(packsDir, `.${slug}.download.zip`);
  const incoming = path.join(packsDir, `.${slug}.incoming`);
  for (const p of [incoming, old]) fs.rmSync(p, { recursive: true, force: true });
  try {
    const total = entry.pack.bytes ?? 0;
    const hash = crypto.createHash('sha256');
    let received = 0, last = 0;
    // a stalled connection fails after STALL_MS with no bytes instead of leaving the job running forever
    const stall = new AbortController();
    let timer = setTimeout(() => stall.abort(new Error(`download: no data for ${STALL_MS / 1000} s`)), STALL_MS);
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(new Error(`download: no data for ${STALL_MS / 1000} s`)), STALL_MS); };
    const count = async function* (src) {
      for await (const c of src) {
        alive();
        hash.update(c); received += c.length;
        const now = Date.now();
        if (now - last > 250) { last = now; onProgress({ phase: 'download', received, total }); }
        yield c;
      }
    };
    const url = entry.pack.url;
    let body;
    try {
      if (isUrl(url)) {
        const r = await fetch(url, { signal: stall.signal });
        if (!r.ok || !r.body) throw new Error(`download: HTTP ${r.status} from ${url}`);
        body = Readable.fromWeb(r.body);
      } else body = fs.createReadStream(url);
      await pipeline(body, count, fs.createWriteStream(zipFile), { signal: stall.signal });
    } catch (e) {
      throw stall.signal.aborted ? stall.signal.reason : e;
    } finally { clearTimeout(timer); }
    onProgress({ phase: 'download', received, total });
    const sha = hash.digest('hex');
    if (sha !== entry.pack.sha256) throw new Error(`download: sha256 ${sha} does not match the catalog's ${entry.pack.sha256}`);

    onProgress({ phase: 'unzip', received, total });
    unzip(zipFile, incoming);
    const meta = readJson(path.join(incoming, 'meta.json'));
    if (!meta) throw new Error('the zip has no meta.json');
    if (meta.slug !== slug) throw new Error(`the zip is the ${meta.slug} pack, not ${slug}`);
    if ((meta.formatVersion ?? 0) !== PACK_FORMAT) throw new Error(`the zip's meta.json is format ${meta.formatVersion ?? 0}, this game reads ${PACK_FORMAT}`);
    fs.writeFileSync(path.join(incoming, MARKER), JSON.stringify({
      version: entry.pack.version, sha256: sha, build: meta.build ?? null, url, installed: new Date().toISOString(),
    }, null, 1));
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    // a failed second rename (Windows EPERM / EBUSY: antivirus, the dev server reading a file) puts the old pack back
    try { fs.renameSync(incoming, dest); } catch (e) { if (fs.existsSync(old)) fs.renameSync(old, dest); throw e; }
    fs.rmSync(old, { recursive: true, force: true });
    writePackIndex(packsDir);
    onProgress({ phase: 'done', received, total });
    return { slug, version: entry.pack.version, bytes: received };
  } finally {
    fs.rmSync(zipFile, { force: true });
    fs.rmSync(incoming, { recursive: true, force: true });
  }
}

const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Remove a symlink or junction, never what it points at (rmdirSync is not recursive, so it can't empty the target). */
function removeLink(p) {
  try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
}

/** What publish_pack.py leaves out of a pack's zip: debug/ and dot files at the top. A --from copy leaves them out too. */
const unpublished = (rel) => { const top = rel.split(/[\\/]/)[0]; return top === 'debug' || top.startsWith('.'); };

/**
 * FEAT-242: copy the pack in `from` (a pack folder with meta.json, or a packs/ folder holding <slug>/) into
 * packsDir/<slug>, as the zip would carry it, with a FROM_MARKER naming where it came from. slug defaults to the
 * pack's own meta.json slug. It replaces a link, a catalog download or an earlier --from copy; a pack built in this
 * checkout only with force (it is deleted). A copy, not a link: `git worktree remove` follows a junction under the
 * ignored packs/ and empties the folder it points at, which would be the MapPacker build.
 */
export function copyPack(slug, from, { packsDir = PACKS, force = false } = {}) {
  let src = path.resolve(from);
  if (!fs.existsSync(path.join(src, 'meta.json')) && slug && fs.existsSync(path.join(src, slug, 'meta.json'))) src = path.join(src, slug);
  const meta = readJson(path.join(src, 'meta.json'));
  if (!meta) throw new Error(`${src} is not a pack (no meta.json)${slug ? ` and has no ${slug}/meta.json` : ''}`);
  slug ??= meta.slug;
  if (!SLUG.test(slug ?? '')) throw new Error(`not a resort slug: ${slug}`);
  if (meta.slug !== slug) throw new Error(`${src} is the ${meta.slug} pack, not ${slug}`);
  const f = meta.formatVersion ?? 0;
  if (f !== PACK_FORMAT) {
    throw new Error(`${src} is format ${f}, this game reads ${PACK_FORMAT}: ${f < PACK_FORMAT ? 'rebuild it in MapPacker' : 'update the game (git pull)'}`);
  }
  const dest = path.join(packsDir, slug);
  if (fs.existsSync(dest) && fs.realpathSync(src) === fs.realpathSync(dest)) throw new Error(`${src} is this checkout's own packs/${slug}`);
  const prior = readJson(path.join(dest, FROM_MARKER));
  if (!force && prior?.from === src && meta.build && prior.build === meta.build) return { slug, from: src, already: true };
  const old = path.join(packsDir, `.${slug}.old`);
  const incoming = path.join(packsDir, `.${slug}.incoming`);
  if (isLink(dest)) removeLink(dest);
  else if (fs.existsSync(dest) && !prior && !readJson(path.join(dest, MARKER)) && !force) {
    throw new Error(`packs/${slug} is a pack built on this PC, not one from the catalog: --force replaces it with the copy (it is deleted)`);
  }
  fs.mkdirSync(packsDir, { recursive: true });
  for (const p of [incoming, old]) fs.rmSync(p, { recursive: true, force: true });
  try {
    fs.cpSync(src, incoming, { recursive: true, filter: (s) => s === src || !unpublished(path.relative(src, s)) });
    fs.writeFileSync(path.join(incoming, FROM_MARKER), JSON.stringify({ from: src, build: meta.build ?? null, copied: new Date().toISOString() }, null, 1));
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    try { fs.renameSync(incoming, dest); } catch (e) { if (fs.existsSync(old)) fs.renameSync(old, dest); throw e; }
    fs.rmSync(old, { recursive: true, force: true });
  } finally {
    fs.rmSync(incoming, { recursive: true, force: true });
  }
  writePackIndex(packsDir);
  return { slug, from: src };
}

/** Unpack a zip (stored or deflated, no zip64: MapPacker's publish_pack.py refuses packs over 1.9 GiB) into dir. */
export function unzip(zipFile, dir) {
  const fd = fs.openSync(zipFile, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('not a zip file (no end of central directory)');
    const n = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (n === 0xffff || cdOff === 0xffffffff) throw new Error('zip64 is not supported');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const root = path.resolve(dir);
    fs.mkdirSync(root, { recursive: true });
    const buf = Buffer.alloc(1 << 20);
    for (let p = 0, k = 0; k < n; k++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
      const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), off = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nl);
      p += 46 + nl + xl + cl;
      const out = path.resolve(root, name);
      if (name.includes('\\') || path.isAbsolute(name) || (out !== root && !out.startsWith(root + path.sep))) throw new Error(`unsafe path in zip: ${name}`);
      if (name.endsWith('/')) { fs.mkdirSync(out, { recursive: true }); continue; }
      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, off);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
      const start = off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      if (method === 0) {
        const w = fs.openSync(out, 'w');
        try {
          for (let done = 0; done < csize;) {
            const len = fs.readSync(fd, buf, 0, Math.min(buf.length, csize - done), start + done);
            if (!len) throw new Error(`zip ends inside ${name}`);
            fs.writeSync(w, buf, 0, len); done += len;
          }
        } finally { fs.closeSync(w); }
      } else if (method === 8) {
        const c = Buffer.alloc(csize);
        fs.readSync(fd, c, 0, csize, start);
        const data = zlib.inflateRawSync(c);
        if (data.length !== usize) throw new Error(`${name}: ${data.length} bytes unpacked, expected ${usize}`);
        fs.writeFileSync(out, data);
      } else throw new Error(`${name}: zip method ${method} is not supported`);
    }
  } finally { fs.closeSync(fd); }
}

const mb = (b) => `${Math.round(b / 1e6)} MB`;

async function cli(args) {
  const flag = (f) => { const i = args.indexOf(f); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const catalogSrc = flag('--catalog');
  const packsArg = flag('--packs');
  const from = flag('--from');
  const force = args.includes('--force');
  const list = args.includes('--list');
  const sha256 = args.includes('--sha256');
  const slug = args.find((a) => !a.startsWith('--'));
  const packsDir = packsArg ? path.resolve(packsArg) : PACKS;
  if (from) {
    const res = copyPack(slug, from, { packsDir, force });
    const rel = path.relative(process.cwd(), path.join(packsDir, res.slug)) || '.';
    console.log(res.already ? `${rel} is already that build of ${res.from} (--force copies it again)`
      : `${res.from} copied to ${rel}: cd game && npm run dev, then open /?pack=${res.slug}`);
    return;
  }
  if (!slug && !list) {
    console.log('usage: npm run get <slug> [-- --force]   (npm run get -- --list shows the published resorts;');
    console.log('       npm run get [<slug>] -- --from <MapPacker pack dir> copies in a pack built there)');
    process.exit(2);
  }
  const catalog = await readCatalog(catalogSrc);
  if (sha256) {
    const entry = findEntry(catalog, slug);
    const problem = formatProblem(entry);
    if (problem) throw new Error(problem);
    console.log(entry.pack.sha256);
    return;
  }
  if (list) {
    const local = localPacks(packsDir);
    for (const r of catalog.resorts ?? []) {
      const here = local[r.slug];
      const copied = here && readJson(path.join(packsDir, r.slug, FROM_MARKER));
      const note = formatProblem(r) ?? (copied ? `copy of ${copied.from}` : null) ?? (here ? (here.version === r.pack.version ? 'installed' : here.version ? `installed v${here.version}, v${r.pack.version} out` : 'built on this PC') : '');
      console.log(`${r.slug.padEnd(16)} ${r.name.padEnd(24)} v${r.pack.version}  ${mb(r.pack.bytes).padStart(7)}  ${r.status.padEnd(8)} ${note}`);
    }
    return;
  }
  let shown = -1;
  const res = await getPack(slug, {
    packsDir, catalog, force, onProgress: ({ phase, received, total, already }) => {
      if (already || phase !== 'download' || !total) return;
      const pct = Math.floor((received / total) * 100);
      if (pct >= shown + 10 || received === total) { shown = pct; console.log(`  ${pct}% of ${mb(total)}`); }
    },
  });
  const rel = path.relative(process.cwd(), path.join(packsDir, slug)) || '.';
  console.log(res.already ? `${slug} v${res.version} is already in ${rel}` : `${slug} v${res.version} installed in ${rel}: cd game && npm run dev, then open /?pack=${slug}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((e) => { console.error(`get_pack: ${e.message ?? e}`); process.exit(1); });
}
