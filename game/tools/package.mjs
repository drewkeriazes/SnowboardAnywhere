// FEAT-261 `npm run package -- --version X.Y.Z`: the Windows zip a rider unzips and double-clicks. Builds the game
// (vite build, with the version and the hosted flag that hides the dev-only tools), bundles tools/launcher.mjs into
// one CommonJS file (esbuild) and makes it a Node single executable application (SEA: `node --experimental-sea-config`,
// then postject into a copy of this node.exe), and zips it all into game/release/SnowboardAnywhere-win.zip:
//   SnowboardAnywhere.exe   the launcher (tools/launcher.mjs)
//   game/                   the built game (dist/)
//   packs/                  empty: the first launch downloads Vail into it, Change resort > Download the rest
//   README.txt              how to start it, and the SmartScreen note
// Windows only (the exe is this node.exe). The version is stamped into the exe (SBA_LAUNCHER.version) and the game
// (import.meta.env.VITE_GAME_VERSION, shown on the main menu); without --version both say "dev".
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PACK_FORMAT } from './get_pack.mjs';
import { GAME } from './paths.mjs';

const args = process.argv.slice(2);
const vi = args.indexOf('--version');
const version = vi >= 0 ? args[vi + 1] : 'dev';
if (!/^\d+\.\d+\.\d+$/.test(version) && version !== 'dev') { console.error(`package: --version wants X.Y.Z, not ${version}`); process.exit(2); }
if (process.platform !== 'win32') { console.error('package: the launcher is Windows only for now (the exe is this node.exe)'); process.exit(2); }
if (vi < 0) console.warn('package: no --version, so the exe and the game say "dev"');

const RELEASE = path.join(GAME, 'release');
const WORK = path.join(RELEASE, 'build'); // the bundle, the SEA blob
const STAGE = path.join(RELEASE, 'SnowboardAnywhere-win'); // what the zip holds, as it unzips
const ZIP = path.join(RELEASE, 'SnowboardAnywhere-win.zip');
const EXE = path.join(STAGE, 'SnowboardAnywhere.exe');
const t0 = Date.now();
const mb = (b) => `${(b / 1e6).toFixed(0)} MB`;

for (const p of [WORK, STAGE, ZIP]) fs.rmSync(p, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(path.join(STAGE, 'packs'), { recursive: true });

// 1. the game: the hosted build (no dev-only tools, as `npm run host`) with the version on the main menu
console.log(`Building the game ${version} into release/SnowboardAnywhere-win/game/ ...`);
process.env.VITE_HOSTED = '1';
process.env.VITE_GAME_VERSION = version;
const { build } = await import('vite');
await build({ root: GAME, configFile: path.join(GAME, 'vite.config.ts'), logLevel: 'warn', build: { outDir: path.join(STAGE, 'game'), emptyOutDir: true } });

// 2. the launcher as one CommonJS file (a SEA's main script is CommonJS and can require only Node's own modules)
console.log('Bundling the launcher ...');
const esbuild = await import('esbuild');
const bundle = path.join(WORK, 'launcher.cjs');
await esbuild.build({
  entryPoints: [path.join(GAME, 'tools', 'launcher.mjs')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  // paths.mjs and get_pack.mjs read this instead of the repo's folders and src/pack/format.ts
  define: { SBA_LAUNCHER: JSON.stringify({ version, packFormat: PACK_FORMAT }) },
  logOverride: { 'empty-import-meta': 'silent' }, // import.meta.url is only read outside the launcher
  logLevel: 'warning',
});

// 3. the exe: the SEA blob injected into a copy of this node.exe, its Node.js signature removed first (the injection
// breaks it anyway, and a broken signature looks worse to antivirus than none)
console.log(`Making SnowboardAnywhere.exe with Node ${process.version} ...`);
const blob = path.join(WORK, 'sea-prep.blob');
const seaConfig = path.join(WORK, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: true }, null, 1));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit', cwd: WORK });
fs.copyFileSync(process.execPath, EXE);
unsign(EXE);
const { inject } = await import('postject');
await inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
const said = execFileSync(EXE, ['--version'], { encoding: 'utf8' }).trim();
if (said !== version) throw new Error(`the exe says ${said}, not ${version}`);

// 4. README.txt (Notepad line ends)
fs.writeFileSync(path.join(STAGE, 'README.txt'), [
  `SnowboardAnywhere ${version}`,
  '',
  '1. Double-click SnowboardAnywhere.exe. The first time, a small window downloads Vail (about 270 MB, a few minutes); later it starts straight away.',
  '2. The game opens in your browser on the main menu: Ride. More resorts: Change resort > Download (kept in the packs folder).',
  '3. Close the small window to quit.',
  '',
  'Windows may say "Windows protected your PC" the first time: the exe is not code-signed (that costs money).',
  'Click More info, then Run anyway.',
  '',
].join('\r\n'));

// 5. the zip
console.log('Zipping ...');
const n = zipDir(STAGE, ZIP);
console.log(`\n${path.relative(process.cwd(), ZIP)}: ${n} files, ${mb(fs.statSync(ZIP).size)} (the exe ${mb(fs.statSync(EXE).size)}), in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

/** Drop a PE file's Authenticode signature: zero the certificate table entry and cut the table off the end. */
function unsign(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    const head = Buffer.alloc(4096);
    fs.readSync(fd, head, 0, head.length, 0);
    const pe = head.readUInt32LE(0x3c);
    if (head.readUInt32LE(pe) !== 0x4550) throw new Error(`${file} is not a PE file`);
    const opt = pe + 24;
    const dir = opt + (head.readUInt16LE(opt) === 0x20b ? 112 : 96) + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY
    const at = head.readUInt32LE(dir), size = head.readUInt32LE(dir + 4);
    if (!at || !size) return;
    if (at + size !== fs.fstatSync(fd).size) throw new Error(`${file}: the signature is not at the end of the file`);
    fs.writeSync(fd, Buffer.alloc(8), 0, 8, dir);
    fs.ftruncateSync(fd, at);
  } finally { fs.closeSync(fd); }
}

/** Zip a folder's contents (deflate where it helps, stored otherwise; no zip64, so under 4 GB). Returns the file count. */
function zipDir(root, out) {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const fd = fs.openSync(out, 'w');
  const central = [];
  let offset = 0, files = 0;
  const write = (b) => { fs.writeSync(fd, b); offset += b.length; };
  const add = (name, data) => {
    const isDir = data === null;
    const raw = data ?? Buffer.alloc(0);
    const crc = isDir ? 0 : zlib.crc32(raw);
    const packed = isDir ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const deflate = !isDir && packed.length < raw.length;
    const body = deflate ? packed : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(deflate ? 8 : 0, 10); cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(isDir ? 0x10 : 0, 38); cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    write(local); write(nameBuf); write(body);
    if (offset > 0xffffffff) throw new Error('the zip is over 4 GB (no zip64)');
    if (!isDir) files++;
  };
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { add(`${r}/`, null); walk(path.join(dir, e.name), r); } else add(r, fs.readFileSync(path.join(dir, e.name)));
    }
  };
  try {
    walk(root, '');
    const cdStart = offset;
    for (const c of central) write(c);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
    write(end);
  } finally { fs.closeSync(fd); }
  return files;
}
