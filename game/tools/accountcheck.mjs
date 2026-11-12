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

fs.rmSync(dir, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
