# Applying the real vs game photo pairs (DATA-008): realism roadmap

Researched 2026-11-06. Inputs: the 14 Vail spots and 50 views in `docs/compare/vail/` (Street View photos against the eye camera), the Vail pack (`packs/vail/`), `pipeline/build_pack.py`, the raw LANDFIRE EVT clip, and the game source. Card: FEAT-072 (#116).

## 1. What the pairs say, by category

| Category | Spots where it shows | Verdict |
|---|---|---|
| Terrain shape (DEM) | all 14 | **Matches.** Ridges, saddles, fall lines, gullies and lift lines line up everywhere once position and compass are right. No DEM work needed. |
| Forest density | 12 of 14 | **Far too sparse.** Closed stands render as open snow with lone trees. The biggest gap by far. |
| Tree shape and species | 12 of 14 | Black, smooth cones; no lodgepole form, no winter aspen, no snow on branches, no snags; krummholz pyramids where tall forest stands. |
| Far forest tone | 7 | Forested valleys and ridges at 300 m to 2.5 km read pale (snow with green specks) instead of dark. |
| Rock | 6 | Grey rock bands where real winter slopes are clean snow (China Bowl), red sandstone outcrops missing where they do poke out (In the Wuides), one boulder misplaced (Pete's). |
| Buildings | 4 | Lodges buried on slopes or drawn as grey boxes; terminals drawn twice with a red roof; cat tracks as grey roads. |
| Snow surface | 10 | Fresh corduroy everywhere; real snow is tracked, chopped, bumpy or spring-textured depending on the run and season. |
| Sky and weather | 6 | Always clear; photos range from clear to overcast and falling snow. |

## 2. Measured evidence from the pack

Trees within 100 m of each spot (pack trees file), canopy cover (mask alpha) and the LANDFIRE EVT classes around the spot (5 x 5 samples at 30 m):

| Spot | Ground (m) | Trees < 30 m | Trees < 100 m (per ha) | Species (conifer / aspen / krummholz) | Median height | Canopy cover < 80 m | Main LANDFIRE classes | Real (photo) |
|---|---|---|---|---|---|---|---|---|
| Born Free | 3,000 | 0 | 42 (13) | 42 / 0 / 0 | 14.8 | 0.11 | Developed-Low; Urban Evergreen Forest | closed lodgepole stand 10 to 15 m away |
| Mid-Vail / Wildwood | 3,087 | 0 | 61 (19) | 61 / 0 / 0 | 12.8 | 0.12 | Developed-Low / Medium | tall spruce walls around the loading area |
| Prima / Brown's Face | 3,152 | 0 | 99 (32) | 98 / 1 / 0 | 15.2 | 0.17 | Developed-Medium; Cliff | forest on both run edges |
| The Divide | 3,232 | 3 | 94 (30) | 93 / 1 / 0 | 12.4 | 0.27 | Urban Evergreen Forest | mixed aspen-spruce corridor |
| Pete's Express | 3,117 | 4 | 149 (47) | 149 / 0 / 0 | 14.1 | 0.23 | Urban Evergreen; Spruce-Fir | best match: forest edges right |
| Belle's Camp | 3,481 | 25 | 311 (99) | 0 / 0 / 311 | 4.5 | 0.46 | Spruce-Fir Forest | tall closed spruce-fir |
| Hornsilver | 3,377 | 3 | 167 (53) | 0 / 0 / 167 | 4.5 | 0.23 | Developed-Low; Spruce-Fir | glade inside dense forest |
| In the Wuides | 3,273 | 2 | 30 (10) | 11 / 0 / 19 | 3.3 | 0.02 | Spruce-Fir; Mesic Meadow | lone bushy conifers on the slope |
| Mongolia Bowl | 3,437 | 0 | 3 (1) | 0 / 0 / 3 | 4.5 | 0.00 | Mesic Meadow | spruce clumps across the slope |
| China Bowl Poppyfields | 3,282 | 0 | 0 | 0 | | 0.00 | Grassland; Sagebrush | lone spruce groups on the saddle and ridge |
| Campbell's | 3,334 | 1 | 12 (4) | 6 / 0 / 6 | 4.9 | 0.02 | Mesic Meadow; Grassland | dense spruce stand edge up the slope |

Pack totals: 1,251,077 trees; 179,659 krummholz (14.4 %), of which 171,089 sit between 3,350 and 3,550 m.

Closed subalpine spruce-fir and lodgepole stands carry hundreds of crown-forming trees per hectare (starting point, to verify against full-density lidar crown counts). The forested spots above are at 13 to 47 per hectare, so roughly an order of magnitude short.

## 3. Root causes, with code locations

1. **Krummholz rule (BUG-025, #113).** `build_pack.py` around line 589: `is_krumm = (elev > 3350) | ((hgt < 4) & (elev > 3250))`, then heights are capped at 4.5 m. Every tree above 3,350 m becomes a 4.5 m krummholz. The vegetation research (`vegetation-and-landcover.md`) already said krummholz should be *above 3,450 m and CHM under 4 m*. Explains Belle's Camp, Hornsilver, Mongolia and the black pyramids.
2. **LANDFIRE fill gate excludes the ski area (BUG-027, #115).** LANDFIRE maps the resort's forest as `Developed-Low/Medium Intensity` and `Western Cool Temperate Urban Evergreen Forest`. The gate `forest_of[v] = lfm == "Tree" and "Urban" not in name` (around line 284) rejects both, and `fill &= lf_forest2` (line 571) then removes every fill tree there. Only lidar-detected crowns survive, which the subsampled lidar finds sparsely. Explains Born Free, Mid-Vail, The Divide and Prima.
3. **Canopy mask under-detects (step 5).** `canopy = ((chm > 2.5) | ((ndvi2 > 0.45) & (chm > 1.2))) & (ndvi2 > 0.30) & has_pts & have2`. Three suspects, in order of likely effect:
   - the EPT nodes were fetched at about 3 m spacing (about 0.1 pt per m², per the vegetation research), so many 2 m cells have no return and `has_pts` (dilated by one cell) fails;
   - the DSM is the max per 2 m cell from that sparse cloud, so narrow crowns are often missed, and peaks (local maxima of the smoothed CHM) are too few;
   - `ndvi2 > 0.30` on 2023 summer NAIP may drop grey beetle-killed lodgepole (the 2012 Born Free photos show many). Hypothesis: check NDVI under known forest.
4. **Fill rate set by render budget, not by data.** `fill ... < 0.10` (line 569); the comment notes 0.33 gave 5.26 M trees, too many to render. Density in the pack and density on screen are the same thing today.
5. **Far forest relies on the same thin canopy.** `TerrainMaterial.ts` darkens forested ground only beyond 2.5 to 6 km (`smoothstep(2500, 6000, dist) * vForest`), weighted by canopy cover, which is low (item 3). Between the instanced trees' near ring and 2.5 km, forest reads as snow.
6. **Species model is too coarse.** Species are 0 conifer, 1 aspen, 2 krummholz. The planned schema (`vegetation-and-landcover.md`) had spruce-fir, lodgepole, aspen and krummholz. Aspen is near zero at every spot (aspen comes from NAIP brightness or LANDFIRE aspen classes, and the resort is `Urban`/`Developed` in LANDFIRE). `Vegetation.ts` draws stacked cones (conifer), a cone (krummholz) and a thin cone (aspen).
7. **Rock has one tint and no winter burial.** `rockShader.ts` uses a single `uRockTint` (cool grey Rock030, FEAT-020). Real ski-area rock is red / maroon Minturn and Maroon Formation sandstone, grey only on the Gore Range (FEAT-069). Slope-derived rock bands show where winter snow buries them.
8. **Buildings and roads.** Roof heights set before tiles load (BUG-024), boxes with default 5.5 m heights (FEAT-071), terminals drawn twice (DATA-009), on-mountain roads grey (BUG-026), false bridges (BUG-022).

## 4. Roadmap

Ordered by realism gained per effort, with the cards each step closes. Phase 1 is one pack rebuild.

**Phase 1: tree data (pipeline, one rebuild)**
1. BUG-025 (#113, done in 01f22a5): krummholz only where CHM < 4 m and elevation > 3,450 m, or in LANDFIRE alpine / limber-bristlecone classes; never cap a lidar height.
2. BUG-027 (#115): treat `Urban Evergreen Forest`, `Urban Mixed Forest` and `Developed-*` as "unknown, ask lidar and NAIP" instead of "not forest"; gate fill only on truly non-forest classes (meadow, grassland, shrubland, bare rock, water).
3. BUG-028 (#118), canopy detection: test `has_pts` dilation 2 cells, a 3 x 3 median before the local maxima (as the vegetation research suggested), and an NDVI floor of 0.20 where CHM > 5 m (dead lodgepole). Measure with the harness (section 5) at Born Free, Mid-Vail and Prima before and after.
4. DATA-010 (#119): fetch LANDFIRE **EVC** (existing vegetation cover) and **EVH** (existing vegetation height) for the same clip as EVT, and optionally USFS Tree Canopy Cover (NLCD TCC, 30 m). Use EVC as the target canopy fraction per 30 m cell, so density no longer depends on how many lidar crowns survive.
5. DATA-011 (#120), optional, larger: re-fetch the EPT nodes one or two levels deeper inside the forest mask only (denser points for crown detection). Run on Drew's PC; size to be measured first.

**Phase 2: rendering dense forest within budget**
6. FEAT-074 (#121), separate pack density from drawn density: store stand density (trees per cell from EVC / canopy) and the detected crowns, and generate the extra stems procedurally per cell at load with a seeded RNG, so 5 M stems never sit in the pack. Draw full meshes only in the near ring, impostors in the mid ring, and nothing beyond.
7. FEAT-075 (#122), far forest: start the terrain's forest darkening at the impostor ring edge (about 300 to 600 m, tied to `NEAR_RADIUS`), driven by the improved canopy cover, so forested slopes read dark green at every distance.
8. FEAT-070 (#109) tree shapes: snow-flocked spruce-fir with ragged narrow tops; lodgepole (tall bare trunk, small high crown) as its own species; winter aspen (white trunk, twig crown, no cone); a few percent grey snags; low wide krummholz lumps. Lighting: lit, textured crowns instead of near-black.

**Phase 3: rock, buildings, roads**
9. FEAT-069 (#106): a rock tint per region (red sandstone inside the ski area, grey Gore Range outside), plus winter burial: drop slope-only rock bands where snow depth covers them, keep outcrops on true cliffs.
10. BUG-024 (#110), then FEAT-071 (#111, building styles and heights) and DATA-009 (#112, terminals from OSM footprints, dark roofs), BUG-026 (#114, cat tracks as snow), BUG-022 (#105, false bridges).

**Phase 4: snow and sky**
11. FEAT-077 (#124), snow surface by run and day: corduroy only on groomed runs (grooming reports exist), tracked and chopped elsewhere, bumps on ungroomed steeps (FEAT-059), spring texture late in the season; blend tracks (BUG-021).
12. FEAT-078 (#125, done in f68ba27), weather presets matched to the photos: overcast and falling snow are common in the pairs (Mongolia, Mid-Vail, Riva / Prima). The snowstorm mode exists; add an overcast-flat-light preset so pairs can be compared like for like. Built as the `overcast` and `flurries` presets, set per spot by `weather` in `spot.json`.

## 5. Measuring progress: a compare metrics harness (FEAT-076, #123)

The pairs become a regression test. Proposed `tools/compare_metrics.py` (Python, reads only the pack and `docs/compare`):
- For every spot: trees within 30 m and 100 m, trees per hectare, species mix, median height, krummholz share, canopy cover within 30 m and 80 m, and the LANDFIRE classes.
- A `targets` block per spot in `spot.json`, set from the photo (for example Born Free: canopy within 80 m at least 0.5, trees within 30 m at least 5; Belle's Camp: krummholz share 0, median height at least 12 m; China Bowl Poppyfields: at least one spruce group within 100 m).
- Output `docs/compare/vail/metrics.md`: one row per spot, pass / fail against targets, and the delta from the previous run.
- Optional, on Drew's PC where `real-*.png` exist: image statistics per view (share of dark forest pixels below the horizon, sky brightness) for real and game, so tree cover and tone have a number, not only a judgement.

Run after each pack rebuild together with `cd game && node tools/shoot_spots.mjs vail --gpu --size 1919x910`, and commit the new shots and metrics with the change.

## 6. Open questions

- How dense can the near ring get on the target GPU? Measure with the perf-check skill once Phase 2 step 6 exists (current: 1.25 M trees in the pack, `NEAR_RADIUS` 1,500 m, `FAR_RADIUS` 4,500 m).
- Is the NDVI floor really dropping dead lodgepole? Sample NAIP NDVI under the Born Free stand.
- Hornsilver's panorama is from the same contributor as three panoramas with compasses 76 to 88 degrees off; its compass was never checked. Re-check before using it as a target.

## Sources

- DATA-008 pairs and notes: `docs/compare/README.md`, `docs/compare/vail/*/notes.md`.
- Pack measurements in section 2: computed 2026-11-06 from `packs/vail/trees/*.bin`, `packs/vail/mask/*.png` and the raw LANDFIRE EVT clip (`LF2024_EVT`).
- Code: `pipeline/build_pack.py` (steps 4, 5, 5b, 8), `game/src/world/Vegetation.ts`, `game/src/terrain/TerrainMaterial.ts`, `game/src/terrain/rockShader.ts`.
- Prior research: `docs/research/vegetation-and-landcover.md` (treeline, krummholz rule, species schema, lidar density).
- LANDFIRE products (EVT, EVC, EVH): https://landfire.gov/
