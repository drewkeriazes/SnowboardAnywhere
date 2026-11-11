# Research: what to build next (feature opportunities)

Researched 2026-11-10 (FEAT-193). Question: given what SnowboardAnywhere already has, what is the most valuable thing to add next? Not benchmarked against Bonvo Ride.

Method: read `main` at 30a335a (README, HANDOFF, developer guide, research docs, the 309 issues on the board), ran the client, then ranked candidates by player value per hour of work. Only ideas that are NOT already a card, or are a cheap slice of an open card, are proposed as new work. Things already on the board are named with their card id.

## 1. What we have

### What I ran (cloud sandbox, 2026-11-10)
- `npx tsc --noEmit`: clean. `npx vite build`: clean (1.23 MB JS, 387 KB gzip).
- `python pipeline/synth_pack.py packs/synth`: built (182,632 trees, 133,778 shrubs, 9.7 ha moguls).
- `node tools/shoot.mjs synth`: first still `01_start.png` rendered correctly (rider on groomed snow, carve tracks, forest band, lift cable, sky). Later segments ran past 9 min under SwiftShader and were stopped; that is the known software-GPU slowness (HANDOFF), not a bug.
- Not run: the real Vail pack. Packs are not in git and the sandbox cannot reach Drew's PC folders (no connected folder this session). Real-pack status below comes from HANDOFF, the closed cards and the compare set, not from my own ride.
- Cloud note: the repo's `playwright` 1.64 wants a browser build the sandbox cannot download; moving `game/node_modules/playwright*` aside makes `tools/browser.mjs` fall back to `/opt/npm-tools` and it works. Not worth a card.

### What we have table

