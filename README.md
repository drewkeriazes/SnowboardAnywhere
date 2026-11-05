# SnowboardAnywhere

Browser snowboard game that rebuilds real resorts at 1:1 from topographic data (1 m lidar DEM, canopy-segmented trees, NAIP masks, OSM and OpenSkiData features). Three.js + TypeScript + Vite. First resort: Vail.

Reference and design rationale: `docs/bonvo-teardown-and-build-plan.md`.

## Layout

- `game/` – the client. `cd game && npm install && npm run dev` → http://localhost:5173
- `fetch_vail.cmd` / `pipeline/fetch.ps1` – double-click on Windows to download the raw inputs listed in `pipeline/manifests/vail.json` into `raw/vail/` (about 1.2 GB; resumable)
- `fetch_static.cmd` / `pipeline/fetch_static.ps1` – downloads the Geofabrik Colorado OSM extract and USGS GNIS names into `raw/static/`
- `pipeline/gen_manifest.py` – builds the manifest from `pipeline/resorts/<slug>.json` (needs `pip install pyproj`)
- `pipeline/extract_osm.py` – cuts `raw/vail/osm/*.json` and `raw/vail/names/gnis.json` out of the static files (needs `pip install osmium`)
- `pipeline/process/` – Python that turns `raw/<slug>/` into a resort pack: `python pipeline/process/build_pack.py vail`
- `raw/` – downloaded source data (gitignored, ~1.6 GB for Vail)
- `packs/` – generated resort packs (gitignored), served by Vite as static tiles
- `docs/` – plans and notes

## Milestones

M0 pipeline (Vail) → M1 terrain viewer → M2 riding physics → M3 trees and rock → M4 lifts and landmarks → M5 snow and atmosphere → M6 second resort, timed runs, multiplayer.
