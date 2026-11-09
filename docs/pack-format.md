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
  trees/<tx>_<ty>.bin       tree instances per 1 km cell
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

## Instances

`trees/<tx>_<ty>.bin`: little-endian Float32 records of 6:
`x, y, z, height, crownRadius, species` with species 0 = conifer (spruce/fir/lodgepole),
1 = aspen (leafless, white trunk), 2 = krummholz (stunted conifer near treeline).

`rocks/<tx>_<ty>.bin`: Float32 records of 6: `x, y, z, size, yaw, type` with type 0 = outcrop,
1 = boulder, 2 = talus clump.

Cell size is `meta.instances.cellSize` (1000 m), origin `meta.instances.minX/minY`. `treeCells` and `rockCells` list the cells that have a file (`"cx_cy"`); the client only requests those. Packs built before BUG-036 lack the lists and the client requests every cell in range; add them without a rebuild with `python pipeline/packwriter.py packs/<slug>`.

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
  "crs": "EPSG:26913", "origin": [384300, 4384250], "lonlat": [-106.35, 39.60],
  "bounds": { "minX", "minY", "maxX", "maxY" },           // resort area, local metres
  "zRange": [2300, 3700],
  "terrain": { "fine": {...}, "mid": {...}, "far": {...} },
  "mask": { "res": 2, "tileSize": 512, "minX", "minY", "tilesX", "tilesY" },
  "ao": { same fields as mask },                           // optional
  "dir": { same fields as mask },                          // optional, DATA-002
  "moguls": { same fields as mask },                       // optional, FEAT-059
  "instances": { "cellSize": 1000, "minX", "minY", "cellsX", "cellsY", "treeCount", "rockCount", "treeCells", "rockCells" },
  "start": { "x", "y", "heading" },                       // default drop-in
  "sun": { "azimuth": 160, "elevation": 32 },             // degrees, default lighting
  "attribution": ["..."]
}
```
