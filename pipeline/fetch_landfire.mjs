#!/usr/bin/env node
// Downloads a LANDFIRE clip for a resort via the LANDFIRE Product Service (LFPS) v2 REST API (the old
// ArcGIS GPServer submitJob endpoint now returns the web page). Products: EVT (existing vegetation type,
// species and forest extent), EVC (existing vegetation cover, canopy fraction) and EVH (existing vegetation
// height), DATA-010.
//   GET /api/job/submit?Email&Layer_List&Area_of_Interest[&Output_Projection&Resample_Resolution] -> { jobId, status }
//   GET /api/job/status?JobId=...  -> { jobId, status, queuePosition, messages, outputFile }  (poll until Succeeded)
//   download outputFile (zip: .tif, .tfw, .tif.aux.xml, .tif.vat.dbf, metadata xml), unzip next to it
// Source: LFPS user guide https://lfps.usgs.gov/LFProductsServiceUserGuide.pdf and the rlandfire
// client (R/checkStatus.R reads resp$outputFile). Runs on Drew's PC (Node 18+, no installs).
//
// Usage: node pipeline/fetch_landfire.mjs <slug> <email> [EVT|EVC|EVH|<layer>] [--raw <raw_root>] [--force]
// A product (EVT, the default, EVC or EVH) tries the newest year first and falls back; a full layer name
// ("LF2024_EVC") asks for that one. --raw is the folder holding <slug>/ (default: raw/ in the repo).
// Output: EVT into <raw_root>/<slug>/landfire/, EVC and EVH into landfire/evc/ and landfire/evh/ (build_pack.py
// reads the EVT GeoTIFF from landfire/*.tif, so the other products keep out of that folder). A product whose
// folder already holds a .tif is skipped unless --force is given.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const fi = argv.indexOf('--force');
const force = fi >= 0;
if (force) argv.splice(fi, 1);
const ri = argv.indexOf('--raw');
const rawArg = ri >= 0 ? argv[ri + 1] : undefined;
const rawRoot = rawArg ? path.resolve(rawArg) : null;
if (ri >= 0) argv.splice(ri, 2);
const [slug, email, layerArg = 'EVT'] = argv;
if (!slug || !email || (ri >= 0 && !rawArg)) {
  console.error('Usage: node pipeline/fetch_landfire.mjs <slug> <email> [EVT|EVC|EVH|<layer, e.g. LF2023_EVC>] [--raw <raw_root>] [--force]');
  process.exit(1);
}
const root = path.resolve(import.meta.dirname, '..');
const cfg = JSON.parse(await readFile(path.join(root, 'pipeline', 'resorts', `${slug}.json`), 'utf8'));
const [w, s, e, n] = cfg.lonlat_bbox; // lon0, lat0, lon1, lat1
const pad = 0.02;
const aoi = `${(w - pad).toFixed(5)} ${(s - pad).toFixed(5)} ${(e + pad).toFixed(5)} ${(n + pad).toFixed(5)}`; // W S E N, WGS84
const epsg = Number(cfg.crs.split(':')[1]);
const API = 'https://lfps.usgs.gov/api/job';
const isProduct = /^(EVT|EVC|EVH)$/i.test(layerArg);
const product = (isProduct ? layerArg : layerArg.split('_').pop()).toUpperCase();
const layers = isProduct ? ['LF2024', 'LF2023', 'LF2022'].map((y) => `${y}_${product}`) : [layerArg];
const out = path.join(rawRoot ?? path.join(root, 'raw'), slug, 'landfire', ...(product === 'EVT' ? [] : [product.toLowerCase()]));
await mkdir(out, { recursive: true });
const have = (await readdir(out)).filter((f) => f.toLowerCase().endsWith('.tif'));
if (have.length && !force) {
  console.log(`${product}: ${path.join(out, have[0])} is already there; skipping (--force fetches it again)`);
  process.exit(0);
}

/** fetch JSON, with a readable error when the server returns HTML or an error body */
async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'SnowboardAnywhere-pipeline (personal project)' } });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch {
    throw new Error(`HTTP ${r.status}: expected JSON, got: ${text.slice(0, 200).replace(/\s+/g, ' ')}...\n  (LFPS may be down for maintenance: last Wednesday of the month, 8 am to noon Central)`);
  }
  return { ok: r.ok, status: r.status, body };
}

let job = null, layer = '';
for (const L of layers) {
  const u = new URL(`${API}/submit`);
  u.searchParams.set('Email', email);
  u.searchParams.set('Layer_List', L);
  u.searchParams.set('Area_of_Interest', aoi);
  u.searchParams.set('Output_Projection', String(epsg));
  console.log(`Submitting ${L} for AOI [${aoi}] in EPSG:${epsg} ...`);
  const r = await getJson(u);
  if (r.ok && r.body.jobId) { job = r.body.jobId; layer = L; break; }
  console.log(`  rejected (HTTP ${r.status}): ${r.body.message ?? JSON.stringify(r.body)}`);
}
if (!job) { console.error('No layer was accepted. Check the layer names at https://lfps.usgs.gov/products and pass one as the third argument.'); process.exit(2); }
console.log('jobId', job);

const t0 = Date.now();
let st;
for (;;) {
  await new Promise((r) => setTimeout(r, 10000));
  const r = await getJson(`${API}/status?JobId=${encodeURIComponent(job)}`);
  st = r.body;
  const q = st.queuePosition >= 0 ? ` (queue position ${st.queuePosition})` : '';
  console.log(new Date().toLocaleTimeString(), st.status + q);
  if (/Succeeded|Failed|Canceled/.test(st.status)) break;
  if (Date.now() - t0 > 45 * 60 * 1000) { console.error('Gave up after 45 minutes. Job', job, 'may still finish: check https://lfps.usgs.gov/'); process.exit(3); }
}
if (!/Succeeded/.test(st.status)) {
  console.error('Job ended:', st.status);
  for (const m of st.messages ?? []) console.error(' ', typeof m === 'string' ? m : (m.description ?? JSON.stringify(m)));
  process.exit(3);
}
const zipUrl = st.outputFile;
if (!zipUrl) { console.error('No outputFile in the status response:', JSON.stringify(st, null, 2)); process.exit(4); }
console.log('downloading', zipUrl);
const res = await fetch(zipUrl);
if (!res.ok) { console.error('download failed: HTTP', res.status, '(links expire after 6 hours)'); process.exit(4); }
const buf = Buffer.from(await res.arrayBuffer());
const zipPath = path.join(out, `${layer}.zip`);
await writeFile(zipPath, buf);
console.log(`saved ${zipPath} (${(buf.length / 1e6).toFixed(1)} MB)`);
// unzip in place: tar.exe ships with Windows 10+ and reads zip files
try {
  // Windows' own bsdtar by full path: a GNU tar earlier on PATH (Git Bash) reads "C:" as a remote host
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', zipPath, '-C', out], { stdio: 'inherit' });
  console.log('unzipped into', out);
} catch {
  console.log('Could not unzip automatically; right-click the zip > Extract All.');
}
console.log(`The GeoTIFF is the ${product} raster (${layer}) in EPSG:${epsg} at 30 m.`);
