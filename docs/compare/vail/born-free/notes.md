# Born Free, at the Cub's Way junction

Real: Google Street View trekker, Mar 2012 (Google's own imagery, so position and compass are calibrated; links in spot.json, `real-*.png` local only). Sunny spring snow. Game: `eye-<view>.jpg`, eye camera at (-3256, 2724), 1919x910, 2026-11-06. This is 480 m down the run from the game's start position.

## What matches
- **Terrain:** the run's fall line north, the valley view opening ahead (north, north-west), and the open slope rising to the ridge in the south-east.
- **Eagle Bahn gondola:** the line and towers on the ridge top in the south-east view are where the photo has them.

## What doesn't
1. **The forest beside the run is missing.** Real: Born Free here is a narrow corridor through a closed lodgepole pine stand, with the tree wall about 10 to 15 m from the camera on both sides (north, south-west, north-west). The pack has **0 trees within 30 m and about 12 per hectare within 100 m**, so the game shows open snow with a few lone cones. Closed lodgepole stands run to hundreds of trees per hectare. This is mature Front Side forest, not a glade or the treeline. -> BUG-023
2. **Tree shape:** lodgepole pine is tall, with straight bare trunks and a small crown near the top, so the stand reads as a wall of trunks with light between them. The game draws every conifer as a spruce-like cone from the ground up. In 2012 many trees were red-brown or grey beetle-kill. -> FEAT-070
3. **Snow:** spring snow, smooth and slightly grey-green in the photo's colour; the game has fresh corduroy. Season, not a bug.

## Species check (DATA-015, 2026-11-11)
LANDFIRE maps the spot as `Urban Evergreen Forest` and `Developed-Low`, which name no species, with the natural forest round it about half lodgepole and half spruce-fir. DATA-015 fills those pixels from that mix and lets NAIP canopy NDVI pick lodgepole or spruce-fir: within 150 m lodgepole went from 36 % to 58 %, spruce and fir from 60 % to 35 %, aspen 4 %. The photo is closer to all lodgepole, so the NAIP split (about 75 % right) leaves some spruce-fir in.
