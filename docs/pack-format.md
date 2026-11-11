# Resort pack format v1

A pack is a static folder served over HTTP. Everything is in **local metres**: x east, y north, z up,
relative to `meta.origin` (a UTM easting/northing). The client never touches lat/lon.

```
pack/<slug>/
  meta.json
  fine/<tx>_<ty>.png        1 m heights, 512 x 512 samples per tile, resort area only
  mid/<tx>_<ty>.png         16 m heights, 512 x 512 samples per tile, 40 km square
  far/<tx>_<ty>.png         128 m heights, 512 x 512 samples per tile, 262 km square
  mask/<tx>_<ty>.png        2 m RGBA surface classes, 512 x 512 per tile, resort area
  ao/<tx>_<ty>.png          2 m greyscale sky visibility (baked AO), same grid as mask (optional)
  dir/<tx>_<ty>.png         2 m greyscale piste direction (groomed run axis), same grid as mask (optional)
  cover/<level>.png         RGBA forest cover for the terrain at a distance, one image per level (optional)
  trees/<tx>_<ty>.bin       tree instances per 1 km cell (the detected crowns)
  stands/<tx>_<ty>.png      stand density per 4 m cell, one RGB image per 1 km tree cell (optional, FEAT-074)
  rocks/<tx>_<ty>.bin       rock instances per 1 km cell
  features.json             lifts, runs, buildings, roads, water, peaks, labels
```

## Height tiles (Terrarium RGB)

8-bit RGB PNG, `h = (R * 256 + G + B / 256) - 32768` metres (1/256 m precision, same scheme as
Mapterhorn so the far ring can be re-encoded without loss). Pixel (0,0) is the **north-west**
corner (image row 0 = max y), so `y = tileMaxY - row * res`, `x = tileMinX + col * res`.
Tiles abut without overlap; a sampler reads the neighbour tile across an edge.

`meta.terrain.<set>` gives for each set: `res`, `tileSize` (512), `minX`, `minY` (lower-left of
tile (0,0) in local metres), `tilesX`, `tilesY`. Tile `<tx>_<ty>` covers
`x in [minX + tx*size, minX + (tx+1)*size)`, `y in [minY + ty*size, ...)` with `size = res*tileSize`.
Void samples are encoded as height -32768 (R=G=B=0) and must be treated as "no data".

## Mask tiles

RGBA PNG at 2 m. R = rock (0..255), G = scree/talus, B = groomed piste, A = canopy cover.
Snow is implicit: `snow = 1 - max(rock, scree)`. Alpha drives forest-floor darkening and
snow-depth reduction under trees.

R is rock the imagery saw (full weight on steep bare ground, half on grey rock on gentler slopes),
softened over about 2 m; it carries no slope-only term. The renderer adds rock on faces steeper than
about 45 degrees, on wind-scoured ridges and talus below cliffs, and thresholds the weights against
noise so rock shows as crisp patches (FEAT-020). Packs built before FEAT-020 put 0.3 to 0.6 rock on
every 30 to 40 degree slope and should be rebuilt.

## AO tiles (optional)

Greyscale PNG on the mask grid: sky visibility 0..255 from `pipeline/terrain_ao.py` (16 directions,
horizon angles up to 170 m measured above the cell's tangent plane, visibility `1 - sin(h)`).
Planar slopes and ridges are 255; gullies, couloirs, cirques and cliff feet are darker. Padding
outside the data is 255. The terrain uses it for chunks at 32 m or finer; packs without it render
with open sky everywhere.

## Piste direction tiles (optional)

Greyscale PNG on the mask grid from `pipeline/piste_dir.py` (DATA-002): the axis a groomer drives
along, so corduroy follows the run and not the raw fall line (a traversing cat track has ridges along
the track). Byte 0 = no direction; 1..255 = axis angle `(byte - 1) / 254 * 180` degrees from east
toward north, in [0, 180). The axis is undirected; the client picks the downhill sense from the
heights. Every cell takes the nearest groomed centre line's segment direction (doubled-angle field,
blurred 6 m across polyline kinks), kept where the mask is groomed or within 30 m of a groomed run.
Padding and everything else is 0. Packs built before DATA-002 lack it; add it without a rebuild with
`python pipeline/piste_dir.py packs/<slug>` (reads `features.json` and the mask tiles).
## Mogul tiles (optional, FEAT-059)

