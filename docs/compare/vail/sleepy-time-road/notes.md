# Sleepy Time Road, toward Blue Sky Basin and the Gore Range

Real: Street View, March 2012, about midday, thin high cloud (links in spot.json; `real-*.png` local only). Three views along the road: south-southeast (157 deg) toward Blue Sky Basin, south (166 deg) a little further east, and south-west (212 deg) from further east toward the Gore Range. Game: `eye-<view>.jpg`, eye camera, 1919x910, noon (`SHOT_QUERY="&time=12"`, so 15 February, the tool's default month), 2026-11-10. Added for FEAT-171 (#395), which measured its targets on these photos.

## Measured on the photos (from the FEAT-171 card)
- Near trees are near black (brightness 19 to 32 of 255) against sunlit snow at about 180, so 1 : 6 to 1 : 9.
- The far forest lifts to 38 to 70 with the haze.
- Snow on near, mid and far slopes is within about 15% (154 to 181): even, not shaded by slope.
- Snow is brighter than the sky above the horizon (180 against 135 to 146).
- Past about 1 km, trees are dark upright specks; at midday the shadow sits inside the speck.

## In the game (FEAT-171 branch, 15 March noon, clear, `tools/aerial.mjs --gpu` at 1600x900)
1. **Tree shadows:** sparse trees from 260 m to about 2 km carry their own crisp shadow, attached at the trunk (FEAT-171). Before it, the 4 m tree map painted soft patches there.
2. **Tones:** far forest under the horizon 62 to 70, mid-distance trees about 1 : 4 to 1 : 6 against the snow; snow stays even. Close to the targets.
3. **Snow against the sky:** about equal (snow 200 to 208, sky 195 to 207); the photos have the snow about 1.25 x brighter. -> [FEAT-178 #414](https://github.com/drewkeriazes/SnowboardAnywhere/issues/414)
4. **Sky:** the photos have thin high cloud; these shots use the default weather.
