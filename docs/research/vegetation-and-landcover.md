# Research: trees, species and landcover from the raw data (M0 trees/masks stages, M3)

Researched 2026-11-05. Covers the three inputs that decide where trees go and what they look like: the lidar point cloud (positions, heights), LANDFIRE EVT (species), NAIP (masks). Facts about our files are from the files; algorithm parameters are from the cited docs; "starting point" thresholds are to be tuned against the Vail trail map.

## 1. The lidar we have (`raw/vail/ept/`)
- Dataset: `USGS_LPC_CO_Central_Western_2016_LAS_2018` on `usgs-lidar-public` (3DEP). Flown 2016, so trees cut or burned since then are still in the cloud and newer lift lines (e.g. the 2022 Sun Down Express realignment) are not reflected; cross-check against the 2023 NAIP.
- EPT 1.1.0, laszip, `span: 256`, 103.7 billion points in the full dataset. 388 nodes pre-selected for the Vail bbox, subsampled to ~3 m spacing (roughly 0.1 pt/m^2 at the fetched nodes: fine for crowns >= 3 m, not for saplings).
- SRS is EPSG:3857 (Web Mercator). X/Y units are Mercator metres, NOT ground metres: at Vail's latitude ground distance = mercator distance * cos(39.6 deg) ~ 0.77. Reproject X/Y to EPSG:26913 with pyproj before any distance-based step (window sizes, crown radii, spacing). Z is in metres and correct as-is (conforming bounds 1206 to 4843 m).
- Schema: X, Y, Z (scale 0.001), Intensity, ReturnNumber, NumberOfReturns, Classification, ScanAngleRank, GpsTime, etc. ASPRS classes: 1 unclassified, 2 ground, 7 low noise, 9 water, 17 bridge deck, 18 high noise; vegetation (3/4/5) is usually left as 1 in USGS deliveries, so derive canopy from height above ground, not class codes.

Pipeline
1. Ground points (class 2) -> DTM at 1 m, or just use the 3DEP 1 m DEM (derived from the same flights).
2. All non-noise points -> DSM at 1 m (max Z per cell). CHM = DSM - DTM, clamp to [0, 60].
3. Smooth CHM with a 3 x 3 median (removes pits), then local-maximum filter.

