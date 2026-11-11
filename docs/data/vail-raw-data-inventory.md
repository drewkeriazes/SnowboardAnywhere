# Vail raw data inventory and fetch lessons

Last updated 2026-11-06. Status: fetch COMPLETE for Vail.

Location: `raw/` at the repo root (gitignored). On Drew's PC that is `C:\Users\Drew\git\SnowboardAnywhere\raw\`. Stage files from there into a cloud session with the remote-devices tools; the data hosts are not reachable from the sandbox.

## raw/vail/ (691 manifest items, all downloaded)

| Folder | Files | What | Notes for processing |
|---|---|---|---|
| `dem1m/` | 64 x `dem_{i}_{j}.tif` (i,j in 0..7) | USGS 3DEP 1 m bare-earth DEM, F32 GeoTIFF, EPSG:26913 (UTM 13N), nodata -9999 | 1500 x 1500 px chunks (edge chunks smaller). Resort bbox UTM 378500,4378400 to 390100,4390100 (11.6 x 11.7 km). Mosaic with `rasterio.merge`. |
| `dem10m/` | 4 x `mid_{i}_{j}.tif` | Same service at 10 m, 40 km ring centred on the resort origin | 2000 x 2000 px quarters, NOT a single `mid.tif`. Mosaic them first. |
| `naip1m/` | 16 x `{item}_{i}_{j}.tif` | NAIP 4-band (R,G,B,NIR) 1 m crops from Planetary Computer (2023 collection), EPSG:26913 | Band 4 is NIR for NDVI. |
| `ept/` | `ept.json` + 388 x `{node}.laz` | 3DEP lidar Entwine Point Tiles (`USGS_LPC_CO_Central_Western_2016_LAS_2018`), pre-selected nodes covering the resort | SRS is EPSG:3857, see `docs/research/vegetation-and-landcover.md` for the scale trap. Read with laspy[lazrs]. |
| `ept_far/` | 1,485 x `{node}.laz` (1.9 GB, fetched 2026-11-11) | BUG-081: the same lidar dataset over the far tree ring, 5 km round the resort box down to depth 9 (`lidar.far`, `vail_ept_far_nodes.txt`), less the nodes `ept/` has | Read by `far_trees.py` with the `ept/` nodes that reach past the pack. |
| `mapterhorn/{z}/` | 210 x `{x}_{y}.webp` | Terrarium-encoded 512 px WebP terrain tiles, far ring to ~100 km | Decode: `h = (R*256 + G + B/256) - 32768` metres. |
| `osm/` | `ski.json`, `built.json`, `natural.json`, `peaks_far.json`, `places_far.json`, `pistes_wide.json` | OpenStreetMap, Overpass `out geom` JSON format | Elements carry `type`, `id`, `tags`, plus `lat/lon` (nodes), `geometry[]` + `bounds` + `nodes[]` (ways), `members[]` with per-member `geometry` (relations). |
| `landcover/` | `worldcover/N36W108.tif`, `N39W108.tif` (90 MB each), `eth_canopy/` same names (285 MB each) | DATA-019: ESA WorldCover 2021 v200 classes (AWS open data) and the ETH Global Sentinel-2 10 m canopy height 2020 (ETH libdrive), whole 3 x 3 degree COG tiles named by their south-west corner, covering the far ring | uint8, EPSG:4326, 1/12000 degree, 1024 px tiles, 6 overviews. WorldCover nodata 0, ETH nodata 255 (heights in m). `pipeline/cover.py` decodes only the tiles a level needs (`read_window`). Fetched in 40 s on Drew's PC (2026-11-09). |
| `landfire/` | LANDFIRE EVT clip (`*.tif` + `.tif.vat.dbf` class table) | Existing vegetation type, from `fetch_landfire.mjs` | Drives tree species and forest extent. A build without it falls back to NAIP-colour species and logs "no LANDFIRE clip". |
| `landfire/evc/`, `landfire/evh/` | LANDFIRE 2024 EVC and EVH clips (`*.tif` int16 + `.tif.vat.dbf`, 433 x 472 px, the same 30 m grid as EVT) | DATA-010: existing vegetation cover and height, from `fetch_landfire.mjs vail <email> EVC` / `EVH` (fetched 2026-11-10, 0.3 and 0.2 MB) | Read by class name: EVC `Tree Cover = 10%` to `81%` in 1 % classes (values 110 to 181), EVH `Tree Height = 1 meter` to `25 meters` in 1 m classes (101 to 125). Shrub, herb, developed (including `Developed-Upland Evergreen Forest`), water and barren classes carry no tree value and read as NaN. `build_pack.py` stage 5c logs the cover and height range over the pack. |
| `grooming/` | 39 x `{wayback timestamp}.json` (Apr 2022 to Apr 2026) | Vail's own nightly grooming report: every trail with name, area, difficulty, open and groomed, from `FR.TerrainStatusFeed` on vail.com's terrain status page, via Internet Archive snapshots | From `fetch_grooming.py`. `build_pack.py` marks a run groomed if Vail groomed it on any saved night (plus OSM `piste:grooming` tags); nothing is inferred from difficulty. Names are joined to OSM ignoring case and punctuation, then by run base ("Simba - Lower" to "Simba"); `grooming_aliases` in the resort config covers spelling differences. vail.com itself returns 403 to scripted requests, so the live page is only saved by hand. |
| `names/` | `gnis.json` | USGS GNIS official names: 1750 features in the far box (1174 Summits, 413 Populated Places, 118 Ridges, 22 Ranges), 34 inside the resort box | No elevations in the current GNIS format; sample from the DEM. Use for horizon labels. |

