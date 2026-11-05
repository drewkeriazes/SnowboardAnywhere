# Bonvo Ride teardown and build plan for a higher-fidelity resort sim

Written 2026-11-05, updated the same day after a live capture of the game in the browser. Covers (1) how bonvo.ski/en/ride works, (2) what "feels like you have been there" actually requires, (3) the data sources and pipeline that get us there for US resorts, (4) the renderer and physics design, (5) milestones and decisions.

Decisions made 2026-11-05: first resort is Vail; v1 is free ride only; the data pipeline runs through Drew's PC (`C:\Users\Drew\Documents\snowboard-sim`) because the cloud sandbox cannot reach the data hosts.

---

## 1. How Bonvo Ride works (verified by live capture, 2026-11-05)

Captured from `https://bonvo.ski/en/ride/vail?play=run` in the desktop app browser: window globals, canvas contexts, every network request, and the actual data payloads.

### Engine and app
- **Three.js r172** (`window.__THREE__ === "172"`), one WebGL2 canvas. No Babylon, PlayCanvas or Unity.
- Next.js app on Vercel (`/_next/static/chunks/app/[locale]/ride/[resortSlug]/(game)/page-*.js`). The game is a client component in that route.
- Supabase (`guylejsnnuhmbsmebzpj.supabase.co`) RPC `ride_play_tick` for the live player counter; `/api/ride/gate`, `/api/ride/proof`, `/api/ride/funnel` on the Next backend (anti-cheat gate, run proof submission, funnel analytics).
- Microsoft Clarity session recording, Google Tag Manager and GA4.
- Background music streamed from `tiles.bonvo.ski/music/v1/*.mp3`.
- Live weather from **Open-Meteo** (`api.open-meteo.com/v1/forecast?latitude=39.600&longitude=-106.347&current=temperature_2m,weather_code,snowfall,cloud_cover,wind_speed_10m,is_day&hourly=snowfall`). That drives sky, cloud cover, snowfall particles and day/night.
- Multiplayer (from the privacy policy): WebRTC, Google and Cloudflare STUN, Cloudflare TURN, an encrypted race-room relay on Cloudflare near the first player. Party rooms up to 16, public lobbies up to 10.

### Terrain: Mapterhorn tiles at zoom 13
- Requests: `https://data.bonvo.ski/data/v2/dem/mapterhorn-z13-c59b8db01ca5/tiles/13/{x}/{y}.webp` (their own re-host of Mapterhorn, 4 tiles for Vail: 1675-1676 / 3112-3113), plus `https://tiles.mapterhorn.com/12/{x}/{y}.webp` (6 tiles) and `https://tiles.mapterhorn.com/8/52/97.webp` for the background.
- Mapterhorn tiles are 512 px Terrarium-encoded WebP. At Vail's latitude a z13 512 px tile is about **7.4 m per pixel**, and the upstream source for Colorado is 10 m class data, so the ridable surface is roughly 10 m resolution. Cat tracks, benches, cornices and gullies do not exist at that scale. Our plan uses 1 m lidar, roughly 100x the detail per unit area.
- Runs carry a `demFit` block (`{dem: "mapterhorn-z13-c59b8db01ca5", maxDevM, climbM, maxPitchDeg, resolved}`), so they pre-fit every run to that DEM offline and flag ones that climb or deviate.

### Runs and lifts: OpenSkiData, re-hosted per resort
- `https://data.bonvo.ski/data/v2/releases/2026-09-22-f6378027/resorts/88a22ba23468cf120025366ef40f004c9043546e_runs.geojson` and `..._lifts.geojson`. The id is the OpenSkiData ski-area id for Vail (sources `openstreetmap way/531009607` and `skimap.org 507`). Vail: 229 run features, 32 lifts.
- Run properties are OpenSkiData's (`difficulty, convention, color, grooming, gladed, lit, oneway, patrolled, elevationProfile {heights[], resolution: 24.963}, sources`) plus bonvo additions: `featureRole` ("slope"), `isConnector`, `lengthM, dropM, topM, bottomM, avgGradePct, maxGradePct, elevationChainParts, _elevationCleaned, demFit`.
- Lift properties are OpenSkiData's (`liftType, capacity, duration, bubble, heating, occupancy`) plus `lengthM, topM, bottomM, verticalM`.
- Coordinates are `[lon, lat, ele]` 3D LineStrings. The `slope=<id>~N` in challenge links is a run id plus a segment index.

### Forest: a density raster from OSM polygons, not real trees
- `https://data.bonvo.ski/data/v2/forest/osm-forest-4d51194df042/{z}/{x}/{y}.bft` at z10 and z12.
- Format: gzip. Decompressed: magic `BFT1`, then `01 0c 00 02` (version 1, zoom 12, flags, 2?), then uint32 x=837, uint32 y=1556, then exactly 512*512 = 262,144 bytes. One byte per pixel, about 15 m per pixel at z12. It is a forest coverage/density mask rasterised from OSM `landuse=forest` / `natural=wood`. Tree instances are scattered procedurally inside it.
- Consequence: trail cuts exist only where OSM has mapped the piste as a gap in the forest polygon; glade density, tree islands and treeline are invented.

