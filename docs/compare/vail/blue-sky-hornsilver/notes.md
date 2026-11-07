# Blue Sky Basin, Hornsilver near the top of Pete's Express

Real: Street View, Feb 2014 (links in spot.json; not stored here). Game: `game-east.png`, `game-south.png`.

## Findings
- **Forest is far too sparse.** In reality the spot is a small glade inside dense spruce/fir forest, with trees on all sides and a narrow tracked path uphill to the south. In the game it's an open snowfield with scattered trees and a sparse skyline. Same pattern as China Bowl (missing lone trees and clumps). -> BUG-023
- **Trees are black, bare cones.** Real February trees are tall (15 to 25 m), narrow and ragged, and heavily flocked with snow, so they read white and grey-green with blue shadows. Ours are short, dark, smooth single cones with no snow, close to black in shade. -> FEAT-070
- **Snow surface:** real snow is tracked-out powder with lumps, footprints and crisp small shadows. Ours is smooth with soft blue-grey blotches. -> FEAT-047 / FEAT-069 notes
- **Far view (east):** real lower valley slopes are tan/brown (south-facing, wind-stripped or bare in Feb, sage and grass), with white ridges above. Ours are all white or forest. A low-elevation, south-aspect snow line would fix it. -> FEAT-069 (snow depth model)
- **Sky:** high cirrus streaks in the real photo; ours is clear. A "thin high cloud" weather option. -> FEAT-069 note

## Eye camera shots (DATA-008, 2026-11-06)
`eye-east.png` and `eye-south.png`: 1.7 m above the converted Street View position (2866, -2968), headings corrected to grid north, Street View pitch and FOV. Re-shoot with `cd game && node tools/shoot_spots.mjs vail blue-sky-hornsilver --gpu`.
- **Same finding, clearer:** looking east the game is an open snowfield rising to a line of small cones and the lift; the real spot is a glade with forest close on all sides. -> BUG-023
- **Black pyramids up close:** the large solid black cones at the right edge (east) and the left (south) are krummholz instances (4.5 m tall; the nearest is 16 m from the camera), each a single flat-shaded cone. -> FEAT-070
