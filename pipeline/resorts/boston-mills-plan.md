# Boston Mills / Brandywine: data plan

Planned 2026-11-11 by `pipeline/resort.py plan boston-mills` (FEAT-223). EPSG:26917 (17N), origin 453150, 4569350. Ski area 3.5 km across, buffer 1000 m, box 3.9 x 5.1 km, elevation 192 to 312 m (Mapterhorn z12).

**Tier: gold**

| Layer | Source | Year | Resolution | Items | Size | Tier |
|---|---|---|---|---|---|---|
| Terrain, resort | 3DEP ImageServer; 1 m tiles: OH_Statewide_Phase1_2019_B19 (100% of the box) |  | 1 m | 12 | 84 MB | gold |
| Terrain, mid ring | 3DEP ImageServer |  | 10 m | 4 | 65 MB |  |
| Terrain, far ring | Mapterhorn |  | z11 | 210 | 22 MB |  |
| Lidar | EPT OH_Statewide_Phase1_1_2019 (100% of the box, QL 1, 18.6 pts/m2) | 2019-11 to 2020-05, leaf-off | depth 10: 2.2 m | 204, 12 M points | 109 MB | gold |
| Lidar, far tree ring | same, 5000 m round the box | | depth 9: 4.4 m | 910 | 417 MB | |
| Imagery | Planetary Computer naip 2023 30cm (1 quarter quad from 2021 where 2023 has none) | 2023, 2021 | 1 m | 5 | 41 MB | gold |
| Land cover, far terrain | ESA WorldCover 2021 + ETH canopy height 2020 (3 degree tiles) | 2021, 2020 | 10 m | 8 | 1,492 MB |  |
| Vegetation type | LANDFIRE EVT, EVC, EVH (`fetch_landfire.mjs`) | | 30 m | | 2 MB | |
| Runs, lifts, buildings | OSM via Overpass (Geofabrik extract: us/ohio) |  |  | 5 | 19 MB |  |
| Grooming | none | | | | | |

Total about **2,252 MB**.

Lidar size is points x 8.8 bytes (LAZ), raster sizes are pixels x bytes per pixel, both measured on Vail's raw data.

## Notes

- OH_Statewide_Phase1_1_2019 was flown 2019-11 to 2020-05 (leaf-off): deciduous crowns read low and sparse; compare crown count against NAIP canopy
- no archived Vail Resorts terrain status page: groomed runs come from OSM tags only

## Next

- `start_run` is empty: FEAT-175 step 4 picks it after the build.
- `python pipeline/gen_manifest.py boston-mills`, then `pipeline/fetch.ps1 -Slug boston-mills -RawDir <dir>` on Drew's PC.