## 2. Individual tree detection: local maximum filter with a height-dependent window
From lidR's `lmf` (Popescu & Wynne 2004 style): a pixel is a tree top if it is the maximum within a circular window of diameter `ws` and above `hmin` (default 2 m). `ws` can be a function of height; lidR's documented example is `ws(h) = 0.07 * h + 3` metres. [lidR itd_lmf](https://rdrr.io/pkg/lidR/man/itd_lmf.html)

Starting point for subalpine conifers (narrow crowns): `ws(h) = 0.05 * h + 2.5`, `hmin = 3`. Aspen crowns are wider and rounder: `ws(h) = 0.08 * h + 3`. Apply the species-appropriate window using the LANDFIRE class under each pixel. In Python: `scipy.ndimage.maximum_filter` per height band (quantise h into 5 m bands, run the filter with that band's window, keep pixels where chm == max and band matches).

Crown radius: grow a region from each top until height drops below 50 % of the top height or meets another crown (`skimage.segmentation.watershed` on the inverted CHM with tops as markers). radius = sqrt(area / pi), clamp 1 to 6 m.

Treeline at Vail is roughly 3,500 to 3,600 m (11,500 to 11,800 ft); the summit is 3,527 m, so the top of the Back Bowls and Blue Sky ridges sit at treeline with krummholz. Expect tree heights to drop from 20 m at 3,000 m elevation to under 5 m above 3,450 m. Use this as a sanity check on the CHM.

## 3. Species from LANDFIRE EVT (30 m)
Relevant class codes (LANDFIRE EVT values from the Earth Engine catalog page), mapped to our four render species.

| EVT code | Name | Render species |
|---|---|---|
| 3011 | Rocky Mountain Aspen Forest and Woodland | aspen (leafless white trunks in winter) |
| 3061 | Inter-Mountain Basins Aspen-Mixed Conifer Forest and Woodland | mixed: 50 % aspen, 50 % spruce-fir |
| 3050 | Rocky Mountain Lodgepole Pine Forest | lodgepole (tall, straight, thin crown, bare lower trunk) |
| 3167 | Rocky Mountain Poor-Site Lodgepole Pine Forest | lodgepole, shorter |
| 3055 | Rocky Mountain Subalpine Dry-Mesic Spruce-Fir Forest and Woodland | spruce-fir (narrow conical, branches to the ground, snow-loaded) |
| 3056 | Rocky Mountain Subalpine Mesic-Wet Spruce-Fir Forest and Woodland | spruce-fir |
| 3160 | Rocky Mountain Subalpine/Upper Montane Riparian Forest and Woodland | spruce-fir + willow shrub |
| 3057 | Subalpine-Montane Limber-Bristlecone Pine Woodland | krummholz/limber (gnarled, short) |
| 3145 | Rocky Mountain Subalpine-Montane Mesic Meadow | no trees, meadow mask |
| 3146 | Southern Rocky Mountain Montane-Subalpine Grassland | no trees, meadow mask |
| 3070 / 3143 / 3144 | Alpine Dwarf-Shrubland / Fell-Field / Turf | no trees, alpine mask (wind-scoured snow) |
| 3222 | Alpine/Montane Sparsely Vegetated | rock/scree mask |
| 3126 | Inter-Mountain Basins Montane Sagebrush Steppe | low shrubs (south-facing lower slopes near I-70) |
| 3166 / 3227 / 3234 / 3235 | Douglas-fir forest variants | render as spruce-fir (lower elevations only) |
| 3293 | Snow-Ice | snow mask |
| 3294 | Barren | rock mask |
| 3296 to 3299 | Developed (low/med/high, roads) | built mask (base areas, I-70) |

Update 2026-11-05: LF 2.4 / 2.5 (LF2023_EVT, LF2024_EVT from LFPS) renumbered these classes into the 7000s (aspen 7011, spruce-fir dry-mesic 7055, lodgepole 7050, meadow 7145). `build_pack.py` therefore matches by EVT_NAME from the clip's .vat.dbf, not by code. Vail LF2024 mix: spruce-fir 39 %, aspen 19 %, lodgepole 12 %, meadow and grassland 9 %, developed 6 %.

Notes: there is no Colorado-specific krummholz class; derive krummholz from elevation > 3,450 m plus CHM < 4 m within a spruce-fir class. Resolution is 30 m, so species boundaries are blobby; refine with NAIP (aspen stands are distinctly brighter and greener with higher NDVI in leaf-on NAIP than conifer). LANDFIRE is not yet in `raw/`; it needs a one-time download of the Colorado EVT GeoTIFF from landfire.gov (LF 2024) or an export from Earth Engine. [LANDFIRE EVT on Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/LANDFIRE_Vegetation_EVT_v1_4_0)

## 4. Masks from NAIP (`raw/vail/naip1m/`, 2023, 4-band)
Starting-point rules at 1 m, with NDVI = (NIR - R) / (NIR + R):
- Conifer canopy: NDVI > 0.45 and CHM > 3 m and NIR relatively low (conifers are darker in NIR than broadleaf).
- Aspen canopy: NDVI > 0.55 and CHM > 3 m and NIR high and green high (summer leaf-on).
- Meadow / grass: NDVI 0.3 to 0.55 and CHM < 1 m.
- Rock / scree: NDVI < 0.15, brightness (R+G+B)/3 mid-to-high, slope > 30 deg or OSM natural=bare_rock|scree|cliff. Scree has low local height variance in the DEM, outcrops high.
- Water: NDVI < 0 and NIR very low, plus OSM natural=water.
- Built: OSM building/highway buffers, plus LANDFIRE developed classes.
- Trail cuts: CHM < 2 m inside an OSM piste polygon or within 25 m of a piste way; the lidar canopy gap is the authoritative corridor edge, better than OSM's hand-drawn piste width.
Validate each mask by rendering it top-down over NAIP RGB and comparing with the official trail map.

## 5. Tree instance record (for `trees.bin`)
Per tree: x, y (UTM metres relative to origin, float32), z (ground height, float32), height (float16 or uint8 in 0.25 m steps), crown radius (uint8 in 0.1 m), species (uint8: 0 spruce-fir, 1 lodgepole, 2 aspen, 3 krummholz), seed (uint8 for rotation/variant). 16 bytes per tree; 150k trees ~ 2.4 MB. Spatially sort into 256 m cells so the renderer can stream and cull by cell.

## Sources
- [lidR itd_lmf documentation](https://rdrr.io/pkg/lidR/man/itd_lmf.html)
- [LANDFIRE EVT v1.4.0 class table (Earth Engine catalog)](https://developers.google.com/earth-engine/datasets/catalog/LANDFIRE_Vegetation_EVT_v1_4_0)
- [LANDFIRE LF2024 EVT data dictionary (PDF)](https://www.landfire.gov/sites/default/files/DataDictionary/2024/LF24_EVTADD.pdf)
- `raw/vail/ept/ept.json` (dataset name, SRS, schema)
