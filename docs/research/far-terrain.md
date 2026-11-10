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

## 7. From high up (FEAT-154, #347)

Researched 2026-11-09 after FEAT-153 and DATA-019 landed, for the FEAT-128 menu backdrop: Vail from 500 to 900 m up showed soft grey blobs over the far terrain, open bowls included, and grey forest on sunlit slopes. All stills here are from `game/tools/aerial.mjs` on Drew's GPU (RTX 2070 SUPER), clear weather, the default sun, at three poses:

| Pose | Eye camera |
|---|---|
| Back Bowls gateway | x -727, y 524, heading 170, pitch -22, 700 m up |
| Front side from the northeast (across I-70) | x 2600, y 7200, heading 220, pitch -14, 600 m up |
| Blue Sky looking north (over the Back Bowls to the Gore Range) | x 1100, y -3600, heading 355, pitch -12, 800 m up |

Before and after: `docs/renders/2026-11-09-feat154-*.jpg`.

### 7.1 Which term makes the blobs
Each term switched off in turn (`uDebugFar` in `TerrainMaterial.ts`, plus `uAO` and the shadows setting), same poses:

| Term off | Effect from the air |
|---|---|
| Forest darkening (`fd`) | **The blobs go.** The bowls turn white with the drawn tree clumps on them; but the dense forest past the trees (Blue Sky, the front side, the ranges) goes white too, so the term is needed, just not as it was. |
| Rock and talus | Only the hard-edged dark patches on steep faces (mostly outside the pack) go. Not the blobs. |
| Baked AO | Barely visible from the air (it fades out by 5 km). |
| Snow drift normals | No visible change at these distances. |
| Shadows | Only the near trees' own shadows. |

A red tint of the darkening showed what was wrong with it:
1. **Sunlit timber read mid grey, not dark.** The darkened ground takes the full sun like the snow beside it. With an albedo of about 0.15 (timber 0.05 plus the 10% of snow mixed in, which outweighed the timber itself), a sunlit slope tone-maps to grey. Real sunlit conifer canopy is mostly shaded needles and the shadow sides of crowns, so it stays dark. The geometric-optical canopy models (Li and Strahler) describe exactly this mutual shadowing.
2. **The ground went dark under trees that were already drawn.** Inside the tree reach (4.5 km), the ground darkened by the full cover share and the instanced trees and impostors stood on top. Sparse stands in the bowls therefore read as grey halos around the trees.
3. **Outside the pack there are no trees**, but the darkening still faded in from 350 m to 1 km as if trees stood in front. From the air the near slopes past the pack (front side from the NE) were a half-grey wash.
4. **No view angle.** FEAT-075 lifted the darkening so that from the snow, at grazing angles, the forest reads as a mass. From above, the real openings between crowns show, and the same lift made every partly forested cell grey.

### 7.2 How the real view looks
The reference is a cloud-free Sentinel-2 L2A scene from 1 March 2025 (`S2C_MSIL2A_20250301T175311_R141_T13SCD`, 0.02% cloud, sun 40 degrees up), cropped to the pack at 10 m through the Planetary Computer data API (`/api/data/v1/item/bbox/...`; the `crop` route used for NAIP now returns 404). It is in `docs/renders/2026-11-09-feat154-sentinel2-vs-cover.jpg` next to the pack's cover share.
- From above, the Back Bowls are white with dark tree islands, the lower bowls toward Sun Down's base are forest, and Blue Sky and the front side are dark timber cut by white trails. The cover level shows the same pattern.
- **Is the cover's forest share right?** On shaded slopes the Sentinel-2 brightness can't separate shaded snow from canopy, so the comparison only uses sunlit slopes (cos of the sun incidence from the 10 m DEM between 0.55 and 0.95). There it unmixes as `(snow - pixel) / (snow - canopy)`, with snow and canopy taken from cover-0 and cover-1 pixels at the same incidence. Region by region the cover matches what the satellite sees: Back Bowls 0.18 against 0.21 (and 0.05 against 0.06 on the most sunlit faces), Blue Sky 0.47 against 0.50 (0.55 against 0.59), the front side 0.35 against 0.41. Cells the cover calls open still unmix at about 0.26 (towns, roads, scattered small trees and noise), so the method has a floor. **Conclusion: the data is not the problem. The blobs came from how the shader drew it.**
- A crude dark-pixel share of the true-colour image (luminance under 0.45) reads lower in the bowls (0.12 against 0.21). That's the saturated true-colour stretch hiding sparse trees on bright snow, not a real difference.

