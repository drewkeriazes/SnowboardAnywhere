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

## Second pass (Tea Cup bridge)

- Step 1 answered: in the browser `__sim.pack.decks` has the China Bridge deck and it renders. Drew confirmed it shows.
- Drew then reported the bridge by Tea Cup missing. It is Cloud 9 - Lower over the creek at the Tea Cup / Skyline base, around (627, -1777). OSM puts a node in the creek bed (z 2913.9, banks 2919), so both segments follow the ground and no single chord spans the gap.
- Fix: `Bridges.addDips` finds dip vertices on ski runs (a node 4 m+ higher within 40 m on both sides, nearest such node as the rim) and tests the rim-to-rim chord with a stricter 12% sag-to-span rule. Dips are tested before plain segments, and a span that lands on an existing deck is skipped. Roads and trails are left out on purpose (they ford creeks and pass through underpasses).
- An offline run over all Vail fine tiles passes exactly two dips: Cloud 9 - Lower (5.3 m deep, 36 m span) and China Spur (1855, -1513), which now gets one rim-to-rim deck instead of a ramp into the gully.

## Rules

- Commit as Drew, plain message, no trailers, id BUG-013 in the message; comment the hash on #64 and close it when Drew confirms.
- `cd game && npx tsc --noEmit` before committing. No em dashes in prose.

## New: false-positive deck (Drew screenshot, 2026-11-05)

Near Tea Cup Express / Skyline Express (Blue Sky Basin) the rider sits on a wide, flat grey slab that runs along the valley side and looks like a bad road overlay. It is almost certainly a bridge deck from the `Bridges.ts` gap detector on an ordinary cat track or road segment. So decks do render in the browser; the detector is too loose.

Likely cause: a curving road or cat track on a sidehill. The straight chord between two OSM nodes cuts out over the downhill side, so the terrain "sags" under it even though there is no gap.

Suggested fix in `Bridges.maintain`:
- At the deepest sag point, sample the terrain 8 to 12 m to each side, perpendicular to the segment. Accept only when both sides are also at least 2 m below the deck (a gully crossing the line). A sidehill has one side high and gets rejected.
- Tighten `MAX_SPAN` to about 80 m and require the ends to sit on the terrain (chord within 1.5 m of the ground at both ends).
- Debug aid: log each accepted deck (`console.info('bridge', d)`) so Drew can see false positives, then remove it.
- Re-check that China Bridge Access Road (1291, -1655) to (1260, -1694) still passes.
