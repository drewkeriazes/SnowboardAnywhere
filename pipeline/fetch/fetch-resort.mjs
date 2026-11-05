#!/usr/bin/env node
// Runs on Drew's PC (Node 18+, no installs). Downloads raw inputs for one resort
// into pipeline/raw/<slug>/. The cloud sandbox cannot reach these hosts, so this
// step is local; processing (pipeline/process) runs anywhere.
//
// Usage: node fetch-resort.mjs vail
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RESORTS } from './resorts.mjs';

const slug = process.argv[2];
const resort = RESORTS[slug];
if (!resort) {
  console.error(`Unknown resort "${slug}". Known: ${Object.keys(RESORTS).join(', ')}`);
  process.exit(1);
}

const out = path.resolve(import.meta.dirname, '..', 'raw', slug);
await mkdir(out, { recursive: true });

async function save(name, url, opts = {}) {
  process.stdout.write(`${name} ... `);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path.join(out, name), buf);
  console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
}

const [w, s, e, n] = resort.bbox;

// 1. OpenSkiData: runs, lifts, ski area polygon (filtered later by ski-area id).
await save('openskidata_runs.geojson', 'https://tiles.openskimap.org/geojson/runs.geojson');
await save('openskidata_lifts.geojson', 'https://tiles.openskimap.org/geojson/lifts.geojson');
await save('openskidata_ski_areas.geojson', 'https://tiles.openskimap.org/geojson/ski_areas.geojson');

// 2. OSM via Overpass: pistes, aerialways, buildings, roads, water, peaks, landcover.
const overpass = `
[out:json][timeout:180];
(
  way["piste:type"](${s},${w},${n},${e});
  way["aerialway"](${s},${w},${n},${e});
  node["aerialway"](${s},${w},${n},${e});
  way["building"](${s},${w},${n},${e});
  way["highway"](${s},${w},${n},${e});
  way["natural"~"water|bare_rock|scree|cliff|wood"](${s},${w},${n},${e});
  way["landuse"="forest"](${s},${w},${n},${e});
  node["natural"="peak"](${s},${w},${n},${e});
);
out body geom;`;
await save('osm.json', 'https://overpass-api.de/api/interpreter', {
  method: 'POST',
  body: 'data=' + encodeURIComponent(overpass),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});

// 3. USGS 3DEP 1 m DEM tile list for the bbox (download URLs saved; files fetched next).
const tnm = new URL('https://tnmaccess.nationalmap.gov/api/v1/products');
tnm.searchParams.set('datasets', 'Digital Elevation Model (DEM) 1 meter');
tnm.searchParams.set('bbox', `${w},${s},${e},${n}`);
tnm.searchParams.set('prodFormats', 'GeoTIFF');
tnm.searchParams.set('max', '200');
await save('tnm_dem_products.json', tnm.toString());

const products = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(out, 'tnm_dem_products.json'), 'utf8'));
await mkdir(path.join(out, 'dem'), { recursive: true });
for (const p of products.items ?? []) {
  const name = path.basename(new URL(p.downloadURL).pathname);
  await save(path.join('dem', name), p.downloadURL);
}

// 4. Mapterhorn background tiles z10..z12 around the resort.
await mkdir(path.join(out, 'mapterhorn'), { recursive: true });
for (const z of [10, 11, 12]) {
  const tiles = tilesForBbox(resort.bgBbox, z);
  for (const [x, y] of tiles) {
    await save(path.join('mapterhorn', `${z}_${x}_${y}.webp`), `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`);
  }
}

console.log(`\nDone. Raw data in ${out}`);
console.log('Still to fetch (next scripts): 3DEP lidar EPT, NAIP via Planetary Computer, LANDFIRE EVT.');

function tilesForBbox([w, s, e, n], z) {
  const t = (lon, lat) => {
    const x = Math.floor(((lon + 180) / 360) * 2 ** z);
    const r = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
    return [x, y];
  };
  const [x0, y0] = t(w, n), [x1, y1] = t(e, s);
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
}
