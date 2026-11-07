# Developer guide

The detail behind the top-level README: what is in the game, where the code lives, every tool and
pipeline script, URL parameters and the milestone history. Process docs: [HANDOFF.md](HANDOFF.md)
(current state), [BOARD.md](BOARD.md) (kanban), [workspace-and-sessions.md](workspace-and-sessions.md)
(where things live, multi-session rules). Plan of record: [bonvo-teardown-and-build-plan.md](bonvo-teardown-and-build-plan.md).

## Features in detail

- Terrain: quadtree LOD over the 262 km far ring, 1 m near the rider, snow / rock / scree / groomed material.
- Riding: carve and skid edge model, tuck, brake (the board swings across into a hockey stop, scrapes a wide track and holds on its edge once stopped), charged jumps, grabs, air spin, landings; collisions with trees, rocks and building walls. Snowboard or skis, outfit colours, articulated rider with blended poses.
- Snow: 3D tracks pressed into the snow behind the rider.
- World: instanced forests (species from LANDFIRE, impostors at distance), rocks with snow caps, extruded buildings, roads and catwalks draped on the terrain, bridges over gaps the bare-earth lidar removes, piste overlay, peak and town labels on the horizon (hidden behind nearer ridges).
- Lifts: towers, cables and moving chairs from OSM. E at a bottom terminal boards (prompt card, floating markers and a loading zone show where); while riding, E skips to the top and holding W fast-forwards. The rider sits on a real chair.
- Time trials (Settings > Game): start and finish gates on real runs, splits, a ghost of your best run, boundary walls with a 5 s grace, an arrow to the finish. T jumps to the nearest start.
- Sky and weather: real sun position for the resort's lon/lat and date (resort default, real time, or a fixed hour and month); volumetric clouds from bluebird to broken; a snowstorm option.
- Cameras: chase, close, far, first person and free fly. Hold Alt to look around. First person sees through goggles (dark frame, lens tint, snow drift, frost in powder, darken and shake on hard landings) with your legs, board and arms in view.
- Maps: minimap with nearby lift names, and a full map (M) with zoom, pan and click to drop in anywhere.
- Sound: layered surface-aware board sound (groomed, powder, hardpack, crust), carve and wind layers, varied one-shots, lift sounds.
- Music: four playlists (Ska-punk, Melodic house, Metal, Lofi hip-hop, plus Shuffle all) picked on the main menu or in Settings. Ska-punk is the DavidKBD "Skank the Summer" pack (CC BY 4.0); playlists without files play a procedural jukebox in that style. See `game/public/music/README.md`.
- Menus: main menu (resort picker, snowboard or skis, music), Esc pause menu (resume, restart, map, settings, quit) and a shared settings panel for audio, graphics, controls (key remapping), rider and game options, saved in localStorage.
- Touch controls on phones and tablets.

## Code layout

- `game/` the client (Three.js 0.172, TypeScript, Vite). `cd game && npm install && npm run dev`.
  - `src/pack/` pack loader, tiled height / mask sampling, bridge decks
  - `src/terrain/` quadtree LOD terrain and snow material
  - `src/sim/` rider physics, controls, collisions, lift riding, time trials
  - `src/world/` trees, rocks, buildings, roads, bridges, lifts, piste overlay, sky, sun, clouds, snow, rider model, cameras
  - `src/ui/` main menu, pause menu, settings, resort map, horizon labels, goggles, touch controls
  - `src/audio/` synthesised sound and the music player / jukebox
  - `public/music/` soundtrack, `playlist.json`, credits
- `pipeline/` data pipeline (Python, plus PowerShell fetch scripts for Windows)
- `raw/` downloaded source data (gitignored); the Vail download currently lives at `C:\Users\Drew\Documents\snowboard-sim\raw\vail`
- `packs/` generated resort packs (gitignored); the dev server serves them at `/packs/`
- `docs/` plans, handoff, board, research and data notes

## Test tools (`game/tools/`)

