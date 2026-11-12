# Name a resort, get a pack: auto pipeline and pack hosting (EPIC-15, #516)

Designed 2026-11-11 against `main` at 76da1ff. Idea from Drew: type a resort name, a pipeline builds its config and pack using everything DATA-022 (#439) taught us, and the pack is published somewhere free so it can be downloaded. Packs and resort data live in a second repo. Edge case to design for: Boston Mills, Ohio.

> **Superseded in part by EPIC-16 ([MapPacker-SnowboardAnywhere#9](https://github.com/drewkeriazes/MapPacker-SnowboardAnywhere/issues/9), 2026-11-11):** the pipeline moved to MapPacker (FEAT-238 to FEAT-242) and this repo just plays packs. The pack format is the contract between the repos, with its spec in MapPacker. Plan: [`docs/pipeline-move.md`](https://github.com/drewkeriazes/MapPacker-SnowboardAnywhere/blob/main/docs/pipeline-move.md). Section 2's "all pipeline code" row and "How the two repos link" describe the layout before that move; the `pipeline/` paths in this note are history and name the same files in MapPacker.

This epic sits on top of FEAT-175 (#409). FEAT-175 makes the build repeatable and measured (`pack_report.py`, no Vail constants, `build_resort.py`). This epic adds the two ends it does not have: **a name in** (no hand-written `resorts/<slug>.json`) and **a download out** (packs published and fetched by slug).

## 1. The flow (one command, five stages)

```
python pipeline/resort.py add "Boston Mills"
  resolve  -> name to OpenSkiData ski area(s)            (cloud or PC)
  plan     -> resorts/<slug>.json + data plan + tier      (cloud or PC)
  fetch    -> raw/<slug>/  (fetch.ps1, LANDFIRE, grooming) (Drew's PC)
  build    -> packs/<slug>/ + report.json                  (FEAT-175 build_resort.py)
  publish  -> release <slug>-v<N> in the resorts repo + catalog.json
```
Each stage writes its output and stops on a clear message; re-running skips finished stages (FEAT-175 rule). `--stop-after plan` lets Drew read the plan before a 1+ GB fetch.

### resolve
- Search OpenSkiData `ski_areas.geojson` (`tiles.openskimap.org/geojson/`, already our run and lift source) by name, case and accent insensitive.
- One match: go on. Several (Boston Mills and Brandywine, or "Big Sky" vs "Big Sky Resort"): print id, name, location, run and lift counts, and stop. `--id <openskidata id>` picks one; `--with <name or id>` merges a neighbour into the same pack.
- No match: stop with the closest names. A ski area missing from OpenSkiData is a later "any hill" pack (section 5), not a guess.

### plan (writes `resorts/<slug>.json` like the hand-written ones)
Everything Drew typed by hand for Vail, Breck and Big Sky, derived:
| Field | Derived from |
|---|---|
| `slug`, `name`, `region`, `country`, `osm_ski_area_way` | the OpenSkiData feature |
| `crs`, `utm_zone`, `origin` | centroid of the ski area polygon |
| `lonlat_bbox`, `utm_bbox`, `buffer_m` | polygon buffered by `max(500 m, 0.3 x polygon diameter)`, not a fixed 1.5 km (Vail's buffer would make Boston Mills 90 % forest and farmland) |
| `elevation_range_m` | Mapterhorn z12 sample over the box (no fetch needed) |
| `dem` | TNM Access API: 1 m 3DEP product in the box? else Mapterhorn z15, else 3DEP 1/3 arc-second |
| `lidar` | `usgs.entwine.io` boundaries index: EPT datasets covering the box (several allowed, as Big Sky's `lidar.extra`), with the year and point density from `ept.json` |
| `naip` items | Planetary Computer STAC search, newest leaf-on year covering the box |
| LANDFIRE, WorldCover, ETH canopy, `pistes_wide` | always (US) / WorldCover and ETH only (outside US) |
| OSM source | Geofabrik extract for the state, chosen from the centroid (no Overpass, per the fetch lessons) |
| grooming feed | operator from OpenSkiData; Vail Resorts resorts get `fetch_grooming.py` |
| `start_run` | left empty; FEAT-175 step 4 picks it after the build |
| `tier` | section 4 |

The plan also prints a **data plan**: each layer, its source, year, resolution and expected download size, and the tier. That is what Drew checks before the fetch.

As built (FEAT-223, `pipeline/resort.py`), checked against the hand configs with `resort.py compare` and `tests/test_resort_plan.py`:
- **Extent** is the OpenSkiData polygon plus the area's lifts and runs (Breckenridge has only a point; `runs.geojson` is about 800 MB but holds one feature per line, so a scan for a few ids takes seconds). Vail comes out 7 m from its hand box, Big Sky within 500 m; Breckenridge's hand box was drawn 1.6 km wider than its runs and lifts on three sides, and the planned one sits inside it.
- **Buffer** is capped: `min(1000, max(500, 0.3 x diagonal))`. Uncapped, Vail's would be about 4 km; every hand config uses 1 km.
- **The two-area question** is asked for a named neighbour with lifts that reaches into the box (closer than the buffer plus 500 m: Snowbird and Alta, Big Sky and the Yellowstone Club) or is sold with the resort (the same website within 3 km: Boston Mills and Brandywine, 1.5 km apart). Copper, 2.3 km from Breckenridge's runs but outside its box, is not asked about. `--alone` writes the neighbour's run and lift ways into `exclude` by OSM id (`osm_filter.py` `osm_ways`).
- **EPT depth** is the shallowest whose node spacing on the ground is under 3.2 m (Vail 2.9 m and Big Sky 3.1 m at depth 9; Big Sky's east strip, MT P3_3_B21, is 4.4 m at 9, so it gets 10, one deeper than its hand config). `lidar.far` (5 km) goes on every resort at the depth under 4.5 m. Flight dates and QL come from the 3DEP elevation index's lidar work units (MapServer layer 8), not `ept.json`, which has none: Ohio's 2019 statewide lidar was flown November to May, leaf-off.
- **Grooming feed**: a resort gets `terrain_status_url` when the Internet Archive holds its Vail Resorts terrain status page (Vail, Breckenridge; not Boston Mills, which has no snapshots). The live pages answer 403 or carry no feed to a script, so the archive is the evidence.
- **The data plan** goes to `pipeline/resorts/<slug>-plan.md` beside the config, and `publish_pack.py` copies it to the resorts repo's `reports/`; a plan written straight into the MapPacker clone would leave it dirty, which `publish_pack.py` refuses.
- **OSM**: the plan records the Geofabrik extract (`osm.geofabrik`), but `gen_manifest.py` still uses Overpass; switching the fetch is a later card (Overpass still answers for every resort so far).

As built (FEAT-224, `resort.py add`, on FEAT-175 step 3's `build_resort.py`): stages `resolve`, `plan`, `fetch`, `build`, `report`, `ride`, `publish`, each skipped when done; `add_resort.cmd` stops once after a new plan. How the section 3 lessons landed:
- Manifest version (3): `build_resort.py` makes an older manifest again and fetches what it lacked; the fingerprints hash the manifest's items, so the new version key alone fetches nothing.
- LANDFIRE (4): a stage of the fetch, with the LFPS email from `--email`, `LANDFIRE_EMAIL` or a prompt.
- Far terrain skipped without land cover (8): the raw check before the build requires land cover and `pistes_wide` (unless the config turns land cover off) and `ept_far/` with `lidar.far` (8b), instead of `cover.py` failing, so `cover.py` run by hand on an old pack still works.
- Density, attribution (7, 13): already `pack_report.py` lines 7 and 13.
- Start and headless ride (10): the start is still `build_pack.py`'s (FEAT-175 step 4 picks it); `add` rides from it with `shoot.mjs` before publishing and stops on a page error.
- Gate (rule 2): the MVP lines that fail are printed before the ride and publish; `publish_pack.py` marks the pack `preview` from the report.
- Not yet: stills re-shot and compared on publish (19), and the Geofabrik fetch.

### publish
- Gate: every DATA-022 MVP line (1 to 14) in `report.json` passes, or the release is marked `preview` in the catalog.
- `zip packs/<slug>` (stored, no recompression of PNG tiles), sha256, then `gh release create <slug>-v<N>` in the resorts repo with the zip, `report.md` and `meta.json` as assets.
- Update `catalog.json` in the resorts repo and commit it in the same step.

### download (game side)
- `npm run get <slug>` (`game/tools/get_pack.mjs`, Node, about 60 lines): read `catalog.json`, download the zip, check sha256 and `formatVersion`, unzip to `packs/<slug>`, update `packs/index.json`.
- Resort picker: packs in the catalog that are not on disk show "Download (180 MB)". When the game is served by `npm run dev` or `npm run host`, the button calls a small endpoint on that same Node server that runs `get_pack`. The download happens in Node, not the page, because GitHub release downloads send no CORS headers, so a browser `fetch` of the asset fails. (Unverified for the redirect target today; GitHub community discussion #45446 asks for CORS on release assets.)

## 2. Two repos: what goes where

Drew's call (2026-11-11): game in one repo, resort data in another. Agreed, with one split rule.

| Repo | Holds | Why |
|---|---|---|
| `SnowboardAnywhere` (this one) | game, **all pipeline code**, `docs/pack-format.md`, checks | The pack format and the client that reads it change in the same PR. Splitting the pipeline from the client would mean two PRs and version skew on every format change |
| `MapPacker-SnowboardAnywhere` (new, Drew creates it) | `resorts/<slug>.json` + EPT node lists + manifests, `catalog.json`, `reports/<slug>.md`, compare spot lists, and **packs as release assets** | Small text in git (history of every recipe and every report); big binaries in releases |

**Packs in releases, not in git history.** Git history keeps every copy forever, and binary tiles do not diff:
- Vail is 234 MB per build (HANDOFF; more now with `stands/`). Four rebuilds pass GitHub's "ideally under 1 GB" repo size, about twenty pass "under 5 GB strongly recommended". Every clone of the resorts repo would download all of it.
- Releases have no limit on total size or bandwidth, up to 1000 assets per release, each file under 2 GiB. One zip per resort per build fits with room to spare (GitHub docs).
- Old releases can be deleted to drop old builds; git history cannot without a rewrite (we did one already, DATA-017).
- Git LFS: skip. Small free quota and it still stores every version.

The resorts repo's git history still gets the part worth versioning: the config that built each pack and its report, so a regression shows up as a diff in `reports/vail.md`.

### How the two repos link (FEAT-222)
No git submodule; two sibling clones linked by a path, a URL, a version number and the board.
| Link | How |
|---|---|
| On disk | Sibling clones: `C:\Users\Drew\git\SnowboardAnywhere` and `C:\Users\Drew\git\MapPacker-SnowboardAnywhere`. The pipeline finds MapPacker at `../MapPacker-SnowboardAnywhere`; `--resorts-repo <path>` overrides. |
| Resort configs | `pipeline/resorts/*.json` and `*_ept_nodes*.txt` move to MapPacker `resorts/` (one home per file, not copies). The pipeline reads them from there. |
| Publish (pipeline to MapPacker) | `publish_pack.py` writes the config, `reports/<slug>.md` and `catalog.json` into the MapPacker clone, commits as Drew, pushes, then `gh release create <slug>-v<N> -R drewkeriazes/MapPacker-SnowboardAnywhere`. Uses Drew's local `gh` login; no tokens in either repo. |
| Download (game to MapPacker) | One constant in `game/tools/get_pack.mjs`: `https://raw.githubusercontent.com/drewkeriazes/MapPacker-SnowboardAnywhere/main/catalog.json`. `SBA_CATALOG_URL` overrides it (a local path works, for testing). |
| Version | `formatVersion` in the client constant, `meta.json` and the catalog entry. A mismatch shows "needs rebuild", never a broken load. |
| Traceability | Each catalog entry and release note records the SnowboardAnywhere commit (`pipeline`) and the card that built it: `Built by drewkeriazes/SnowboardAnywhere@<sha> (<card>)`. |
| Board | One board (projects/2) pulls issues from both repos; card ids are one sequence across them (`tools/card_id.py` reads both). A card lives in the repo whose PR closes it; cross-repo PRs use `Fixes drewkeriazes/MapPacker-SnowboardAnywhere#<n>`. `docs/BOARD.md`. |
| Docs | MapPacker README: what it holds, how to get a pack, data licences, link back here. This repo's `docs/developer-guide.md` and `docs/pack-format.md` link to MapPacker. |

**Later, not now:** Cloudflare R2 (10 GB-month free, free egress, S3 API) when packs need to be fetched straight from a hosted page, since R2 can send CORS headers. A database (Supabase or D1) only when there is per-player data to store (accounts, times, shared ghosts) or hundreds of resorts; until then `catalog.json` is the database.

### `catalog.json`
```json
{
  "formatVersion": 7,
  "resorts": [
    {
      "slug": "boston-mills",
      "name": "Boston Mills / Brandywine",
      "region": "Ohio", "country": "US",
      "lonlat": [-81.56, 41.27],
      "tier": "gold",
      "status": "playable",
      "pack": {
        "version": 1, "formatVersion": 7, "build": "20261120T150000Z-3fa2c1", "built": "2026-11-20", "pipeline": "76da1ff",
        "bytes": 120000000, "sha256": "...",
        "url": "https://github.com/drewkeriazes/MapPacker-SnowboardAnywhere/releases/download/boston-mills-v1/boston-mills.zip"
      },
      "report": "reports/boston-mills.md"
    }
  ]
}
```
As built (FEAT-222): each `pack` carries its own `formatVersion` (packs are published at different times), and the top-level one is the newest any pack in the catalog uses. `formatVersion` was new work: before FEAT-222 `meta.json` had only `version` (`docs/pack-format.md`). FEAT-222 adds `formatVersion` to `meta.json` and the catalog, bumps it on every format change, and adds a matching constant in the client; a pack from an older format then shows "needs rebuild" instead of loading wrong (the FEAT-074 `stands` problem, caught automatically).

## 3. DATA-022 lessons, built in

Each lesson from the checklist becomes something the pipeline does or checks, so no resort repeats it:
| Lesson (DATA-022 item) | What the pipeline does |
|---|---|
| Breck was fetched before land cover existed (3, 8) | The manifest carries a `manifestVersion`; `plan` refuses to reuse raw data from an older manifest and lists the missing layers |
| LANDFIRE took a slug only after PR #503 (4) | LANDFIRE is a normal stage of `fetch`, never a separate launcher |
| LANDFIRE calls in-resort forest `Developed-*` (4) | `report.json` logs `LANDFIRE forest x%, open y%`; fails when open ground covers more than half of the lidar canopy |
| Tree density compared on crowns only (7) | Density is always crowns + stems per km², by elevation band, against Vail's |
| Pack without `stands` predates FEAT-074 (7) | `formatVersion` in `meta.json` and the catalog (new field, FEAT-222) |
| Far terrain silently skipped without land cover (8) | `cover.py` fails instead of skipping; three cover levels required |
| Attribution missing for new data (13) | Each fetch stage adds its own attribution line; the report checks every layer has one |
| Start point by hand (10) | FEAT-175 step 4 picks it; headless `shoot.mjs` ride from it is part of the gate |
| Rock 11 % at Big Sky vs 1.6 % at Vail; thresholds tuned on Vail (14, 20) | Per-resort thresholds from that resort's NAIP histogram (FEAT-175 step 2), **with absolute floors** (section 6) |
| Lidar density sets tree heights (20) | `plan` reads point density from `ept.json` and picks the EPT depth (DATA-011) |
| Stills go stale (19) | Compare stills are re-shot by the pipeline on every publish, never reused |

## 4. "Snowboard anywhere": tiers chosen per layer

The pipeline picks the best source per layer and the pack's tier is its weakest layer. The client already reads every layer from the pack, so a lower tier is the same format with coarser data.
| Tier | Terrain | Trees | Surface masks | Where |
|---|---|---|---|---|
| Gold | 1 m 3DEP | lidar crowns + LANDFIRE stands | NAIP 1 m | Most US resorts |
| Silver | 1 m 3DEP or Mapterhorn z15 | stands only, from ETH 10 m canopy height + WorldCover (no crowns) | NAIP | US places with a 1 m DEM but no usable EPT |
| Bronze | Mapterhorn (best zoom it has there) | ETH canopy + WorldCover stands | WorldCover 10 m | Outside the US (Mapterhorn carries 1 m-class national data for parts of Europe) |

v1 builds Gold only and reports which layer would drop a resort to Silver or Bronze. Silver and Bronze are their own cards.

## 5. Later: any hill
A pin on the map instead of a ski area: a 3 x 3 km box, no runs or lifts, free ride and drop-in only, Bronze or better. Same pipeline with `resolve` skipped. Separate card once the named-resort path works.

## 6. Boston Mills / Brandywine: the edge case

Facts: Summit County, Ohio, near Peninsula; owned by Vail Resorts since 2019; 240 ft (73 m) vertical; 16 lifts and 18 trails across both areas; Brandywine about a mile north of Boston Mills; 5 terrain parks; 100 % snowmaking; night skiing ([Wikipedia mirror](https://bafybeiaysi4s6lnjev27ln5icwm6tueaw2vdykrtjkwiphwekaywqhcjze.ipfs.ipfs.hypha.coop/wiki/Boston_Mills/Brandywine_Ski_Resort)). The TNM Access API returns 1 m DEM tiles from `OH_Statewide_Phase1_2019` over the area, so it should be Gold.

What breaks or changes, and what the pipeline must do:
| Issue | Why | Handling |
|---|---|---|
| Two ski areas, one ticket | Probably two OpenSkiData areas a mile apart (unverified) | `resolve` lists both; `--with Brandywine` makes one pack over both |
| Tiny resort | Vail's 1.5 km buffer would make the box mostly farmland | Buffer scales with the polygon (section 1); pack should be a few tens of MB |
| UTM 17N | Every hand config so far is 12N or 13N | `crs` derived (FEAT-175 step 2); the first 17N build checks that nothing assumes zone 12N or 13N (no hard-coded zone found in `pipeline/` today) |
| Hardwood forest, leafless in winter | LANDFIRE eastern classes (oak, maple, beech, hemlock) are not in `species.classify_evt`; our 8 species are western | Unknown EVT share in the report; new species "bare hardwood" plus hemlock as a conifer variant (own card) |
| Lidar likely flown leaf-off | Fewer canopy returns from bare crowns, so crowns read low and sparse (unverified for this dataset) | `plan` logs the flight season from the EPT metadata; report compares crown count against NAIP leaf-on canopy |
| No treeline | The derivation expects one (Vail 3,500 m, Big Sky 2,700 m) | Treeline "none" is a valid result; `proceduralForest` and snow ghosts off when there is none (no Colorado fallback of 3,480 m) |
| No real rock | Percentile thresholds would call the brightest pixels rock: parking lots, roofs, the lodge | Rock needs slope over 30 deg and not OSM built-up, plus an absolute NDVI and brightness floor, so the share can be near 0 |
| Valley resort | Runs drop from the plateau into the Cuyahoga valley; lodges at the bottom | Start at the top of the highest lift still works; elevation range derived (about 220 to 300 m, not 2,000 to 3,450) |
| Flat horizon | No `natural=peak` worth labelling, views are farmland and suburbs | Labels from `places_far`; far cover from WorldCover built-up; zero peaks is not a failure |
| Parks are the point | Boston Mills riding is jumps and rails, which no data source places | Out of scope here; own card for a park kit placed in OSM park areas |
| Snow and lights | Man-made snow, night riding (OSM `lit=yes`) | Grooming feed should work (Vail Resorts); lights are a later card |
| Moguls, trials | Slopes rarely over 18 deg, runs short | Moguls score 0 (fine); courses short (fine) |

## 7. Cards
| Card | What | Depends on |
|---|---|---|
| EPIC-15 (#516) | This epic | |
| FEAT-222 (#517) | Resorts repo, `catalog.json`, `publish_pack.py`, `get_pack.mjs`; publish Vail, Breck and Big Sky as v1 | none (download works right away) |
| FEAT-223 (#518) | `resort.py resolve` and `plan`: name to config and data plan | FEAT-175 step 2 for the derived values |
| FEAT-224 (#519) | `resort.py add`: one command from name to published pack, gated on the DATA-022 report | FEAT-175 steps 1 and 3, FEAT-222, FEAT-223 |
| DATA-023 (#520) | Boston Mills / Brandywine as the proof | FEAT-224 |
| FEAT-225 (#521) | Silver and Bronze tiers | FEAT-224 |

Order: FEAT-222 first (a day, and every existing pack becomes downloadable), then FEAT-175 steps 1 and 2, FEAT-223, FEAT-224, DATA-023.

## Sources
- [GitHub: About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) (1000 assets, under 2 GiB each, no total or bandwidth limit)
- [GitHub: About large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) (repos ideally under 1 GB, under 5 GB strongly recommended, 100 MiB file block, use releases for binaries)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) (10 GB-month free, free egress)
- [GitHub community discussion #45446: CORS for release assets](https://github.com/orgs/community/discussions/45446)
- [TNM Access API, 1 m DEM products over Boston Mills](https://tnmaccess.nationalmap.gov/api/v1/products?datasets=Digital%20Elevation%20Model%20(DEM)%201%20meter&bbox=-81.575,41.25,-81.545,41.28&max=5)
- DATA-022 (#439), FEAT-175 (#409), `docs/research/licensing-and-attribution.md`, `docs/HANDOFF.md`
