// Account line check (FEAT-273): the main menu's corner line, in a browser, against a built dist/ (no .env.local, as CI).
// Guest play is never gated: the line is the whole start flow. Uses the ?account= fakes, never the network.
// FEAT-274: the account panel the line opens: GitHub and email and password sign-in, sign-up and its verification
// gate, the refusals, and adding a method from a signed-in session (the fakes are the real account logic in memory).
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

// A build with the four Firebase values (game/.env.local) is a configured build: the unconfigured lines do not apply.
const envLocal = path.join(path.dirname(DIST), '.env.local');
const envHas = (txt, n) => txt.split(String.fromCharCode(10)).some((l) => l.trim().startsWith(n + '=') && l.trim().length > n.length + 1);
const configured = fs.existsSync(envLocal) && ['API_KEY', 'AUTH_DOMAIN', 'PROJECT_ID', 'APP_ID'].every((n) => envHas(fs.readFileSync(envLocal, 'utf8'), `VITE_FIREBASE_${n}`));
{ // no query (CI's unconfigured build, or a configured one)
  const c = await open('');
  check('a firebasePort chunk exists in dist/assets', fs.readdirSync(path.join(DIST, 'assets')).some((f) => /^firebasePort-.*\.js$/.test(f)));
  check('guest line', (await c.text()).includes('Playing as guest'));
  if (configured) {
    console.log('ok   configured build: unconfigured checks skipped');
    check('configured: Sign in is enabled', !(await c.page.locator('#menu .account button', { hasText: 'Sign in' }).isDisabled()));
  } else {
    check('unconfigured: Sign in disabled with its reason', await c.btn.isDisabled() && (await c.text()).includes('Sign-in is not set up in this build.'));
    check('unconfigured: no Firebase chunk requested', !c.requests.some((u) => /firebasePort-/.test(u)));
  }
  check('menu paints, RIDE is there without the account', await c.page.evaluate(() => !!document.querySelector('#menu button.ride')));
  await c.page.close();
}
/** the account panel (FEAT-274): opened from the corner line's button, in the menu's pop-up */
function panel(c) {
  const pop = c.page.locator('#menu .pop.acct');
  return {
    pop,
    open: async (label) => { await c.page.locator('#menu .account button', { hasText: label }).click(); await pop.waitFor({ state: 'visible', timeout: 15000 }); },
    text: () => pop.textContent(),
    note: () => c.page.evaluate(() => { const n = document.querySelector('#menu .pop .acct-note'); return n && !n.hidden ? n.textContent : ''; }),
    fill: async (email, password) => {
      if (email !== null) await pop.locator('input[name=email]').fill(email);
      await pop.locator('input[name=password]').fill(password);
    },
    /** presses a panel button and waits until the work is done (the note shows, or the panel closes) */
    press: async (label) => {
      await pop.locator('button', { hasText: new RegExp(`^${label}$`) }).click();
      await c.page.waitForFunction(() => { const p = document.querySelector('#menu .pop'); return p.hidden || ![...p.querySelectorAll('button')].some((b) => b.textContent === 'Working...'); }, null, { timeout: 15000 });
      await c.page.waitForTimeout(100);
    },
    closed: () => c.page.evaluate(() => document.querySelector('#menu .pop').hidden),
  };
}
const EMAIL_IN_USE = 'That email already belongs to another account. Sign in the way you usually do, then add this method from your account.';
const BAD_CREDENTIALS = 'That email and password do not open an account. Check them, or sign in the way you usually do and add a password from your account.';

