import { defineConfig, type Connect, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { handleShotPost, handleTakePost } from './tools/attract_files.mjs';
import * as gp from './tools/get_pack.mjs';

/**
 * Serve ../packs at /packs/ so resort packs stay out of the game bundle (they are gitignored).
 * Dev server and `vite preview` both (FEAT-138: `npm run host` serves the built game through preview).
 */
function servePacks(): Plugin {
  const packsDir = path.resolve(__dirname, '..', 'packs');
  const types: Record<string, string> = { '.png': 'image/png', '.json': 'application/json', '.bin': 'application/octet-stream', '.webp': 'image/webp' };
  const handle: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url || !req.url.startsWith('/packs/')) return next();
    // npm run host serves this to the LAN: a bad escape is a 400, and only files inside packs/ (not a packs-old/ sibling)
    let rel: string;
    try { rel = decodeURIComponent(req.url.split('?')[0].slice('/packs/'.length)); } catch { res.statusCode = 400; res.end(); return; }
    const file = path.join(packsDir, rel);
    if (!file.startsWith(packsDir + path.sep) ||!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-cache');
    fs.createReadStream(file).pipe(res);
  };
  return {
    name: 'serve-packs',
    configureServer(server) { server.middlewares.use(handle); },
    configurePreviewServer(server) { server.middlewares.use(handle); },
  };
}

/**
 * FEAT-222: the resort picker's Download button, on the dev server and `npm run host` (preview) both. The download
 * runs here in Node (tools/get_pack.mjs): GitHub release assets send no CORS headers, so the page can't fetch them.
 *   GET  /__packs/catalog      { formatVersion, catalog | null, error?, local: { slug: { formatVersion, build, version? } }, jobs }
 *   POST /__packs/get {slug}   starts the download; 202, or 400 with the reason
 *   GET  /__packs/job?slug=    { phase: 'download' | 'unzip' | 'done' | 'error', received, total, error? }
 * The catalog is cached for 5 minutes; a failed read (offline) answers catalog: null and the picker shows local packs.
 */
function packDownloads(): Plugin {
  type Job = { phase: string; received: number; total: number; error?: string };
  const jobs = new Map<string, Job>();
  let cached: { at: number; catalog: unknown } | null = null;
  const send = (res: import('node:http').ServerResponse, code: number, body: unknown) => {
    res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body));
  };
  const handle: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith('/__packs/')) return next();
    route(req, res, next).catch((e: Error) => send(res, 500, { error: String(e.message ?? e) }));
  };
  const route = async (req: Connect.IncomingMessage, res: import('node:http').ServerResponse, next: Connect.NextFunction) => {
    const url = new URL(req.url, 'http://x');
    const catalog = async () => {
      if (!cached || Date.now() - cached.at > 5 * 60_000) cached = { at: Date.now(), catalog: await gp.readCatalog() };
      return cached.catalog as { resorts?: { slug: string }[] };
    };
    if (req.method === 'GET' && url.pathname === '/__packs/catalog') {
      let cat = null, error: string | undefined;
      try { cat = await catalog(); } catch (e) { error = String((e as Error).message ?? e); cached = null; }
      return send(res, 200, { formatVersion: gp.PACK_FORMAT, catalog: cat, error, local: gp.localPacks(), jobs: Object.fromEntries(jobs) });
    }
    if (req.method === 'GET' && url.pathname === '/__packs/job') {
      const job = jobs.get(url.searchParams.get('slug') ?? '');
      return job ? send(res, 200, job) : send(res, 404, { error: 'no download for that resort' });
    }
    if (req.method === 'POST' && url.pathname === '/__packs/get') {
      // the game's own page only: a JSON body forces a CORS preflight this server never answers, and a browser's
      // Origin must be this host (the server listens on the LAN, so another site must not start a 2 GB download)
      const origin = req.headers.origin;
      let sameOrigin = !origin;
      try { sameOrigin ||= new URL(origin!).host === req.headers.host; } catch { /* "null" or junk: refused */ }
      if (!(req.headers['content-type'] ?? '').startsWith('application/json') || !sameOrigin) return send(res, 403, { error: 'same-origin JSON only' });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let slug = '';
      try { slug = String(JSON.parse(Buffer.concat(chunks).toString('utf8')).slug ?? ''); } catch { /* checked below */ }
      if (!gp.SLUG.test(slug)) return send(res, 400, { error: 'bad slug' });
      const running = jobs.get(slug);
      if (running && running.phase !== 'done' && running.phase !== 'error') return send(res, 202, running);
      let cat;
      try { cat = await catalog(); } catch (e) { return send(res, 400, { error: String((e as Error).message ?? e) }); }
      const job: Job = { phase: 'download', received: 0, total: 0 };
      jobs.set(slug, job);
      // a pack built on this PC (no catalog marker) is never replaced from the menu: getPack refuses without force
      gp.getPack(slug, { catalog: cat, onProgress: (p: Job) => Object.assign(job, p) })
        .then(() => { job.phase = 'done'; console.log(`[packs] ${slug} installed from the catalog`); })
        .catch((e: Error) => { job.phase = 'error'; job.error = String(e.message ?? e); console.warn(`[packs] ${slug}: ${job.error}`); });
      return send(res, 202, job);
    }
    next();
  };
  return {
    name: 'pack-downloads',
    configureServer(server) { server.middlewares.use(handle); },
    configurePreviewServer(server) { server.middlewares.use(handle); },
  };
}

