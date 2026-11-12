// The pack routes every server of the game shares (FEAT-261): the dev server and `npm run host` (vite.config.ts
// plugins) and the Windows launcher (tools/launcher.mjs) mount these same handlers, so there is one copy of them
// and of their checks. Each is a Connect-style handler, (req, res, next), that calls next() for a URL it doesn't own.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import * as gp from './get_pack.mjs';
import { PACKS } from './paths.mjs';
import { refuseForeignOrigin } from './same_origin.mjs';

const TYPES = { '.png': 'image/png', '.json': 'application/json', '.bin': 'application/octet-stream', '.webp': 'image/webp' };

/** /packs/* from packsDir (resort packs stay out of the game bundle; they are gitignored). */
export function packFiles(packsDir = PACKS) {
  return (req, res, next) => {
    if (!req.url || !req.url.startsWith('/packs/')) return next();
    // npm run host serves this to the LAN: a bad escape is a 400, and only files inside packs/ (not a packs-old/ sibling)
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0].slice('/packs/'.length)); } catch { res.statusCode = 400; res.end(); return; }
    const file = path.join(packsDir, rel);
    if (!file.startsWith(packsDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-cache');
    // pipeline, not pipe: a request the browser drops mid-file (a page left while a cover image streams) closes the
    // file too. With pipe it stayed open, and Windows then refused to rename the pack folder, so the picker's
    // Update or Download over it failed with EPERM until the server stopped (BUG-095)
    pipeline(fs.createReadStream(file), res, () => {});
  };
}

/**
 * FEAT-222: the resort picker's Download button. The download runs here in Node (tools/get_pack.mjs): GitHub release
 * assets send no CORS headers, so the page can't fetch them.
 *   GET  /__packs/catalog      { formatVersion, catalog | null, error?, local: { slug: { formatVersion, build, version? } }, jobs }
 *   POST /__packs/get {slug}   starts the download; 202, or 400 with the reason
 *   GET  /__packs/job?slug=    { phase: 'download' | 'unzip' | 'done' | 'error', received, total, error? }
 * The listing's catalog is cached for 5 minutes, so opening the picker again and again spends no more than 12 of the
 * 60 an hour GitHub API calls readCatalog makes; a failed read (offline) answers catalog: null and the picker shows
 * local packs. A Download reads it afresh (BUG-096), so it installs the release published a minute ago, not the one
 * the cached listing names; if that read fails it uses the cached one. `readCatalog` is for getpackcheck.
 */
export function packDownloads(packsDir = PACKS, { readCatalog = gp.readCatalog } = {}) {
  const jobs = new Map();
  let cached = null;
  const send = (res, code, body) => {
    res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body));
  };
  const catalog = async (fresh = false) => {
    if (fresh || !cached || Date.now() - cached.at > 5 * 60_000) {
      try { cached = { at: Date.now(), catalog: await readCatalog() }; } catch (e) { if (!fresh || !cached) throw e; }
    }
    return cached.catalog;
  };
  const route = async (req, res, next) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/__packs/catalog') {
      let cat = null, error;
      try { cat = await catalog(); } catch (e) { error = String(e.message ?? e); cached = null; }
      return send(res, 200, { formatVersion: gp.PACK_FORMAT, catalog: cat, error, local: gp.localPacks(packsDir), jobs: Object.fromEntries(jobs) });
    }
    if (req.method === 'GET' && url.pathname === '/__packs/job') {
      const job = jobs.get(url.searchParams.get('slug') ?? '');
      return job ? send(res, 200, job) : send(res, 404, { error: 'no download for that resort' });
    }
    if (req.method === 'POST' && url.pathname === '/__packs/get') {
      // the game's own page only: a JSON body forces a CORS preflight this server never answers, and a browser's
      // Origin must be this host (BUG-110: another site must not start a 2 GB download)
      if (refuseForeignOrigin(req, res)) return;
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 403, { error: 'same-origin JSON only' });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let slug = '';
      try { slug = String(JSON.parse(Buffer.concat(chunks).toString('utf8')).slug ?? ''); } catch { /* checked below */ }
      if (!gp.SLUG.test(slug)) return send(res, 400, { error: 'bad slug' });
      const running = jobs.get(slug);
      if (running && running.phase !== 'done' && running.phase !== 'error') return send(res, 202, running);
      // the job is in place before the catalog read, so a second click meanwhile joins it instead of starting another
      const job = { phase: 'download', received: 0, total: 0 };
      jobs.set(slug, job);
      let cat;
      try { cat = await catalog(true); } catch (e) {
        if (running) jobs.set(slug, running); else jobs.delete(slug);
        return send(res, 400, { error: String(e.message ?? e) });
      }
      // a pack built on this PC (no catalog marker) is never replaced from the menu: getPack refuses without force
      gp.getPack(slug, { packsDir, catalog: cat, onProgress: (p) => Object.assign(job, p) })
        .then(() => { job.phase = 'done'; console.log(`[packs] ${slug} installed from the catalog`); })
        .catch((e) => { job.phase = 'error'; job.error = String(e.message ?? e); console.warn(`[packs] ${slug}: ${job.error}`); });
      return send(res, 202, job);
    }
    next();
  };
  return (req, res, next) => {
    if (!req.url?.startsWith('/__packs/')) return next();
    route(req, res, next).catch((e) => send(res, 500, { error: String(e.message ?? e) }));
  };
}
