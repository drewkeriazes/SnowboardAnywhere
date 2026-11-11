# Back Bowls, top of Campbell's (Sun Down Bowl)

Real: Street View, Jan 2019 (link in spot.json; not stored here). Game: `game-east-standing.png` (at the spot), `game-east-riding.png` (a few metres east, slightly lower).

## Findings
- **Moguls (Drew):** the real bowl is covered in mogul fields: the bowl floor and the steep slopes on the right (Milt's Face / The Slot side) show a dense, regular bump texture. The game bowl is smooth. Reference for FEAT-059 (#92). Ungroomed, steep, high-traffic Back Bowls runs are exactly where the card's score should put bumps.
- **Tree density: matches looking east, too low looking north-west.** East: sparse lone conifers on the steep bowl faces, similar in game. North-west (uphill, 15 degrees up): a dense band of tall spruce/fir (20 to 25 m, snow clumps on the branches) lines the top of the slope, with one silver dead snag in it. In the game (`game-northwest-aerial.png`, shot from above, not yet matched) the same slope has only scattered small trees. So BUG-023 also hits stand edges in the bowls, not only glades.
- **Trees still read black and cone-shaped** against the bright snow; the real ones are dark green with snow and narrow ragged tops. -> FEAT-070
- **The bowl shape looks shallower in the game** at this framing. Re-shoot at eye height (1.7 m) with the matching pitch and FOV once DATA-008's `cam=eye` exists before judging terrain.
- **Snow:** real foreground is tracked-out and chalky with sharp small shadows; ours is smooth. -> FEAT-047 / FEAT-069
- **Far ridges (right):** real distant forest is dark green with white clearings; ours is close but greyer. -> FEAT-041 / FEAT-052

## North-west view (uphill, Street View 305 degrees, 15 degrees up)
- Dense stand edge of tall spruce/fir along the upper slope, plus a **standing dead tree (silver snag)**. Mixing a few percent of dead snags into stands is a cheap realism win. -> FEAT-070
- **No rock at all** on the real slope; the game has three or four grey boulders scattered on it. -> FEAT-069
- Snow: wind-crusted and chalky, with crossing ski tracks and small ridges. -> FEAT-047
- Game shot was taken from high above. Re-shoot at eye height looking 305 degrees, 15 degrees up.

- Extra game shot `game-chase-549-121.png` (chase camera at -549, 121, about 70 m north-east of the spot, looking roughly east): the slope edge there has only 2 or 3 trees, where the real north-west view shows a dense stand edge.

## North-west, matched (`game-northwest.png`, at -616, 92, heading 305, near eye height)
- **Trees:** the real view is a dense wall of tall spruce/fir along the crest, filling the skyline. The game shows the same crest with the lift line and patrol huts, but only about 12 small trees spread thinly along it, plus one lone tree on the right. This is the clearest BUG-023 evidence so far.
- **Slope:** the real slope rises steeply right in front of the camera (the photo is tilted 15 degrees up). The game rises gently (9 degrees under the rider) to the ridge 300+ m away. Street View positions can be off by tens of metres, so check the DEM profile along 305 degrees before calling it a terrain error.
- **Track:** the rider's own track shows as a bright white X in the foreground (BUG-021).

## Eye camera shots (DATA-008, 2026-11-06)
`eye-east.jpg` and `eye-northwest.jpg`: 1.7 m above the converted Street View position (-620, 94), headings corrected to grid north, Street View pitch and FOV. These replace the hand-framed shots above for future comparisons; re-shoot with `cd game && node tools/shoot_spots.mjs vail back-bowls-campbells --gpu`.
- **North-west:** at the photo's 15 degrees up, the game slope rises gently to a crest well away from the camera, with about 15 small trees on it. Confirms the two findings above (slope too gentle at this point, stand edge far too thin). -> BUG-023
- **East:** a large solid black pyramid right of centre is a krummholz instance 12 m from the camera (one dark 6-sided cone, 4.5 m tall). Up close it reads as a black tent, not a shrub. -> FEAT-070

## Re-shot for BUG-023 (2026-11-11)
Eye shots re-taken on a pack built from main plus BUG-023 (crown heights from the tallest lidar return, not the blurred CHM). North-west: the crest now carries a continuous band of tall spruce and fir (since BUG-027 / BUG-028 / FEAT-074), which is what the photo shows. East: lone trees on the bowl faces, close to the photo. Within 200 m the lidar finds about one crown per tree shadow in the 2023 NAIP; LANDFIRE calls 92 % of this disc open, so only those crowns stand there, no generated stems.
