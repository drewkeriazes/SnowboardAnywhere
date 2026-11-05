import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/** Serve ../packs at /packs/ in dev so resort packs stay out of the game bundle (they are gitignored). */
function servePacks(): Plugin {
  const packsDir = path.resolve(__dirname, '..', 'packs');
  const types: Record<string, string> = { '.png': 'image/png', '.json': 'application/json', '.bin': 'application/octet-stream', '.webp': 'image/webp' };
  return {
    name: 'serve-packs',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/packs/')) return next();
        const rel = decodeURIComponent(req.url.split('?')[0].slice('/packs/'.length));
        const file = path.join(packsDir, rel);
        if (!file.startsWith(packsDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end(); return; }
        res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
        res.setHeader('cache-control', 'no-cache');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [servePacks()],
  server: { host: true, port: 5173 },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
});
