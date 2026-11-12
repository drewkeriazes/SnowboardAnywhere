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

fs.rmSync(dir, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
