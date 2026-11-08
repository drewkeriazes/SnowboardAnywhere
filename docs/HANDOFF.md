# Handoff: state of the project (updated 2026-11-06)

Read this first when picking the project up in Claude Code / VS Code. Current work lives on the board (https://github.com/users/drewkeriazes/projects/2, see `docs/BOARD.md`); this file is the background: where things are, what works, and the dated notes below. The "Next steps" list is the original 2026-11-05 plan, kept for history; steps 1 to 5 are done or have moved to cards.

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
  - Headless check: `node tools/shoot.mjs synth` (Playwright is a devDependency of `game/`; run `npx playwright install chromium` once per machine; the cloud falls back to `/opt/npm-tools`. Add `--headed` for a visible window on the real GPU). Use `?lowgfx` in software-rendered environments; a full-density scene takes ~9 s per frame under SwiftShader, which is what made the earlier run look hung. The first screenshot (snow, forest with trail cuts, rider) rendered correctly.
- `pipeline/`: downloader proven on Vail; `build_pack.py` runs end to end on the real Vail data in about 4 minutes on Drew's PC (see "First Vail build" below) and has been rebuilt several times since (for example the AO and rock-mask rebuild for FEAT-047). Breckenridge has fetch and build launchers (`fetch_breckenridge.cmd`, `build_breckenridge.cmd`).

## Next steps, in order

1. DONE 2026-11-05: the Vail pack builds end to end in about 4 minutes (see "First Vail build" below). To rebuild:
   `pip install -r pipeline/requirements.txt`
   `python pipeline/build_pack.py vail C:\Users\Drew\Documents\snowboard-sim\raw\vail packs\vail`
   The raw argument is the folder that directly contains `dem1m/`, `ept/`, `osm/` (manifest paths have no `vail/` prefix). Run it from PowerShell or cmd; in Git Bash quote the output path, because an unquoted `packs\vail` becomes `packsvail`. Needs ~6 GB RAM (1 m grid is 11,600 x 11,700). Stages: DEM mosaic -> mid ring -> far ring -> lidar DSM/CHM -> NAIP classes -> OSM features -> masks -> trees/rocks -> meta.
2. `cd game && npm install && npm run dev`, open `http://localhost:5173/?pack=vail`. Default start is the top of the first named chair lift; use `?x=&y=&h=` (local metres, heading degrees) to drop in elsewhere, `F` to fly.
3. Known data caveat: the Planetary Computer crop endpoint capped NAIP crops at 2048 px, so imagery is ~2 m, not 1 m. `build_pack.py` already handles this (works on a 2 m grid). For 1 m crown detection later, re-fetch NAIP in 2 km chunks (`naip.max_px` 2048 with 2 km bboxes in `gen_manifest.py`).
4. Visual passes after the first real render: tree LOD impostors, CSM shadows, piste-aligned corduroy, aerial perspective (see the Project doc `research-threejs-rendering-stack.md`).
5. Then M4 landmarks (buildings/roads are already in features.json but not drawn), M5 snow and weather, timed runs.

## First Vail build (2026-11-05, Drew's PC)

`packs/vail` on Drew's PC was built from `build_pack.py` at f8d2b3d (the cloud session's memory and classifier fixes d3d38a3 and 67415ab merged with the local UTF-8 and `places_far` fixes). Run time 4.3 minutes: DEM mosaic and fine tiles 134 s, mid and far 10 s, lidar 48 s, NAIP 9 s, OSM 1 s, masks 47 s, trees and rocks 4 s. Pack is 234 MB (fine 143 MB, trees 47 MB, mask 25 MB, mid 12 MB, far 3 MB, features 3.4 MB).

Fixes found on the first local run, now in `build_pack.py`: OSM JSON must be opened as UTF-8 (Windows defaults to cp1252 and crashed on a run name); place labels come from `places_far.json` (they were read from `peaks_far.json` and came out empty).

Validated (scratch scripts, not in the repo): fine tiles round-trip the raw 1 m DEM to 0.004 m; mid vs fine median 1.2 m; far covers 100% of the 200 km grid; 354 runs, 33 lifts (32 named), 2,000 buildings, 1,406 roads, 1,281 peaks, 74 town labels; the groomed mask covers 179 of 180 groomed-run midpoints; all 1.97 M trees (19.9 k aspen, 224 k krummholz) sit within 1.5 m of the terrain; `start` is the top of Gondola One (3,103 m). A top-down hillshade with the mask and run overlays matches the Vail trail layout, and the Back Bowls now read as open snow and meadow rather than rock.

