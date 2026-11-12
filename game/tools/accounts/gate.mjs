// FEAT-273: the dev server's account gate. A route that needs to know who is asking (FEAT-246's Build it) wraps its
// handler in requireAccount(devVerifier(), handler, { role: 'maintainer' }). The checks, in this order, each one
// ending the request:
//   a foreign Origin                 403 (BUG-110's refuseForeignOrigin reply)
//   no Authorization: Bearer token   401 {"error":"sign in first"}
//   the server has no Admin key      503 {"error":"accounts are not set up on this dev server"}
//   the token is not accepted        401 {"error":"sign in again: the session was not accepted"}
//   opts.role set and not matched    403 {"error":"only a maintainer can do this"}
// then handler(req, res, account). A missing player number is never a refusal. Every reply is no-store. Dev server
// only (vite.config.ts configureServer): `npm run host` and the launcher have no account routes.
import { refuseForeignOrigin } from '../same_origin.mjs';

/** @typedef {import('./verifier.mjs').VerifiedAccount} VerifiedAccount */
/** @typedef {import('./verifier.mjs').TokenVerifier} TokenVerifier */
/** @typedef {import('node:http').IncomingMessage} Req */
/** @typedef {import('node:http').ServerResponse} Res */

/** @param {Res} res @param {number} status @param {unknown} body */
function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** The token from `Authorization: Bearer <token>` (the scheme in any case), null when there is none.
 *  @param {{ headers: Record<string, string | string[] | undefined> }} req @returns {string | null} */
export function bearerToken(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(h);
  return m ? m[1] : null;
}

/** @type {WeakSet<object>} the verifiers whose missing key has been logged */
const told = new WeakSet();

/**
 * @param {TokenVerifier} verifier
 * @param {(req: Req, res: Res, account: VerifiedAccount) => void | Promise<void>} handler
 * @param {{ role?: 'maintainer' }} [opts]
 * @returns {(req: Req, res: Res, next: (err?: unknown) => void) => void}
 */
export function requireAccount(verifier, handler, opts = {}) {
  return (req, res) => {
    res.setHeader('cache-control', 'no-store'); // the Origin refusal too
    if (refuseForeignOrigin(req, res)) return;
    const token = bearerToken(req);
    if (token === null) return reply(res, 401, { error: 'sign in first' });
    if (!verifier.configured) {
      if (!told.has(verifier)) {
        told.add(verifier);
        // the server console only: the path never goes in a reply
        console.warn(`[accounts] no Firebase Admin key${verifier.keyPath ? ` at ${verifier.keyPath}` : ''}: account routes answer 503 (set SBA_FIREBASE_ADMIN_KEY, or put the key there)`);
      }
      return reply(res, 503, { error: 'accounts are not set up on this dev server' });
    }
    verifier.verify(token).then(
      (account) => {
        if (opts.role && account.role !== opts.role) return reply(res, 403, { error: 'only a maintainer can do this' });
        // a handler that throws, or (FEAT-246's, async) rejects, answers 500 instead of leaving the request open
        Promise.resolve().then(() => handler(req, res, account)).catch((e) => {
          console.warn(`[accounts] ${req.url}: ${e?.message ?? e}`);
          if (!res.headersSent) reply(res, 500, { error: 'the server failed on this request' });
        });
      },
      () => reply(res, 401, { error: 'sign in again: the session was not accepted' }),
    );
  };
}

/** GET /api/account: who the server says this token is, { uid, role, player }. Anything else goes on to next().
 *  @param {TokenVerifier} verifier @returns {(req: Req, res: Res, next: (err?: unknown) => void) => void} */
export function accountRoute(verifier) {
  const gated = requireAccount(verifier, (req, res, account) => reply(res, 200, { uid: account.uid, role: account.role, player: account.player }));
  return (req, res, next) => {
    if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/api/account') return next();
    gated(req, res, next);
  };
}
