// Account line check (FEAT-273): the main menu's corner line, in a browser, against a built dist/ (no .env.local, as CI).
// Guest play is never gated: the line is the whole start flow. Uses the ?account= fakes, never the network.
// node tools/accountmenucheck.mjs [pack] [--gpu | --headed | --cpu]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const pack = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] ?? 'synth';
const t0 = Date.now();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const browser = await launchBrowser();
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };

const distFiles = (d = DIST) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? distFiles(path.join(d, e.name)) : [path.join(d, e.name)]);

/** one case: a fresh page at ?pack=<pack>&lowgfx<query>, waiting for the account line (never for the session) */
async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.addInitScript(() => { try { localStorage.clear(); } catch { /* none */ } });
  await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&lowgfx${query}`);
  await page.waitForSelector('#menu .account', { state: 'visible', timeout: 60000 });
  const text = () => page.evaluate(() => document.querySelector('#menu .account').textContent);
  const btn = page.locator('#menu .account button');
  const click = async (label) => {
    const before = await text();
    await page.locator('#menu .account button', { hasText: label }).click();
    await page.waitForFunction((b) => document.querySelector('#menu .account').textContent !== b, before, { timeout: 15000 });
    await page.waitForTimeout(100);
  };
  return { page, text, btn, click, requests };
}

{ // no query (CI's unconfigured build)
  const c = await open('');
  check('unconfigured: guest line', (await c.text()).includes('Playing as guest'));
  check('unconfigured: Sign in disabled with its reason', await c.btn.isDisabled() && (await c.text()).includes('Sign-in is not set up in this build.'));
  check('unconfigured: no Firebase chunk requested', !c.requests.some((u) => /firebasePort-/.test(u)));
  check('menu paints, RIDE is there without the account', await c.page.evaluate(() => !!document.querySelector('#menu button.ride')));
  await c.page.close();
}
{ // &account=maintainer
  const c = await open('&account=maintainer');
  check('maintainer line', (await c.text()).includes('Test maintainer \u00b7 player 1 \u00b7 maintainer'));
  await c.click('Sign out');
  check('Sign out: guest line', (await c.text()).includes('Playing as guest'));
  await c.page.close();
}
{ // &account=guest
  const c = await open('&account=guest');
  check('MenuNav reaches the account button', await c.page.evaluate(() => { const b = document.querySelector('#menu .account button'); b.focus(); return document.activeElement === b; }));
  await c.click('Sign in with GitHub');
  check('player 0 reads', (await c.text()).includes('\u00b7 player 0'));
  check('name is text', (await c.text()).includes('<i>player</i>') && (await c.page.$('#menu .account i')) === null);
  await c.page.close();
}
// the built bundle
const read = (f) => fs.readFileSync(f, 'latin1');
check('no Admin SDK or key in dist', !distFiles().some((f) => /firebase-admin|-----BEGIN PRIVATE KEY-----|"type":\s*"service_account"/.test(read(f))));
await browser.close();
server.close();
console.log(`${fails.length ? `${fails.length} failed` : 'all ok'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(fails.length ? 1 : 0);
