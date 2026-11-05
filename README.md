# SnowboardAnywhere

Browser snowboard game that rebuilds real resorts at 1:1 from public topographic data: 1 m USGS lidar DEM, trees from the lidar canopy and NAIP imagery, rock and groomed-piste masks, OpenStreetMap lifts, runs, buildings and roads, and a 260 km horizon from Mapterhorn. Three.js + TypeScript + Vite. First resort: Vail.

Start with `docs/HANDOFF.md`. Work is tracked on the kanban at https://github.com/users/drewkeriazes/projects/2 (one issue per card, see `docs/BOARD.md`). Reference and design rationale: `docs/bonvo-teardown-and-build-plan.md`. Pack format: `docs/pack-format.md`. Research and data notes: `docs/README.md`.

## What's in the game

- Terrain: quadtree LOD over the 262 km far ring, 1 m near the rider, snow / rock / scree / groomed material.
- Riding: carve and skid edge model, tuck, brake, charged jumps, grabs, air spin, landings; collisions with trees, rocks and building walls.
- World: instanced forests, rocks with snow caps, extruded buildings, roads draped on the terrain, piste overlay, peak and town labels on the horizon (hidden behind nearer ridges).
- Lifts: towers, cables and moving chairs from OSM. Ride up with E at a bottom terminal (prompt card, floating markers and a loading zone show where), E again to skip to the top.
- Time of day: real sun position for the resort's lon/lat and date; the resort default, real time, or a fixed hour and month from Settings.
- Cameras: chase, close, far, first person and free fly.
- Maps: minimap with nearby lift names, and a full map (M) with zoom, pan and click to drop in anywhere.
- Sound: layered surface-aware board sound (groomed, powder, hardpack, crust), carve and wind layers, varied one-shots, lift sounds, plus a music playlist from `public/music/playlist.json`.
- Menus: main menu, Esc pause menu (resume, restart, map, settings, quit to main menu) and a shared settings panel for audio, graphics, key remapping, cameras, units and markers, saved in localStorage.

## Layout

- `game/` the client. `cd game && npm install && npm run dev` then open http://localhost:5173/?pack=vail (or `?pack=synth`).
  - `src/pack/` pack loader and tiled height / mask sampling
  - `src/terrain/` quadtree LOD terrain and snow material
  - `src/sim/` rider physics, controls, collisions, lift riding
  - `src/world/` trees, rocks, buildings, roads, lifts, piste overlay, sky and sun, rider model, cameras
  - `src/ui/` main menu, pause menu, settings, resort map, horizon labels
  - `src/audio/` synthesised sound and music
  - `tools/shoot.mjs [pack] [outDir] [--headed]` render and ride test (screenshots into `game/shots/`; `--headed` opens a visible window on the real GPU), also `npm run shoot` / `npm run shoot:headed`
  - `tools/shoot_features.mjs` map, buildings, rocks and lift feature check; `tools/probe.mjs` step timing probe for hangs
- `pipeline/` data pipeline
  - `resorts/<slug>.json` resort config (origin, UTM bbox, rings, NAIP items, lidar nodes)
  - `gen_manifest.py` -> `manifests/<slug>.json` download list (needs `pip install pyproj`)
  - `fetch.ps1` resumable Windows downloader (about 1.4 GB for Vail; `-RawDir` picks the destination), launched by `fetch_vail.cmd` in the repo root
  - `fetch_static.ps1` (launcher `fetch_static.cmd`) Geofabrik Colorado OSM extract and USGS GNIS names into `raw/static/`
  - `fetch_landfire.mjs <slug> <email>` (launcher `fetch_landfire.cmd`) LANDFIRE EVT clip via the LFPS job service into `raw/<slug>/landfire/`
  - `extract_osm.py` cuts `osm/*.json` and `names/gnis.json` out of the static files (needs `pip install osmium`), the Overpass-free route for future resorts
  - `build_pack.py <slug> <raw_dir> <out_dir>` raw inputs -> resort pack (`pip install -r pipeline/requirements.txt`), about 4 minutes and 234 MB for Vail
  - `synth_pack.py <out_dir>` synthetic test mountain in the same format
- `raw/` downloaded source data (gitignored); the Vail download currently lives at `C:\Users\Drew\Documents\snowboard-sim\raw\vail`
- `packs/` generated resort packs (gitignored); served at `/packs/` by the dev server
- `docs/` plans, handoff, board, research and data notes

## Controls

Defaults; every action can be remapped in Settings > Controls.

| Key | Action |
| --- | --- |
| Left/Right or A/D | steer |
| Up/W | tuck |
| Down/S | brake |
| Space (hold, release) | jump |
| Shift | grab |
| E | board a lift at a bottom terminal; while riding, skip to the top |
| C | cycle camera: chase, close, far, first person, free |
| F | free fly (WASD + mouse, Shift fast) |
| M | full map (wheel zoom, drag pan, click to drop in) |
| P | toggle piste lines |
| N | next music track |
| R | restart at the spawn point |
| Esc | pause menu (closes the map first if open) |

## URL parameters

- `pack=<slug>` resort pack to load (`vail`, `synth`)
- `x=&y=&h=` spawn in local metres with heading in degrees
- `cam=fp` start in first person
- `time=now` or `time=16.5` override the time of day
- `lowgfx` reduced graphics for software GPUs; `headless` is used by the test tools

## Milestones

M0 pipeline (Vail) -> M1 terrain viewer -> M2 riding physics -> M3 trees and rock -> M4 lifts and landmarks -> M5 snow and atmosphere -> M6 second resort, timed runs, multiplayer.

M0 to M3 are done on the real Vail pack; M4 has lifts you can ride, buildings, roads and labels; M5 has started with time of day. Open work is on the board.
