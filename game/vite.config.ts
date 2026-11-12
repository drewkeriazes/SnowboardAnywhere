import { defineConfig, type Connect, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { handleShotPost, handleTakePost } from './tools/attract_files.mjs';
import { refuseForeignOrigin } from './tools/same_origin.mjs';
import { packDownloads, packFiles } from './tools/pack_routes.mjs';

/**
 * Serve ../packs at /packs/ so resort packs stay out of the game bundle (they are gitignored), and FEAT-222's
 * /__packs/* routes behind the resort picker's Download button. Dev server and `vite preview` both (FEAT-138:
 * `npm run host` serves the built game through preview). The handlers are in tools/pack_routes.mjs, which the
 * Windows launcher (tools/launcher.mjs, FEAT-261) mounts too.
 */
function packRoutes(): Plugin {
  const handlers = [packFiles(path.resolve(__dirname, '..', 'packs')), packDownloads()];
  const use = (m: Connect.Server) => { for (const h of handlers) m.use(h); };
  return {
    name: 'pack-routes',
    configureServer(server) { use(server.middlewares); },
    configurePreviewServer(server) { use(server.middlewares); },
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
        if (refuseForeignOrigin(req, res)) return;
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
  plugins: [packRoutes(), saveCompareShots(), saveAttractTakes()],
  // FEAT-128: a saved take (public/attract) must not reload the page you are recording in
  server: { host: 'localhost', port: 5173, watch: { ignored: ['**/public/attract/**'] } },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
  // FEAT-177: a new id each build, so the main menu's kept still (ui/MenuStill.ts) never outlives the build that drew it
  define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify(Date.now().toString(36)) },
});