{ // &account=maintainer: player 1 adds email and password from the signed-in session; both then open the account (Done when 2)
  const c = await open('&account=maintainer');
  check('maintainer line', (await c.text()).includes('Test maintainer · player 1 · maintainer'));
  const p = panel(c);
  await p.open('Account');
  check('account panel: lists GitHub, offers to add email and password', (await p.text()).includes('Signs in with: GitHub.') && (await p.text()).includes('Add a sign-in method') && (await p.pop.locator('input[name=email]').inputValue()) === 'player1@example.test');
  await p.fill(null, 'drew-pass-1');
  await p.pop.locator('input[name=password]').focus();
  await c.page.keyboard.press('Enter');
  await c.page.waitForFunction(() => (document.querySelector('#menu .pop .acct-note')?.textContent ?? '') !== '', null, { timeout: 15000 });
  check('Enter in the password field adds it: both methods, a verification note', (await p.text()).includes('Signs in with: GitHub, Email and password.') && (await p.note()).startsWith('Added. We sent a link to player1@example.test'));
  await p.press('Sign out');
  check('Sign out: panel closed, guest line', await p.closed() && (await c.text()).includes('Playing as guest'));
  await p.open('Sign in');
  await p.fill('player1@example.test', 'drew-pass-1');
  await p.press('Sign in');
  check('then email and password opens the same account (the maintainer line, panel closed)', await p.closed() && (await c.text()).includes('Test maintainer · player 1 · maintainer'));
  await c.page.close();
}
{ // &account=guest
  const c = await open('&account=guest');
  check('MenuNav reaches the account button', await c.page.evaluate(() => { const b = document.querySelector('#menu .account button'); b.focus(); return document.activeElement === b; }));
  const p = panel(c);
  await p.open('Sign in');
  check('sign-in panel: GitHub and email and password', (await p.pop.locator('button', { hasText: 'Sign in with GitHub' }).count()) === 1 && (await p.pop.locator('input[type=password]').count()) === 1);
  // typing: menu letter shortcuts (B is Snowboard / Skis, Q / E / R / V) go into the field
  const disc = () => c.page.evaluate(() => document.querySelector('#menu button[data-d].on')?.dataset.d);
  const d0 = await disc();
  await p.pop.locator('input[name=email]').focus();
  await c.page.keyboard.type('bqerv @x');
  check('typing in the email field keeps its letters and space, and no menu shortcut fires', (await p.pop.locator('input[name=email]').inputValue()) === 'bqerv @x' && (await disc()) === d0 && !(await p.closed()));
  // Done when 3: a sign-up with the email on player 1's GitHub account is refused, never joined or opened
  await p.fill('player1@example.test', 'attacker-pass');
  await p.press('Make an account');
  check("sign up with player 1's email: refused with the card's message, still a guest", (await p.note()) === EMAIL_IN_USE && (await c.text()).includes('Playing as guest'));
  await p.fill('rider@example.test', 'wrong-pass');
  await p.press('Sign in');
  check('wrong password: the one refusal, focus back on the password field', (await p.note()) === BAD_CREDENTIALS && await c.page.evaluate(() => document.activeElement?.getAttribute('name') === 'password'));
  await p.fill('nobody@example.test', 'wrong-pass');
  await p.press('Sign in');
  check('no such account: the same refusal', (await p.note()) === BAD_CREDENTIALS);
  await p.fill('new@example.test', 'secret-123');
  await p.press('Make an account');
  check('sign up: a link sent, still a guest (unverified accounts do not sign in)', (await p.note()) === 'Account made. We sent a link to new@example.test: open it, then sign in here.' && (await c.text()).includes('Playing as guest'));
  check('the email stays in its field, the password does not', (await p.pop.locator('input[name=email]').inputValue()) === 'new@example.test' && (await p.pop.locator('input[name=password]').inputValue()) === '');
  await p.fill(null, 'secret-123');
  await p.press('Sign in');
  check('unverified sign-in: refused with a new link', (await p.note()).startsWith('Verify your email first') && (await c.text()).includes('Playing as guest'));
  await c.page.keyboard.press('Escape');
  check('Esc closes the panel', await p.closed());
  await p.open('Sign in');
  await p.press('Sign in with GitHub');
  check('Sign in with GitHub: panel closed, player 0 reads', await p.closed() && (await c.text()).includes('· player 0'));
  check('name is text', (await c.text()).includes('<i>player</i>') && (await c.page.$('#menu .account i')) === null);
  await c.page.close();
}
{ // &account=guest, a verified password account signs in
  const c = await open('&account=guest');
  const p = panel(c);
  await p.open('Sign in');
  await p.fill('rider@example.test', 'rider-password');
  await p.press('Sign in');
  check('verified email and password: signed in', await p.closed() && (await c.text()).includes('Test rider'));
  await c.page.close();
}
{ // &account=rider: a password account adds GitHub
  const c = await open('&account=rider');
  const p = panel(c);
  await p.open('Account');
  check('password account: lists email and password, offers GitHub', (await p.text()).includes('Signs in with: Email and password.') && (await p.pop.locator('button', { hasText: 'Add GitHub' }).count()) === 1);
  await p.press('Add GitHub');
  check('Add GitHub: both methods, nothing left to add', (await p.text()).includes('Signs in with: GitHub, Email and password.') && !(await p.text()).includes('Add a sign-in method') && (await p.note()) === 'Added: you can sign in either way now.');
  await c.page.close();
}
// the built bundle
const read = (f) => fs.readFileSync(f, 'latin1');
check('no Admin SDK or key in dist', !distFiles().some((f) => /firebase-admin|-----BEGIN PRIVATE KEY-----|"type":\s*"service_account"/.test(read(f))));
await browser.close();
server.close();
console.log(`${fails.length ? `${fails.length} failed` : 'all ok'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(fails.length ? 1 : 0);
