# Back Bowls, on Yonder near Sun Up Express (Lift 9)

Real: Street View, Feb 2014, contributor Krishna Vinod (links in spot.json; `real-*.png` local only). Overcast day. Game: `eye-<view>.png`, eye camera at (590, 72), 1919x910 to match the Street View window, 2026-11-06.

**This panorama's compass is about 88 degrees off.** Street View's "north" view looks west in reality. Found by lining up the valley, the far peaks, the ridge and the Sun Up lift tower; every view agrees once `--offset -88` is applied. The view ids here are the true directions. The `south-lift` view had no URL in the screenshot; its heading was matched on the lift tower.

The pair also confirmed the FOV convention: the Maps `y` value is the vertical FOV. The lone pine's position across three views matches the vertical reading to within 5 px.

## What matches
- **Terrain shape** in every view: the rounded ridge with the cat track over it (west), the valley and the far peaks (south-west), the rising slope (north-west), and the angle and height of the slope under the lift (south-lift). The 1 m DEM is right here.
- **Sun Up Express:** the line, the tower position and the chair spacing land where the photo has them. The game tower has no red base band; the real one does.
- **Tree clumps on the far ridge (west, north-west):** roughly the right places and count.

## What doesn't
1. **Treeline on the skyline (north-east, uphill):** the real skyline is lined with about 30 tall spruce/fir in a near-continuous band. The game has about 6 small cones. Same pattern as China Bowl and Hornsilver. -> BUG-023
2. **Far forest reads as snow (south-west, west, south-lift):** the real valley slopes below the ridge are near-black continuous forest. The game shows pale snow with a green speckle, so the valley loses its dark mass. Either the far tree density is too low or the far terrain colour does not darken under forest. -> BUG-023
3. **Lone pines:** the real slopes have several broad, round-crowned lone pines (west and south-lift views, also north-east). The game only has narrow cones. -> FEAT-070
4. **Snow surface:** real is tracked-out and chalky with ski tracks and sharp small shadows; the game foreground is smooth. -> FEAT-047, BUG-021 (known)
5. **Sky:** overcast in the photo, clear in the game. Weather, not a bug.