### Visual style
- Stylised low-poly: cartoon rider, flat-shaded conifers in blocky clusters, smooth untextured snow, pastel sky. Pleasant, but nothing in the scene is a landmark you would recognise.

### Game loop and controls
- Pick resort on a Mapbox world map or list, pick a run (difficulty filters), ride it timed from the top, or free ride with every lift and no clock.
- Keyboard: Left/Right steer, Up tuck (push on flats), Down brake, hold-release Space to jump, Shift grab, E boost. Touch: stick plus JUMP. Camera toggle, retry, pause.
- Modes: Play, Free ride, Challenge a friend (shared drop-in, shareable time card), Party (room code), Public lobbies, Weekly Cup, Arcade (missions, combos, unlocks).

---

## 2. What "feels like you have been there" requires

| Cue a rider recognises | Data that reproduces it |
|---|---|
| Skyline and ridgelines, bowl shapes, cornice lips, cliff bands | 1 m lidar DEM for the resort, 10 to 30 m DEM for 60 to 80 km of surroundings |
| Trail corridors cut through forest, exact width and curves, cat tracks | Lidar canopy height model shows every cut; 1 m DEM shows cat-track benches |
| Glade density, tree islands, where the trees thin out at treeline | Individual tree crowns segmented from the canopy height model |
| Aspen groves (white trunks, leafless in winter) vs lodgepole vs spruce/fir | LANDFIRE Existing Vegetation Type (30 m) plus NAIP near-infrared |
| Rock outcrops, scree, talus | NAIP summer imagery (low NDVI, grey/bright), slope > 35 deg, OSM bare_rock/scree/cliff |
| Lift lines, tower positions, top and bottom terminals | OSM `aerialway=*` ways, `aerialway=pylon` and `aerialway=station` nodes; OpenSkiData lift metadata |
| Base area, mid-mountain lodges, patrol huts | OSM building footprints, heights from lidar |
| Roads, I-70 in the valley, parking, the village | OSM highways, lidar |
| Named peaks on the horizon (Holy Cross, Gore Range from Vail) | OSM `natural=peak` with `ele` and `name` |
| Groomed corduroy on blues, chopped snow and moguls on blacks, wind-scoured ridges | OpenSkiData grooming flag plus procedural snow driven by aspect, slope, elevation |

---

## 3. Data sources (US resorts)

| Need | Source | Resolution | Access |
|---|---|---|---|
| Resort DEM | USGS 3DEP 1 m DEM (lidar-derived GeoTIFF, UTM, 10 km x 10 km tiles) | 1 m | TNM Access API (`tnmaccess.nationalmap.gov/api/v1/products`, dataset "Digital Elevation Model (DEM) 1 meter", bbox) or the public `prd-tnm` S3 bucket. Fallback: 3DEP 1/3 arc-second (~10 m). |
| Canopy / trees | USGS 3DEP lidar point clouds as Entwine Point Tiles (`usgs-lidar-public` S3, index `usgs.entwine.io/boundaries/resources.geojson`) | 2 to 8 pts/m2 | Read only the resort bbox from the EPT hierarchy; DSM minus DTM = canopy height model; local maxima = tree positions and heights |
| Tree species | LANDFIRE EVT | 30 m | landfire.gov; classify aspen / lodgepole / spruce-fir / krummholz |
| Imagery | NAIP 4-band (RGB + NIR), leaf-on summer | 60 cm to 1 m | Microsoft Planetary Computer STAC (`collection=naip`) |
| Rock / scree / meadow masks | NAIP NDVI + brightness + slope, unioned with OSM `natural=bare_rock|scree|cliff` | 1 m | Computed in the pipeline |
| Runs, lifts, resort stats | OpenSkiData GeoJSON | vector | `tiles.openskimap.org/geojson/*.geojson`, daily |
| Towers, stations, buildings, roads, water, peaks | OpenStreetMap via Overpass (bbox) | vector | Overpass API |
| Background terrain | Mapterhorn z10 to z12 (same as bonvo) or 3DEP 1/3 arc-second | 10 to 30 m | `tiles.mapterhorn.com/{z}/{x}/{y}.webp`, Terrarium |
| Live weather (later) | Open-Meteo (same as bonvo) | n/a | free API |

Coverage: 3DEP 1 m lidar covers Eagle County (Vail), Summit County (Copper, Breck, Keystone, A-Basin) and Routt County (Steamboat). Check each new resort against the 3DEP index before assuming 1 m.

---

## 4. Offline pipeline: one resort in, one static "resort pack" out

Fetch scripts run on Drew's PC (Node, no installs). Processing (Python: rasterio, numpy, scipy, shapely, pyproj, laspy) runs in the cloud session on the staged raw files. Everything is in local metres (UTM) relative to a resort origin so the game never deals with lat/lon.