Still outside the ranges in the pack-build skill, for the visual pass (step 4):
- Lidar cells with data 56% (skill expects > 70%): the EPT nodes are subsampled to ~3 m, so 44% of 2 m cells are empty and `grey_closing` spreads canopy into the gaps. Canopy is 61% (expected 20 to 50%) and shows above treeline in the Back Bowls. Fix: require a lidar return (or a dilated one) for canopy, or use LANDFIRE EVT once fetched.
- Rock class is now 0.9% (expected 2 to 10%), so scree is empty and only 2,076 rock instances were placed; the rock mask channel still gets its 8% mean from the slope-only term. Loosen the saturation gate a little (0.15 to about 0.2) or place rocks from slope as well as class.
- Aspen is 1.0% of cells; LANDFIRE EVT is the intended source.

Also: raw data on this PC is at `C:\Users\Drew\Documents\snowboard-sim\raw\`, not the repo-root `raw\` that CLAUDE.md and the inventory doc describe. Either move it or update those docs. Python packages install to the user site (`%APPDATA%\Python\Python313`), so `python -I` cannot see them; use `python -E -P` for isolated runs. The commit "add topo data" (ece9c41) accidentally added 158 MB of pack tiles from a mis-named `packsvail/` output folder; they were untracked again in cefff00 and purged from history on 2026-11-06 (DATA-017, see `docs/history-rewrite-2026-11-06.md`).

## 2026-11-06: snow lighting, terrain AO, rock (FEAT-047, FEAT-020, DATA-005)

Packs need a rebuild from 20526bf or later: `ao/` tiles (baked sky visibility, `pipeline/terrain_ao.py`) and a mask whose R channel is imagery rock only (slope and ridge rock come from the renderer now). Vail on Drew's PC is rebuilt; features.json came out identical. Rock and talus textures are CC0 ambientCG sets in `game/public/textures/` (regenerate with `pipeline/prep_textures.py`). For look checks use `cd game && node tools/views.mjs <pack> <outDir> tools/views-rock.json --gpu` (fixed free-camera stills, headless on the real GPU); `tools/shoot.mjs` takes `--gpu` too. Reference renders: `docs/renders/2026-11-06-feat020-*.jpg`.

## 2026-11-06: real vs game photo pairs (DATA-008)

`docs/compare/` holds 10 Vail spots (35 views) of Street View photos against the game's eye camera, each with notes linked to cards; start at `docs/compare/README.md`. Tools: `python tools/gmaps2game.py "<maps url>" vail --spot <slug>/<view> --add` (with `--offset` for a wrong panorama compass and `--at X,Y` for a misplaced pin), the `?cam=eye` URL mode with P to save a shot, and `cd game && node tools/shoot_spots.mjs vail --gpu --size 1919x910` to re-shoot every pair after a build. The pairs' main findings: forest far too sparse even in mature Front Side stands (BUG-023; Born Free has 0 trees within 30 m), trees drawn as black cones with no lodgepole or winter aspen shapes (FEAT-070), buried and box-shaped buildings (BUG-024, FEAT-071), lift terminals drawn twice with the wrong roof (DATA-009), too much grey rock (FEAT-069). Terrain matched closely at every spot.

## 2026-11-06: krummholz from lidar height (BUG-025)

`build_pack.py` no longer turns every tree above 3,350 m into a 4.5 m krummholz. A tree is krummholz only when its lidar canopy height is 1 to 4 m and it is above 3,450 m or in a LANDFIRE alpine class; no lidar height is capped. Vail rebuilt on Drew's PC: krummholz 1,497 of 1.25 M trees (0.1%, was 14.4%), median height above 3,350 m 13.5 m (was 4.5). Above 3,350 m, 97% of trees are in LANDFIRE's subalpine spruce-fir forest class, so Vail has almost no real treeline. The previous pack is kept at `packs/vail_pre025`.

## 2026-11-07: Outrun mode (FEAT-097 to FEAT-101)

Built on one branch from the research doc (`docs/research/outrun-mode.md`): `game/src/sim/Outrun.ts` (the chase sim), `world/Monster.ts` (the procedural yeti rig and gallop), `world/Eat.ts` (the eat sequence), `audio/ChaseAudio.ts` (spatial sound and music stages, the jukebox `chase` style), `ui/OutrunUI.ts` (HUD and card), the Outrun panel in the pause menu. Checked headless on Vail with `game/tools/outruncheck.mjs` (countdown, head start, spawn 150 to 250 m back, chase, lift ride, catch, eat, card). Not yet tuned by hand on the real GPU: the Normal speed law (`PRESETS` in Outrun.ts) and the eat timing are the first things to play with. Known gaps: no tree sway (a puff and a crack instead), the monster's fur is a jittered flat-shaded silhouette with tufts, and the base rule picks the lowest lift-base building cluster nearest the start.

## 2026-11-07: ollie and nollie body (FEAT-125)

On a tail or nose press (Z / V, or Space with S / W) the snowboarder's hips move up to 0.3 m toward the loaded end (`HIP_SHIFT`, was 0.12 m times the bend), reached at a bend of 0.6 (`PRESS_FLEX`, a full lean without a charge). The bend only comes from the lean, so this changes nothing outside a press; the BUG-047 deck clamp still applies. `pressLegs` then raises the hips so the leg over the unloaded end reaches nearly straight, and the IK bends the other. The upper body comes from the `pressTail` / `pressNose` poses in `RiderModel.ts` (added as offsets from neutral, the arms blended in), the head takes 80 % of the pelvis roll back out, and `balanceArms` adds the wobble, the correction swing when the lean changes and the upswing on the pop. Skis keep the old torso lean.

Measured by stepping `RiderView` in Node with a fake rider: tail press front knee 26 deg, back knee 72 deg, both hands above the shoulders; nose press mirrored; ollie load (charged) back knee 102 deg; foot gap 0 throughout. Known gap: the card asked for a 90 to 110 deg back knee on a plain press, which with this rig's legs and stance needs the hips about 0.5 m back; the straight front leg and the 0.3 m shift won. `node tools/rider.mjs synth` now shoots a held tail and nose press (`05b`, `05c`) and folds them into its worst foot gap.

## Session lanes (2026-11-05 14:50 ET, synced by the cloud session)

Two sessions are active. To avoid overlapping edits:

- VS Code session (Drew's PC): client only. Visual pass items from step 4: tree LOD / impostors, CSM shadows, piste-aligned corduroy, aerial perspective; then M4 landmarks. Pull before each work block; `pipeline/` is being edited by the cloud session.
- Cloud session: `pipeline/` only. Taking the three classifier gaps listed above: canopy above treeline (require a lidar return under canopy instead of `grey_closing`), rock saturation gate and slope-based rock placement, aspen pending LANDFIRE. Also owns `docs/data/` and `docs/research/`.
- Both: commit small on a branch per card and land through a PR (see `docs/BOARD.md` > Parallel sessions); pull with `--rebase`, never force-push `main`.

Cloud-session status (updated after build 5, commit 4e12521): classifier gaps closed and validated on the real data: canopy 38.7 % (was 60.8 %; the Back Bowls and the ridge above treeline are open now, Front Side forest intact), rock 1.6 % with 27,612 rock instances (was 2,076), meadow 25.4 %, trees 1.32 M, start on Born Free. REBUILD the pack on Drew's PC from 4e12521 or later before the next client work: `python pipeline/build_pack.py vail C:\Users\Drew\Documents\snowboard-sim\raw\vail packs\vail` (about 4 min). Remaining data gap: aspen (1.0 %) waits on the LANDFIRE clip (`fetch_landfire.cmd`).

Headless ride check on the real pack (build 4, cloud, SwiftShader with lowgfx): start on Born Free at 3,124 m on the ground, 1042 chunks, 612k tris, 79k tree instances in view, first frame 25 ms; after 4 s of tuck the rider moved 17.5 m down the run at 8.1 m/s with z following the slope (no tunnelling); a 2 s right carve shifted x by 10 m and scrubbed speed to 5.8 m/s. Screenshot 02 shows the Gore Creek valley and the ridges north of Vail at mid and far LOD, the Eagle's Nest lift with chairs, trees along the piste edges and spray at the board. The run stopped after the right-carve segment (the software GPU takes minutes per segment at 2.1 M tris); the jump and far-camera segments are unverified on real data and should be run with `--headed` on Drew's PC. Client observations for the visual pass: far ridges blend into the sky (aerial perspective), lift towers render as hairlines.

Previous status: `aaa8454` moved `meta.start` to Born Free (15 m below its top, facing down the run) and removed roads and buildings from rock and scree; headless render check of the real pack confirmed tree bases within 0.2 m of the terrain (first frame 26 ms, 1042 chunks, 758k tris under SwiftShader with `lowgfx`). A rebuild with those changes is running in the cloud; the pack on Drew's PC should be rebuilt once the classifier gaps land (one more commit).

## Conventions

- Pack coordinates: x east, y north, z up, metres from `meta.origin` (UTM 13N 384300, 4384250 for Vail). three.js: x east, y up, z = -north.
- Pack format is `docs/pack-format.md`. Keep `packwriter.py` and `src/pack/` in sync if it changes.
- Fetch lessons (USGS 500s above 1500 px, Overpass flakiness, PowerShell quirks) are in the Project doc `vail-raw-data-inventory.md`.
