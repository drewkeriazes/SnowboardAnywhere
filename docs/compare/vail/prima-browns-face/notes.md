# Prima, near Brown's Face (Front Side)

Real: Street View, Jan 2017, contributor Hongbin Zhuang, listed as "Vail Ski Resort" (links in spot.json; `real-*.png` local only). Overcast, fresh snow. Game: `eye-<view>.png`, eye camera at (-652, 1809), 1919x910, 2026-11-06.

**The Street View pin is about 540 m off.** Google places it at (-1192, 1709), in forest between Christmas and Riva Glade, and it shows up when searching "Riva Ridge". From there nothing matched: the game camera stood in trees, and the 34-degree view ran across the slope instead of down it. The real spot was found by scoring every open slope within 900 m on three things the photo fixes: the fall line (about 36 degrees true), the end-of-run building (about 59 degrees true) and open ground. Then candidates were rendered. Prima / Brown's Face matched every view; the clincher is the three parallel cut runs on the ridge across the drainage in the east view. The compass is good. Stored with `--at -652,1809`.

## What matches
- **Terrain:** the steep fall line down the run (north-east), the slope angle across it (east, north-west), and the ridge across the drainage with its three cut runs. Very close.
- **Forest layout:** the forested ridges, the run edges and the tree line along the slope above (south, south-west) are in the right places.
- **Far view:** the valley and the ridge beyond it.

## What doesn't
1. **Trees look like black cones.** Real: tall, narrow spruce heavily flocked with fresh snow, grey-white rather than dark. -> FEAT-070
2. **Far forest too pale (north-east left, north-west right):** the real valley slopes are dense dark forest with grey aspen; the game shows pale snow with green specks. -> BUG-023
3. **Snow surface:** real is chopped powder with soft bumps on a steep advanced slope; the game is smooth. -> FEAT-059 (moguls), FEAT-047
4. **Sky:** overcast with snow in the photo, clear in the game. Weather.
