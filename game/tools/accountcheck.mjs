// Accounts check (FEAT-273): the public Firebase web config reader, no browser, no network.
// A config is complete only when all four VITE_FIREBASE_* names are set and not blank; values are
// trimmed. Later tasks add the account state, token and role checks here.
// node tools/accountcheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

let fails = 0;
function ok(cond, label) { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`); if (!cond) fails++; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accountcheck-'));
async function load(rel, name) {
  const out = path.join(dir, name + '.mjs');
  await build({ entryPoints: [path.join(GAME, 'src', rel)], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
  return import(pathToFileURL(out).href);
}

const { readFirebaseConfig } = await load('firebase/config.ts', 'config');
const full = { VITE_FIREBASE_API_KEY: 'k', VITE_FIREBASE_AUTH_DOMAIN: 'p.firebaseapp.com', VITE_FIREBASE_PROJECT_ID: 'p', VITE_FIREBASE_APP_ID: '1:2:web:3' };
let r = readFirebaseConfig({});
ok(r.config === null && r.missing.length === 4, 'no VITE_FIREBASE_* set: unconfigured');
r = readFirebaseConfig(full);
ok(JSON.stringify(r.config) === JSON.stringify({ apiKey: 'k', authDomain: 'p.firebaseapp.com', projectId: 'p', appId: '1:2:web:3' }) && r.missing.length === 0, 'all four set: a config');
r = readFirebaseConfig({ ...full, VITE_FIREBASE_APP_ID: '  ' });
ok(r.config === null && r.missing.join() === 'VITE_FIREBASE_APP_ID', 'a blank value counts as missing');
r = readFirebaseConfig({ ...full, VITE_FIREBASE_API_KEY: ' k ' });
ok(r.config?.apiKey === 'k', 'values are trimmed');

const { playerFromUser } = await load('account/claims.ts', 'claims');
const { isMaintainer } = await load('account/Account.ts', 'account');
const { signInFailure } = await load('account/errors.ts', 'errors');
const { FakeAccount, FAKE_PLAYER, FAKE_MAINTAINER } = await load('account/fakeAccount.ts', 'fake');
const u = (displayName) => ({ uid: 'u1', displayName, providerIds: ['github.com'] });
let p = playerFromUser(u('Drew'), { role: 'maintainer', player: 1 });
ok(p.role === 'maintainer' && p.playerNumber === 1 && p.displayName === 'Drew', 'maintainer claim: role maintainer, player 1');
p = playerFromUser(u('Drew'), {});
ok(p.role === 'player' && p.playerNumber === null, 'no claims: role player, no number');
ok(['Maintainer', 'admin', true, 1].every((role) => playerFromUser(u('x'), { role }).role === 'player'), 'any other role value is a player');
ok(playerFromUser(u('x'), { player: 0 }).playerNumber === 0, 'player 0 is kept');
ok(['1', 1.5, -1, null].every((player) => playerFromUser(u('x'), { player }).playerNumber === null), 'a string, fraction or negative player is no number');
ok(playerFromUser(u(null), {}).displayName === 'Player' && playerFromUser(u('  '), {}).displayName === 'Player', 'no display name: "Player"');
ok(!isMaintainer({ kind: 'pending' }) && !isMaintainer({ kind: 'guest' }) && !isMaintainer({ kind: 'signed-in', player: FAKE_PLAYER }) && isMaintainer({ kind: 'signed-in', player: FAKE_MAINTAINER }), 'isMaintainer only for the maintainer role');
for (const [fb, code] of [['auth/popup-closed-by-user', 'cancelled'], ['auth/cancelled-popup-request', 'cancelled'], ['auth/popup-blocked', 'popup-blocked'], ['auth/account-exists-with-different-credential', 'email-in-use'], ['auth/unauthorized-domain', 'unauthorized-domain'], ['auth/network-request-failed', 'network'], ['auth/operation-not-allowed', 'not-enabled']])
  ok(signInFailure(fb).code === code, `${fb} maps to ${code}`);
{
  const M = 'Sign-in works only at http://localhost:5173 on this PC. Here you can play as a guest.';
  const a = signInFailure('auth/requests-from-referer-http://192.168.1.5:5173-are-blocked.');
  ok(a.code === 'unauthorized-domain' && a.message === M, 'auth/requests-from-referer-<origin>-are-blocked. maps to unauthorized-domain with the localhost message');
  ok(signInFailure('auth/unauthorized-domain').message === M, 'auth/unauthorized-domain uses the same message');
  const k = signInFailure('auth/api-key-not-valid.-please-pass-a-valid-api-key.');
  ok(k.code === 'unavailable' && k.message === 'Sign-in is not set up correctly in this build.', 'auth/api-key-not-valid... maps to unavailable with its message');
}
ok(signInFailure('auth/zzz').code === 'unknown' && signInFailure('auth/zzz').message.includes('auth/zzz'), 'an unknown code is named in the message');
ok(signInFailure('auth/popup-closed-by-user').message === '', 'a closed popup says nothing');

const m = FakeAccount.fromParam('maintainer');
ok((await m.ready()).kind === 'signed-in' && isMaintainer(m.state()), 'fake maintainer is signed in');
const seen = []; const off = m.onChange((s) => seen.push(s.kind));
await m.signOut();
ok(m.state().kind === 'guest' && seen.join() === 'guest' && (await m.idToken()) === null, 'sign out: guest, one change, no token');
off(); await m.signIn({ method: 'github' });
ok(seen.length === 1, 'unsubscribe stops the callbacks');
const g = FakeAccount.fromParam('guest');
const res = await g.signIn({ method: 'github' });
ok(res.ok && g.state().kind === 'signed-in' && (await g.idToken()) === 'fake:fake-player', 'fake guest signs in as the test player');
const n = FakeAccount.fromParam('unconfigured');
const nr = await n.signIn({ method: 'github' });
ok(!n.available && n.unavailableReason === 'Sign-in is not set up in this build.' && !nr.ok && nr.code === 'unavailable', 'unconfigured: unavailable with its reason');
ok(FakeAccount.fromParam('bogus') === null, 'an unknown ?account value is no fake');
ok(FAKE_PLAYER.playerNumber === 0 && FAKE_PLAYER.displayName === 'Test <i>player</i>', 'the fake player is number 0 with markup in its name');

// FirebaseAccount and createAccount on a stub port: the SDK is never imported (./firebasePort stays external and unused).
async function loadExt(rel, name) {
  const out = path.join(dir, name + '.mjs');
  await build({ entryPoints: [path.join(GAME, 'src', rel)], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error', external: ['./firebasePort'] });
  return import(pathToFileURL(out).href);
}
const { FirebaseAccount } = await loadExt('account/firebaseAccount.ts', 'fbaccount');
const { createAccount } = await loadExt('account/createAccount.ts', 'create');
const drew = { uid: 'u-drew', displayName: 'Drew', providerIds: ['github.com'] };
function stubPort({ claims = {}, claimsFail = false, fail = null, hold = false } = {}) {
  const calls = { signIn: 0, claims: [] };
  let release = () => {}; const gate = new Promise((r) => { release = r; });
  let cb = null; let pending; let has = false; let failLeft = fail;
  const port = {
    onUser(f) { cb = f; if (has) f(pending); },
    async signInGithub() {
      calls.signIn++;
      await new Promise((r) => setTimeout(r, 5));
      if (failLeft) { const code = failLeft; failLeft = null; throw Object.assign(new Error(code), { code }); }
      return drew;
    },
    async signOut() {},
    async claims(u, refresh) { calls.claims.push(refresh); if (hold && refresh) await gate; if (claimsFail) throw new Error('offline'); return claims; },
    async token(u) { return `tok-${u.uid}`; },
  };
  return { port, calls, release: () => release(), fire(u) { if (cb) cb(u); else { pending = u; has = true; } } };
}
let s = stubPort({ claims: { role: 'maintainer', player: 1 } });
let a = new FirebaseAccount(Promise.resolve(s.port));
ok(a.state().kind === 'pending', 'pending until the first auth state');
s.fire(null); ok((await a.ready()).kind === 'guest', 'then guest');
s = stubPort({ claims: { role: 'maintainer', player: 1 } }); a = new FirebaseAccount(Promise.resolve(s.port)); s.fire(drew);
ok(isMaintainer(await a.ready()) && s.calls.claims[0] === false, 'a restored maintainer session is a maintainer');
s = stubPort({ claims: { role: 'maintainer', player: 1 } }); a = new FirebaseAccount(Promise.resolve(s.port)); s.fire(null); await a.ready();
const changes = []; a.onChange((x) => changes.push(x.kind));
const [r1, r2] = await Promise.all([a.signIn({ method: 'github' }), a.signIn({ method: 'github' })]);
ok(r1.ok && r2.ok && s.calls.signIn === 1, 'two signIn clicks open one popup');
s.fire(drew); await new Promise((r) => setTimeout(r, 5));
ok(s.calls.claims.at(-1) === true && a.state().kind === 'signed-in' && changes.join() === 'signed-in', 'signIn refreshes claims, one change (the SDK echo adds none)');
ok((await a.idToken()) === 'tok-u-drew', 'idToken is the port token when signed in');
await a.signOut(); ok(a.state().kind === 'guest' && (await a.idToken()) === null, 'signOut: guest, no token');
for (const [code, want] of [['auth/popup-closed-by-user', 'cancelled'], ['auth/popup-blocked', 'popup-blocked'], ['auth/account-exists-with-different-credential', 'email-in-use']]) {
  s = stubPort({ fail: code }); a = new FirebaseAccount(Promise.resolve(s.port)); s.fire(null); await a.ready();
  let fired = 0; a.onChange(() => fired++);
  const r = await a.signIn({ method: 'github' });
  ok(!r.ok && r.code === want && a.state().kind === 'guest' && fired === 0, `${code}: ${want}, still guest`);
}
s = stubPort({ fail: 'auth/popup-blocked' }); a = new FirebaseAccount(Promise.resolve(s.port)); s.fire(null); await a.ready();
await a.signIn({ method: 'github' }); ok((await a.signIn({ method: 'github' })).ok && s.calls.signIn === 2, 'popup blocked: button free again (a second try opens a popup)');
s = stubPort({ claimsFail: true }); a = new FirebaseAccount(Promise.resolve(s.port)); s.fire(drew);
ok((await a.ready()).player?.role === 'player', 'claims unreadable: role player');
a = new FirebaseAccount(Promise.reject(Object.assign(new Error('bad key'), { code: 'auth/invalid-api-key' })));
ok((await a.ready()).kind === 'guest' && !a.available && a.unavailableReason === 'Sign-in could not start (auth/invalid-api-key).', 'port fails to start: unavailable with the code, guest');
ok(!(await a.signIn({ method: 'github' })).ok, 'port failed to start: signIn is refused');

// An auth-state echo during a sign-in must not drop the signed-in state.
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
for (const [when, wait] of [['after the popup resolved, before claims', 20], ['before the popup resolved', 1]]) {
  s = stubPort({ claims: { role: 'maintainer', player: 1 }, hold: true }); a = new FirebaseAccount(Promise.resolve(s.port)); s.fire(null); await a.ready();
  const ch = []; a.onChange((x) => ch.push(x.kind));
  const pr = a.signIn({ method: 'github' });
  await tick(wait); s.fire(drew); await tick(); s.release();
  const rr = await pr; await tick();
  ok(rr.ok && isMaintainer(a.state()) && (await a.idToken()) === 'tok-u-drew' && ch.join() === 'signed-in', `echo ${when}: signed in, token, one change`);
}
s = stubPort({ claims: { role: 'maintainer', player: 1 }, hold: true }); a = new FirebaseAccount(Promise.resolve(s.port)); s.fire(null); await a.ready();
{
  const pr = a.signIn({ method: 'github' });
  await tick(20); s.fire(null); await tick(); s.release();
  const rr = await pr;
  ok(a.state().kind === 'guest' && !rr.ok && rr.code === 'cancelled' && (await a.idToken()) === null, 'sign-out elsewhere during a sign-in: guest wins, signIn reports cancelled');
}

let loads = 0; const loadPort = () => { loads++; return Promise.resolve(stubPort({}).port); };
ok(!createAccount({ env: {}, fake: null, hosted: false, headless: false, loadPort }).available && loads === 0, 'no env: unavailable, no SDK load');
ok(!createAccount({ env: full, fake: null, hosted: false, headless: true, loadPort }).available && loads === 0, 'headless never starts Firebase');
ok(createAccount({ env: {}, fake: 'maintainer', hosted: true, headless: false, loadPort }).available === false, '?account= is ignored on a hosted build');
ok(isMaintainer(await createAccount({ env: {}, fake: 'maintainer', hosted: false, headless: false, loadPort }).ready()), '?account=maintainer gives the fake maintainer');
createAccount({ env: full, fake: null, hosted: false, headless: false, loadPort }); ok(loads === 1, 'full config: the port loads once');

// FEAT-273 Task 4: the account line's view table
const { accountLineView } = await load('ui/AccountLine.ts', 'accountline');
let v = accountLineView({ kind: 'guest' }, true, '');
ok(v.who === 'Playing as guest' && v.action === 'sign-in' && v.label === 'Sign in with GitHub' && !v.disabled, 'guest, sign-in set up: an enabled Sign in with GitHub');
v = accountLineView({ kind: 'guest' }, false, 'Sign-in is not set up in this build.');
ok(v.disabled && v.note === 'Sign-in is not set up in this build.', 'guest, not set up: disabled, the reason as the note');
ok(accountLineView({ kind: 'signed-in', player: FAKE_PLAYER }, true, '').who === 'Test <i>player</i> · player 0', 'player 0 reads "· player 0"');
ok(accountLineView({ kind: 'signed-in', player: { ...FAKE_PLAYER, playerNumber: null } }, true, '').who === 'Test <i>player</i>', 'no number: just the name');
ok(accountLineView({ kind: 'signed-in', player: FAKE_MAINTAINER }, true, '').who === 'Test maintainer · player 1 · maintainer', 'maintainer: "· maintainer"');
ok(accountLineView({ kind: 'pending' }, true, '').action === null, 'pending: hidden');
ok(accountLineView({ kind: 'signed-in', player: FAKE_PLAYER }, true, '').action === 'sign-out', 'signed in: Sign out');

fs.rmSync(dir, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