Also `raw/static/`: `colorado-latest.osm.pbf` (369 MB Geofabrik extract, 2026-11-02) and `DomesticNames_CO_Text.zip` (USGS GNIS). These are the source for `osm/*` and `names/*` and can regenerate them for any Colorado resort with `pipeline/extract_osm.py` (pyosmium, ~5 min per run).

### OSM extract contents (resort box padded 0.015 deg: lat 39.5424..39.6582, lon -106.4166..-106.2777)
- `ski.json`: 881 elements (493 nodes, 388 ways). piste:type ways/relations, aerialway ways and nodes (stations, pylons), landuse=winter_sports.
- `built.json`: 3923 elements (395 nodes, 3519 ways, 9 relations). building, highway, man_made, amenity, tourism, parking.
- `natural.json`: 1441 elements (4 nodes, 1423 ways, 14 relations). natural, landuse, waterway, peak and saddle nodes.
- `peaks_far.json`: 1374 peak nodes with `ele` in the ~200 km far box.
- `pistes_wide.json` (DATA-019): 2,477 downhill piste ways and relations in a 140 km box (Vail, Beaver Creek, Copper, Breckenridge, Keystone, Arapahoe Basin, Ski Cooper, ...), 3 MB.
- `places_far.json`: 74 town/city/village nodes in the far box (Vail, Avon, Edwards, Eagle, Minturn, Leadville, Frisco, Breckenridge, Silverthorne, Aspen, Glenwood Springs, Steamboat Springs, ...).

## Fetch lessons (so nobody repeats them)
- USGS 3DEP ImageServer `exportImage` returns HTTP 500 for 1 m F32 exports around 3000 x 3000 px and above, even though the service advertises 8000 x 8000 max. 1500 x 1500 works every time (about 9 MB each). 10 m exports at 4000 x 4000 also fail; 2000 x 2000 works. Occasional 502 is transient and a retry fixes it.
- Overpass is unreliable for bulk pulls: overpass-api.de queues for minutes, overpass.kumi.systems returned 502/504 on every attempt, overpass.private.coffee intermittent. For any future resort, skip Overpass and run `extract_osm.py` on the Geofabrik state extract instead. Output is byte-compatible with Overpass `out geom` (validated: identical element counts for ski.json).
- PowerShell 5.1: `"$Var: text"` inside a double-quoted string is parsed as a drive reference and fails; write `"${Var}: text"`.
- .NET HttpClient on PS 5.1 sends `Expect: 100-continue` on POST, which some servers reject; use GET with `?data=` for Overpass or set `ExpectContinue = $false`.
- Planetary Computer NAIP crops, Mapterhorn tiles and the EPT nodes on `usgs-lidar-public` all downloaded without a single error.

## Pipeline files (`pipeline/`)
- `fetch.ps1` + `fetch_vail.cmd` (repo root): manifest-driven downloader, resumable, per-host concurrency limits, mirror rotation.
- `gen_manifest.py`: builds `manifests/vail.json` from `resorts/vail.json` (needs pyproj). DEM chunk size is `dem.chunk_px` in the resort config (1500).
- `fetch_static.ps1` + `fetch_static.cmd` (repo root): downloads the Geofabrik PBF and GNIS zip.
- `extract_osm.py <pbf> <gnis.txt> <out> --near lat0,lon0,lat1,lon1 --far ...`: produces `osm/*.json` and `names/gnis.json`.
- `fetch_grooming.py <slug> <raw_dir>`: the resort's grooming history from archived snapshots of `terrain_status_url` (stdlib + curl, resumable).
- `resorts/vail.json`: origin, UTM bbox, lonlat bbox, mid/far ring sizes, NAIP item bboxes, EPT path and node list, `terrain_status_url`, `grooming_aliases`.

## Adding a second resort
1. Copy `pipeline/resorts/vail.json` to `<slug>.json`, set origin, bboxes, EPT dataset (check the 3DEP index at `usgs.entwine.io/boundaries/resources.geojson`) and NAIP item ids.
2. Set `lidar.far` (`pad_m` wide enough for the ridges one or two over that show from the lifts, 5000 at Vail; `max_depth` as `max_depth_resort`), run `python pipeline/ept_select.py <slug>`, then `python pipeline/gen_manifest.py <slug>` and the `fetch_vail.cmd` equivalent with `-Slug <slug>`. A resort is not complete without the far tree ring (BUG-081): the land cover alone reads as camo from the lifts, so it is only a start for a new range.
3. `python pipeline/extract_osm.py raw/static/colorado-latest.osm.pbf <gnis.txt> raw/<slug> --near ... --far ...` (same PBF if the resort is in Colorado).