Greyscale PNG on the mask grid: mogul field strength 0..255 = 0..1 from `pipeline/moguls.py` (read as metres
of amplitude before FEAT-147; the client now sizes the bumps from the slope, see below). Each run's
`mogulScore` is painted along its corridor (fading over the outer 3 m, where real bumps shrink; closed
`area` runs are filled), times a slope window (none below 15 degrees, full 20 to 35, none above 40),
and removed under canopy, on groomed corduroy, built-up ground and rock. Padding outside the data is 0.
The client turns the strength into bumps cut by rider lines down the fall line (`game/src/terrain/Moguls.ts`,
FEAT-147: 4 to 7 m apart along a line, about 0.55 m per unit strength at 16 degrees up to 1.38 m at 32 degrees
and steeper, each bump +-30%, at most 1.8 m; the pattern changes every 80 m) in both the physics height and
the near terrain mesh (chunks at 2 m or finer), and shades
the same field per pixel in the terrain shader on every chunk up to 16 m (BUG-062: the bump normal and a
relief colouring from the bump's own height and slope). Packs without the set have no bumps.

## Cover levels (optional, FEAT-153)

One RGBA PNG per level from `pipeline/cover.py`, each over its own rectangle (image row 0 = north):
R = forest, the share of the cell under closed canopy 0..255 = 0..1; G = canopy height of the forested
part, 0..255 = 0..`heightMax` m; B = rock / bare ground, the mask's rock weight (0.5 is where patches
start); A = 255 minus built-up (inverted so a decoder that premultiplies alpha keeps RGB). The `pack`
level is 4 m over the pack bounds: the 2 m mask's canopy, contrast-lifted as the shader lifts the
under-detected lidar canopy (0.08 to 0.45) and then box-averaged, with the pack's OSM runs burned in as
cleared strips (areas filled, lines at 0.6 of their corridor width; gladed runs keep their trees), the
mask's rock, and the mean tree height per 16 m from the tree instances. The forest is then weighted by
the pack's tree instances (BUG-069), so a sparse stand the lidar canopy reads as closed is not a dark patch
around its few trees. R, the forest seen from far off, is weighted by the share of the ground under the
crowns (averaged over 16 m, full weight from 0.2 up). The level's optional `stands` image (greyscale, same
grid, `cover/pack-stands.png`) is the forest seen from near, where single trees show: only closed stands
keep it (the crown share averaged over 10 m passes 0.05 to 0.14, and the stand is at least 40 m across:
smaller clumps are dropped, holes that size inside a stand filled). The shader shows `stands` to 1.2 km and
R from 2.8 km. With `"crowns": true` on the level the image is RGB and its G is where the drawn trees
stand: the share of each cell under their crowns, each tree weighted by its height over 12 m (FEAT-168; the
shader throws their shadows on the snow from it). A pack without tree instances keeps the canopy as is.

