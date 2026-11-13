// Accounts check (FEAT-273): the public Firebase web config reader, no browser, no network.
// A config is complete only when all four VITE_FIREBASE_* names are set and not blank; values are
// trimmed. Then the claim rule, the account states, the fakes and (FEAT-274) email and password sign-in,
// verification and adding a method, all on the in-memory fake project.
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
let holdToken = null; // a promise the stub's token() waits on (FEAT-246: a sign-out during the await)
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
    async token(u) { if (holdToken) await holdToken; return `tok-${u.uid}`; },
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
{
  // FEAT-246: signed out while the token was being read: null, never the previous user's token
  s = stubPort({ claims: { role: 'maintainer', player: 1 } }); a = new FirebaseAccount(Promise.resolve(s.port)); s.fire(drew); await a.ready();
  let release; holdToken = new Promise((r) => { release = r; });
  const pending = a.idToken();
  await new Promise((r) => setTimeout(r, 5));
  await a.signOut(); release(); holdToken = null;
  ok((await pending) === null, 'idToken: a sign-out during the await gives null, not the old token');
  s.fire(drew); await new Promise((r) => setTimeout(r, 5));
  ok((await a.idToken()) === 'tok-u-drew', 'idToken: signed in again, the token comes back');
}
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
ok(v.who === 'Playing as guest' && v.action === 'open' && v.label === 'Sign in' && !v.disabled, 'guest, sign-in set up: an enabled Sign in (opens the account panel)');
v = accountLineView({ kind: 'guest' }, false, 'Sign-in is not set up in this build.');
ok(v.disabled && v.note === 'Sign-in is not set up in this build.', 'guest, not set up: disabled, the reason as the note');
ok(accountLineView({ kind: 'signed-in', player: FAKE_PLAYER }, true, '').who === 'Test <i>player</i> · player 0', 'player 0 reads "· player 0"');
ok(accountLineView({ kind: 'signed-in', player: { ...FAKE_PLAYER, playerNumber: null } }, true, '').who === 'Test <i>player</i>', 'no number: just the name');
ok(accountLineView({ kind: 'signed-in', player: FAKE_MAINTAINER }, true, '').who === 'Test maintainer · player 1 · maintainer', 'maintainer: "· maintainer"');
ok(accountLineView({ kind: 'pending' }, true, '').action === null, 'pending: hidden');
{ const w = accountLineView({ kind: 'signed-in', player: FAKE_PLAYER }, true, ''); ok(w.action === 'open' && w.label === 'Account', 'signed in: Account (opens the account panel)'); }