### 7.3 How other large-terrain renderers draw far forest (cheaply)
- **Land-class forest with autogen trees near and a forest colour far:** flight sims (X-Plane, Microsoft Flight Simulator) place generated trees from forest land-class polygons out to a set distance and leave the forest to the ground texture past it. This is what we do: instances to 4.5 km, then the cover levels.
- **A baked far albedo or forest texture per tile** (from imagery or canopy data): cheap and exact in colour, but the lighting is baked into it (section 4.3). We get the same spatial accuracy from the cover share lit in the shader.
- **Impostor or billboard clusters per tile** (one card per stand rather than per tree): good mid-distance texture at a few draw calls per tile. It's the natural next step if the 1.5 to 8 km band needs more 3D texture than the ground shading gives (section 4.5).
- **A canopy-height bump in the terrain:** we already lift forested ground past the trees (FEAT-153), which gives treed silhouettes and self-shading.
- **Canopy optics instead of a flat tint:** the probability that a sight line passes between crowns falls with the path length through the canopy layer. That is the canopy gap fraction, `P(theta) = exp(-k LAI / cos theta)` in Nilson's form. With a share `s` of the ground under crowns, the Poisson version is `(1 - s)^(1/mu)`, where `mu` is the cosine of the view to the ground normal. It makes a stand denser at grazing angles and true to its share from above, at the cost of one `pow`.
- **Horizon-based shading** (a per-texel horizon angle for sun occlusion past the shadow maps) would put the far valleys into shadow at low sun. It is not needed for these views at 11 am. A follow-up if dawn and dusk backdrops matter.

### 7.4 What was built
All in `TerrainMaterial.ts`, no new data:
- **Gap fraction with the drawn trees taken out:** `seen = 1 - ((1 - s) / (1 - rho s))^(1/mu)`. Here `s` is the S-curved cover share and `mu` is clamped to 0.12..1. `rho` (`uForestDrawn`, 0.7) is the part of the canopy the drawn trees cover, fading to 0 at the tree reach (`uLiftNear`) and outside the pack's tree instances (`uTreeRect`). From the snow `mu` is small and the forest stays a dark mass, as FEAT-075 wanted; from the air sparse stands open up. Closed stands (`s` near 1) stay dark whatever `rho` is, which keeps the BUG-023 compensation where the drawn trees are too sparse.
- **No near fade outside the pack:** past the tree instances the ground carries the forest from the first metre.
- **Canopy sunlight:** forested pixels take `uCanopySun` (0.3) of the direct diffuse light, and a forested pixel is `uTimberMix` (0.97) timber, up from 0.9.
- The old second term (`smoothstep(2500, 6000, dist) * forestV`, the raw unlifted share) is gone; the gap fraction covers it.

### 7.5 What the pack should bake
Nothing new for this. The cover levels already carry the right share (7.2) and everything above is lighting. Candidates for later:
- A winter "canopy seen from above" level from Sentinel-2, as a check or a correction, needs terrain-illumination correction (7.2 used only sunlit slopes). It would mainly help outside the pack, where WorldCover's tree class is a thresholded share.
- Generated tree instances outside the pack from the mid cover level (one cell set per 1 km, like FEAT-074's per-cell stands). From the NE pose the near slopes past the pack are now dark forest with snow between the crowns, but they are flat colour with no trees.

### 7.6 Frame cost
One `pow`, a dot product and a few multiplies per terrain pixel; no new textures, draw calls or vertices. Main against this branch with `aerial.mjs` (`SHOT_DIST` serving a main build), two alternating rounds, 1600 x 900, 30 GPU-finished frames per pose:

| Pose | main (ms) | FEAT-154 (ms) |
|---|---|---|
| Born Free start, eye height | 17.8 / 16.9 | 16.8 / 15.6 |
| Front side mid-run, eye height | 18.9 / 18.7 | 18.6 / 17.0 |
| Back Bowls gateway, eye height | 19.9 / 19.0 | 18.9 / 19.3 |
| Blue Sky run, eye height | 18.4 / 19.9 | 19.6 / 19.8 |
| Gateway, 700 m up | 23.3 / 24.0 | 21.9 / 22.9 |
| Blue Sky looking north, 800 m up | 23.7 / 24.3 | 24.7 / 24.2 |

All within run-to-run noise, with identical draw calls and triangles. The Low preset runs the same shader; its shorter tree reach only moves where `rho` fades out.

### 7.7 Left over
- Dense stands where the drawn trees are sparse (BUG-023, FEAT-074) show from the air as dark ground with a few trees standing in it, about 1 to 3 km out from the gateway pose. Raising `rho` doesn't change them (they are closed canopy in the cover); more trees will.
- Sunlit-slope check only: a full Sentinel-2 comparison needs illumination correction.

## Sources
- [Nilson 1971, A theoretical analysis of the frequency of gaps in plant stands (Agricultural Meteorology 8)](https://doi.org/10.1016/0002-1571(71)90092-6)
- [Li and Strahler 1992, Geometric-optical bidirectional reflectance modeling of the discrete crown vegetation canopy: effect of crown shape and mutual shadowing (IEEE TGRS 30(2), 276-292)](https://doi.org/10.1109/36.134078)
- [Microsoft Planetary Computer, Sentinel-2 Level-2A](https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a)
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
