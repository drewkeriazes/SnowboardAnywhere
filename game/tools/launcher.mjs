// FEAT-261 the Windows launcher, SnowboardAnywhere.exe: serves the prebuilt game and the pack routes, then opens the
// browser on the main menu. tools/package.mjs bundles this file (esbuild, CommonJS) into a Node single executable
// application next to the built game (game/) and an empty packs/, where Change resort > Download puts resorts.
// No Vite here: the game is already built. The pack routes are tools/pack_routes.mjs, the same handlers the dev
// server and `npm run host` mount, and the folders come from tools/paths.mjs (next to the exe when bundled).
//
//   SnowboardAnywhere.exe [--lan] [--port N] [--no-open] [--version]
//   node tools/launcher.mjs [...]   the same from the repo: serves game/dist (npx vite build first) and ../packs
//
// It listens on loopback only (127.0.0.1 and ::1, so no Windows Firewall prompt) on port 5173, the dev server's, so
// settings and best times kept by a browser on http://localhost:5173 carry over; a busy port moves to the next free
// one. --lan listens on every interface instead, to play from another computer on the home network.
// The first launch, with no resort in packs/ (the zip ships it empty), downloads Vail in the console before it opens
// the browser: the game can't reach its main menu without a pack (Game.ts falls back to the synthetic one). Later
// launches start straight away; more resorts come from Change resort.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DIST, LAUNCHER, PACKS } from './paths.mjs';
import { getPack, localPacks, PACK_FORMAT } from './get_pack.mjs';
import { packDownloads, packFiles } from './pack_routes.mjs';

/* global SBA_LAUNCHER */
export const VERSION = LAUNCHER ? SBA_LAUNCHER.version : 'dev';
const PORT = 5173;
const TRIES = 20;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
};

/** The built game from dir: / is index.html, only files inside dir, one byte range for the music's <audio>. */
function gameFiles(dir) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0]); } catch { res.statusCode = 400; res.end(); return; }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end(); return; }
    const size = fs.statSync(file).size;
    res.setHeader('content-type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('accept-ranges', 'bytes');
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0, end = size - 1;
    if (m && (m[1] || m[2])) {
      start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) { res.statusCode = 416; res.setHeader('content-range', `bytes */${size}`); res.end(); return; }
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('content-length', end - start + 1);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).pipe(res);
  };
}

/**
 * The browser's Host must be an IP address or localhost (Vite's default allowedHosts): a page on another site that
 * points its own name at 127.0.0.1 (DNS rebinding) would otherwise be same-origin with this server and could start
 * downloads. The /__packs/get Origin check in pack_routes.mjs then compares against that Host.
 */
function hostAllowed(host) {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '');
  return net.isIP(name) !== 0 || name === 'localhost' || name.endsWith('.localhost');
}

function handler(dir) {
  const chain = [packFiles(PACKS), packDownloads(PACKS)];
  const files = gameFiles(dir);
  return (req, res) => {
    if (!hostAllowed(req.headers.host)) { res.statusCode = 403; res.end('This address is not allowed: open http://localhost instead.'); return; }
    if (req.url === '/__launcher') { // a second launch finds the first one here
      res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({ app: 'SnowboardAnywhere', version: VERSION })); return;
    }
    let i = 0;
    const next = () => { const h = chain[i++]; if (h) h(req, res, next); else files(req, res); };
    next();
  };
}

/** Listen on host:port; resolves the server, or null when the port is taken there. */
function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(app);
    s.once('error', (e) => {
      if (e.code === 'EADDRINUSE' || e.code === 'EACCES') resolve(null); // EACCES: a Windows reserved port range
      else if (host === '::1' && (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT')) resolve('no-ipv6');
      else reject(e);
    });
    s.listen(port, host, () => resolve(s));
  });
}