| Feature | Status | Evidence |
|---|---|---|
| 1 m lidar terrain, 262 km far ring, LOD | Working | `game/src/terrain/Terrain.ts`; HANDOFF "What works"; compare set says terrain matches at all 14 spots |
| Trees from lidar crowns, 8 species, impostors, snow flocking | Partial | FEAT-156/157/158 closed; forest still too sparse in closed stands (BUG-027 #115, BUG-028 #118, FEAT-074 #121 open); Breck far too few (BUG-079 #433) |
| Rocks, cliffs, snow burial | Partial | `rockShader.ts`, FEAT-020 closed; FEAT-069 #106 (too much grey rock) open |
| Moguls from grooming, slope, aspect | Working | `game/src/terrain/Moguls.ts`, FEAT-059/147 closed; BUG-067 #358 (The Slot) open |
| Rider physics: carve, skid, brake, fall line, switch, presses | Working | `game/src/sim/Rider.ts`, `tools/carvecheck.mjs`, `fallcheck.mjs`, `brakecheck.mjs` |
| Jumps, flips, spins | Partial | FEAT-110 closed; BUG-055 #293 (jumps too high), tricks epic FEAT-186 to 192 just carded |
| Lifts: towers, cables, chairs, gondolas, ride them up, lift lines | Working (gondola view broken) | `world/Lifts.ts`, `sim/LiftRide.ts`; BUG-058 #301 open |
| Buildings, roads, bridges, landmarks (Back Bowls gate) | Working | `world/Buildings.ts`, `Landmarks.ts`, FEAT-071/132/143 closed |
| Peak, town, lift and run labels | Working | FEAT-007, FEAT-014 closed, `ui/Labels.ts` |
| Sky, sun from date and time, clouds, 8 weather presets | Working (manual only) | `ui/Settings.ts:28` (`clouds`), `world/SunClock.ts:26` (`?time=now` live clock) |
| Live real weather | Missing | No Open-Meteo call anywhere in `game/src` (grep); request already designed in `lifts-weather-and-sun.md` section 3 |
| Snow conditions change the ride (powder, chop, ice, slush) | Working | `sim/SnowConditions.ts:20` |
| Tracks, deformable snow, spray, bootprints | Working | FEAT-031/044 closed, `world/Deform.ts`, `Tracks.ts` |
| Cameras (7), replay viewer with photo view, rewind | Working | `world/ChaseCamera.ts:15`, `states/ReplayState.ts:30` (P photo, H clean) |
| Run stats, current run name on the HUD, day summary | Working | `sim/RunStats.ts:39` (`current`), `ui/HudLine.ts:34`, FEAT-055 closed |
| Map, minimap, drop-in anywhere | Working | `ui/ResortMap.ts`, FEAT-001/002/030 closed |
| Time trials with your own ghost | Working | `sim/TimeTrial.ts:12` (`GhostSample`), `world/TrialWorld.ts` |
| Outrun (yeti chase) | Working | `sim/Outrun.ts`, `modes/OutrunMode.ts` |
| Menu ghost riders | Working | `tools/ghost_lines.mjs`, PR #435 |
| Keyboard, gamepad, DualSense, touch controls | Working (touch is basic) | FEAT-124/137/015 closed; FEAT-063 #96 (touch and mobile) open |
| Audio: carve sounds, music stations | Working | `audio/`, FEAT-017/026/033 closed |
| Host on the home network | Working | `game/tools/host.mjs` (Vite `preview`), FEAT-138 closed |
| Exploration goals, challenges | Missing (carded) | FEAT-056 #88, planning only |
| Shareable ghosts / challenge links | Missing (carded) | FEAT-050 #82 |
| Multiplayer | Missing (carded) | FEAT-021 #37 |
| Real GoPro run as a ghost (ShredFinder) | Missing, NOT carded | No card on the board; ShredFinder has no `ghost` command yet (repo last commit 2026-03-23); plan in `shredfinder-ghost-and-gps.md` |
| Route finding ("get me to Blue Sky") | Missing, NOT carded | Course wayfinding exists for trials only (FEAT-035) |

### Data we own and are not using yet
| Asset | Where | Used today | Unused potential |
|---|---|---|---|
| GoPro HERO11 footage, 10 Hz GPS + CORI | Breck on `M:\GoPro\`, Vail and Park City in the GoPro cloud (`shredfinder-ghost-and-gps.md` section 5) | No | Ghost of a real run, physics tuning against real speeds, synced video |
| OpenSkiData / OSM runs and lifts with stations | `features.json` (`runs[].points`, `lifts[].stations`) | Drawing, labels, run stats | A run-and-lift graph: routing, "ridden every run", lift-to-run links |
| GNIS and OSM names | pack labels | Horizon labels | Goals ("reach every named peak"), part of FEAT-056 |
| Open-Meteo (free, no key) | not fetched | No | Today's real weather and snow |
| OSM public GPS traces (~450k points in the Vail box) | not fetched | No | Heat map of real lines; low player value, skip for now |
| LAN host server | `tools/host.mjs` | Serving the build | The relay for local multiplayer |

## 2. Candidates

Effort: S = a day or less of session work, M = a few days, L = a week or more. Value is for a player who knows the real resort (Drew, family, friends who have been there).

| # | Feature | Why a player cares | What we already have | Effort | Risk / unknowns |
|---|---|---|---|---|---|
| 1 | **Live conditions**: Weather "Live" pulls today's weather and recent snow for the resort | "It's dumping at Vail right now, and it's dumping in the game" | Weather presets, snow conditions, `?time=now`, request and WMO table designed | S | API down or offline (fall back to manual); elevation choice |
| 2 | **Mountain logbook**: runs and lifts you've ridden, coloured on the map, % of the mountain | The Slopes-app itch: tick off every run at Vail | `RunStats.current`, run lines in `features.json`, the map | S to M | Run matching on short or overlapping runs |
| 3 | **Ride your real day**: a ShredFinder GoPro run as a ghost (plus that day's weather) | Ride next to yourself on the exact line you rode in 2024 | `GhostSample` + ghost renderer, ShredFinder parser, plan doc, footage | M | GoPro cloud copies may lack telemetry (unverified); GPS jitter |
| 4 | **LAN multiplayer**: friends on the home network see each other ride | Ride Vail with family from two PCs | `npm run host`, second `RiderView` proven by ghosts | M | Vite server hook details (unverified), extra rider cost |
| 5 | **Route finder**: pick a run, lodge or lift on the map, get the way there | Learn the real mountain before a trip ("how do I get to Blue Sky?") | Runs, lifts, trial wayfinding arrow and beacon | M | Gaps in OSM run ends need snapping |
| 6 | Shareable ghost files (FEAT-050, carded) | Send a time to a friend | Ghost samples | S to M | Low value until others play |
| 7 | Generated challenges (rest of FEAT-056, carded) | Reasons to roam: biggest drop, longest tree run | DEM, canopy, run stats | M | Tuning what counts as a "line" |
| 8 | Trick scoring and trick book (FEAT-186 to 192, carded) | Arcade replay value | Flips, spins, grabs partly | L | Big design surface |
| 9 | Forest density fix (BUG-027, BUG-028, FEAT-074, carded) | Biggest realism gap in the photo pairs | Pipeline, compare harness design | M to L | Render budget |
| 10 | Touch and mobile (FEAT-063, carded) | Play on a phone or tablet | Touch controls exist | L | Mobile GPU budget |
| 11 | Wind and blowing snow (FEAT-060, carded) | Ridgetop feel | Live wind feeds it once #1 exists | M | Shader cost |
| 12 | Synced GoPro video picture-in-picture | Watch the real clip while the ghost rides | Comes after #3 | S after #3 | Video file size in the browser |
| 13 | Physics tuning from real GoPro speeds | Realistic speeds per run | Comes after #3 | S after #3 | Needs several real runs |
| 14 | OSM GPS heat map | See where people really ride | Nothing fetched | M | Licence check, low player value |

### Ranking (player value per hour)
1. Live conditions (#1)
2. Mountain logbook (#2)
3. Ride your real day (#3)
4. LAN multiplayer (#4)
5. Route finder (#5)

Quick wins (S effort, high value): **Live conditions** and the **logbook core** (ridden runs saved and coloured on the map; the generated challenges stay in FEAT-056).

Honest note: the single biggest *realism* gap is still forest density (#9, already carded with a plan in `compare-findings-roadmap.md`). If the goal is "feels like you've been there", that pipeline work is worth more than any new feature here. The list above is the best *new* player-facing value.

## 3. Top 5, researched

### 3.1 Live conditions (S)

How it works
- One HTTPS GET to Open-Meteo at load and every 15 min. Free, no key for non-commercial use, browser calls work (Bonvo calls the same endpoint from the page, see the verified capture in the plan doc).
- Map `weather_code` and `cloud_cover` to our `clouds` presets, recent `snowfall` to powder depth, temperature to slush or ice.

Build steps
1. `game/src/ui/Settings.ts:28`: add `'live'` to `clouds`; `SettingsRows.ts:176`: add a "Live (today at the resort)" option. When `live`, also force the sun to `now` (`SunClock.live()` already supports it).
2. New `game/src/world/LiveWeather.ts` (~80 lines): build the URL from `meta.lonlat` (already in `meta.json`, pack-format line 169; the lat/lon only touches the URL, never the renderer), `elevation` = mid-mountain height from the pack, `current=weather_code,cloud_cover,snowfall,temperature_2m,wind_speed_10m,is_day`, `hourly=snowfall&past_days=3`. Cache the JSON in `localStorage` for 15 min inside try/catch.
3. Map to presets (from the existing table in `lifts-weather-and-sun.md` section 3): 0 to `off`, 1 to `few`, 2 to `scattered`, 3 to `overcast` (or `broken` under 85 % cover), 45 and 48 to `overcast`, 71/77/85 to `flurries`, 73/75/86 to `storm`.
4. Snow: sum of hourly `snowfall` over the last 48 h (cm) sets the powder bias in `SnowConditions` (0 to 5 cm groomed, 5 to 15 cm some powder off-piste, over 15 cm deep powder off-piste); temperature above 1 C sets slush; over 3 days dry and below -5 C nudges wind-scoured aspects to ice.
5. A one-line toast on load: "Live at Vail: -6 C, light snow, 14 cm in 48 h". Settings show "Live: <time fetched>" or "Live: offline, using Bluebird".
6. README (Weather row) and developer guide (new file, URL param `?weather=live` if added).

References
- Request, units and WMO mapping: `docs/research/lifts-weather-and-sun.md` section 3 (already researched).
- [Open-Meteo forecast API docs](https://open-meteo.com/en/docs): every hourly variable is also available as `current`; `snow_depth` is hourly in metres; `past_days` 0 to 92; `elevation` controls downscaling (default from a 90 m DEM).

What could go wrong
- No network: keep the last cached reading, else fall back to the saved preset. Never block loading on the fetch.
- Model snowfall at a 90 m grid point can under-read ridge storms. Tolerable for a game.
- `snow_depth` is model snowpack, not the resort's reported base. Use snowfall, not depth, for powder.

### 3.2 Mountain logbook (S to M; the core slice of FEAT-056)

How it works
- `RunStats` already knows the named run under the rider (`current`, refreshed every 0.5 s within `RUN_NEAR`). Count a run as ridden once the rider has covered most of its length on it; count a lift as ridden when a `LiftRide` completes.
- Save per resort in `localStorage`. The map paints ridden runs bright and the rest dim, with "Vail: 41 of 217 runs, 9 of 31 lifts".

Build steps
1. `sim/RunStats.ts`: while `current` is a run, accumulate distance along that run's polyline (project the rider onto the run line, track min and max arc length). Ridden = covered arc span at least 70 % of the run's length, or 400 m for long runs. Emit `runRidden` on the event bus (`core/Events.ts`).
2. New `session/Logbook.ts` (~60 lines): `{ runs: {name: firstDate}, lifts: {...} }` under key `logbook:<slug>`, try/catch like `Settings.ts:195`.
3. `ui/ResortMap.ts`: draw ridden runs at full colour, unridden at 35 % alpha, totals in the corner. Toast on a new run ("New run: Riva Ridge, 42 of 217").
4. Zones (Back Bowls, Blue Sky Basin, Front Side): a small hand list in `pipeline/resorts/vail.json` or polygons from the OSM `landuse=winter_sports` areas later. Optional for v1.
5. FEAT-056 keeps the generated line challenges; this card closes its "ride every lift / all runs in a zone" part.

References
- [Slopes app summary (Mountainwatch)](https://www.mountainwatch.com/?p=34678): per-run speed, vertical and distance, lift time, run replay on a map, friends and a season leaderboard. That run-and-map logbook is the part that maps onto our data.

What could go wrong
- OSM splits one named run into several ways and some names repeat (354 ways, 217 names at Vail). Key the logbook by name, sum the arc coverage across ways of the same name.
- Short connector runs get ticked by accident. Ignore runs under 150 m and cat tracks for the totals.
- Drop-in teleport makes it trivial to tick runs. Fine: it's a sandbox, not a contest.

### 3.3 Ride your real day: GoPro ghost (M)

How it works
- ShredFinder already parses GPMF (HERO11, 10 Hz GPS9, plus CORI orientation). Export the riding segments, convert lat/lon to pack metres with the pack origin, smooth, drop onto the DEM (GPS altitude is useless, measured 120 m swings), resample to 10 Hz and write the game's existing `GhostSample` shape (`sim/TimeTrial.ts:12`). The game then replays it with the time-trial ghost renderer that already exists.

Build steps
1. ShredFinder (separate repo): keep `GPSF`/`GPSP` as `fix`/`dop` columns, add `shredfinder ghost <mp4> -o ride.json` (raw GPS, segments, events). Fix the `gpx_export.py` lat 0 / lon 0 waypoint bug. As of 2026-11-10 none of this is in the ShredFinder repo yet.
2. `pipeline/ghost_build.py <ride.json> <slug>`: filter fix < 2 or dop > 5, pyproj to the pack CRS minus `meta.origin`, Savitzky-Golay over about 1.5 s, z from the 1 m DEM, ballistic hop on detected jumps, heading from the path, write `packs/<slug>/ghosts/<id>.json` as `GhostSample[]` plus `{date, camera, clip}`.
3. Game: a "Real rides" list in the free ride menu (`ghosts/index.json`); pick one, drop in at its start, the ghost starts when you move (reuse `TrialWorld`'s ghost `RiderView`). Draw its line on the map and minimap.
4. Same-day weather: Open-Meteo's historical API for the ride date (`past_days` only reaches 92 days back, so 2024 rides need the archive API) sets the clouds preset and sun date. Reuses 3.1's mapping.
5. Later: video picture-in-picture from the same clock (#12), real speeds per run vs `rider-physics.md` targets (#13), body lean from CORI.

Start with Breckenridge, not Vail: the Breck originals sit on `M:\GoPro\Breck Day 1\` (camera originals, telemetry intact) and the Breck pack exists. Vail clips are only in the GoPro cloud.

References
- Plan, file contents and footage locations: `docs/research/shredfinder-ghost-and-gps.md` (2026-11-06).
- [gopro-telemetry (npm, ISC)](https://npmjs.com/package/gopro-telemetry): picks the best GPS stream (GPS5 or GPS9) and exports GPX, GeoJSON or CSV. A fallback if ShredFinder's parser falls short; Node only per its README (browser use unverified).
- [GPMF format overview](https://cineform.blogspot.com/2017/05/gpmf-gopros-metadata-format.html).

What could go wrong
- GoPro cloud downloads may strip the telemetry track. Unverified: a GoPro support thread is titled "Lost GPS data after upload-download to and from GoPro Cloud" ([thread](https://community.gopro.com/t5/Cameras/Lost-GPS-data-after-upload-download-to-and-from-GoPro-Cloud/td-p/333189)) but the page would not load to read the answer. Test one Vail download with `ffprobe` before pulling more.
- GPS at 10 Hz wanders 2 to 5 m; the ghost can clip tree trunks at the edges of glades. It is a ghost with no collisions, so it only looks odd. Snap toward the run centreline only when within 15 m (plan step 4).
- The lidar is from 2016 and runs have changed (Sun Down realigned 2022), so a 2024 line can cross a "forest" that is now a run.

### 3.4 LAN multiplayer (M; the home-network slice of FEAT-021)

How it works
- `npm run host` already serves the game to other PCs on the network. Add a tiny WebSocket relay in that same Node process: each client sends its rider state 15 times a second; the relay forwards to everyone else in the same pack. Each client draws the others as extra `RiderView`s with a name tag, interpolating about 200 ms behind. No shared physics, no collisions, no server authority (as FEAT-021 already scopes).

Build steps
1. `game/tools/host.mjs`: after `preview()` returns, attach `ws` (`new WebSocketServer({ noServer: true })`) to the preview server's `httpServer` `upgrade` event on path `/mp`. Rooms keyed by pack slug. Add `ws` as a devDependency (host is a dev tool).
2. New `game/src/session/Net.ts`: connect to `ws(s)://<host>/mp` only when the page was served by `npm run host` (`import.meta.env.VITE_HOST_NAME` is set there, `host.mjs:19`). Send `{id, name, colour, t, x, y, z, h, lg, e, f, lift}` reusing the `GhostSample` fields at 15 Hz.
3. New `game/src/world/RemoteRiders.ts`: one `RiderView` per peer (as `TrialWorld` does for the ghost), a 200 ms interpolation buffer (Hermite with the sent speed, or linear to start), names via `ui/Labels.ts`, dots on the minimap.
4. Lift rides: send the lift id and carrier position so peers on chairs sit on chairs.
5. README: "Ride together on the home network".

References
- [Gaffer On Games, Snapshot Interpolation](https://gafferongames.com/post/snapshot_interpolation): about 3x the packet interval of buffer (300 ms at 10 Hz, about 150 ms at 30 Hz); Hermite with velocity removes the jitter that linear shows at low rates.
- [Colyseus Vite plugin](https://docs.colyseus.io/server/vite): shows a game WebSocket server sharing Vite's own HTTP server and port. Which hook it uses and how it keeps clear of Vite's HMR socket: unverified (the page does not say). In `preview` mode there is no HMR socket, which makes our case simpler.

What could go wrong
- Each remote rider is a full skinned `RiderView`; 3 to 4 peers should be fine, 16 would not. Cap the room at 6 for v1; FEAT-182's instanced far riders are the path beyond.
- Over `--https` the socket must be `wss` on the same port; same self-signed cert, so it should just work. Unverified.
- Windows Firewall already allows Node for hosting, so no new setup.
- Internet play (outside the house) needs a hosted relay or WebRTC (FEAT-021 proper). Out of scope here.

### 3.5 Route finder (M)

How it works
- Build a directed graph once at load: run polylines go downhill (from high end to low end), lifts go from bottom station to top station. Connect any run end or lift station to any other run or lift point within about 40 m (OSM run ends often stop short of each other). Dijkstra by time (run length over a cruise speed, lift length over its line speed), pick a target on the map, show the route.

Build steps
1. New `game/src/sim/RouteGraph.ts` (~150 lines): nodes from run ends and points every 50 m, lift stations; edges along runs (downhill only, using the pack's z), lifts (up only), and transfer edges for gaps under 40 m. A binary-heap Dijkstra in plain TS, no library.
2. `ui/ResortMap.ts`: right click (or a "Go to" menu item) on a run, lift or named building sets the target; draw the route on the map and minimap.
3. Reuse the time-trial wayfinding (FEAT-035: route line, arrow, finish beacon) for the in-world guidance, with re-routing when the rider leaves the route by over 60 m.
4. Difficulty filter ("greens and blues only") as an edge weight multiplier, so a beginner route avoids blacks.
5. Validation: from Born Free's top, the route to Belle's Camp (Blue Sky) should go via the Back Bowls and a lift, as the trail map does. Add a node check (`tools/routecheck.mjs`) with three or four known routes.

References
- [Ski Nav, a routing app from OSM pistes and lifts (OSM diary)](https://www.openstreetmap.org/user/jancellor/diary/391208): the two real problems are missing joins at hubs (they add artificial connections) and wrong directions (they use elevation to flip ways that go uphill). Their snapping distance is not given.
- [OsmAnd ski routing](https://download.osmand.net/docs/user/navigation/routing/ski-routing) and [WikiProject Piste Maps](https://wiki.openstreetmap.org/wiki/WikiProject_Piste_Maps) for how OSM tags pistes and aerialways.

What could go wrong
- The 34 groomed Vail trails with no OSM line (DATA-013 #137) leave holes; the transfer edges hide some of them, the rest route around.
- Big open bowls have few run lines, so routes through the Back Bowls will look like they follow one run. Acceptable for v1.
- 40 m transfers can bridge across a cliff band. Reject a transfer when the DEM drop along it is over 15 m or the max slope is over 45 degrees.

## 4. Recommended order
1. Live conditions (a day; makes every session feel current).
2. Logbook core (a day or two; gives free ride a reason to roam).
3. Ride your real day, starting with a Breck clip from `M:` (unique to this project; needs ShredFinder work first).
4. LAN multiplayer (once the house wants to ride together).
5. Route finder (before the next real trip).

## Sources
- [Open-Meteo forecast API docs](https://open-meteo.com/en/docs)
- [Slopes app features (Mountainwatch)](https://www.mountainwatch.com/?p=34678)
- [Steep review summary (VaporLens)](https://vaporlens.app/app/460920/steep™): players liked free roaming and riding with friends; disliked always-online and repetition. Supports offline-first features and the logbook and multiplayer picks.
- [gopro-telemetry (npm)](https://npmjs.com/package/gopro-telemetry)
- [GPMF format (CineForm blog)](https://cineform.blogspot.com/2017/05/gpmf-gopros-metadata-format.html)
- [GoPro support thread on GPS lost via GoPro Cloud](https://community.gopro.com/t5/Cameras/Lost-GPS-data-after-upload-download-to-and-from-GoPro-Cloud/td-p/333189) (title only, page did not load)
- [Gaffer On Games: Snapshot Interpolation](https://gafferongames.com/post/snapshot_interpolation)
- [Colyseus Vite plugin](https://docs.colyseus.io/server/vite)
- [Ski Nav routing (OSM diary)](https://www.openstreetmap.org/user/jancellor/diary/391208)
- [OsmAnd ski routing](https://download.osmand.net/docs/user/navigation/routing/ski-routing)
- [WikiProject Piste Maps](https://wiki.openstreetmap.org/wiki/WikiProject_Piste_Maps)
- Repo: `docs/HANDOFF.md`, `docs/research/lifts-weather-and-sun.md`, `docs/research/shredfinder-ghost-and-gps.md`, `docs/research/compare-findings-roadmap.md`, issues #1 to #458
