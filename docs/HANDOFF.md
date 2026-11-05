# Handoff: state of the project on 2026-11-05 (end of the cloud session)

Read this first when picking the project up in Claude Code / VS Code.

## Where things are

- Repo: `C:\Users\Drew\git\SnowboardAnywhere` (origin github.com/drewkeriazes/SnowboardAnywhere). Everything below is committed on `main`.
- Raw Vail data (1.4 GB, complete): `C:\Users\Drew\Documents\snowboard-sim\raw\vail\` (64 DEM chunks, 4 mid-ring chunks, 16 NAIP crops, 388 lidar nodes, 210 Mapterhorn tiles, 4 OSM extracts). Not in git. `docs/` in the claude.ai Project has the full inventory (`vail-raw-data-inventory.md`).
- Synthetic test pack: generate with `python pipeline/synth_pack.py packs/synth` (takes ~3 min, 39 MB). The client runs against it with `?pack=synth`.

## What works

- `game/`: full client skeleton, type-checks and builds.
  - Quadtree LOD terrain over the 262 km far ring, 1 m near the rider, CPU-built chunks with skirts (`src/terrain/Terrain.ts`), snow / rock / scree / groomed material with procedural detail (`src/terrain/TerrainMaterial.ts`).
  - Tiled Terrarium height sets with bilinear sampling and on-demand loading (`src/pack/`).
  - Rider physics: carve / skid edge model, tuck, brake, hold-release jump, air spin, landing penalties, surface types, tree and rock collisions (`src/sim/`).
  - Instanced trees per 1 km cell with near / far geometry, rocks, lifts with towers, catenary cables and moving chairs, piste overlay, sky, sun shadows, chase and free-fly cameras, HUD (`src/world/`).
  - Headless check: `node tools/shoot.mjs synth` (needs the Playwright browser; in the cloud it was at `/opt/npm-tools/node_modules/playwright`, locally use `npm i -D playwright` and change the import). Use `?lowgfx` in software-rendered environments; a full-density scene takes ~9 s per frame under SwiftShader, which is what made the earlier run look hung. The first screenshot (snow, forest with trail cuts, rider) rendered correctly.
- `pipeline/`: downloader proven on Vail; `build_pack.py` written but NOT yet run end to end on the real data (see next steps).

## Next steps, in order

1. DONE 2026-11-05: the Vail pack builds end to end in about 3 minutes (see "First Vail build" below). To rebuild:
   `pip install -r pipeline/requirements.txt`
   `python pipeline/build_pack.py vail C:\Users\Drew\Documents\snowboard-sim\raw\vail packs\vail`
   The raw argument is the folder that directly contains `dem1m/`, `ept/`, `osm/` (manifest paths have no `vail/` prefix). Run it from PowerShell or cmd; in Git Bash quote the output path, because an unquoted `packs\vail` becomes `packsvail`. Needs ~6 GB RAM (1 m grid is 11,600 x 11,700). Stages: DEM mosaic -> mid ring -> far ring -> lidar DSM/CHM -> NAIP classes -> OSM features -> masks -> trees/rocks -> meta.
2. `cd game && npm install && npm run dev`, open `http://localhost:5173/?pack=vail`. Default start is the top of the first named chair lift; use `?x=&y=&h=` (local metres, heading degrees) to drop in elsewhere, `F` to fly.
3. Known data caveat: the Planetary Computer crop endpoint capped NAIP crops at 2048 px, so imagery is ~2 m, not 1 m. `build_pack.py` already handles this (works on a 2 m grid). For 1 m crown detection later, re-fetch NAIP in 2 km chunks (`naip.max_px` 2048 with 2 km bboxes in `gen_manifest.py`).
4. Visual passes after the first real render: tree LOD impostors, CSM shadows, piste-aligned corduroy, aerial perspective (see the Project doc `research-threejs-rendering-stack.md`).
5. Then M4 landmarks (buildings/roads are already in features.json but not drawn), M5 snow and weather, timed runs.

## First Vail build (2026-11-05, Drew's PC)

Fixes made on the first run: OSM JSON must be opened as UTF-8 (Windows defaults to cp1252 and crashed on a run name); place labels now come from `places_far.json` (they were read from `peaks_far.json` and came out empty). Both are in `build_pack.py`.

Timing: DEM mosaic and fine tiles 90 s, mid and far 8 s, lidar 28 s, NAIP 5 s, OSM 1 s, masks 46 s, trees and rocks 3 s. Pack is 320 MB (fine 143 MB, trees 126 MB, mask 28 MB, mid 12 MB, far 3 MB, features 3.4 MB).

Validated: fine tiles round-trip the raw 1 m DEM to 0.004 m; mid vs fine median 1.2 m; far covers 100% of the 200 km grid; 354 runs, 33 lifts (32 named), 2,000 buildings, 1,406 roads, 1,281 peaks, 74 town labels; the groomed mask covers 179 of 180 groomed-run midpoints; all 5.26 M trees sit within 1.3 m of the terrain; `start` is the top of Gondola One (3,103 m). A top-down hillshade with the mask and run overlays matches the Vail trail layout.

Out of the ranges in the pack-build skill, all pointing at the land-cover classifier, not the geometry:
- Lidar cells with data 56% (expected > 70%): the EPT nodes are subsampled to ~3 m, so 44% of 2 m cells are empty and `grey_closing` then spreads canopy into the gaps.
- Canopy 61% (expected 20 to 50%), tree count 5.26 M (expected 0.5 to 3 M), and canopy shows above treeline in the back bowls.
- Rock 20% (expected 2 to 10%): the low-NDVI threshold also fires on steep forested valley sides.
- Aspen 0.1% (6,055 trees): the NAIP colour thresholds are too strict for the 2 m crops; Vail has large aspen stands.
Fix these in the visual pass (step 4): require lidar returns for canopy, raise the rock NDVI/brightness gate, loosen the aspen rule.

Also: raw data on this PC is at `C:\Users\Drew\Documents\snowboard-sim\raw\`, not the repo-root `raw\` that CLAUDE.md and the inventory doc describe. Either move it or update those docs. Python packages install to the user site (`%APPDATA%\Python\Python313`), so `python -I` cannot see them; use `python -E -P` for isolated runs.

## Conventions

- Pack coordinates: x east, y north, z up, metres from `meta.origin` (UTM 13N 384300, 4384250 for Vail). three.js: x east, y up, z = -north.
- Pack format is `docs/pack-format.md`. Keep `packwriter.py` and `src/pack/` in sync if it changes.
- Fetch lessons (USGS 500s above 1500 px, Overpass flakiness, PowerShell quirks) are in the Project doc `vail-raw-data-inventory.md`.
