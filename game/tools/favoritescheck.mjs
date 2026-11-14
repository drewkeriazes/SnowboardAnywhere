// Favorites check (FEAT-302): the resort picker's favorites tier, in a browser, against a built dist/. Over a fake
// catalog (two resorts to download beside the built pack, no network) it opens Change resort from the main menu,
// stars a resort with the keyboard (right to its star, Enter), checks it moves to the top under Favorites with the
// focus still on its star, that up / down still go row to row and left goes back to the row, stars a second one with
// the controller (D-pad right, A), reloads and finds both first, then unstars both and the headings go. Never waits
// for the session: the menu and its picker are up before the resort has loaded.
// node tools/favoritescheck.mjs [pack] [--gpu | --headed | --cpu] [--shots]   (run after `npx vite build`; exit 1 on a failed check)
//   --shots saves the picker with a favorite to shots/favorites/picker.png
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';
import { packDownloads } from './pack_routes.mjs';
import { PACK_FORMAT } from './get_pack.mjs';

const args = process.argv.slice(2);
const shots = args.includes('--shots');
const pack = args.filter((a) => !a.startsWith('--'))[0] ?? 'synth';
const t0 = Date.now();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
const entry = (slug, name) => ({ slug, name, status: 'playable', pack: { version: 1, formatVersion: PACK_FORMAT, bytes: 50e6 } });
const packRoutes = packDownloads(PACKS, { readCatalog: async () => ({ resorts: [entry('alpha-peak', 'Alpha Peak'), entry('zed-mountain', 'Zed Mountain')] }) });
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
const url = `http://localhost:${server.address().port}/index.html?pack=${pack}&lowgfx${process.env.SHOT_QUERY ?? ''}`;

const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  window.__pad = { buttons, axes: [0, 0, 0, 0] };
  navigator.getGamepads = () => [{ id: 'favoritescheck pad', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(), buttons, axes: window.__pad.axes, vibrationActuator: null }];
  if (!sessionStorage.getItem('favoritescheck')) { localStorage.clear(); sessionStorage.setItem('favoritescheck', '1'); }
});
const key = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(80); };
const pad = async (i) => { await page.evaluate((i) => { window.__pad.buttons[i].pressed = true; window.__pad.buttons[i].value = 1; }, i); await page.waitForTimeout(90); await page.evaluate((i) => { window.__pad.buttons[i].pressed = false; window.__pad.buttons[i].value = 0; }, i); await page.waitForTimeout(100); };
const PAD_A = 0, PAD_RIGHT = 15;
/** the focused item: a row by its slug, a star as star:<slug> */
const active = () => page.evaluate(() => { const a = document.activeElement; return a?.dataset.fav ? `star:${a.dataset.fav}` : a?.dataset.pack ?? a?.tagName ?? null; });
/** the list as it reads: headings in caps, starred rows with a * */
const list = () => page.evaluate(() => [...document.querySelectorAll('#menu .pop .courses .tier, #menu .pop .courses button[data-pack]')].map((e) => e.matches('.tier') ? e.textContent.toUpperCase() : `${e.dataset.pack}${e.parentElement.querySelector('button.star')?.getAttribute('aria-pressed') === 'true' ? '*' : ''}`).join(' '));
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('favoriteResorts') ?? '[]'));
/** open Change resort and wait for the catalog's rows */
const openPicker = async () => {
  await page.waitForSelector('#menu .card[data-a="resort"]', { timeout: 120000 });
  await page.evaluate(() => document.querySelector('#menu .card[data-a="resort"]').click());
  await page.waitForFunction(() => document.querySelectorAll('#menu .pop button[data-pack]').length >= 3, null, { timeout: 30000 });
};
/** put the menu focus on an item, as the arrows would */
const focusOn = (sel) => page.evaluate((sel) => { const el = document.querySelector(sel); el?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, movementX: 2, movementY: 2 })); el?.focus(); return !!el; }, sel);

await page.goto(url);
await openPicker();
check('no favorites: the list as before, no headings', (await list()) === `${pack} alpha-peak zed-mountain`, await list());
check('every built or catalog row has a star', await page.evaluate(() => document.querySelectorAll('#menu .pop button.star').length === document.querySelectorAll('#menu .pop button[data-pack]').length));

