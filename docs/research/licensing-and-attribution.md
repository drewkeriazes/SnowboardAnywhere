# Research: data licences and the attribution we must ship

Researched 2026-11-05. This decides what text goes in `meta.json.attributions` and the in-game credits screen. Public-domain sources need no attribution legally but USGS asks for a credit line; ODbL sources require it.

| Source | What we use it for | Licence | Required attribution / notes |
|---|---|---|---|
| USGS 3DEP 1 m DEM (ImageServer exports) and 1/3 arc-second | terrain | Public domain (U.S. Government work) | Credit: "Elevation data: U.S. Geological Survey 3D Elevation Program". No restrictions on redistribution or derived packs. |
| USGS 3DEP lidar point cloud (`usgs-lidar-public` EPT, CO Central Western 2016) | trees, canopy, building heights | Public domain | Same credit. The AWS bucket is part of the AWS Open Data program; no key, no limits stated. |
| USGS GNIS Domestic Names | place and peak names | Public domain | Credit: "Geographic names: USGS Geographic Names Information System". |
| NAIP imagery (via Microsoft Planetary Computer) | landcover masks, validation | Public domain (USDA FSA) | Credit: "Imagery: USDA NAIP via Microsoft Planetary Computer". Planetary Computer's API terms ask for attribution of the platform; no key needed for the data endpoints we used. |
| LANDFIRE EVT (USGS / USFS) | tree species | Public domain | Credit: "Vegetation type: LANDFIRE (USGS and U.S. Forest Service)". LFPS requires an email at request time for usage stats only. |
| OpenStreetMap (via Geofabrik extract and Overpass) | pistes, lifts, towers, buildings, roads, water, peaks, places | ODbL 1.0 | MUST show "© OpenStreetMap contributors" wherever OSM-derived content is visible (in-game credits and the resort picker). Derived databases: our `features.json` is a "derivative database" if we redistribute it; a game pack is arguably a "produced work" but include the credit regardless. If we ever publish the packs separately, the ODbL share-alike applies to the OSM-derived parts. |
| OpenSkiData / OpenSkiMap (russellporter) | runs, lifts, resort polygon, difficulty, grooming | Data is OSM-derived, so ODbL; the format library is MIT | Same OSM credit plus "Ski area data: OpenSkiMap.org". Skimap.org-sourced attributes (resort status, some names) are under skimap.org's terms; we only use OSM-sourced run/lift attributes. |
| Mapterhorn terrain tiles | far-ring background terrain | Code BSD-3; tile data inherits each source's licence; for the USA all 34 sources are USGS 3DEP, public domain | Credit "Terrain tiles: Mapterhorn (USGS 3DEP)". No stated usage limits or terms on the public tile endpoint; hosted on Cloudflare. Be a good citizen: cache tiles in the pack rather than hitting `tiles.mapterhorn.com` at runtime. |
| Open-Meteo | live weather | CC BY 4.0 for the API data; free for non-commercial use without a key | Credit "Weather data by Open-Meteo.com". Commercial use needs a paid key. |
| Three.js, Vite, @three.ez/*, meshoptimizer | engine | MIT | Licence files ship with the bundle. |
| ambientCG Rock030, Gravel040 (`game/public/textures/`, made by `pipeline/prep_textures.py`) | rock and talus albedo, normal, roughness | CC0 1.0 | None required; credit "Rock textures: ambientCG.com (CC0)" anyway. Chosen in DATA-005 (#18): Google Maps / Street View imagery may not be used as textures (Google Maps Platform terms forbid extracting imagery), so photo detail comes from CC0 PBR sets. Poly Haven (also CC0) is the fallback source. |

## What to write into `packs/<slug>/meta.json`
```json
"attributions": [
  "Elevation and lidar: U.S. Geological Survey 3D Elevation Program (public domain)",
  "Terrain tiles: Mapterhorn, built from USGS 3DEP",
  "Imagery: USDA NAIP via Microsoft Planetary Computer (public domain)",
  "Vegetation type: LANDFIRE, USGS and U.S. Forest Service (public domain)",
  "Geographic names: USGS GNIS (public domain)",
  "Map data © OpenStreetMap contributors, ODbL; ski area data: OpenSkiMap.org",
  "Weather data by Open-Meteo.com (CC BY 4.0)",
  "Rock textures: ambientCG.com (CC0)"
]
```
Show the OSM line in the credits screen and under the resort picker. Do not use resort trademarks (Vail Resorts logos, the official trail map artwork) in-game; run and lift names are facts and are fine.

## Mapterhorn as a possible DEM source for future resorts (new finding)
- Mapterhorn serves `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` from z0 up to z17 (PMTiles archives: `planet.pmtiles` for z0 to z12, per-region `6-x-y.pmtiles` for z13+). 512 px Terrarium WebP.
- Its US sources (attribution.json) now include 33 regional USGS 1 m 3DEP datasets plus the 10 m 1/3 arc-second layer. So where 1 m coverage exists, z15/z16 tiles carry ~1 to 2 m data at Vail's latitude (ground pixel size at z = 40075016 * cos(39.6 deg) / (512 * 2^z): z13 7.4 m, z14 3.7 m, z15 1.8 m, z16 0.9 m).
- Bonvo only fetched z13, which is why their terrain is ~10 m class; the data behind the tiles may be better than that.
- Not yet verified for Vail's tiles specifically. To check: fetch one z16 tile over the Back Bowls and compare against our `dem1m/` mosaic. If it matches to ~1 m, the whole DEM step for the next resort becomes "fetch z15 or z16 Terrarium tiles" with no USGS ImageServer 500s and no reprojection step (tiles are Web Mercator, so we still warp to UTM, but from a clean, pre-mosaicked source). Coverage page: https://mapterhorn.com/coverage.

## Sources
- [Mapterhorn attribution.json](https://download.mapterhorn.com/attribution.json)
- [Mapterhorn data access](https://mapterhorn.com/data-access)
- [OpenStreetMap ODbL](https://www.openstreetmap.org/copyright)
- [openskidata-format (MIT)](https://github.com/russellporter/openskidata-format)
- [Open-Meteo docs](https://open-meteo.com/en/docs)
- [LANDFIRE Product Service](https://lfps.usgs.gov/)
