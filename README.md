# SnowboardAnywhere

Browser snowboard game that rebuilds real resorts at 1:1 from public topographic data: 1 m USGS lidar DEM, trees from the lidar canopy and NAIP imagery, rock and groomed-piste masks, OpenStreetMap lifts, runs, buildings and roads, and a 260 km horizon from Mapterhorn. Three.js + TypeScript + Vite. First resort: Vail.

Start with `docs/HANDOFF.md`. Reference and design rationale: `docs/bonvo-teardown-and-build-plan.md`. Pack format: `docs/pack-format.md`. Research and data notes: `docs/README.md`.

## Layout

- `game/` the client. `cd game && npm install && npm run dev` then open http://localhost:5173/?pack=vail (or `?pack=synth`).
  - `src/pack/` pack loader and tiled height / mask sampling
  - `src/terrain/` quadtree LOD terrain and snow material
  - `src/sim/` rider physics, controls, collisions
  - `src/world/` trees, rocks, lifts, piste overlay, sky, rider model, chase camera
  - `tools/shoot.mjs` headless render and ride test (screenshots into `game/shots/`)
- `pipeline/` data pipeline
  - `resorts/<slug>.json` resort config (origin, UTM bbox, rings, NAIP items, lidar nodes)
  - `gen_manifest.py` -> `manifests/<slug>.json` download list (needs `pip install pyproj`)
  - `fetch.ps1` + `fetch_vail.cmd` resumable Windows downloader (about 1.4 GB for Vail; `-RawDir` picks the destination)
  - `fetch_static.ps1` + `fetch_static.cmd` Geofabrik Colorado OSM extract and USGS GNIS names into `raw/static/`
  - `extract_osm.py` cuts `osm/*.json` and `names/gnis.json` out of the static files (needs `pip install osmium`), the Overpass-free route for future resorts
  - `build_pack.py <slug> <raw_dir> <out_dir>` raw inputs -> resort pack (`pip install -r pipeline/requirements.txt`)
  - `synth_pack.py <out_dir>` synthetic test mountain in the same format
- `raw/` downloaded source data (gitignored); the Vail download currently lives at `C:\Users\Drew\Documents\snowboard-sim\raw`
- `packs/` generated resort packs (gitignored); served at `/packs/` by the dev server
- `docs/` plans, handoff, research and data notes

## Controls

Left/Right or A/D steer, Up/W tuck, Down/S brake, hold and release Space to jump, Shift grab. R restart, C camera, M piste map, F free fly (WASD + mouse, Shift fast).

## Milestones

M0 pipeline (Vail) -> M1 terrain viewer -> M2 riding physics -> M3 trees and rock -> M4 lifts and landmarks -> M5 snow and atmosphere -> M6 second resort, timed runs, multiplayer.
