// FEAT-138 `npm run host [-- --https] [-- --port N]`: build the game and serve it to other computers on the home
// network. Bundled build through `vite preview` (one request per chunk, no HMR, no dev-only endpoints) with the
// packs streamed from ../packs. --https (or HOST_HTTPS=1) adds a self-signed certificate so a gamepad works on
// the other computer: Firefox (and Chrome, as it phases in the restriction) only exposes the Gamepad API in a
// secure context, and http://<LAN IP> is not one.
import { build, preview } from 'vite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GAME, PACKS as packsDir } from './paths.mjs';

const args = process.argv.slice(2);
const https = args.includes('--https') || process.env.HOST_HTTPS === '1';
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.HOST_PORT ?? 5173);
const outDir = 'dist-host'; // not dist/, which the test tools serve
const configFile = path.join(GAME, 'vite.config.ts');

// the hosted build hides dev-only tools and shows "Hosted from <PC>" on the main menu (import.meta.env.VITE_HOST_NAME)
process.env.VITE_HOST_NAME = os.hostname();

console.log(`Building the game into game/${outDir}/ ...`);
await build({ root: GAME, configFile, logLevel: 'warn', build: { outDir, emptyOutDir: true } });

const plugins = [];
if (https) {
  const { default: basicSsl } = await import('@vitejs/plugin-basic-ssl');
  plugins.push(basicSsl({ name: os.hostname() }));
}
const server = await preview({ root: GAME, configFile, plugins, build: { outDir }, preview: { host: true, port, strictPort: true } });

// the pack the link opens: vail if it is built, else the first built one
let built = [];
try { built = JSON.parse(fs.readFileSync(path.join(packsDir, 'index.json'), 'utf8')).packs ?? []; } catch {
  try { built = fs.readdirSync(packsDir).filter((d) => fs.existsSync(path.join(packsDir, d, 'meta.json'))); } catch { /* no packs */ }
}
const pack = built.includes('vail') ? 'vail' : built[0];
const query = pack ? `?pack=${pack}` : '';

const urls = server.resolvedUrls ?? { local: [], network: [] };
console.log(`\nSnowboardAnywhere is hosted from ${os.hostname()}${https ? ' over https' : ''}.`);
if (!pack) console.log('No resort pack found in packs/: build one first (see README > How a resort gets built).');
console.log('On another computer on this network, open:');
for (const u of urls.network) console.log(`  ${u}${query}`);
if (!urls.network.length) console.log('  (no network address found: is this PC connected to the home network?)');
console.log(`On this PC: ${urls.local[0] ?? `http://localhost:${port}/`}${query}`);
console.log('\nIf the other computer cannot connect: allow Node.js on Private networks in Windows Firewall,');
console.log('and make sure this PC\'s network is set to Private (not Public).');
if (https) console.log('The certificate is self-signed: on the other computer click Advanced > Proceed once.');
else console.log('If a controller on the other computer is not seen (Firefox needs https for it): run `npm run host -- --https`.');
console.log('Ctrl+C stops the server.');