1. Resort bbox = OpenSkiData ski-area polygon buffered 1.5 km; background bbox = 80 km radius.
2. Mosaic the 1 m DEM; fill voids; resample to a 1 m grid aligned to the origin; downsample a 30 m background grid.
3. Lidar EPT for the bbox: DSM and DTM, canopy height model, crown segmentation (local-maximum filter with height-dependent window), tree instances: x, y, z, height, crown radius, species id.
4. NAIP: NDVI and brightness, 1 m class masks (conifer, aspen, meadow, rock, scree, water, built), unioned with OSM landcover. Species per tree from LANDFIRE and NDVI.
5. OSM: pistes, lifts (ways, pylons, stations), buildings, roads, water, peaks. Building heights from lidar.
6. OpenSkiData runs and lifts for this ski area joined to OSM ways by source id.
7. Snow layer: groomed-piste mask (grooming flag, corridor width from the canopy gap), wind-scour from aspect and exposure, depth from elevation.
8. Pack:
   - `terrain/z{0..3}/{x}_{y}.png`: 16-bit heightmap tiles, 512 px, 1 m / 2 m / 4 m / 8 m, plus `background.png` at 30 m.
   - `masks/{x}_{y}.png`: RGBA splat weights (snow, rock, scree, meadow) and detail controls (groomed, wind-scour, depth).
   - `trees.bin`, `rocks.bin`: packed instances.
   - `features.json`: runs, lifts (tower positions, cable spans, stations), buildings, roads, water, labels.
   - `meta.json`: origin, bounds, UTM zone, default sun, attributions.
9. Validate: top-down render of the pack vs NAIP and the official trail map; tree counts on a known glade; run polylines within 1 m of the DEM.

Pack size target for Vail: roughly 60 to 120 MB, streamed by tile.

---

## 5. Renderer and physics (Three.js, TypeScript, Vite)

Rendering
- Terrain: chunked quadtree LOD, heightmaps sampled in the vertex shader, skirts, geomorphing.
- Materials: splat-mapped snow / rock / scree / meadow with triplanar projection on steep faces, corduroy on groomed pistes, chop and moguls on ungroomed blacks, wind-scoured ridge texture, sparkle on sunlit snow.
- Trees: GPU instancing, 3 LODs plus billboard impostors beyond ~400 m; snow-loaded conifers, leafless white-trunk aspen, krummholz near treeline. Real positions and heights.
- Rocks: instanced outcrop and talus meshes on the rock mask, oriented to the slope normal.
- Lifts: towers at real pylon positions, catenary cables, moving chairs or cabins, terminals. Rideable in free ride.
- Buildings and roads: extruded footprints, draped road ribbons, snow on roofs.
- Sky: physically based sky, sun from date and time, aerial perspective, clouds, snowfall.
- Shadows: cascaded shadow maps so trees shadow the pistes in the morning.

Physics (fixed 120 Hz)
- Rider as a point mass with a board heading; height and normal from bilinear heightfield samples.
- Edge model: lateral grip rises with edge angle and falls with speed; under the limit the board carves, over it the board skids with spray and speed loss.
- Inputs: steer, tuck (lower drag, less steering), brake (skid), hold-release jump, grab and spin in the air, landing penalty by angle between velocity and slope plane.
- Surface modifiers from the masks: groomed, chop, powder (speed-scaled drag and float), ice on wind-scoured aspects.
- Collisions: spatial hash of trunks (cylinders) and rocks (capsules).
- Camera: chase camera with lag, FOV widens with speed, drops in a tuck.

Networking (later): WebRTC data channels plus a small relay, 20 Hz snapshots with interpolation.

---

## 6. Where this beats Bonvo Ride

- 1 m terrain instead of ~10 m, so cat tracks, gullies, benches and cornice lips exist.
- Real trees at real positions and heights with the right species, instead of scatter inside a 15 m OSM forest mask.
- Real rock outcrops and cliff bands.
- Lift towers, terminals, lodges, roads and the village as landmarks.
- The real horizon with the real peaks in the right places.
- Snow that respects grooming, aspect and elevation.
- Fewer resorts, each done properly.

---

## 7. Milestones

- M0 Pipeline for Vail: DEM, canopy trees, masks, OSM features, OpenSkiData runs, packed and validated.
- M1 Terrain viewer: streaming LOD terrain, sky, sun, background ring, fly camera.
- M2 Riding: physics on the heightfield, chase camera, keyboard and touch, drop-in anywhere.
- M3 Vegetation and rock: instanced trees with LODs, rocks, collisions, shadows.
- M4 Landmarks: lifts with cables and chairs, buildings, roads, labels. Rideable lifts.
- M5 Snow and atmosphere: groomed vs ungroomed, powder, time of day, weather.
- M6 Second resort from the same pipeline, then timed runs and multiplayer.
