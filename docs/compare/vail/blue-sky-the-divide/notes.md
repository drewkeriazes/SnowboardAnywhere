# Blue Sky Basin, The Divide near Skyline Express

Real: Street View, Mar 2023, contributor JianMing Zhou, listed as "Vail Ski Resort" (links in spot.json; `real-*.png` local only). Sunny, spring snow. Game: `eye-<view>.png`, eye camera at (1097, -2725), 1919x910, 2026-11-06.

Position and compass: the pin is 10 m from The Divide, and the Skyline Express line runs north-south 118 m to the west, which fits the cables crossing the west view and sitting on the right of the south view. The slope directions agree in all four views (fall line north; rising to the left looking west, to the right looking east). With so few trees in the game there is no skyline to fine-tune the heading against, so treat the compass as checked to about 10 degrees, not exact.

## What matches
- **Terrain:** the run falling north between the slopes, the cross-slope in the east and west views, and the drop to the valley ahead (north).

## What doesn't
1. **Mixed aspen and spruce forest at the run edge is missing.** Real: tall aspen (pale white-grey bare trunks, fine twig crowns) mixed with spruce and fir, standing a few metres from the run on both sides and closing the view into a corridor. The pack has 0 trees within 15 m, 12 within 50 m, and of 94 trees within 100 m only **one is aspen**. The game shows open snow with lone dark cones and a wide view where the photo has a tree corridor. -> BUG-023 (density), FEAT-070 (aspen shape), aspen classification (LANDFIRE EVT, see HANDOFF)
2. **Snow:** chopped spring snow and soft bumps; the game is smooth corduroy. -> FEAT-059 / season.
3. **Sky:** close; scattered cumulus in both.
