import { defineConfig, type Connect, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

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
 * Dev only (FEAT-128): the replay viewer's L key (with ?debug) posts a marked span here as a main menu ghost.
 * Saves game/public/attract/<pack>/take-<n>.json and lists it under the pack in game/public/attract/index.json.
 */
function saveAttractTakes(): Plugin {
  const dir = path.resolve(__dirname, 'public', 'attract');
  return {
    name: 'save-attract-takes',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/__attract/save' || req.method !== 'POST') return next();
        // the dev server listens on the home network (host: true): only the game's own page, JSON, a few MB
        const origin = req.headers.origin, host = req.headers.host;
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json') || (origin && host && new URL(origin).host !== host)) { res.statusCode = 403; res.end('forbidden'); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => { size += c.length; if (size > 8e6) { res.statusCode = 413; res.end('too big'); req.destroy(); return; } chunks.push(c); });
        req.on('end', () => {
          if (size > 8e6) return;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (typeof body.pack !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(body.pack)) throw new Error('bad pack');
            const take = JSON.parse(String(body.take));
            const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
            if (take.version !== 1 || !Array.isArray(take.samples) || !take.samples.length || !take.samples.every((s: Record<string, unknown>) => num(s.t) && num(s.x) && num(s.y) && num(s.z))) throw new Error('not a take');
            const d = path.join(dir, body.pack);
            fs.mkdirSync(d, { recursive: true });
            const idxFile = path.join(dir, 'index.json');
            const all: Record<string, { stills?: string[]; ghosts?: string[] }> = Object.assign(Object.create(null), fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : {});
            const idx = (all[body.pack] ??= {});
            let n = 1; while (fs.existsSync(path.join(d, `take-${n}.json`))) n++;
            const name = `take-${n}.json`;
            fs.writeFileSync(path.join(d, name), JSON.stringify(take) + '\n');
            idx.ghosts = [...(idx.ghosts ?? []), name];
            fs.writeFileSync(idxFile, JSON.stringify(all, null, 2) + '\n');
            res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ file: `game/public/attract/${body.pack}/${name}` }));
          } catch (e) { res.statusCode = 400; res.end(String((e as Error).message ?? e)); }
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [servePacks(), saveCompareShots(), saveAttractTakes()],
  // FEAT-128: a saved take (public/attract) must not reload the page you are recording in
  server: { host: true, port: 5173, watch: { ignored: ['**/public/attract/**'] } },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
});
