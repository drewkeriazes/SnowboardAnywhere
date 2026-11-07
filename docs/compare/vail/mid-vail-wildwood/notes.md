# Mid-Vail, between the Wildwood Express and Mountain Top Express bottom terminals

Real: Street View, Mar 2016, contributor Scott Moss (links in spot.json; `real-*.png` local only). Overcast, light snow, busy lift lines. Game: `eye-<view>.jpg`, eye camera at (-1568, 1608), 1919x910, 2026-11-06. Mid-Vail lodge is 167 m to the west-north-west, out of these frames.

The compass is good: the Mountain Top Express terminal footprint's centre is at 83.6 degrees true in the pack and at about 84 degrees in the photo. No offset needed.

## What matches
- **Terrain:** the flat loading area, the slope rising south to the bowl, and the drop to the north down the valley.
- **Lift lines:** the Mountain Top Express line and towers (east, south) and the Wildwood line (south-west) run where the photo has them.
- **Terminal positions:** both bottom terminals sit in the right places.

## What doesn't
1. **Both terminals are drawn twice and look wrong (east, south, south-west).** Each real terminal is a long, low detachable-lift station with a curved **dark navy / blue-grey roof** (about 30 m long), the lift name and number on the fascia. The game draws the generic red-roofed shed on legs and, through it, a grey OSM box. Same dark roof as the Pride Express top terminal at Eagle's Nest. -> DATA-009 (#112)
2. **Dense spruce walls are missing (north, east).** Real: tall, snow-flocked spruce close on both sides of the loading area, framing the view down the valley. Game: a few small dark cones and open snow. -> BUG-023, FEAT-070
3. **Mid-Vail area buildings (south-west):** the timber buildings beside the Wildwood terminal read as low grey boxes. -> FEAT-071 (#111)
4. **Snow:** real is chopped up, packed and crowded around the lines; the game is fresh corduroy. Expected for a groomed area at opening; not a bug.
5. **Sky:** overcast with light snow in the photo. Fixed by FEAT-078: the spot is shot with `weather: overcast` (grey deck, shadowless flat light). Measured on the south view: sky sRGB (184, 189, 199) game vs (181, 187, 197) photo, foreground snow (190, 194, 203) vs (190, 195, 206).

A fifth Street View heading (196 degrees, 90y) was linked but not screenshotted; add it with `--spot mid-vail-wildwood/<id> --add` if a screenshot turns up.