/**
 * Dev only (DATA-008; not in `vite preview`, so `npm run host` leaves it out): the eye camera's P key posts its screenshot here. Saves
 * docs/compare/<pack>/<spot>/eye-<view>.png and records the pose on that view in spot.json, so
 * game/tools/shoot_spots.mjs can re-shoot the same framing after later builds.
 */
function saveCompareShots(): Plugin {
  const compareDir = path.resolve(__dirname, '..', 'docs', 'compare');
  const safe = /^[A-Za-z0-9_-]+$/;
  return {
    name: 'save-compare-shots',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/__compare/save' || req.method !== 'POST') return next();
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const [spot, view = 'view'] = String(body.spot).split('/');
            if (!safe.test(body.pack) || !safe.test(spot) || !safe.test(view)) throw new Error('spot must be <spot-slug> or <spot-slug>/<view-id>');
            const dir = path.join(compareDir, body.pack, spot);
            fs.mkdirSync(dir, { recursive: true });
            const png = String(body.png).replace(/^data:image\/png;base64,/, '');
            fs.writeFileSync(path.join(dir, `eye-${view}.png`), Buffer.from(png, 'base64')); // lossless, gitignored
            // FEAT-095: the committed copy is JPEG 90 (encoded in the browser)
            const jpg = typeof body.jpg === 'string' ? body.jpg.replace(/^data:image\/jpeg;base64,/, '') : null;
            if (jpg) fs.writeFileSync(path.join(dir, `eye-${view}.jpg`), Buffer.from(jpg, 'base64'));
            const shot = jpg ? `eye-${view}.jpg` : `eye-${view}.png`;
            const specFile = path.join(dir, 'spot.json');
            const spec = fs.existsSync(specFile) ? JSON.parse(fs.readFileSync(specFile, 'utf8')) : { name: spot, views: [] };
            spec.views ??= [];
            let v = spec.views.find((e: { id?: string }) => e.id === view);
            if (!v) { v = { id: view }; spec.views.push(v); }
            const weather = typeof body.weather === 'string' && safe.test(body.weather) ? body.weather : undefined;
            v.eye = { ...body.pose, ...(weather ? { weather } : {}), link: body.link, shot, date: new Date().toISOString().slice(0, 10) };
            fs.writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n');
            // FEAT-093: catch a clear-sky shot saved over a spot tagged overcast (and the like)
            const want = v.weather ?? spec.weather;
            const warning = want && weather && want !== weather ? `Shot taken in ${weather}, but this spot is tagged ${want}; open its link with &weather=${want} and press P again.` : undefined;
            if (warning) console.warn(`[compare] ${spot}/${view}: ${warning}`);
            const file = path.relative(path.resolve(__dirname, '..'), path.join(dir, shot)).split(path.sep).join('/');
            res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ file, warning }));
          } catch (e) {
            res.statusCode = 400; res.end(String((e as Error).message ?? e));
          }
        });
      });
    },
  };
}

/**
 * Dev only (FEAT-128): the replay viewer's L key (with ?debug) posts a marked span here as a main menu ghost:
 * game/public/attract/<pack>/take-<n>.json, listed under the pack in game/public/attract/index.json. FEAT-181: the
 * eye camera's Shift+P (with ?debug) posts the resort's menu shot (game/public/attract/<pack>/shots.json).
 */
function saveAttractTakes(): Plugin {
  const dir = path.resolve(__dirname, 'public', 'attract');
  return {
    name: 'save-attract-takes',
    configureServer(server) {
      // the attract folder straight from disk: Vite doesn't watch it (a save must not reload the page), so its
      // list of public files would miss a take saved after the server started
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' || !req.url) return next();
        const u = req.url.split('?')[0];
        const at = u.indexOf('/attract/');
        if (at < 0) return next();
        let rel: string;
        try { rel = decodeURIComponent(u.slice(at + '/attract/'.length)); } catch { return next(); }
        const file = path.join(dir, rel);
        if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
        res.setHeader('content-type', file.endsWith('.json') ? 'application/json' : file.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream');
        res.setHeader('cache-control', 'no-cache');
        fs.createReadStream(file).pipe(res);
      });
      // the replay viewer's L (a recorded take, numbered one past the highest in use) and the eye camera's Shift+P
      // (FEAT-181: the resort's menu shot), written into this checkout by tools/attract_files.mjs
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST') return next();
        if (req.url === '/__attract/save') return handleTakePost(dir, req, res);
        if (req.url === '/__attract/shot') return handleShotPost(dir, req, res);
        next();
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [servePacks(), packDownloads(), saveCompareShots(), saveAttractTakes()],
  // FEAT-128: a saved take (public/attract) must not reload the page you are recording in
  server: { host: true, port: 5173, watch: { ignored: ['**/public/attract/**'] } },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
  // FEAT-177: a new id each build, so the main menu's kept still (ui/MenuStill.ts) never outlives the build that drew it
  define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify(Date.now().toString(36)) },
});
