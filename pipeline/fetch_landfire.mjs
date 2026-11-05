#!/usr/bin/env node
// Downloads a LANDFIRE Existing Vegetation Type (EVT) clip for a resort via the
// LANDFIRE Product Service (LFPS), an ArcGIS GeoProcessing job service.
//   submit -> poll jobs/<id> until esriJobSucceeded -> fetch results/Output_File -> download zip
// Runs on Drew's PC (Node 18+, no installs). Output: raw/<slug>/landfire/<layer>.zip (+ unzipped tif).
//
// Usage: node pipeline/fetch_landfire.mjs vail you@example.com [240EVT]
// LFPS requires an email address for usage statistics. Layer names: 240EVT = LF 2023 EVT (LF 2.4.0),
// 250EVT = LF 2024 if published. Check https://lfps.usgs.gov/ "LFPS Layers" if a name is rejected.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [slug, email, layer = '240EVT'] = process.argv.slice(2);
if (!slug || !email) {
  console.error('Usage: node pipeline/fetch_landfire.mjs <slug> <email> [layer]');
  process.exit(1);
}
const root = path.resolve(import.meta.dirname, '..');
const cfg = JSON.parse(await readFile(path.join(root, 'pipeline', 'resorts', `${slug}.json`), 'utf8'));
const [w, s, e, n] = cfg.lonlat_bbox; // lon0, lat0, lon1, lat1
const pad = 0.02;
const aoi = `${(w - pad).toFixed(5)} ${(s - pad).toFixed(5)} ${(e + pad).toFixed(5)} ${(n + pad).toFixed(5)}`; // W S E N, WGS84
const epsg = Number(cfg.crs.split(':')[1]);

const GP = 'https://lfps.usgs.gov/arcgis/rest/services/LandfireProductService/GPServer/LandfireProductService';
const out = path.join(root, 'raw', slug, 'landfire');
await mkdir(out, { recursive: true });

const submitUrl = new URL(GP + '/submitJob');
submitUrl.searchParams.set('Layer_List', layer);
submitUrl.searchParams.set('Area_Of_Interest', aoi);
submitUrl.searchParams.set('Output_Projection', String(epsg));
submitUrl.searchParams.set('Resample_Resolution', '30');
submitUrl.searchParams.set('Email', email);
submitUrl.searchParams.set('f', 'json');

console.log(`Submitting ${layer} for AOI [${aoi}] in EPSG:${epsg} ...`);
const sub = await (await fetch(submitUrl)).json();
if (!sub.jobId) { console.error('submit failed:', JSON.stringify(sub, null, 2)); process.exit(2); }
console.log('jobId', sub.jobId);

let status = sub.jobStatus;
while (status !== 'esriJobSucceeded') {
  if (/Failed|Cancelled|TimedOut/.test(status)) {
    const j = await (await fetch(`${GP}/jobs/${sub.jobId}?f=json`)).json();
    console.error('job ended:', status, JSON.stringify(j.messages ?? j, null, 2)); process.exit(3);
  }
  await new Promise((r) => setTimeout(r, 15000));
  const j = await (await fetch(`${GP}/jobs/${sub.jobId}?f=json`)).json();
  status = j.jobStatus;
  console.log(new Date().toLocaleTimeString(), status);
}

const res = await (await fetch(`${GP}/jobs/${sub.jobId}/results/Output_File?f=json`)).json();
const zipUrl = res?.value?.url;
if (!zipUrl) { console.error('no Output_File url in', JSON.stringify(res, null, 2)); process.exit(4); }
console.log('downloading', zipUrl);
const buf = Buffer.from(await (await fetch(zipUrl)).arrayBuffer());
const zipPath = path.join(out, `${layer}.zip`);
await writeFile(zipPath, buf);
console.log(`saved ${zipPath} (${(buf.length / 1e6).toFixed(1)} MB)`);
console.log('Unzip it in place; the GeoTIFF inside is the EVT raster in EPSG:' + epsg + ' at 30 m, plus a CSV attribute table (EVT code -> name).');