/** Is a launcher already serving this port? (its /__launcher answers) */
async function launcherAt(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__launcher`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j?.app === 'SnowboardAnywhere' ? j : null;
  } catch { return null; }
}

/** Does something already answer on localhost:port? (true on a connection either way, IPv4 or IPv6) */
function answers(port) {
  const one = (host) => new Promise((resolve) => {
    const c = net.connect({ port, host, timeout: 500 });
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('timeout', () => { c.destroy(); resolve(false); });
    c.once('error', () => resolve(false));
  });
  return Promise.all([one('127.0.0.1'), one('::1')]).then(([a, b]) => a || b);
}

/**
 * The first port from `first` this can have: loopback both ways (so localhost can't reach another server on ::1),
 * or every interface with --lan. Windows lets a loopback listen succeed on a port another server holds on every
 * interface (`npm run dev` does), and would then take localhost from it, so a port that answers counts as busy.
 */
async function bind(app, first, lan) {
  for (let port = first; port < first + TRIES; port++) {
    if (await answers(port)) continue;
    if (lan) {
      const s = await listen(app, port, undefined);
      if (s) return { port, servers: [s] };
      continue;
    }
    const v4 = await listen(app, port, '127.0.0.1');
    if (!v4) continue;
    const v6 = await listen(app, port, '::1');
    if (v6 === null) { v4.close(); continue; }
    return { port, servers: v6 === 'no-ipv6' ? [v4] : [v4, v6] };
  }
  throw new Error(`ports ${first} to ${first + TRIES - 1} are all in use: close something, or start with --port <number>`);
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* the address is printed */ }
}

function lanUrls(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}/`);
  }
  return out;
}

const FIRST = { slug: 'vail', name: 'Vail' };

/**
 * No resort in packs/ at this game's pack format (the synthetic test pack doesn't count): download Vail through
 * get_pack.mjs, one updating line of progress. getPack builds it as packs/.vail.* and renames it in only when it is whole, so a window closed
 * mid-download leaves nothing localPacks counts, and the next launch starts again. Returns an error message or null.
 */
async function firstResort() {
  // BUG-106: only a pack at this game's format counts. An older Vail from the catalog (it has a release `version`)
  // is downloaded again, which replaces it; one built on this PC or copied in with --from (no version) is left alone,
  // since getPack replaces it only with --force.
  const local = localPacks(PACKS);
  if (Object.entries(local).some(([slug, p]) => slug !== 'synth' && p.formatVersion === PACK_FORMAT)) return null;
  const old = local[FIRST.slug];
  if (old && !old.version) return null;
  if (old) console.log(`\n${FIRST.name} in packs is not the pack format this game reads: downloading the current one (about 270 MB, a few minutes).\n`);
  else {
    console.log(`\nFirst launch: downloading ${FIRST.name} (about 270 MB, a few minutes). Later launches start straight away;`);
    console.log('more resorts come from Change resort on the main menu.\n');
  }
  const mb = (b) => `${Math.round(b / 1e6)} MB`;
  let shown = '';
  try {
    await getPack(FIRST.slug, {
      packsDir: PACKS, onProgress: ({ phase, received, total }) => {
        const line = phase === 'unzip' ? `  Unpacking ${FIRST.name}...` : phase === 'done' ? `  ${FIRST.name} is ready.`
          : total ? `  Downloading ${FIRST.name}: ${mb(received)} of ${mb(total)} (${Math.floor((received / total) * 100)}%)` : `  Downloading ${FIRST.name}...`;
        if (line !== shown) { process.stdout.write(`\r${line.padEnd(shown.length)}`); shown = line; }
      },
    });
    process.stdout.write('\n');
    return null;
  } catch (e) {
    if (shown) process.stdout.write('\n');
    const offline = e?.message === 'fetch failed' || e?.cause?.code; // fetch says only "fetch failed"; the cause has why
    const why = offline ? `no connection to the download server (${e.cause?.code ?? e.cause?.message ?? 'offline?'})`
      : String(e?.message ?? e).replace(/: update the game \(git pull\)$/, ''); // get_pack's hint is for a checkout
    const releases = 'https://github.com/drewkeriazes/SnowboardAnywhere/releases';
    const tip = offline ? 'Check the internet connection, then open SnowboardAnywhere.exe again (the download starts over).'
      : /newer than this game/.test(why) ? `This SnowboardAnywhere is older than the published resorts: get the newest SnowboardAnywhere-win.zip from ${releases}`
      : `Open SnowboardAnywhere.exe again later (the download starts over). If it keeps failing, get the newest zip from ${releases}`;
    return `${FIRST.name} could not be downloaded: ${why}.\n${tip}`;
  }
}

