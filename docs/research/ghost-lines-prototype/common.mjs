// Ghost lines prototype: a headless game page on the built game (game/dist) and a packs folder, like the
// game/tools check scripts. Run `cd game && npx vite build` first.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..', '..');
const { launchBrowser } = await import(pathToFileURL(path.join(REPO, 'game', 'tools', 'browser.mjs')).href);
const { DIST, PACKS } = await import(pathToFileURL(path.join(REPO, 'game', 'tools', 'paths.mjs')).href);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.woff2': 'font/woff2' };

/** a headless page on `pack` with the eye camera (window.__step / __sim ready); close() ends it */
export async function openPage(pack) {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice(7)] : [DIST, u];
    const p = path.join(root, rel);
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  const browser = await launchBrowser(['--gpu']);
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.setDefaultTimeout(300000);
  await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&cam=eye`);
  await page.waitForFunction(() => window.__step, null, { timeout: 120000 });
  await page.evaluate(() => window.__step(1, 1 / 60));
  return { page, close: async () => { await browser.close(); server.close(); } };
}

/** named flags: --key value */
export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
