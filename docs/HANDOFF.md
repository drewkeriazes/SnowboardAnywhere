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

1. Run the Vail pack build locally (Python 3.13 is on the PC):
   `pip install -r pipeline/requirements.txt`
   `python pipeline/build_pack.py vail C:\Users\Drew\Documents\snowboard-sim\raw packs\vail`
   Expect it to need fixes on first run; it has only been syntax-checked. It needs ~6 GB RAM (1 m grid is 11,600 x 11,700). Stages: DEM mosaic -> mid ring -> far ring -> lidar DSM/CHM -> NAIP classes -> OSM features -> masks -> trees/rocks -> meta.
2. `cd game && npm install && npm run dev`, open `http://localhost:5173/?pack=vail`. Default start is the top of the first named chair lift; use `?x=&y=&h=` (local metres, heading degrees) to drop in elsewhere, `F` to fly.
3. Known data caveat: the Planetary Computer crop endpoint capped NAIP crops at 2048 px, so imagery is ~2 m, not 1 m. `build_pack.py` already handles this (works on a 2 m grid). For 1 m crown detection later, re-fetch NAIP in 2 km chunks (`naip.max_px` 2048 with 2 km bboxes in `gen_manifest.py`).
4. Visual passes after the first real render: tree LOD impostors, CSM shadows, piste-aligned corduroy, aerial perspective (see the Project doc `research-threejs-rendering-stack.md`).
5. Then M4 landmarks (buildings/roads are already in features.json but not drawn), M5 snow and weather, timed runs.

## Conventions

- Pack coordinates: x east, y north, z up, metres from `meta.origin` (UTM 13N 384300, 4384250 for Vail). three.js: x east, y up, z = -north.
- Pack format is `docs/pack-format.md`. Keep `packwriter.py` and `src/pack/` in sync if it changes.
- Fetch lessons (USGS 500s above 1500 px, Overpass flakiness, PowerShell quirks) are in the Project doc `vail-raw-data-inventory.md`.
