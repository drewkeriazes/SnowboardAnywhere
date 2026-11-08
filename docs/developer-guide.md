# Developer guide

The detail behind the top-level README: what is in the game, where the code lives, every tool and
pipeline script, URL parameters and the milestone history. Process docs: [HANDOFF.md](HANDOFF.md)
(current state), [BOARD.md](BOARD.md) (kanban), [workspace-and-sessions.md](workspace-and-sessions.md)
(where things live, multi-session rules). Plan of record: [bonvo-teardown-and-build-plan.md](bonvo-teardown-and-build-plan.md).

## Features in detail

- Terrain: quadtree LOD over the 262 km far ring, 1 m near the rider, snow / rock / scree / groomed material; forested ground darkens from the tree impostor ring outward so the far forest reads dark.
- Riding: carving on a real edge angle (up to 72 deg on firm snow, 45 in powder) with the turn radius from the board's sidecut, washing into a skid past the grip; edge to edge takes about 0.3 s at speed; the rider leans into the hill up to 60 deg with deep toeside and heelside carve poses. Also tuck, brake (the board swings across into a hockey stop, scrapes a wide track and holds on its edge once stopped; steering while braking digs the edge in for a harder stop or lets it off into a skidded turn or a side-slip), charged jumps with ollie and nollie off the board's spring (hold W / S with Space), nose and tail presses (V / Z), squat (Left Ctrl), skating on the flat (X), grabs, air spins, front flips and backflips (Up / Down in the air, trick names toast on landing), landings; collisions with trees, rocks and building walls. The snowboard bends when loaded. Snowboard or skis, outfit colours, articulated rider with blended poses. The body leads and the board follows (BUG-056, visual only): the head and shoulders pose about 0.18 s ahead of the physics (the steer's target edge and the heading the turn rate is reaching), the hips and the body's inclination about 0.09 s ahead, and the board as drawn trails the physics yaw and edge by about 0.08 s (critically damped, never rolled past the physics edge, snapped on landings and crashes), so an edge change reads look, shoulders, hips, knees, board. Tunables `LEAD_UPPER`, `LEAD_HIPS`, `BOARD_LAG` at the top of `RiderView.ts`, live on `riderView.leadUpper` / `leadHips` / `boardLag` and as sliders under `?debug`.
- Crashes: a Verlet ragdoll takes over the skeleton, tumbles against the snow, trunks, rocks and walls, follows the sim's crash slide and blends back to the animated pose as the rider gets up.
- On foot: B unstraps when nearly stopped (or straps back in standing still); walk with the board carried (on the shoulder when sprinting), sprint on Shift (stamina), step up and climb onto platforms, bootprints in the snow.
- Snow: 3D tracks pressed into the snow behind the rider (carves narrow to a knife-cut line); tracks and bootprints fill in faster while it snows, and new snow buries terrain rock from its edges in.
- World: instanced forests (species from LANDFIRE, impostors at distance), rocks with snow caps, extruded buildings, roads and catwalks draped on the terrain, bridges over gaps the bare-earth lidar removes, piste overlay, peak and town labels on the horizon (hidden behind nearer ridges). Landmarks (FEAT-132) are hand-placed signs OSM does not carry, such as Vail's Legendary Back Bowls gateway arch; its name toasts as you ride under it, and Vail's default start is just above it.
- Lifts: towers, cables and moving chairs from OSM. E at a bottom terminal boards (prompt card, floating markers and a loading zone show where); while riding, E skips to the top and holding W fast-forwards. The rider sits on a real chair. Chairlift bases have lift-line mazes (2 to 4 lanes by capacity, wait and load lines, funnel fences, a name board) whose ropes are colliders; with a maze built, boarding works only inside the corral. Settings > Game turns the mazes off.
- Time trials (Settings > Game): start and finish gates on real runs, splits, a ghost of your best run, boundary walls with a 5 s grace, an arrow to the finish. T jumps to the nearest start.
- Outrun (Esc > Outrun, FEAT-097 to FEAT-101; design in `docs/research/outrun-mode.md`): a snow monster chases you down the mountain after a head start. It follows your breadcrumbs by arc length (no pathfinding, any pack), charges straight with line of sight inside 60 m, rubber-bands on your recent speed so crashes and stops feed it, and rides the cable tower to tower when you take a lift (no lift skip while it runs). Difficulties Chill / Normal / SkiFree, escape by reaching the base (lowest building cluster near a lift bottom) or Endless (a second one at 3 min). F burns adrenaline (close calls, clean landings, fast carving) for a 4 s boost, hold G to look back. Spatial sound (HRTF gallop, roars, breathing, heartbeat), music ducks, muffles and cuts as it closes in with war drums from the jukebox. Caught: slow-mo grab, rip in half (snow and confetti, no gore), unhinged jaw, two bites, the board spat out, a burp, then the EATEN card with best scores; Gentle swallows you whole. `node tools/outruncheck.mjs vail shots-outrun --gpu` runs the whole flow headless.
- Replay and rewind (FEAT-043): the session is recorded. K opens the replay viewer (play, scrub, speed, follow / trackside / free camera, FOV, time of day, hide HUD, P photo); holding Backspace rewinds along the recording and letting go carries on from the last good ground (it cancels a time trial).
- Sky and weather: real sun position for the resort's lon/lat and date (resort default, real time, or a fixed hour and month); volumetric clouds from bluebird to broken, plus thin high cloud (streaky cirrus and faint contrails); a snowstorm option.
- Cameras: chase (behind and above, looking over the rider's head at the snow ahead), close (tight and low), far (angled broadcast view looking down at the rider), cinematic (low, off to one side, long lens), first person, helmet cam (wide and level, on top of the helmet) and free fly (backtick). Hold Alt or the right mouse button to look around, hold G to look behind in any camera (FEAT-124). Speed feel: FOV widens with speed, the camera rumbles with the snow under the board (none on corduroy, more off-piste) and shakes on landings, and speed lines streak past; each has a switch in Settings. First person sees through goggles (dark frame, lens tint, snow drift, frost in powder, darken and shake on hard landings) with your legs, board and arms in view.
- Run stats (FEAT-055): each run tracks time, top speed, distance, vertical, longest air, biggest drop, max lateral g, the named runs ridden (nearest mapped run line within 25 m) and the line, sampled every 2 s. A run starts at 3 m/s on the board and ends on boarding a lift, a 4 s stop or a restart; under 60 m of vertical it is dropped. The after-run card shows the summary; the HUD shows the live run. Day totals (vertical, runs, lifts) and per-run personal bests (fastest time, top speed, keyed by the first named run) persist in localStorage under `session-day` and `run-pbs`. Paused during Outrun; no card in headless runs.
- Maps: minimap with nearby lift names, and a full map (M) with zoom, pan and click to drop in anywhere; landmarks show as gold diamonds.
- Sound: layered surface-aware board sound (groomed, powder, hardpack, crust), rock scrapes, carve and wind layers, varied one-shots, lift sounds.
- Music: four playlists (Ska-punk, Melodic house, Metal, Lofi hip-hop, plus Shuffle all) picked on the main menu or in Settings. Ska-punk is the DavidKBD "Skank the Summer" pack (CC BY 4.0); playlists without files play a procedural jukebox in that style. See `game/public/music/README.md`.
- Menus: main menu (resort picker, snowboard or skis, music), Esc pause menu (resume, restart, map, settings, quit) and a shared settings panel for audio, graphics, controls (two bindings per action, grouped by context, clashes marked; old one-key maps migrate; standard-mapping gamepad support in `sim/Controls.ts`, FEAT-124), rider and game options, saved in localStorage.
- Touch controls on phones and tablets.

## Code layout

- `game/` the client (Three.js 0.172, TypeScript, Vite). `cd game && npm install && npm run dev`.
  - `src/pack/` pack loader, tiled height / mask sampling, bridge decks
  - `src/terrain/` quadtree LOD terrain and snow material
  - `src/sim/` rider physics, controls, collisions, lift riding, time trials, replay recording, Outrun, run stats (`RunStats.ts`)
  - `src/world/` trees, rocks, buildings, roads, bridges, lifts and lift-line mazes, landmarks, piste overlay, sky, sun, clouds, snow, rider model and ragdoll, cameras, the Outrun monster
  - `src/ui/` main menu, pause menu, settings, resort map, horizon labels, goggles, speed lines, Outrun HUD, touch controls, run card (`RunCard.ts`), shared speed / height / distance formatters (`Units.ts`)
  - `src/audio/` synthesised sound and the music player / jukebox
  - `public/music/` soundtrack, `playlist.json`, credits
- `pipeline/` data pipeline (Python, plus PowerShell fetch scripts for Windows)
- `raw/` downloaded source data (gitignored); the Vail download currently lives at `C:\Users\Drew\Documents\snowboard-sim\raw\vail`
- `packs/` generated resort packs (gitignored); the dev server serves them at `/packs/`
- `docs/` plans, handoff, board, research and data notes
- `tools/` repo helpers: `card_id.py` (next free card id, duplicate ids; set `PYTHONUTF8=1` on Windows), `gmaps2game.py` (Street View URL to an eye-camera link)

## Test tools (`game/tools/`)

- `shoot.mjs [pack] [outDir] [--headed | --gpu]` render and ride test, screenshots into `game/shots/`; `--headed` opens a visible window on the real GPU, `--gpu` runs headless on the real GPU (Windows). Also `npm run shoot` / `npm run shoot:headed`. Use `SHOT_QUERY="&lowgfx"` on software GPUs.
- `ridecheck.mjs [pack] [seconds] [--headed]` streaming and determinism check: a straight tuck run ridden twice; reports top speed, late tiles and tree cells, and whether run 2 matches run 1 exactly.
- `rider.mjs [pack] [outDir] [--headed]` rider close-up check: stand, tuck, carves, jump, crash and skis; records the worst boot-to-binding gap and saves side-view shots.
- `walkcheck.mjs [pack] [outDir] [--headed] [--ski]` on-foot check: unstrap, walk, sprint, turn, strap back in; prints speed, stamina, foot-IK gap and bootprint spacing.
- `outruncheck.mjs [pack] [outDir] [--gpu | --headed]` Outrun flow: chase, look back, the eat sequence.
- `views.mjs <pack> <outDir> <views.json> [--headed | --gpu]` stills from fixed free-camera spots for look checks (`views-*.json` in the same folder).
- `shoot_features.mjs` map, buildings, rocks and lift feature check.
- `probe.mjs` step timing probe for hangs.
- `brakecheck.mjs` brake physics on exact planes, no browser: hockey-stop time and distance against the snow-cutting targets, board swing, release, standing across the hill, ski snowplough, and the steer-modulated brake (FEAT-133: a harder stop into the edge, a skidded turn and a side-slip away from it, release onto the new line). Exits 1 on a failed check.
- `carvecheck.mjs` carve feel on exact planes, no browser (BUG-053): turn rate and radius at 25 m/s standing and tucked, edge-to-edge time and the hang at the crossover, turning back up across the hill, the slow pivot. Exits 1 on a failed check.
- `brakeshot.mjs [pack] [outDir] [--headed] [--ski]` hockey-stop render check: tucks to speed, holds brake, saves shots of the swing, spray and scraped track.
- `carveshot.mjs [pack] [outDir] [--headed] [--ski]` carve track render check (FEAT-109): tucks to speed, links hard carves, saves the knife-cut line close up, overhead and from 40 m down the run, and prints the edge amount per shot.
- `leadcheck.mjs [pack] [--headed] [--control]` body lead / board lag check (BUG-056): linked carves on the synthetic mountain; at each edge change prints the ms at which the shoulders' pose, the hips' pose, the body's inclination, the physics edge and the drawn board cross to the new side, and checks that order, that the drawn board never rolls past the physics edge and that the drawn yaw stays near the physics yaw. `--control` zeroes the leads and the lag to show the old look. Exits 1 on a failed check.
- `leancheck.mjs [pack] [outDir] [--headed] [--ski]` carve lean check (FEAT-126): a gentle turn, then hard linked carves; prints the lean, hip height and each body part's lowest point above the snow, and saves shots at the deepest toeside and heelside lean.
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
- `packwriter.py` shared pack writer (Terrarium height tiles, masks) used by `build_pack.py` and `synth_pack.py`.
- `terrain_ao.py` baked sky visibility (terrain ambient occlusion) from the DEM, used by the pack build.
- `ept_select.py <dataset> <depth_in_ski_area> <depth_in_buffer> [out.txt]` picks the EPT lidar nodes over a resort for the manifest (boxes are hard-coded for Breckenridge).
- `prep_textures.py [work_dir]` fetches the CC0 ambientCG rock and talus sets and writes the game's surface textures into `game/public/textures/`.

The data hosts (USGS, Planetary Computer, Overpass, Mapterhorn) are not reachable from cloud sandboxes; fetching runs on Drew's PC. Before touching raw data read [data/vail-raw-data-inventory.md](data/vail-raw-data-inventory.md). Pack layout: [pack-format.md](pack-format.md).

## URL parameters

- `pack=<slug>` resort pack to load (`vail`, `breckenridge`, `synth`)
- `x=&y=&h=` spawn in local metres with heading in degrees
- `cam=fp` start in first person
- `cam=eye&pitch=&fov=&eye=&spot=` still camera at eye height (default 1.7 m) over `x, y`, looking along `h` with `pitch` degrees up (negative is down) and `fov` vertical degrees; HUD and rider hidden, P saves the shot (into `docs/compare/` when `spot=<slug>/<view>` is set). Make these links from a Street View URL with `python tools/gmaps2game.py`.
- `time=now` or `time=16.5` override the time of day
- `weather=clear|cirrus|few|scattered|broken|overcast|flurries|storm` override the cloud cover; `valleyfog` forces valley fog on
- `rider=ski` or `rider=board`
- `debug` adds a HUD line with the edge angle, lateral acceleration, turn radius and turn rate, and sliders for the body lead / board lag chain (BUG-056)
- `lowgfx` reduced graphics for software GPUs; `headless` is used by the test tools; `csm` / `nocsm` force cascaded shadows on or off; `noimpostors` disables tree impostors; `bridgeguess` adds the segment-chord bridge detector

## Milestones

M0 pipeline (Vail) -> M1 terrain viewer -> M2 riding physics -> M3 trees and rock -> M4 lifts and landmarks -> M5 snow and atmosphere -> M6 second resort, timed runs, multiplayer.

M0 to M3 are done on the real Vail pack. M4 has rideable lifts, buildings, roads, bridges and labels. M5 has time of day, clouds, snowstorms and snow tracks. M6 has started: Breckenridge is playable from the resort picker, and time trials with ghosts are in. Open work is on the board.
