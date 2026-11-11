# SnowboardAnywhere docs

Start here. Everything a session needs to know that is not code lives in this folder. The claude.ai Project docs under `claude/` are a mirror; this folder is canonical.

| Doc | Read it when |
|---|---|
| [bonvo-teardown-and-build-plan.md](bonvo-teardown-and-build-plan.md) | Plan of record: how Bonvo works, what we build instead, data sources, pack format, renderer and physics design, milestones M0 to M6. |
| [workspace-and-sessions.md](workspace-and-sessions.md) | Repo layout, where raw data lives, rules for multiple Claude sessions, known divergences in older code. |
| [data/vail-raw-data-inventory.md](data/vail-raw-data-inventory.md) | Before touching `raw/`: every folder, file naming, projections, element counts, fetch lessons, how to add a resort. |
| [research/threejs-rendering-stack.md](research/threejs-rendering-stack.md) | M1/M3/M5: CDLOD terrain, heightmap textures, `@three.ez/instanced-mesh` and octahedral impostors for trees, CSM shadows, sky, snow shading. |
| [research/rider-physics.md](research/rider-physics.md) | M2: carving equations (Komissarov), snowboard adaptation, carve/skid controller, surface modifiers, validation targets. |
| [research/vegetation-and-landcover.md](research/vegetation-and-landcover.md) | M0 trees/masks and M3: lidar facts (2016 flight, EPSG:3857 trap), tree detection parameters, LANDFIRE EVT code table, NAIP mask rules, tree record format. |
| [research/vail-resort-facts.md](research/vail-resort-facts.md) | M0 validation and M4: elevations, the three faces, all 33 lifts joined to OSM `ref`, priority runs, landmark lodges, horizon peaks. |
| [research/lifts-weather-and-sun.md](research/lifts-weather-and-sun.md) | M4/M5: the OpenSkiData GeoJSON schema (from source), lift speeds and carrier spacing, cable sag, Open-Meteo request and WMO code mapping, verified sun-position code. |
| [research/licensing-and-attribution.md](research/licensing-and-attribution.md) | Before shipping: licence per data source, the attribution block for `meta.json`, and the Mapterhorn z17 / 1 m finding. |
| [research/claude-code-tooling.md](research/claude-code-tooling.md) | Which Claude Code plugins, skills and MCP servers help on this project (Chrome DevTools MCP, Three.js DevTools MCP, parallax-threejs, game skills, GeoAI), install commands, and the repo-local skills in `.claude/skills/`. |
| [research/shredfinder-ghost-and-gps.md](research/shredfinder-ghost-and-gps.md) | Ghost rider epic: what the ShredFinder GoPro telemetry contains (HERO11, 10 Hz GPS, CORI), gaps to fix, the 3-step export/build/replay plan, and what the data can and cannot do for the maps. |
| [research/outrun-mode.md](research/outrun-mode.md) | Before building FEAT-097 to FEAT-101 (Outrun, the SkiFree-style chase): the card's design checked against the code, key and jukebox corrections, breadcrumb AI, sound and music stages, the eat sequence on the current rig, the build order. |
| [research/deformable-snow-and-spray.md](research/deformable-snow-and-spray.md) | Before building FEAT-044 (#76, deformable snow and powder spray): what the tracks, bootprints, terrain and spray do today, the Batman and Tomb Raider heightfield techniques, the design (top-down raster of the existing ribbons and prints into a rider-local texture, a 25 cm near split of the terrain, GPU spray), build order and risks. |
| [research/ghost-lines-prototype/](research/ghost-lines-prototype/README.md) | Before building FEAT-181 (#423, menu ghost riders from lines drawn on a screenshot): how the Vail backdrop ghosts were made by hand, the prototype scripts (extract, camera fit and cast, physics ride), what failed and why, the numbers, and the game-side timing and cost. |
| [research/far-terrain.md](research/far-terrain.md) | Before far terrain, background forest or horizon work (FEAT-153, DATA-019): why distant forest looks random today, which pixel sizes matter at distance, land cover and canopy data sources, mask levels, a far class texture, the canopy silhouette lift, geomorphing, the phased plan and budgets; section 7 (FEAT-154): the view from high up, which shader term made the grey blobs, a Sentinel-2 check of the forest share, the canopy gap fraction and its frame cost. |
| [developer-guide.md](developer-guide.md) | Full feature list, code layout, test tools, every pipeline script, URL parameters, milestone status (the detail behind the top-level README). |
| [HANDOFF.md](HANDOFF.md) | Current state and next steps when a session picks the project up. |
| [research/compare-findings-roadmap.md](research/compare-findings-roadmap.md) | Before tree, rock, building or snow realism work: what the DATA-008 photo pairs found, pack measurements per spot, root causes with code locations, the phased plan (FEAT-072, #116) and the compare metrics harness. |
| [research/rpg-rider-stats.md](research/rpg-rider-stats.md) | Before FEAT-194 (#462, RPG-style rider stats): how THPS, Elder Scrolls and Riders Republic do it, four ways to build it, the v1 skill report card (stat formulas and code hooks) and the optional Arcade-only physics scaling. |
| [compare/README.md](compare/README.md) | Real vs game photo pairs (Street View spot vs the eye camera): the workflow, the checklist and the index of spots. |
| [pack-format.md](pack-format.md) | The resort pack layout the pipeline writes and the game reads. |

Conventions
- Dated "Researched YYYY-MM-DD" headers; update the date when you revise.
- Cite sources at the bottom of each research doc. Mark unverified numbers as "starting point" or "reasoned".
- Add a new doc here rather than a long comment in code when the knowledge is reusable across milestones.
