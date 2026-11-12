// FEAT-273: set an account's role and player number (the only way to set either, for now). Sets the custom claims
// (role 'maintainer', player <n>) through the Admin SDK and the players/<uid> record, and revokes the account's
// refresh tokens on a demotion so the old role stops working at once. The service-account key stays outside every
// checkout: SBA_FIREBASE_ADMIN_KEY (set in game/.env.local, which this loads), else %USERPROFILE%\.snowboardanywhere\firebase-admin-key.json.
// The database is the Realtime Database: SBA_FIREBASE_DATABASE_URL, else https://<project_id>-default-rtdb.firebaseio.com.
//   node tools/set_role.mjs (--uid <uid> | --email <email>) [--role maintainer|player] [--player <n>] [--name <display name>]
//   node tools/set_role.mjs --check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyPath } from './accounts/verifier.mjs';
import { GAME } from './paths.mjs';

const USAGE = 'usage: node tools/set_role.mjs (--uid <uid> | --email <email>) [--role maintainer|player] [--player <n>] [--name <display name>]\n       node tools/set_role.mjs --check';

/** @param {string[]} argv @returns {{ uid?: string; email?: string; role?: 'maintainer' | 'player'; player?: number; name?: string; check?: boolean } | { error: string }} */
export function parseRoleArgs(argv) {
  /** @type {{ uid?: string; email?: string; role?: 'maintainer' | 'player'; player?: number; name?: string; check?: boolean }} */
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--check') { a.check = true; continue; }
    if (!['--uid', '--email', '--role', '--player', '--name'].includes(flag)) return { error: `unknown argument ${flag}` };
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) return { error: `${flag} needs a value` };
    if (flag === '--uid') a.uid = v;
    else if (flag === '--email') a.email = v;
    else if (flag === '--name') a.name = v;
    else if (flag === '--role') {
      if (v !== 'maintainer' && v !== 'player') return { error: `--role is maintainer or player, not ${v}` };
      a.role = v;
    } else {
      if (!/^\d+$/.test(v)) return { error: `--player is an integer 0 or more, not ${v}` };
      a.player = Number(v);
    }
  }
  if (a.check) return a;
  if (!a.uid && !a.email) return { error: 'give --uid or --email' };
  return a;
}

/** The new claims: other claims kept, role 'maintainer' set or (for 'player') removed, the number set when given.
 *  @param {Record<string, unknown>} existing @param {{ role?: 'maintainer' | 'player'; player?: number }} a */
export function claimsFor(existing, a) {
  const next = { ...existing };
  if (a.role === 'maintainer') next.role = 'maintainer';
  else if (a.role === 'player') delete next.role;
  if (a.player !== undefined) next.player = a.player;
  return next;
}

/** A demotion: the account was a maintainer and no longer is.
 *  @param {Record<string, unknown>} existing @param {Record<string, unknown>} next */
export function needsRevoke(existing, next) {
  return existing.role === 'maintainer' && next.role !== 'maintainer';
}

/** The database URL: SBA_FIREBASE_DATABASE_URL, else the default one for the key's project.
 *  @param {string} projectId @param {Record<string, string | undefined>} [env] */
export function databaseUrl(projectId, env = process.env) {
  const u = env.SBA_FIREBASE_DATABASE_URL;
  return u && u.trim() !== '' ? u.trim() : `https://${projectId}-default-rtdb.firebaseio.com`;
}

/** The admin calls of an update, in their order: claims, then (on a demotion) the revoke, then the database. The revoke
 *  comes before the database write so a failed write never leaves the claim changed with the old token still valid.
 *  @param {{ setCustomUserClaims(uid: string, c: object): Promise<void>; revokeRefreshTokens(uid: string): Promise<void> }} auth
 *  @param {{ update(path: string, v: object): Promise<void> }} db */
export async function applyRole(auth, db, uid, existing, next, record) {
  await auth.setCustomUserClaims(uid, next);
  if (needsRevoke(existing, next)) await auth.revokeRefreshTokens(uid);
  await db.update(`players/${uid}`, record);
}

/** @param {NonNullable<ReturnType<typeof parseRoleArgs>>} args @returns {Promise<number>} the exit code */
async function run(args) {
  const envFile = path.join(GAME, '.env.local');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile); // the key path lives there; a variable already set wins
  const file = keyPath();
  if (!fs.existsSync(file)) {
    console.error(`No Firebase Admin key at ${file}. Put the service-account key there, or set SBA_FIREBASE_ADMIN_KEY to its path.`);
    return 2;
  }
  const { cert, initializeApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { getDatabase } = await import('firebase-admin/database');
  let key;
  try { key = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.error(`Could not parse the key file at ${file}`); return 2; }
  const app = initializeApp({ credential: cert(key), databaseURL: databaseUrl(key.project_id) }, 'sba-set-role');
  const auth = getAuth(app);

  if (args.check) {
    console.log(`key ok: project ${key.project_id}`);
    let token;
    do {
      const page = await auth.listUsers(1000, token);
      for (const u of page.users) {
        const c = u.customClaims ?? {};
        if (c.role) console.log(`${u.uid} ${u.email ?? '(no email)'}: role ${c.role}, player ${c.player ?? 'none'}`);
      }
      token = page.pageToken;
    } while (token);
    return 0;
  }

  const user = args.uid ? await auth.getUser(args.uid) : await auth.getUserByEmail(args.email);
  const db = getDatabase(app);
  if (args.player !== undefined) {
    const taken = await db.ref('players').orderByChild('player').equalTo(args.player).get();
    let other = null;
    taken.forEach((c) => { if (c.key !== user.uid) other = c.key; });
    if (other) {
      console.error(`Player ${args.player} already belongs to uid ${other}. To move a number, rerun this script for that uid with another number first.`);
      return 1;
    }
  }
  const existing = user.customClaims ?? {};
  const next = claimsFor(existing, args);
  const role = next.role === 'maintainer' ? 'maintainer' : 'player';
  const player = typeof next.player === 'number' ? next.player : null;
  await applyRole(auth, { update: (p, v) => db.ref(p).update(v) }, user.uid, existing, next, {
    player,
    displayName: args.name ?? user.displayName ?? null,
    role,
    updatedAt: Date.now(),
  });
  console.log(`uid ${user.uid}: role ${role}, player ${player ?? 'none'}. Sign out and back in to pick it up.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseRoleArgs(process.argv.slice(2));
  if ('error' in args) { console.error(`${args.error}\n${USAGE}`); process.exit(2); }
  run(args).then((code) => process.exit(code), (e) => { console.error(e?.message ?? e); process.exit(1); });
}