// the keyboard: right from a row to its star, Enter stars it
await focusOn('#menu .pop button[data-pack="zed-mountain"]');
await key('ArrowRight');
check('right from a row goes to its star', (await active()) === 'star:zed-mountain', await active());
await key('Enter');
check('Enter on the star: the resort lists first, under Favorites', (await list()) === `FAVORITES zed-mountain* ALL RESORTS ${pack} alpha-peak`, await list());
check('the focus follows the star to the top', (await active()) === 'star:zed-mountain', await active());
check('the favorite is stored', JSON.stringify(await stored()) === '["zed-mountain"]', JSON.stringify(await stored()));
await key('ArrowLeft');
check('left from the star goes back to its row', (await active()) === 'zed-mountain', await active());
await key('ArrowDown');
check('down goes to the next row (past the heading)', (await active()) === pack, await active());
await key('ArrowDown');
check('down again to the row after', (await active()) === 'alpha-peak', await active());
await key('ArrowUp'); await key('ArrowUp');
check('up goes back to the favorite', (await active()) === 'zed-mountain', await active());
if (shots) {
  fs.mkdirSync(path.join('shots', 'favorites'), { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join('shots', 'favorites', 'picker.png') });
  console.log(`shot: ${path.resolve('shots', 'favorites', 'picker.png')}`);
}

// the controller: D-pad right from a row to its star, A stars it
await focusOn('#menu .pop button[data-pack="alpha-peak"]');
await pad(PAD_RIGHT);
check('D-pad right from a row goes to its star', (await active()) === 'star:alpha-peak', await active());
await pad(PAD_A);
check('A on the star stars it too, in list order', (await list()) === `FAVORITES alpha-peak* zed-mountain* ALL RESORTS ${pack}`, await list());

// a reload keeps them
await page.reload();
await openPicker();
check('after a reload the favorites list first', (await list()) === `FAVORITES alpha-peak* zed-mountain* ALL RESORTS ${pack}`, await list());
// Find a resort filters inside the tiers
await page.fill('#menu .pop input.find', 'zed');
await page.waitForTimeout(150);
check('the filter keeps a matching favorite under Favorites', (await list()) === 'FAVORITES zed-mountain*', await list());
await page.fill('#menu .pop input.find', '');
await page.waitForTimeout(150);

// unstar both: the list and the storage go back
await page.evaluate(() => document.querySelector('#menu .pop button.star[data-fav="alpha-peak"]').click());
await page.evaluate(() => document.querySelector('#menu .pop button.star[data-fav="zed-mountain"]').click());
check('unstarred: the list as before, no headings', (await list()) === `${pack} alpha-peak zed-mountain`, await list());
check('unstarred: nothing stored', JSON.stringify(await stored()) === '[]', JSON.stringify(await stored()));

// storage that throws: the picker still lists, and a star still works for this page
{
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  p2.on('pageerror', (e) => errors.push(`blocked-storage pageerror: ${e.message}`));
  await p2.addInitScript(() => {
    const no = () => { throw new DOMException('blocked', 'SecurityError'); };
    Storage.prototype.getItem = no; Storage.prototype.setItem = no;
  });
  await p2.goto(url);
  await p2.waitForSelector('#menu .card[data-a="resort"]', { timeout: 120000 });
  await p2.evaluate(() => document.querySelector('#menu .card[data-a="resort"]').click());
  await p2.waitForFunction(() => document.querySelectorAll('#menu .pop button[data-pack]').length >= 3, null, { timeout: 30000 });
  const n = await p2.evaluate(() => { document.querySelector('#menu .pop button.star[data-fav="alpha-peak"]').click(); return document.querySelectorAll('#menu .pop button[data-pack]').length; });
  check('storage blocked: the picker lists every resort and a star does not throw', n === 3);
  await p2.close();
}

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' / '));
await browser.close();
server.close();
console.log(`${fails.length ? `${fails.length} failed` : 'all ok'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(fails.length ? 1 : 0);