- `shoot.mjs [pack] [outDir] [--headed]` render and ride test, screenshots into `game/shots/`; `--headed` opens a visible window on the real GPU. Also `npm run shoot` / `npm run shoot:headed`. Use `SHOT_QUERY="&lowgfx"` on software GPUs.
- `shoot_features.mjs` map, buildings, rocks and lift feature check.
- `probe.mjs` step timing probe for hangs.
- `brakecheck.mjs` brake physics on exact planes, no browser: hockey-stop time and distance against the snow-cutting targets, board swing, release, standing across the hill, ski snowplough. Exits 1 on a failed check.
- `brakeshot.mjs [pack] [outDir] [--headed] [--ski]` hockey-stop render check: tucks to speed, holds brake, saves shots of the swing, spray and scraped track.
- `carveshot.mjs [pack] [outDir] [--headed] [--ski]` carve track render check (FEAT-097): tucks to speed, links hard carves, saves the knife-cut line close up, overhead and from 40 m down the run, and prints the edge amount per shot.
- `shoot_spots.mjs [pack] [spot ...] [--gpu | --headed]` re-shoots the game side of the real vs game photo pairs in `docs/compare/<pack>/` with the eye camera, as `eye-<view>.png` (DATA-008; see [compare/README.md](compare/README.md)).
- `fetch-music.ps1 -Source <folder> -Playlist <name>` converts downloaded tracks into a playlist (needs ffmpeg).

Typecheck before committing: `cd game && npx tsc --noEmit`.

## Pipeline scripts (`pipeline/`)

Flow: `resorts/<slug>.json` -> `gen_manifest.py` -> `manifests/<slug>.json` -> `fetch.ps1` -> `raw/<slug>/` -> `build_pack.py` -> `packs/<slug>/`.

- `resorts/<slug>.json` resort config (origin, UTM bbox, rings, NAIP items, lidar nodes).
- `gen_manifest.py` writes `manifests/<slug>.json`, the download list (needs `pip install pyproj`).
- `fetch.ps1` resumable Windows downloader (about 1.4 GB for Vail; `-RawDir` picks the destination), launched by `fetch_vail.cmd` in the repo root. Run one fetch at a time.
- `fetch_static.ps1` (launcher `fetch_static.cmd`) Geofabrik Colorado OSM extract and USGS GNIS names into `raw/static/`.
- `fetch_landfire.mjs <slug> <email>` (launcher `fetch_landfire.cmd`) LANDFIRE EVT clip via the LFPS job service into `raw/<slug>/landfire/`.
- `fetch_grooming.py <slug> <raw_dir>` the resort's real grooming history (Vail's nightly reports, from Internet Archive snapshots of its terrain status page) into `raw/<slug>/grooming/`. Groomed runs in the pack come only from these reports and OSM `piste:grooming` tags.
- `extract_osm.py` cuts `osm/*.json` and `names/gnis.json` out of the static files (needs `pip install osmium`), the Overpass-free route for future resorts.
- `build_pack.py <slug> <raw_dir> <out_dir>` raw inputs to a resort pack (`pip install -r pipeline/requirements.txt`), about 4 minutes and 234 MB for Vail.
- `synth_pack.py <out_dir>` synthetic test mountain in the same format, for client work without real data.

The data hosts (USGS, Planetary Computer, Overpass, Mapterhorn) are not reachable from cloud sandboxes; fetching runs on Drew's PC. Before touching raw data read [data/vail-raw-data-inventory.md](data/vail-raw-data-inventory.md). Pack layout: [pack-format.md](pack-format.md).

## URL parameters

- `pack=<slug>` resort pack to load (`vail`, `breckenridge`, `synth`)
- `x=&y=&h=` spawn in local metres with heading in degrees
- `cam=fp` start in first person
- `cam=eye&pitch=&fov=&eye=&spot=` still camera at eye height (default 1.7 m) over `x, y`, looking along `h` with `pitch` degrees up (negative is down) and `fov` vertical degrees; HUD and rider hidden, P saves the shot (into `docs/compare/` when `spot=<slug>/<view>` is set). Make these links from a Street View URL with `python tools/gmaps2game.py`.
- `time=now` or `time=16.5` override the time of day
- `rider=ski` or `rider=board`
- `lowgfx` reduced graphics for software GPUs; `headless` is used by the test tools; `csm` / `nocsm` force cascaded shadows on or off; `noimpostors` disables tree impostors

## Milestones

M0 pipeline (Vail) -> M1 terrain viewer -> M2 riding physics -> M3 trees and rock -> M4 lifts and landmarks -> M5 snow and atmosphere -> M6 second resort, timed runs, multiplayer.

M0 to M3 are done on the real Vail pack. M4 has rideable lifts, buildings, roads, bridges and labels. M5 has time of day, clouds, snowstorms and snow tracks. M6 has started: Breckenridge is playable from the resort picker, and time trials with ghosts are in. Open work is on the board.
