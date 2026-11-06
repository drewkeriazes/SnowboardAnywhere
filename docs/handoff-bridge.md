# Handoff: BUG-013 bridges not showing (China Bridge near Orient Express)

Issue: https://github.com/drewkeriazes/SnowboardAnywhere/issues/64 (reopened). Commit with the first attempt: 7bd0e83.

## The ask

Drew: "missing the bridge near orient express that takes you back to blue sky basin". After 7bd0e83 he reports "bridges are not there".

## Why there is no bridge

The terrain is bare-earth lidar, which strips bridges. `build_pack.py` also dropped the OSM `bridge` tag (now kept as `bridge: true` on runs and roads, but Vail has not been rebuilt since).

## What 7bd0e83 added

- `game/src/pack/Pack.ts`: `Deck` segments, `addDeck`, `deckHeight`, `terrainHeight`. `groundHeight(x, y, z?)` returns the deck when it is above the terrain (and the rider is not 2.5 m+ below it). `groundNormal` uses the deck plane on a deck.
- `game/src/sim/Rider.ts`: passes `this.z` to `groundHeight` / `groundNormal`.
- `game/src/world/Bridges.ts`: tagged ways become decks at load. For untagged packs, `maintain(dt, rx, ry)` checks run/road segments 6 to 120 m long within 600 m of the rider once their fine (1 m) tiles load. A segment is a bridge when its chord sags 4 m or more above the terrain, the sag is at least 6% of its length, and at least 25% of samples are 1.5 m+ under the chord. It draws the deck, girders and railings, and adds railing walls to the collider.
- `game/src/main.ts`: `new Bridges(pack, collider)` after Roads; `bridges.maintain(dt, rider.x, rider.y)` after `lifts.maintain`.
- Typecheck passes.

## What was verified

- Drew's PC checkout has `game/src/world/Bridges.ts`, so the code was pulled.
- A node test (Pack plus Bridges, real fine tiles 12_8 and 13_8 injected) detects exactly 1 deck: (1291, -1655) to (1260, -1694). That is OSM way 1543256508, "China Bridge Access Road". `groundHeight(1276, -1674)` = 2975.5, terrain = 2968.9. The Bridges group has 3 meshes. So the detection and the deck work outside the browser.
- Segment sags near the spot: China Bridge Access Road 1543256508 max sag 6.7 m (bridge); Cloud 9 - Middle 2.1 m; Two Elk 1.5 m (not bridges).

## Open questions (start here)

1. **Does the deck exist in the browser?** Run the dev server, go to `?pack=vail&x=1320&y=-1668`, wait for tiles, then in DevTools run `__sim.pack.decks`. If it is empty, `maintain` is not running or `pack.fine.sample` returns NaN (log inside `Bridges.maintain`). If it has a deck, the mesh is not visible: check `scene` children, material, and position (three.js x east, y up, z = -north).
2. **Is it the right gully?** On the 1 m DEM the deep Two Elk Creek channel runs from about (1235, -1590) down to (1190, -1700). It sits 12 to 20 m below its banks around y -1600 to -1640. The OSM bridge segment crosses a shallower part further south-east, only about 7 to 9 m deep. Compare with Drew's Street View and Google Maps screenshots. The bridge he means may be a different OSM way, or the OSM line may be offset from the real crossing.
3. If the OSM data is off, consider a pipeline fix: rebuild Vail so tagged bridges come through (`python pipeline\build_pack.py vail C:\Users\Drew\Documents\snowboard-sim\raw\vail packs\vail`). Then check `features.json` for runs and roads with `bridge: true`. The raw OSM JSON is in `Documents\snowboard-sim\raw\vail\osm`.

## Rules

- Commit as Drew, plain message, no trailers, id BUG-013 in the message; comment the hash on #64 and close it when Drew confirms.
- `cd game && npx tsc --noEmit` before committing. No em dashes in prose.
