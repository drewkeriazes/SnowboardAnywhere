// Skipped matches check (FEAT-287): Find a resort's line under the matches for the ones MapPacker's
// `resort.py search` left out as unbuildable (`skipped` in its JSON), in a browser, against a built dist/. Signed in
// as the fake maintainer (?account=maintainer) over a faked search reply (page.route, no Python, no network) it types
// three queries: skipped 0 (a match, no line), skipped 1 (a match and "1 more ski area ..."), skipped 3 with no
// match ("3 ski areas ...", and no "No ski area by that name" over it); then clearing the field takes the line away.
// Never waits for the session: the menu and its picker are up before the resort has loaded.
// node tools/skippedcheck.mjs [pack] [--gpu | --headed | --cpu] [--shots]   (run after `npx vite build`; exit 1 on a failed check)
//   --shots saves the picker with each line to shots/skipped/skipped-<n>.png
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';
import { packDownloads } from './pack_routes.mjs';

const args = process.argv.slice(2);
const shots = args.includes('--shots');
const pack = args.filter((a) => !a.startsWith('--'))[0] ?? 'synth';
const t0 = Date.now();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
const packRoutes = packDownloads(PACKS, { readCatalog: async () => ({ resorts: [] }) });
const server = http.createServer((req, res) => packRoutes(req, res, () => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}));
await new Promise((r) => server.listen(0, r));
const browser = await launchBrowser();
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };
const url = `http://localhost:${server.address().port}/index.html?pack=${pack}&lowgfx&account=maintainer${process.env.SHOT_QUERY ?? ''}`;

const match = (slug, name) => ({ openskidata_id: slug, osm_id: 'way/1', name, region: 'Colorado', country: 'US', lat: 39.6, lon: -106.5, runs: 12, lifts: 5, status: 'operating', slug, configured: false, sold_with: null });
/** the faked `resort.py search --json` replies, by query */
const REPLIES = {
  'zero peak': { matches: [match('zero-peak', 'Zero Peak')], skipped: 0 },
  'beaver creek': { matches: [match('beaver-creek-nordic', 'Beaver Creek Nordic')], skipped: 1 },
  'three hills': { matches: [], skipped: 3, closest: [] },
};

const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const asked = [];
await page.route('**/api/resorts/search?**', (route) => {
  const q = new URL(route.request().url()).searchParams.get('q');
  asked.push(q);
  const r = REPLIES[q] ?? { matches: [], skipped: 0, closest: [] };
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ query: q, ...r }) });
});
// the build watcher's list: none running
await page.route('**/api/resorts/builds**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ builds: [] }) }));

const state = () => page.evaluate(() => ({
  rows: [...document.querySelectorAll('#menu .pop .courses button[data-pack]')].map((b) => b.dataset.pack),
  line: document.querySelector('#menu .pop .courses .skipped-note')?.textContent ?? null,
  last: document.querySelector('#menu .pop .courses')?.lastElementChild?.className ?? null,
  note: (() => { const n = document.querySelector('#menu .pop .find-note'); return n && !n.hidden ? n.textContent : ''; })(),
}));
/** type a query and wait for its search to land (its match row, or its line, or the find note) */
const find = async (q, until) => {
  const before = asked.length;
  await page.fill('#menu .pop input.find', q);
  const t = Date.now();
  while (Date.now() - t < 15000) {
    if (asked.length > before) { await page.waitForTimeout(200); const s = await state(); if (until(s)) return s; }
    await page.waitForTimeout(100);
  }
  return state();
};

await page.goto(url);
await page.waitForSelector('#menu .card[data-a="resort"]', { timeout: 120000 });
await page.evaluate(() => document.querySelector('#menu .card[data-a="resort"]').click());
await page.waitForSelector('#menu .pop input.find', { timeout: 30000 });

const why = "found that can't be built yet (no runs or lifts mapped, or no OpenStreetMap or Skimap.org id).";
const shot = async (n) => {
  if (!shots) return;
  fs.mkdirSync(path.join('shots', 'skipped'), { recursive: true });
  await page.waitForTimeout(300);
  const f = path.join('shots', 'skipped', `skipped-${n}.png`);
  await page.screenshot({ path: f });
  console.log(`shot: ${path.resolve(f)}`);
};

let s = await find('zero peak', (x) => x.rows.includes('zero-peak'));
check('skipped 0: the match is listed with no line under it', s.rows.includes('zero-peak') && s.line === null, JSON.stringify(s));
await shot(0);
s = await find('beaver creek', (x) => x.line !== null);
check('skipped 1: the match, then "1 more ski area" under it', s.rows.includes('beaver-creek-nordic') && s.line === `1 more ski area ${why}` && s.last === 'skipped-note dim', JSON.stringify(s));
await shot(1);
s = await find('three hills', (x) => x.line !== null);
check('skipped 3, no match: "3 ski areas" (no "more"), no "No ski area by that name" over it', s.line === `3 ski areas ${why}` && !/No ski area/.test(s.note), JSON.stringify(s));
await shot(3);
await page.fill('#menu .pop input.find', '');
await page.waitForTimeout(400);
s = await state();
check('the field cleared: the line goes, the built rows are back', s.line === null && s.rows.includes(pack), JSON.stringify(s));
check('the search route was asked for each query', ['zero peak', 'beaver creek', 'three hills'].every((q) => asked.includes(q)), asked.join(', '));

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' / '));
await browser.close();
server.close();
console.log(`${fails.length ? `${fails.length} failed` : 'all ok'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(fails.length ? 1 : 0);
