# Front Side, Eagle's Nest event deck (top of Eagle Bahn)

Real: Street View, Jan 2016, contributor Justin Donat (links in spot.json; `real-*.png` local only). Sun and broken cloud. Game: `eye-<view>.png`, eye camera at (-3317, 1983), 1919x910, 2026-11-06.

The compass of this photosphere is good: Eagle's Nest is at a grid bearing of 21 degrees in the pack and sits about 2 degrees right of centre in the 23-degree view. No offset needed.

## What matches
- **Terrain:** the flat summit, the slope dropping to the deck, and the drop into the valley on the west and south-west sides.
- **Far view (south-west, south-east):** the ridge across the valley with its cut ski runs through dense forest is in the right place and shape. The distant peaks sit on the horizon where the photo has them.
- **Lift terminals:** the Eagle Bahn top station (north-east) and the Pride Express top terminal (west) are where the photo has them.

## What doesn't
1. **Eagle's Nest lodge is missing (north-east).** It is in the data but buried: buildings are built before height tiles load, so the roof is set from the lowest ground point under the 68 m footprint and ends up under the snow on the uphill side. The height default (5.5 m) is also far below the real 3 to 4 storeys. -> BUG-024 (#110)
2. **Buildings look like plain boxes (north-east, south-east).** The real summit has timber chalets with steep snowy roofs, light poles, the Adventure Ridge wooden climbing tower and the lodge's multi-storey stucco front. The game has flat grey boxes and a tan octagon. -> no card yet (building styles; candidate FEAT)
3. **Aspen groves read as grey cones (south-west, south-east).** The real slope below the deck is a band of bare aspen: tall pale trunks, no crown, grey-brown in winter. The game draws grey cones. -> FEAT-070
4. **Forest edge by the run (south-east):** real is a dense spruce wall plus aspen; the game has scattered black cones along the run edge. -> BUG-023
5. **Lift terminal roof colour (west):** the real Pride Express top terminal has a dark blue-grey roof; the game uses the same red roof for every terminal. Minor.
6. **Snow:** real foreground is wind-packed and tracked, with ropes, bamboo poles, a closed sign and crowds; the game has corduroy right up to the deck. Grooming here is plausible; the furniture is out of scope.
