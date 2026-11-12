// FEAT-273: who sent this request. The dev server checks the player's Firebase ID token with the Admin SDK
// (revocation checked) and reads the role and player number from its custom claims, with the same rule as the
// game's playerFromUser (src/account/claims.ts): role 'maintainer' only for that exact string, a player number only
// when it is an integer >= 0 (0 is a valid label, no number is normal). The service-account key stays outside every
// checkout: SBA_FIREBASE_ADMIN_KEY, else %USERPROFILE%\.snowboardanywhere\firebase-admin-key.json. firebase-admin
// is imported only on the first verify, so nothing that loads this file pulls the SDK in, and the launcher never
// loads this file (tools/gatecheck.mjs checks its bundle).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {{ uid: string; role: 'maintainer' | 'player'; player: number | null }} VerifiedAccount */
/** @typedef {{ configured: boolean; keyPath?: string; verify(token: string): Promise<VerifiedAccount> }} TokenVerifier
 *  verify rejects on any token it does not accept (bad, expired, revoked, another project's, empty). keyPath, when
 *  there is one, is for the server console only, never for a reply. */

export const KEY_PATH_DEFAULT = path.join(os.homedir(), '.snowboardanywhere', 'firebase-admin-key.json');
const APP_NAME = 'sba-dev-server';

/** @param {Record<string, string | undefined>} [env] @returns {string} */
export function keyPath(env = process.env) {
  const p = env.SBA_FIREBASE_ADMIN_KEY;
  return p && p.trim() !== '' ? p : KEY_PATH_DEFAULT;
}

/** @param {{ uid: string; role?: unknown; player?: unknown }} decoded @returns {VerifiedAccount} */
export function accountFromClaims(decoded) {
  const n = decoded.player;
  return {
    uid: String(decoded.uid),
    role: decoded.role === 'maintainer' ? 'maintainer' : 'player',
    player: typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null,
  };
}

/** The real one: the Admin SDK over the key file. configured is whether the file is there (read on each use, so a
 *  key put in place later works without restarting the server).
 *  @param {string} [file] @returns {TokenVerifier} */
export function firebaseVerifier(file = keyPath()) {
  /** @type {Promise<import('firebase-admin/auth').Auth> | null} */
  let auth = null;
  const start = async () => {
    const { cert, getApps, initializeApp } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const app = getApps().find((a) => a.name === APP_NAME)
      ?? initializeApp({ credential: cert(JSON.parse(fs.readFileSync(file, 'utf8'))) }, APP_NAME);
    return getAuth(app);
  };
  return {
    get configured() { return fs.existsSync(file); },
    keyPath: file,
    async verify(token) {
      if (typeof token !== 'string' || token === '') throw new Error('no token');
      if (!fs.existsSync(file)) throw new Error('accounts are not set up');
      if (!auth) {
        auth = start();
        // a bad key file: say so on the server console (the reply only says the session was not accepted), and
        // try again on the next request, so fixing the file needs no restart
        auth.catch((e) => { auth = null; console.warn(`[accounts] the Firebase Admin key at ${file} did not load: ${e?.message ?? e}`); });
      }
      const decoded = await (await auth).verifyIdToken(token, true);
      return accountFromClaims(decoded);
    },
  };
}

/** For the checks: a fixed table of tokens; any other token is rejected.
 *  @param {Record<string, VerifiedAccount>} tokens @returns {TokenVerifier} */
export function fakeVerifier(tokens) {
  return {
    configured: true,
    async verify(token) {
      if (!Object.hasOwn(tokens, token)) throw new Error('unknown token');
      return { ...tokens[token] };
    },
  };
}

/** @type {TokenVerifier | null} */
let dev = null;
/** The dev server's one verifier (vite.config.ts accountRoutes; FEAT-246's build route uses this same instance).
 *  @returns {TokenVerifier} */
export function devVerifier() {
  return (dev ??= firebaseVerifier());
}
