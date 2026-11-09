# Research: accurate far terrain (background mountains and forest) within budget

Researched 2026-11-09 for FEAT-153 (#345) after Drew's comparison from the Back Bowls gateway: in the real photo Blue Sky Basin is dark forest cut by white ski trails, in the game the same slopes are random speckle. The aim is a background that reads as the real place (forest edges, trails, bowls, rock, the right ridgelines) at the same or lower cost than today.

## 1. What the game does today (code facts)

- **Geometry.** `terrain/Terrain.ts` is a chunked quadtree over the far height set (262 km). Chunks split when `distance < size * 2.6`; the finest data is 1 m (`fine`, resort only, ±5.8 km), then 16 m (`mid`, 40 km square), then 128 m (`far`, 262 km square, Mapterhorn). Chunk builds are capped at 4 ms a frame while riding. Terrain is 300 to 900 draw calls of the 1,500 budget (`perf-check` skill).
- **Colour.** There's no terrain texture. Each vertex gets classes (rock, scree, groomed, forest) and `TerrainMaterial.ts` shades snow, rock and forest from them.
- **Where the classes come from.** Chunks at **8 m or finer** sample the 2 m pack mask (`useMask = !!pack.mask && res <= 8`), which carries the real lidar canopy with trails cut out. **Every coarser chunk** uses `proceduralForest(x, y, h, slope)`: trees below a noisy treeline (3,480 m ± 110 m), with value-noise "open patches" standing in for meadows and runs. That's the random look: from a few hundred metres out, even inside the resort, the real forest is thrown away.
- **Trees.** `world/Vegetation.ts` streams instanced trees per 1 km cell out to `NEAR_RADIUS` 1.5 km (3D) and `FAR_RADIUS` 4.5 km (impostor billboards, `Impostors.ts`). Beyond 4.5 km there are no trees, only the terrain's forest colour.
- **Heights.** The far set is a bare-earth-ish DEM, so forested ridges have no canopy on their silhouette: real ridgelines look "furry" against the sky, ours are smooth.

## 2. What makes a background read as accurate

In order of how much they matter from 2 to 30 km:
1. **Forest and open snow in the right places, with clean edges.** Trails, bowls, meadows, avalanche paths and the treeline. This is most of the recognisability (Vail's front side and Blue Sky are identified by their trail cuts).
2. **Ridgeline silhouettes.** Already right from the DEM; adding canopy height on forested ridges makes them read as treed.
3. **Rock bands and cliffs** on the high peaks (Gore Range, Holy Cross), dark against the snow.
4. **Aerial perspective.** Already in place (`Atmosphere.ts`): far forest goes blue-grey and loses contrast.
5. **Lighting consistent with the game's sun.** Baked satellite shading from another time of day looks wrong when the sun moves, so the background should be lit dynamically from classes, not from a photo.

Detail finer than a pixel doesn't matter: at 10 km a 1080p pixel covers about 10 m of ground with a 60 deg field of view, and at 30 km about 30 m. So **10 to 30 m data is enough for everything past about 5 km**, and 2 to 8 m for the 300 m to 5 km band.

## 3. Data sources for the classes

| Source | What | Resolution | Coverage | Licence | Use |
|---|---|---|---|---|---|
| Pack mask (ours, from 3DEP lidar + NAIP) | canopy, rock, scree, groomed | 2 m | the pack (±5.8 km) | ours | the real forest inside the resort at every distance (see 4.1) |
| OSM pistes (ours, via Overpass) | trail polygons and lines | vector | anywhere | ODbL (already attributed) | trails of Vail and neighbouring resorts as cleared strips |
| ESA WorldCover 2021 v200 | classes incl. 10 tree cover, 30 grassland, 60 bare / sparse, 70 snow and ice | 10 m | global, COG, EPSG:4326 | CC BY 4.0 (verify) | forest / open / rock outside the pack |
| ETH Global Sentinel-2 Canopy Height 2020 | canopy height | 10 m | global | CC BY 4.0 (verify) | canopy height for silhouettes and density outside the pack |
| Meta / WRI High Resolution Canopy Height | canopy height | 1 m | global | CC BY 4.0 (verify) | optional sharper edges in the 2 to 6 km band outside the pack |
| LANDFIRE EVT (already in the plan) | vegetation type | 30 m | US | public domain | species / aspen vs conifer tint at distance |
| Sentinel-2 L2A (winter dates) | real winter colour | 10 m | global | Copernicus (free, attribution) | **only as a check** or to find wind-scoured / bare areas; not baked in as colour (see 4.3) |

All fetches run on Drew's PC (`fetch.ps1`), like the rest of the raw data. WorldCover tiles are COGs, so the fetch reads only the window around the resort.

## 4. Options

### 4.1 Use the pack mask on coarse chunks (cheap, inside the pack)
Build a **mip pyramid of the 2 m mask** once per tile in the pipeline (or on load): 4, 8, 16, 32, 64 m levels, box-filtered. A chunk samples the level matching its vertex spacing, so a 32 m chunk gets the true average forest cover of its 32 m cell. Sharpen the forest channel a little after averaging (a contrast curve), so trail edges stay crisp instead of fading to grey.
- Cost: the levels add a third to the mask's size; sampling per vertex is what happens today.
- Fixes Blue Sky Basin from the Back Bowls (it's inside the pack).

### 4.2 A far class texture outside the pack (pipeline)
A new tile set, `farcls/`, on the **mid grid** (40 km square) at 16 m and on the **far grid** at 128 m, RGBA8: R forest cover, G canopy height (0 to 40 m), B rock / bare, A snow-free (meadow, town, water). Built in `build_pack.py` from WorldCover + ETH canopy height, with **OSM pistes of every resort in view** burned in as cleared, and the pack mask (4.1) taking over inside the pack.
- Size: mid 40 km / 16 m = 2,500 px square, about 6 MB raw, 1 to 2 MB as PNG. Far 262 km / 128 m = 2,048 px square, about 4 MB raw. Both tiled like the height sets and streamed with them (`request` on the same tiles), so nothing new to manage.
- Terrain vertices on coarse chunks read it instead of `proceduralForest`. `proceduralForest` stays only as a fallback before a tile has loaded.

### 4.3 Satellite colour texture (rejected as the main look)
Draping a real winter image (Sentinel-2 10 m, or NAIP) gives instant realism in screenshots, but:
- it has the satellite's own sun and shadows baked in (late morning, low winter sun: north faces black), which fights the game's moving sun and the storm / bluebird looks;
- winter scenes are often cloudy, and cloud-free winter mosaics aren't readily available, so we'd have to build one;
- it adds texture memory and streaming (a colour texture per chunk level).
Use satellite imagery to **classify** (or check) instead, and light the classes in the shader. That keeps the background consistent with the time of day and weather.

### 4.4 Canopy on the silhouette
Raise coarse-chunk vertices by `canopyHeight x forestCover x k` (k about 0.6 to 0.8, so dense forest lifts the surface about 15 to 25 m) where the chunk is **coarser than 16 m**, i.e. beyond the instanced trees. Ridges get a treed silhouette for free. Fade it in across the tree ranges, so it doesn't stack on top of the impostors. Normals come from the lifted heights, so the forest gets self-shading. Physics never sees it (coarse chunks are visual only; the rider is always on 1 m data).

### 4.5 Forest that reads as trees at middle distance (1.5 to 8 km)
Today the impostors stop at 4.5 km and the terrain colour takes over. Options:
- **Extend impostors** to 6 to 8 km on high settings, at lower density (one billboard per about 15 m of forest), with the count capped per cell. Cheap in draw calls (already one call per species), costly in vertices.
- **Shell / fur forest:** two or three alpha-tested shells above the terrain on coarse chunks, offset by the canopy height, with a noise texture of crowns. Gives a 3D tree texture on slopes at grazing angles for about 2 to 3 extra draws per chunk band. Commonly used for distant forests in flight sims, but adds draw calls (one per shell per chunk) and overdraw.
- **Shader-only crown texture:** in `TerrainMaterial.ts`, on forest pixels at distance, add a crown-scale noise and a darker "gap" pattern scaled with distance, so the colour mass isn't flat. Zero geometry cost.
Recommend the shader-only texture plus the silhouette lift first, extending impostors as a High setting.

### 4.6 Geometry LOD
The quadtree already gives distance-scaled detail. Two smaller improvements:
- **Geomorphing** (CDLOD style: blend each vertex between its own height and its parent's over the outer part of a chunk's range) removes popping when far chunks split, which is more visible once the colour has real edges.
- **Skirts / T-junctions:** keep as today.
Clipmaps (one grid per ring, heights in textures) would cut draw calls further, but it's a rewrite of `Terrain.ts`; not needed for this.

### 4.7 Texture formats and streaming
- The class tiles are data (sampled per vertex), so PNG on disk and a plain `DataTexture` / CPU array are fine. No KTX2 needed.
- If a colour texture is added later (e.g. a far albedo for the horizon ring), use KTX2 (Basis ETC1S) via `KTX2Loader`: about 6x to 8x smaller in GPU memory than RGBA8 and decoded in a worker.
- Keep decoding off the main thread (an existing note in the `perf-check` budgets: no main-thread task over 50 ms).

## 5. Recommendation (phased)

| Phase | What | Where | Cost | Card |
|---|---|---|---|---|
| 1 | Mask mip levels on coarse chunks inside the pack, sharpened forest edges, OSM trails burned into coarse forest | client (+ a small pipeline step for the levels) | none per frame; mask +33% size | FEAT-153 (#345) |
| 2 | `farcls/` tiles (WorldCover + ETH canopy height + OSM pistes of resorts in view) for the mid and far grids; `proceduralForest` only as a fallback | pipeline (fetch on Drew's PC), client sampling | about 2 MB more download, no new draw calls | DATA-019 (#346) |
| 3 | Canopy on the silhouette for chunks coarser than 16 m, faded across the tree ranges; crown-scale shader texture on distant forest | client | a few ALU per vertex / pixel | FEAT-153 (#345) |
| 4 | Geomorphing for coarse chunks | client | a few ALU per vertex | follow-up |
| 5 | Impostors to 6 to 8 km on High / Ultra | client | vertices; draw calls unchanged | follow-up |

Expected result: from the Back Bowls gateway, Blue Sky Basin shows its forest and trail cuts in the right places (phase 1), the Gore Range and Holy Cross show real rock bands and treeline (phase 2), and forested ridges read as treed against the sky (phase 3), with no new draw calls and a couple of MB of extra data.

## 6. Checks
- Compare shots (DATA-008): the Back Bowls gateway looking south, Vail's summit looking north at the Gore Range, the top of Breckenridge's Imperial looking north to Vail.
- `perf-check`: frame time and draw calls before and after each phase while tucking down a long run (the stream-heavy case).
- Watch for shimmering trail edges at distance (aliasing): the box-filtered levels and the slight edge sharpening should keep them stable; if not, sharpen less.

## Sources
- [ESA WorldCover (terrabyte docs: classes, 10 m, COG)](https://docs.terrabyte.lrz.de/datasets/esaworldcover/)
- [ESA WorldCover 2021](https://worldcover2021.esa.int)
- [ETH Global Sentinel-2 10 m Canopy Height (2020)](https://samapriya.github.io/awesome-gee-community-datasets/projects/canopy)
- [Lang et al., A high-resolution canopy height model of the Earth (arXiv)](https://www.arxiv.org/pdf/2204.08322)
- [Meta / WRI 1 m canopy height (GEE community catalog)](https://gee-community-catalog.org/projects/meta_trees/)
- [forestdata: downloading the ETH and Meta canopy height maps](https://www.rdocumentation.org/packages/forestdata/versions/0.3.0/topics/fd_canopy_height)
- [Open world in the browser, part 6: clipmaps and geomorphing](https://app.cinevva.com/blog/2026-02-25-open-world-browser-part-06-clipmaps.html)
- [Terrain geomorphing in the vertex shader (GameDev.net)](https://gamedev.net/tutorials/programming/graphics/terrain-geomorphing-in-the-vertex-shader-r1936)
- [terrain-cdlod (reference implementation)](https://github.com/tschie/terrain-cdlod)
- [three.js Basis Universal / KTX2 notes](https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/basis/README.md)