The `mid` (16 m over the mid height grid, 40 km) and `far` (100 m over the far ring's data, 200 km) levels
come from the land cover (DATA-019): ESA WorldCover 2021 classes and the ETH 2020 canopy height, read on a
4 x 4 (mid) or 3 x 3 (far) sub-grid per cell. R is the share of sub-samples that are WorldCover tree cover
(class 10) and at least 3 m tall in ETH; G the mean ETH height of those, averaged over about 3 cells; B the
bare / sparse share (class 60) times 0.6, since snow covers the gentler part; A from built-up (class 50).
The downhill pistes of every resort in view (`osm/pistes_wide.json`) are burned in as cleared sub-samples,
so Beaver Creek's and Copper's trails show. G, B and A are quantised (2.5 m, 1/8, 1/4) to keep the files
small. Without `raw/<slug>/landcover/` the build skips these two levels.

The terrain shader samples R per pixel from a mipmapped GPU texture past about 300 m, so a trail
narrower than a far chunk's vertex spacing still shows as a white cut; chunks coarser than 8 m take all
four channels per vertex (forest, rock, and the canopy lift past the instanced trees). Finer levels fade
in over `blend` metres inside their edges; outside every level the terrain keeps the procedural
treeline. Add it to a built pack without a rebuild: `python pipeline/cover.py <slug> <raw_dir> packs/<slug>`.

## Instances

`trees/<tx>_<ty>.bin`: little-endian Float32 records of 6:
`x, y, z, height, crownRadius, species`. Packs with `meta.treeSpecies` 2 (DATA-020) use ids 0 to 7;
older packs have no `treeSpecies` and only ids 0 to 2, where 0 is any conifer.

| id | species | assigned (`pipeline/species.py`) | crown radius |
|---|---|---|---|
| 0 | Engelmann spruce | spruce-fir LANDFIRE classes and the conifer share of other classes; about 60 % of spruce-fir above 3,200 m | 0.13 h |
| 1 | aspen | aspen classes (85 %, aspen-mixed 50 %), or a NAIP bright-green crown (50 %), below 3,300 m | 0.20 h |
| 2 | krummholz | lidar height 1 to 4 m above 3,450 m or in an alpine class | 0.50 h |
| 3 | subalpine fir | the rest of spruce-fir: 50 % below 3,200 m, 40 % above, more on north and east aspects and near streams | 0.10 h |
| 4 | lodgepole pine | lodgepole (and ponderosa) classes, 85 %; without LANDFIRE, the lower slopes below 3,250 m | 0.09 h |
| 5 | Douglas-fir | Douglas-fir and montane mixed conifer classes below about 3,200 m | 0.17 h |
| 6 | limber pine | limber-bristlecone and pinyon-juniper classes; half the short (< 10 m) trees on exposed crests above 3,200 m | 0.35 h |
| 7 | snag | standing dead: CHM peak over 6 m with NAIP NDVI under 0.15 inside forest, at most 3 % of trees | 0.05 h |

The spruce / fir, group and crest draws are hashes of the tree position, so a rebuild gives each tree the same species.

Since FEAT-074 the trees are the lidar's detected crowns (local maxima of the canopy height) and the snags; the stems
between them are the stand density below, generated by the client. Older packs also hold synthetic fill trees (a
share of the canopy cells without a crown nearby).

## Stands (optional, FEAT-074)

`stands/<tx>_<ty>.png` (`pipeline/stands.py`): per 1 km tree cell, an RGB PNG `size` (250) wide and `2 * size`
tall, row 0 = north, one pixel per 4 m cell. RGB only, because a decoder that premultiplies alpha would zero the
colour where alpha is 0.

| rows | R | G | B |
|---|---|---|---|
| 0 .. size-1 | chance of one stem in the 4 m cell, 0..255 = 0..1 | stand height, `hStep` (0.25) m per step | species id 0..7 |
| size .. 2*size-1 | ground height high byte | low byte | 0 |

Ground height = `(R * 256 + G) / zScale + zBase` m, stored where a stem can stand and one cell round it (0 = none).
`zBase` is the pack's lowest ground and `zScale` 32, so a pack spans at most 2,048 m of relief.

The chance is the stems a closed stand needs (`K_CLOSE` crown area per m2 of canopy: canopy share / (pi r^2),
r = the species' crown ratio times the stand height), less the detected crowns within about 6 m. Stems stand only
on canopy, off truly open LANDFIRE classes, groomed runs, built-up ground, cliffs and lift lines. Stand height is
the tallest lidar return in the 4 m cell, LANDFIRE EVH (DATA-010) where the lidar reads under 4 m, at least 3 m.
Species come from the same rules as the trees (`species.assign_species`) at the cell centre.

The client keeps a stem where `hash(cell centre) < chance x density` (the Forest setting), jitters it within 90 %
of the cell, draws it 0.75 to 1 times the stand height with the species' own crown, and reads the ground height
bilinearly. So a cell gives the same stems every time, and a lower density is a subset of a higher one. The cover
(`cover.py`) counts the stems in expectation (chance x crown area) where it weighs the forest by the drawn trees.

`shrubs/<tx>_<ty>.bin` (DATA-020, optional): Float32 records of 6: `x, y, z, height, radius, kind` with
kind 0 = willow (clumps of 3 to 8 stems, 1 to 3 m, within 25 m of an OSM stream on a valley bottom or in a riparian class),
1 = juniper (0.3 to 1 m mats in spruce-fir gaps and on open south crests), 2 = sagebrush (0.5 to 1.2 m, sagebrush classes),
3 = young conifer (1 to 4 m spruce or fir at forest edges and in canopy gaps, about 15 per hectare of edge),
4 = Gambel oak (1 to 3 m, Gambel oak shrubland classes). Density follows NAIP NDVI where there is no canopy, at most 200 per hectare.
The build writes `debug/species.png` into the pack: the most common species per 10 m (left; colours in
`species.SPECIES_RGB`) next to the LANDFIRE tree group (right), for a visual check.

`rocks/<tx>_<ty>.bin`: Float32 records of 6: `x, y, z, size, yaw, type` with type 0 = outcrop,
1 = boulder, 2 = talus clump.

Cell size is `meta.instances.cellSize` (1000 m), origin `meta.instances.minX/minY`. `treeCells`, `rockCells` and `shrubCells` list the cells that have a file (`"cx_cy"`); the client only requests those. Packs built before BUG-036 lack the lists and the client requests every cell in range; add them without a rebuild with `python pipeline/packwriter.py packs/<slug>`.

`packs/index.json` (`{"packs": ["synth", "vail"]}`) lists every pack folder with a `meta.json`. `write_meta` rewrites it after each build; the menu reads it instead of probing each resort's `meta.json`.

## features.json

```
{
  "lifts":     [{ "name", "type", "stations": [[x,y,z],...], "towers": [[x,y,zGround,height],...],
                 "cable": [[x,y,z],...], "capacity" }],
  "runs":      [{ "name", "difficulty": "easy|intermediate|advanced|expert|freeride",
                 "groomed": bool, "gladed": bool, "points": [[x,y,z],...], "osmId",
                 "groomNights", "mogulScore" }],  // groomNights: nights the resort's reports groomed it (absent when never); mogulScore: 0..1 from pipeline/moguls.py (absent in packs before FEAT-059)
  "buildings": [{ "name", "points": [[x,y],...], "zBase", "zMax", "height", "heightDefault", "kind" }],  // zMax: highest ground under the footprint, absent in packs before BUG-024; heightDefault: true when OSM had no height or levels and the pipeline used its 5.5 / 9 m fallback (absent in older packs, where the client guesses from those values)
  "roads":     [{ "name", "kind", "points": [[x,y,z],...], "width" }],
  "water":     [{ "name", "points": [[x,y],...], "z" }],
  "peaks":     [{ "name", "x", "y", "z" }],
  "labels":    [{ "name", "kind", "x", "y", "z" }]
}
```

## meta.json

```
{
  "version": 1, "slug": "vail", "name": "Vail",
  "build": "20261110T171500Z-3fa2c1",                      // FEAT-177: new on every write by any stage (packwriter.stamp_build)
  "crs": "EPSG:26913", "origin": [384300, 4384250], "lonlat": [-106.35, 39.60],
  "bounds": { "minX", "minY", "maxX", "maxY" },           // resort area, local metres
  "zRange": [2300, 3700],
  "terrain": { "fine": {...}, "mid": {...}, "far": {...} },
  "mask": { "res": 2, "tileSize": 512, "minX", "minY", "tilesX", "tilesY" },
  "ao": { same fields as mask },                           // optional
  "dir": { same fields as mask },                          // optional, DATA-002
  "moguls": { same fields as mask },                       // optional, FEAT-059
  "cover": { "heightMax": 40, "blend": 500,                 // optional, FEAT-153
             "levels": [{ "name": "pack", "res": 4, "minX", "minY", "w", "h", "file": "cover/pack.png", "stands": "cover/pack-stands.png", "crowns": true },
                        { "name": "mid", "res": 16, ... }, { "name": "far", "res": 100, ... }] },
  "instances": { "cellSize": 1000, "minX", "minY", "cellsX", "cellsY", "treeCount", "rockCount", "treeCells", "rockCells",
                 "shrubCount", "shrubCells" },              // shrub fields optional, DATA-020
  "treeSpecies": 2,                                        // optional, DATA-020: tree ids 0..7; absent = 0..2
  "stands": { "res": 4, "size": 250, "zBase", "zScale": 32, "hStep": 0.25,  // optional, FEAT-074
              "cells": ["cx_cy", ...], "stems" },          // cells with an image; stems over the pack at full density
  "start": { "x", "y", "heading" },                       // default drop-in
  "treeline": 2700,                                       // optional, m (DATA-021): measured from the canopy; absent = 3,480 (Colorado)
  "sun": { "azimuth": 160, "elevation": 32 },             // degrees, default lighting
  "attribution": ["..."]
}
```
