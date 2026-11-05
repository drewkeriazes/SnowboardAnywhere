# SnowboardAnywhere board

Kanban for the project. Every feature, bug and data task gets a card with an id. Tell Claude "build FEAT-012" or "work on BUG-003" and it picks up the card, moves it to In progress, and moves it to Done with a commit hash when it lands.

Rules
- One card per deliverable. Keep the description short; link to a doc for details.
- Columns: Backlog (idea), Ready (specced, data available), In progress (owner + started date), Done (commit).
- Data cards (DATA-*) are pipeline or raw-data work that runs on Drew's PC; they are not done until the pack is rebuilt.
- Ids never get reused. Next ids: FEAT-021, BUG-004, DATA-006.

## In progress

| Id | Card | Owner | Started |
|---|---|---|---|
| FEAT-001 | Minimap in the bottom-right corner showing the rider on a hillshade with runs and lifts | Claude (cloud) | 2026-11-05 |
| FEAT-002 | Full-screen map on M: click anywhere to drop the rider there; drop-in point persists (R restarts there, survives reload via URL and localStorage) | Claude (cloud) | 2026-11-05 |
| FEAT-003 | Buildings rendered from features.json footprints (lodges first: Eagle's Nest, Two Elk, Mid-Vail, Wildwood, Buffalo's, Belle's Camp, base villages) | Claude (cloud) | 2026-11-05 |
| FEAT-004 | Rocks that look like rocks: displaced low-poly variants, sunk into the slope, tilted to the ground normal, colour variation | Claude (cloud) | 2026-11-05 |
| FEAT-005 | Ride lifts back up: press E at a bottom terminal to board, rider follows the cable, drops in at the top facing downhill | Claude (cloud) | 2026-11-05 |
| FEAT-006 | Skip to the top while on a lift (press E again) | Claude (cloud) | 2026-11-05 |
| BUG-001 | Back Bowls (south side) look unrendered while the Front Side renders fine. Suspects: sun at azimuth 160 lights south faces head-on so they have no relief; fine tiles evicted around the rider instead of the camera; trees/mask stream around the rider, not the camera | Claude (cloud) | 2026-11-05 |

## Ready

| Id | Card | Notes |
|---|---|---|
| FEAT-007 | Lift names and run names on the map and minimap labels | after FEAT-001/002 |
| FEAT-008 | Rideable gondolas and platters/magic carpets use the same boarding flow as chairs | after FEAT-005 |
| FEAT-009 | Tree LOD impostors beyond 400 m (octahedral impostors, see docs/research/threejs-rendering-stack.md) | perf |
| FEAT-010 | Cascaded shadow maps (CSM) so trees shadow pistes at distance | visual |
| FEAT-011 | Piste-aligned corduroy (store piste direction angle in the mask) | needs DATA-002 |
| FEAT-012 | Time of day: sun from date and time at the resort lat/lon, sky colours | visual |
| FEAT-013 | Roads drawn as draped ribbons (I-70, Frontage Road, base area streets) | features.json has 1,406 roads |
| FEAT-014 | Peak and town labels on the horizon (features.json peaks and labels) | |
| FEAT-015 | Touch controls on screen (stick + jump + lift button) | mobile |
| FEAT-016 | Rock collisions: ride up and over low rocks like a ramp (the rock's slope is the ground); only a near-vertical face at speed knocks the rider down | physics; Collider needs rock height profiles, not just cylinders |
| FEAT-017 | Sound effects: carve/skid hiss scaled by speed and edge, wind in a tuck, jump and landing thumps, crash, lift hum, boarding chime (Web Audio, synthesised or short royalty-free samples) | |
| FEAT-018 | Background music: a small playlist with volume control and mute, remembered across sessions | needs licensed or CC0 tracks under `game/public/music/` |
| FEAT-019 | Main menu on start: resort picker, free ride / drop-in from map, settings (audio, graphics, controls), continue from last spawn | ui |
| FEAT-020 | Rock and cliff-face textures: photo-based albedo/normal for rock and scree with triplanar projection on steep faces | needs DATA-005 for imagery |

## Backlog

| Id | Card |
|---|---|
| BUG-002 | Canopy mask shows trees above treeline in the Back Bowls (lidar subsampled to 3 m, grey_closing fills gaps). Needs DATA-001 or a lidar-return gate in build_pack.py |
| BUG-003 | Only 2,076 rocks placed for Vail; rock class is 0.9% of cells. Loosen the NAIP saturation gate (0.15 -> 0.2) or place rocks from slope |
| DATA-001 | Fetch LANDFIRE EVT for the Vail bbox (pipeline/fetch_landfire.mjs) and use it for species and the treeline |
| DATA-002 | Add piste direction (angle byte) to the mask tiles for corduroy alignment |
| DATA-003 | Re-fetch NAIP in 2 km chunks for true 1 m imagery (current crops are capped at 2048 px, about 2 m) |
| DATA-004 | Second resort through the pipeline (Breckenridge or Copper; both have 3DEP 1 m) |
| DATA-005 | Rock texture sources: Google Maps / Street View imagery is not licensed for this use; use CC0 PBR rock sets (ambientCG, Poly Haven) or NAIP summer imagery as a colour overlay on rock masks |
| M6 | Timed runs, challenge links, multiplayer (after the resort looks right) |

## Done

| Id | Card | Commit |
|---|---|---|
| M0 | Vail pipeline end to end: DEM, lidar canopy, NAIP masks, OSM features, pack of 234 MB | c4e6715 |
| M1 | Streaming quadtree terrain, sky, sun, far ring, fly camera | a6762df and earlier |
| M2 | Rider physics, chase camera, keyboard and touch | a6762df and earlier |
| M3 (part) | Instanced trees per cell with near/far geometry, rocks, collisions, shadows | a6762df and earlier |
| M4 (part) | Lifts with towers, catenary cables, moving chairs; piste overlay | a6762df and earlier |