/** The exe's console closes the moment the process ends: keep it open so the rider can read why. */
function stop(message) {
  console.error(`\n${message}`);
  if (!LAUNCHER || !process.stdin.isTTY) process.exit(1);
  console.error('\nPress Enter to close this window.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}

async function main(args) {
  const flag = (f) => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1]; };
  if (args.includes('--version')) { console.log(VERSION); return; }
  if (args.includes('--help')) { console.log('SnowboardAnywhere.exe [--lan] [--port N] [--no-open] [--version]'); return; }
  const lan = args.includes('--lan');
  const asked = flag('--port') !== undefined ? Number(flag('--port')) : PORT;
  if (!Number.isInteger(asked) || asked < 1 || asked > 65535) return stop(`--port ${flag('--port')} is not a port number`);
  if (LAUNCHER) process.title = `SnowboardAnywhere ${VERSION}`;

  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    return stop(LAUNCHER
      ? `The game folder is missing: ${DIST}\nUnzip all of SnowboardAnywhere-win.zip first (right-click it > Extract All),\nthen run SnowboardAnywhere.exe from the unzipped folder.`
      : `No built game in ${DIST}: run \`npx vite build\` in game/ first.`);
  }
  fs.mkdirSync(PACKS, { recursive: true });

  // a second double-click while one is running: open the browser on that one instead of starting another
  if (!lan && !args.includes('--port')) {
    const other = await launcherAt(asked);
    if (other) {
      const url = `http://localhost:${asked}/`;
      console.log(`SnowboardAnywhere ${other.version} is already running at ${url}: opening it.`);
      if (!args.includes('--no-open')) openBrowser(url);
      setTimeout(() => process.exit(0), LAUNCHER ? 3000 : 0);
      return;
    }
  }

  const { port } = await bind(handler(DIST), asked, lan);
  const url = `http://localhost:${port}/`;
  console.log(`SnowboardAnywhere ${VERSION} is running.\n`);
  console.log(`  Game:    ${url}`);
  console.log(`  Resorts: ${PACKS}`);
  const failed = await firstResort(); // before the browser: the game needs a resort to show its menu
  if (failed) return stop(failed);
  if (port !== asked) {
    console.log(`\nPort ${asked} was busy, so this is port ${port}. Settings and best times are kept per address,`);
    console.log(`so the ones saved on port ${asked} don't show here. Close whatever uses port ${asked} and start again to get them back.`);
  }
  if (lan) {
    console.log('\nOn another computer on this network, open:');
    for (const u of lanUrls(port)) console.log(`  ${u}`);
    console.log('If it cannot connect: allow SnowboardAnywhere on Private networks in Windows Firewall, and set this PC\'s network to Private.');
  }
  console.log('\nThe game opens in your browser (if it does not, paste the address above into Chrome or Edge).');
  console.log('More resorts: Change resort on the main menu. Close this window to quit.');
  if (!args.includes('--no-open')) openBrowser(url);
  // FEAT-263: the update check goes here (read the latest release, compare its tag with VERSION, offer the zip).
}

process.on('uncaughtException', (e) => stop(`SnowboardAnywhere stopped: ${e?.stack ?? e}`));
// a SEA has the exe as argv[0] and argv[1], as node and a script do
main(process.argv.slice(2)).catch((e) => stop(`SnowboardAnywhere could not start: ${e?.message ?? e}`));
