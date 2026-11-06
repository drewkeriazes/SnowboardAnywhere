# China Bowl, rock outcrop near the north rim

Real: Street View, Mar 2018, taken standing on a rock outcrop near the north edge of the bowl, looking south-west back at the tree group used in the FEAT-069 pairs (link in spot.json; not stored here). The full write-up of the real photo is the third reference comment on [FEAT-069 (#106)](https://github.com/drewkeriazes/SnowboardAnywhere/issues/106). Game: `eye-southwest.png` (eye camera at the converted Street View pose, 2026-11-06, main after FEAT-020 d769a5c).

## Findings
- **No outcrop under the camera.** The real photo stands on a reddish-brown sandstone outcrop with a snow patch on its flat top, and a second red boulder pokes out on the slope to the right. In the game the spot is smooth, unbroken snow. Either the DEM smooths the outcrop away or no rock instance lands there. -> FEAT-069
- **Rock colour:** the game's rock on the slope ahead is the cool grey Rock030 set. Vail's ski-area rock is red / maroon Minturn and Maroon Formation sandstone and conglomerate; grey belongs to the Gore Range on the horizon. -> FEAT-069
- **Rock amount:** the game shows a streak of grey outcrop mid-slope and a slab at the top right. Per the FEAT-069 pairs the real winter slopes here are nearly all snow. -> FEAT-069
- **Trees:** the game skyline has a thin row of about 10 small dark cones; the real tree group here is several dense clumps with lone trees between them. -> BUG-023, FEAT-070
- Not yet compared in detail against the real photo: terrain shape, far view and sky. Do this with the real photo side by side and adjust the pose with the eye camera if the skyline does not line up.
