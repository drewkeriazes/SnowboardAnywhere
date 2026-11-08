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
    const rel = decodeURIComponent(req.url.split('?')[0].slice('/packs/'.length));
    const file = path.join(packsDir, rel);
    if (!file.startsWith(packsDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end(); return; }
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

export default defineConfig({
  base: './',
  plugins: [servePacks(), saveCompareShots()],
  server: { host: true, port: 5173 },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
});
