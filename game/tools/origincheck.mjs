// BUG-110 origincheck: the dev POST routes that write files or start a download refuse a request from another
// origin (403), and let the game's own page and a request with no Origin reach their handler (which here answers
// 400 to the empty body, so a 400 means "got in"). `npm run dev` listens on localhost only. Real servers on free
// ports (Node's http for the shared handlers, Vite's dev server for /__compare/save); no pack, no browser, no
// network. Exits 1 on a failure.
//   node tools/origincheck.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer, resolveConfig } from 'vite';
import { handleShotPost, handleTakePost } from './attract_files.mjs';
import { packDownloads } from './pack_routes.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const post = (port, url, headers) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  });
  r.on('error', reject); r.end('{}');
});
const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));

async function cases(name, port, url) {
  const s = (headers) => post(port, url, headers);
  let c = await s({ origin: 'https://example.com' });
  ok(c === 403, `${name}: Origin https://example.com gets 403 (${c})`);
  c = await s({ origin: 'null' });
  ok(c === 403, `${name}: Origin null gets 403 (${c})`);
  c = await s({ origin: `http://localhost:${port}` });
  ok(c === 403, `${name}: another host name for this server is another origin (${c})`);
  c = await s({ origin: `http://127.0.0.1:${port}` });
  ok(c === 400, `${name}: same-origin POST reaches the handler (${c})`);
  c = await s({});
  ok(c === 400, `${name}: POST with no Origin reaches the handler (${c})`);
}

const t = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
const servers = [];
try {
  const attract = http.createServer((req, res) => (req.url === '/__attract/save' ? handleTakePost : handleShotPost)(t, req, res));
  servers.push(attract);
  const ap = await listen(attract);
  await cases('/__attract/save', ap, '/__attract/save');
  await cases('/__attract/shot', ap, '/__attract/shot');

  const dl = packDownloads(t, { readCatalog: async () => ({}) });
  const packs = http.createServer((req, res) => dl(req, res, () => { res.statusCode = 404; res.end(); }));
  servers.push(packs);
  await cases('/__packs/get', await listen(packs), '/__packs/get');

  // the real dev server: /__compare/save, and that it listens on localhost only
  const root = path.resolve(import.meta.dirname, '..');
  const cfg = await resolveConfig({ root, configFile: path.join(root, 'vite.config.ts') }, 'serve');
  ok(cfg.server.host === 'localhost', `npm run dev listens on localhost only (host: ${JSON.stringify(cfg.server.host)})`);
  const vite = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port: 0, strictPort: false, host: '127.0.0.1' }, logLevel: 'silent' });
  servers.push({ close: () => vite.close() });
  await vite.listen();
  await cases('/__compare/save', vite.httpServer.address().port, '/__compare/save');
} finally {
  for (const s of servers) s.close();
  fs.rmSync(t, { recursive: true, force: true });
}
process.exit(fails ? 1 : 0);
