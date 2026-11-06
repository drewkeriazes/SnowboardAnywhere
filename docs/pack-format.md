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

## Instances

`trees/<tx>_<ty>.bin`: little-endian Float32 records of 6:
`x, y, z, height, crownRadius, species` with species 0 = conifer (spruce/fir/lodgepole),
1 = aspen (leafless, white trunk), 2 = krummholz (stunted conifer near treeline).

`rocks/<tx>_<ty>.bin`: Float32 records of 6: `x, y, z, size, yaw, type` with type 0 = outcrop,
1 = boulder, 2 = talus clump.

Cell size is `meta.instances.cellSize` (1000 m), origin `meta.instances.minX/minY`.

## features.json

```
{
  "lifts":     [{ "name", "type", "stations": [[x,y,z],...], "towers": [[x,y,zGround,height],...],
                 "cable": [[x,y,z],...], "capacity" }],
  "runs":      [{ "name", "difficulty": "easy|intermediate|advanced|expert|freeride",
                 "groomed": bool, "gladed": bool, "points": [[x,y,z],...], "osmId" }],
  "buildings": [{ "name", "points": [[x,y],...], "zBase", "height", "kind" }],
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
  "instances": { "cellSize": 1000, "minX", "minY", "cellsX", "cellsY", "treeCount", "rockCount" },
  "start": { "x", "y", "heading" },                       // default drop-in
  "sun": { "azimuth": 160, "elevation": 32 },             // degrees, default lighting
  "attribution": ["..."]
}
```