// FEAT-274: email and password, verification, and adding a method only from a signed-in session
const { needsVerification } = await load('account/Account.ts', 'account2');
ok(needsVerification({ providerIds: ['password'], emailVerified: false }), 'password only, unverified: held back');
ok(!needsVerification({ providerIds: ['password'], emailVerified: true }), 'password only, verified: opens');
ok(!needsVerification({ providerIds: ['github.com', 'password'], emailVerified: false }), 'GitHub and password, unverified: opens (GitHub opened it)');
ok(!needsVerification({ providerIds: ['github.com'], emailVerified: false }), 'GitHub only: never held back');
const { EMAIL_IN_USE, BAD_CREDENTIALS } = await load('account/errors.ts', 'errors2');
ok(EMAIL_IN_USE.includes('Sign in the way you usually do, then add this method from your account.'), 'the email-in-use refusal is the card message');
for (const c of ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-login-credentials'])
  ok(signInFailure(c, { method: 'password' }).code === 'bad-credentials' && signInFailure(c, { method: 'password' }).message === BAD_CREDENTIALS, `password ${c}: bad-credentials, the one message`);
ok(signInFailure('auth/email-already-in-use', { method: 'password' }).message === EMAIL_IN_USE && signInFailure('auth/account-exists-with-different-credential').message === EMAIL_IN_USE, 'sign-up or GitHub sign-in with a taken email: the card message');
ok(signInFailure('auth/email-already-in-use', { method: 'password', adding: true }).message.startsWith('That email already belongs to another account, so it cannot be added'), 'adding a password with a taken email: cannot be added');
ok(signInFailure('auth/credential-already-in-use', { method: 'github', adding: true }).message.startsWith('That GitHub account already belongs to another account'), 'adding a GitHub that opens another account: cannot be added');
ok(signInFailure('auth/operation-not-allowed', { method: 'password' }).message === 'Email and password sign-in is not turned on for this game.', 'password not turned on in the console: says so');
for (const [c, want] of [['auth/weak-password', 'weak-password'], ['auth/password-does-not-meet-requirements', 'weak-password'], ['auth/invalid-email', 'invalid-email'], ['auth/too-many-requests', 'too-many-requests'], ['auth/provider-already-linked', 'already-added']])
  ok(signInFailure(c, { method: 'password' }).code === want, `${c} maps to ${want}`);
ok(signInFailure('auth/invalid-credential').code === 'unknown', 'invalid-credential on GitHub is not the password message');

const { memoryAccount, MemoryAuth, FAKE_PASSWORD_RIDER, FAKE_RIDER } = await load('account/fakeAccount.ts', 'fake2');
const settle = () => new Promise((r) => setTimeout(r, 5));
{ // sign up, the verification gate, sign in once verified
  const a = memoryAccount({ session: null }); await a.ready();
  const kinds = []; a.onChange((x) => kinds.push(x.kind));
  let r = await a.signIn({ method: 'password', email: ' new@example.test ', password: 'secret-123', create: true }); await settle();
  ok(!r.ok && r.code === 'unverified' && r.message === 'Account made. We sent a link to new@example.test: open it, then sign in here.' && a.state().kind === 'guest' && (await a.idToken()) === null && kinds.length === 0, 'sign up: account made, a link sent, still a guest (never signed in, no change)');
  ok(a.auth.sent.join() === 'new@example.test', 'sign up: one verification email to the trimmed address');
  r = await a.signIn({ method: 'password', email: 'new@example.test', password: 'secret-123', create: false }); await settle();
  ok(!r.ok && r.code === 'unverified' && r.message.startsWith('Verify your email first: we sent a new link') && a.state().kind === 'guest' && a.auth.sent.length === 2, 'unverified sign-in: refused with a new link, still a guest');
  a.auth.verify('new@example.test');
  r = await a.signIn({ method: 'password', email: 'NEW@example.test', password: 'secret-123', create: false }); await settle();
  ok(r.ok && a.state().kind === 'signed-in' && a.state().player.providers.join() === 'password' && a.state().player.role === 'player' && (await a.idToken()) === `fake:${r.player.uid}`, 'verified: signs in, a player, a token');
  await a.signOut();
  r = await a.signIn({ method: 'password', email: 'new2@example.test', password: 'abc', create: true });
  ok(!r.ok && r.code === 'weak-password', 'sign up with a short password: weak-password');
}
{ // a wrong password and no such account read the same
  const a = memoryAccount({ session: null }); await a.ready();
  const wrong = await a.signIn({ method: 'password', email: FAKE_PASSWORD_RIDER.email, password: 'nope-nope', create: false });
  const none = await a.signIn({ method: 'password', email: 'nobody@example.test', password: 'nope-nope', create: false });
  ok(!wrong.ok && !none.ok && wrong.code === 'bad-credentials' && none.code === 'bad-credentials' && wrong.message === none.message, 'wrong password and no such account: the same refusal');
  const blank = await a.signIn({ method: 'password', email: '  ', password: 'x', create: false });
  ok(!blank.ok && blank.code === 'invalid-email' && a.state().kind === 'guest', 'a blank email never goes to Firebase');
  const ok1 = await a.signIn({ method: 'password', ...FAKE_PASSWORD_RIDER, create: false });
  ok(ok1.ok && a.state().player.uid === FAKE_RIDER.uid, 'the verified password rider signs in');
}
{ // Done when 3: signing up with the email on player 1's GitHub account neither joins nor opens it
  const a = memoryAccount({ session: null }); await a.ready();
  const before = a.auth.users.length;
  const r = await a.signIn({ method: 'password', email: 'player1@example.test', password: 'attacker-pass', create: true }); await settle();
  const p1 = a.auth.user('fake-maintainer');
  ok(!r.ok && r.code === 'email-in-use' && r.message === EMAIL_IN_USE, 'sign up with the email of player 1: refused with the card message');
  ok(a.state().kind === 'guest' && (await a.idToken()) === null && p1.password === null && a.auth.users.length === before && a.auth.sent.length === 0, 'nothing joined, nothing opened, no account made, no email sent');
  const s2 = await a.signIn({ method: 'password', email: 'player1@example.test', password: 'attacker-pass', create: false });
  ok(!s2.ok && s2.code === 'bad-credentials' && a.state().kind === 'guest', 'sign in with the email of player 1 and a guessed password: refused, still a guest');
}
{ // Done when 2: player 1, signed in with GitHub, adds email and password; both then open the same account
  const a = memoryAccount({ session: 'fake-maintainer', github: 'fake-maintainer' }); await a.ready();
  const r = await a.addMethod({ method: 'password', email: 'player1@example.test', password: 'drew-pass-1' });
  ok(r.ok && a.state().player.providers.join() === 'github.com,password' && isMaintainer(a.state()) && r.note.includes('player1@example.test'), 'add email and password from the signed-in session: both methods, still the maintainer, a verification note');
  await a.signOut();
  const pw = await a.signIn({ method: 'password', email: 'player1@example.test', password: 'drew-pass-1', create: false });
  ok(pw.ok && pw.player.uid === 'fake-maintainer' && isMaintainer(a.state()) && (await a.idToken()) === 'fake:fake-maintainer', 'then email and password opens the same account (an unverified email is fine: GitHub opened it)');
  await a.signOut();
  const gh = await a.signIn({ method: 'github' });
  ok(gh.ok && gh.player.uid === 'fake-maintainer', 'and GitHub still opens it');
  const again = await a.addMethod({ method: 'password', email: 'player1@example.test', password: 'other-pass' });
  ok(!again.ok && again.code === 'already-added', 'adding a method the account has: already-added');
}
{
  const a = memoryAccount({ session: null }); await a.ready();
  const r = await a.addMethod({ method: 'password', email: 'x@example.test', password: 'secret-123' });
  ok(!r.ok && r.code === 'not-signed-in' && a.state().kind === 'guest', 'a guest cannot add a method');
}
{ // a method that belongs to another account is never joined
  const a = memoryAccount({ session: 'fake-player', github: 'fake-player' }); await a.ready();
  const r = await a.addMethod({ method: 'password', email: 'player1@example.test', password: 'secret-123' });
  ok(!r.ok && r.code === 'email-in-use' && a.state().player.providers.join() === 'github.com' && a.auth.user('fake-maintainer').password === null, 'adding a password with the email of another account: refused, neither account changed');
  const b = memoryAccount({ session: 'fake-rider', github: 'fake-player' }); await b.ready();
  const g = await b.addMethod({ method: 'github' });
  ok(!g.ok && g.code === 'email-in-use' && b.state().player.providers.join() === 'password', 'adding a GitHub that opens another account: refused, the rider unchanged');
  const c = memoryAccount({ session: 'fake-rider', github: null }); await c.ready();
  const g2 = await c.addMethod({ method: 'github' });
  ok(g2.ok && c.state().player.providers.join() === 'github.com,password' && c.state().player.uid === FAKE_RIDER.uid, 'a password rider adds a new GitHub: both methods, same account');
  await c.signOut(); const g3 = await c.signIn({ method: 'github' });
  ok(g3.ok && g3.player.uid === FAKE_RIDER.uid, 'then GitHub opens the rider account');
}
{ // sign-out while a link runs: nothing reported added to a session that is gone
  const m = new MemoryAuth({ session: 'fake-maintainer', github: 'fake-maintainer' });
  let release = () => {}; const gate = new Promise((r) => { release = r; });
  const link = m.linkPassword.bind(m); m.linkPassword = async (...args) => { await gate; return link(...args); };
  const a = new FirebaseAccount(Promise.resolve(m)); await a.ready();
  const pr = a.addMethod({ method: 'password', email: 'player1@example.test', password: 'drew-pass-1' });
  await settle(); await a.signOut(); release();
  const r = await pr;
  ok(!r.ok && r.code === 'cancelled' && a.state().kind === 'guest', 'sign-out during an add: cancelled, guest');
}
{ // a restored session of an unverified password-only account never opens; a verification email that does not go out says so
  const s = stubPort({}); const a = new FirebaseAccount(Promise.resolve(s.port));
  let signedOut = 0; s.port.signOut = async () => { signedOut++; };
  s.fire({ uid: 'u-new', displayName: null, providerIds: ['password'], email: 'x@example.test', emailVerified: false });
  ok((await a.ready()).kind === 'guest' && (await a.idToken()) === null, 'restored unverified password session: a guest');
  await settle(); ok(signedOut === 1, 'and the SDK session is signed out');
  const m = new MemoryAuth({ session: null }); m.sendVerification = async () => { throw Object.assign(new Error('x'), { code: 'auth/too-many-requests' }); };
  const b = new FirebaseAccount(Promise.resolve(m)); await b.ready();
  const r = await b.signIn({ method: 'password', email: 'y@example.test', password: 'secret-123', create: true });
  ok(!r.ok && r.code === 'unverified' && r.message.includes('did not go out') && b.state().kind === 'guest', 'sign up whose verification email fails: says so, still a guest');
}
// the dev server turns away an unverified password-only token too
const { heldForVerification } = await import(pathToFileURL(path.join(GAME, 'tools', 'accounts', 'verifier.mjs')).href);
ok(heldForVerification({ email_verified: false, firebase: { identities: { email: ['x@example.test'] } } }), 'server: unverified password-only token held back');
ok(!heldForVerification({ email_verified: true, firebase: { identities: { email: ['x@example.test'] } } }), 'server: verified password token passes');
ok(!heldForVerification({ email_verified: false, firebase: { identities: { 'github.com': ['1'], email: ['x@example.test'] } } }), 'server: GitHub and password, unverified: passes');
ok(!heldForVerification({ firebase: {} }) && !heldForVerification({}), 'server: no identities: not this rule (the role check still applies)');

const { accountPanelView } = await load('ui/AccountPanel.ts', 'panel');
ok(accountPanelView({ kind: 'guest' }).kind === 'sign-in' && accountPanelView({ kind: 'pending' }).kind === 'none', 'panel: a guest gets the sign-in choices');
{
  const m = accountPanelView({ kind: 'signed-in', player: FAKE_MAINTAINER });
  ok(m.kind === 'account' && m.methods.join() === 'GitHub' && m.add.join() === 'password' && m.email === 'player1@example.test', 'panel: a GitHub account lists GitHub, offers email and password with its email');
  ok(accountPanelView({ kind: 'signed-in', player: FAKE_RIDER }).add.join() === 'github', 'panel: a password account offers GitHub');
  ok(accountPanelView({ kind: 'signed-in', player: { ...FAKE_RIDER, providers: ['github.com', 'password'] } }).add.length === 0, 'panel: both methods, nothing to add');
}

fs.rmSync(dir, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
