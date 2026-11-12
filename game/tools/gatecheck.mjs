// Gate check (FEAT-273): the dev server's token gate (tools/accounts/gate.mjs) and the claim rule and key path of
// tools/accounts/verifier.mjs, over a fake verifier: no Firebase project, no key file, no browser, no network. A
// Node http server on a free port mounts GET /api/account and a maintainer-only test route; then the launcher,
// bundled the way tools/package.mjs bundles it, must hold no Admin SDK and no account routes. Exits 1 on a failure.
//   node tools/gatecheck.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { accountRoute, bearerToken, requireAccount } from './accounts/gate.mjs';
import { KEY_PATH_DEFAULT, accountFromClaims, fakeVerifier, firebaseVerifier, keyPath } from './accounts/verifier.mjs';
import { GAME } from './paths.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };

const T = {
  'tok-drew': { uid: 'u-drew', role: 'maintainer', player: 1 },
  'tok-p': { uid: 'u-p', role: 'player', player: null },
  'tok-m': { uid: 'u-m', role: 'maintainer', player: null },
};
const handled = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatecheck-'));
const missingKey = path.join(tmp, 'no-such-key.json');
const recordingHandler = (req, res, account) => {
  handled.push(account);
  res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end('{"built":true}');
};
const at = (url, route) => (req, res, next) => (req.url === url ? route(req, res, next) : next());
const routes = [
  accountRoute(fakeVerifier(T)),
  at('/t/build', requireAccount(fakeVerifier(T), recordingHandler, { role: 'maintainer' })),
  at('/u/build', requireAccount({ configured: false, verify: () => Promise.reject(new Error('unset')) }, recordingHandler, { role: 'maintainer' })),
  at('/x/build', requireAccount(fakeVerifier(T), async () => { throw new Error('handler failed (expected)'); })),
  at('/k/build', requireAccount(firebaseVerifier(missingKey), recordingHandler, { role: 'maintainer' })),
];
const server = http.createServer((req, res) => {
  let i = 0;
  const next = () => { const r = routes[i++]; if (r) r(req, res, next); else { res.statusCode = 404; res.end('not found'); } };
  next();
});
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

let last = null;
let body = null;
async function get(p, token, headers = {}) {
  last = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  const text = await last.text();
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: last.status, body };
}

try {
  ok((await get('/t/build')).status === 401 && body.error === 'sign in first', 'no Authorization header: 401 sign in first');
  ok((await get('/t/build', 'tok-nope')).status === 401, 'an unknown token: 401');
  ok((await get('/t/build', 'tok-p')).status === 403 && handled.length === 0, 'player token on a maintainer route: 403');
  ok((await get('/t/build', 'tok-m')).status === 200 && handled.shift()?.player === null, 'a maintainer with no player number passes (a missing number is never a refusal)');
  ok((await get('/t/build', 'tok-drew')).status === 200 && handled[0]?.uid === 'u-drew', 'maintainer token: handler runs with uid u-drew');
  ok((await get('/t/build', 'tok-drew', { origin: 'https://example.com' })).status === 403 && handled.length === 1, 'foreign Origin with a maintainer token: 403, handler not run');
  ok((await get('/u/build', 'tok-drew')).status === 503, 'verifier not configured: 503');
  ok((await get('/t/build', undefined, { origin: 'https://example.com' })).status === 403, 'foreign Origin with no token: 403 (the Origin is checked first)');
  ok((await get('/k/build', 'tok-drew')).status === 503 && !JSON.stringify(body).includes('no-such-key') && handled.length === 1, 'the real verifier with no key file: 503, the key path not in the reply');
  ok((await get('/x/build', 'tok-p')).status === 500, 'a handler that rejects: 500, the request is not left open');
  ok((await get('/api/account')).status === 401 && body.error === 'sign in first', '/api/account as a guest: 401');
  ok((await get('/api/account', 'tok-drew')).status === 200 && body.role === 'maintainer' && body.player === 1, '/api/account for Drew: maintainer, player 1');
  ok(JSON.stringify((await get('/api/account', 'tok-p')).body) === '{"uid":"u-p","role":"player","player":null}', '/api/account: uid, role, player');
  ok(last.headers.get('cache-control') === 'no-store', 'replies are no-store');
  ok(bearerToken({ headers: { authorization: 'bearer abc' } }) === 'abc' && bearerToken({ headers: { authorization: 'Basic abc' } }) === null && bearerToken({ headers: { authorization: 'Bearer ' } }) === null, 'bearerToken: Bearer only, not empty');
  ok(accountFromClaims({ uid: 'x', role: 'maintainer', player: 0 }).player === 0 && accountFromClaims({ uid: 'x', role: 'admin' }).role === 'player' && accountFromClaims({ uid: 'x', player: '1' }).player === null, 'accountFromClaims: exact role, integer player');
  ok(firebaseVerifier(path.join(tmp, 'missing.json')).configured === false, 'no key file: not configured');
  const badKey = path.join(tmp, 'bad-key.json');
  fs.writeFileSync(badKey, '{}');
  const bad = firebaseVerifier(badKey);
  ok(bad.configured === true && await bad.verify('tok-drew').then(() => false, () => true), 'a key file the Admin SDK refuses: configured, and verify rejects (the route says 401)');
  ok(await firebaseVerifier(path.join(tmp, 'missing.json')).verify('tok-drew').then(() => false, () => true), 'no key file: verify rejects');
  ok(keyPath({ SBA_FIREBASE_ADMIN_KEY: 'D:\\k.json' }) === 'D:\\k.json' && keyPath({}) === KEY_PATH_DEFAULT, 'SBA_FIREBASE_ADMIN_KEY overrides the default key path');

  // the launcher bundled as package.mjs bundles it (esbuild, platform node, cjs, node22, SBA_LAUNCHER defined), into a temp file
  const out = path.join(tmp, 'launcher.cjs');
  await build({
    entryPoints: [path.join(GAME, 'tools', 'launcher.mjs')], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    define: { SBA_LAUNCHER: JSON.stringify({ version: 'dev', packFormat: 0 }) },
    logOverride: { 'empty-import-meta': 'silent' }, logLevel: 'error',
  });
  const launcherBundle = fs.readFileSync(out, 'utf8');
  ok(launcherBundle.length > 1000, `the launcher bundled (${launcherBundle.length} bytes)`);
  ok(!/firebase-admin|tools[\\/]accounts/.test(launcherBundle), 'the launcher bundle has no Admin SDK and no account routes');
  // and that test can fail: the same bundling of the verifier is caught (its path and the Admin SDK import)
  const control = path.join(tmp, 'verifier.cjs');
  await build({ entryPoints: [path.join(GAME, 'tools', 'accounts', 'verifier.mjs')], outfile: control, bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', logLevel: 'error' });
  const c = fs.readFileSync(control, 'utf8');
  ok(/firebase-admin/.test(c) && /tools[\\/]accounts/.test(c), 'control: a bundle that holds the verifier is caught');
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (fails) { console.error(`${fails} gatecheck failure(s)`); process.exit(1); }
console.log('gatecheck: all ok');
