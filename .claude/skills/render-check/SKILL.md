---
name: render-check
description: Verify the game renders and rides correctly without a human watching: build the client, run the headless Playwright screenshot and ride test (game/tools/shoot.mjs), read the stats, and judge the screenshots. Use after any change to terrain, materials, vegetation, physics or the pack loader, and before committing client changes.
---

# Headless render and ride check

## Run
```
cd game && npx tsc --noEmit && npx vite build
node tools/shoot.mjs synth shots          # synthetic pack, always available
node tools/shoot.mjs vail shots-vail      # real pack, once packs/vail exists
```
`tools/shoot.mjs` serves `dist/` plus `../packs` on a local port, loads `index.html?pack=<slug>&headless`, steps frames with `window.__step(n, dt)` and saves PNGs with `window.__shot()` (canvas.toDataURL, so no page.screenshot hangs). Each `settle` prints a JSON line with chunk count, triangle count, tree instances, rider position, speed, onGround and loaded tile counts per height set.

Playwright: the cloud sandbox has it preinstalled at `/opt/npm-tools/node_modules/playwright`; locally run `npm i -D playwright && npx playwright install chromium` and import `playwright` normally.

## Software GPU rule
On a machine without a GPU (cloud sandbox, CI), add `&lowgfx` to the URL (`SHOT_QUERY="&lowgfx" node tools/shoot.mjs synth`). It disables shadow maps, sets pixel ratio 1 and shrinks the tree radius to 250 / 600 m. Without it SwiftShader needs about 9 seconds per frame once 180k trees are loaded and the run looks hung. With a real GPU, run without `lowgfx`.

## What to look at
- `01_start.png`: rider standing on snow, forest band with visible trail cuts, horizon with distant ridges (not a flat line; if flat, mid/far tiles did not load or `Pack.height` fell through to `zRange[0]`).
- `02_tuck_4s.png`: rider has moved downhill (position changed, speed 10 to 25 m/s on a blue), no tunnelling (z equals ground height), chase camera behind and above.
- `03/04 carve`: heading changed, rider leaning, spray particles visible when skidding.
- `05/06 jump`: `onGround:false` with airTime > 0 during the jump, lands without `CRASH` on a moderate slope.
- `08_far_cam_map.png`: piste overlay lines draped on the surface, colours by difficulty.
- `09/10 free views`: no cracks between LOD chunks (skirts cover them), no popping holes, far ring continuous.
- Stats sanity: chunks 300 to 900, triangles under 2M, `fine` loaded tiles grow as the rider moves, `builds` returns to 0 when idle.

## Judging and recording
Describe each screenshot in one line in the commit message or PR. Put reference screenshots in `docs/renders/<date>-<label>.png` only when the look changes on purpose (new material, new trees); do not commit `game/shots/`.

## When it fails
- Blank or black canvas: check `console issues` lines printed at the end for shader compile errors (TerrainMaterial `onBeforeCompile` string replacements silently fail if Three.js changed a chunk name; grep the shader for `vWorldPos`).
- `__step` never defined: `main()` threw before the headless hook; open the page with `?pack=<slug>` in a browser and read the console.
- 404 spam for `trees/` or `rocks/`: empty cells, harmless. 404 for `fine/` tiles near the rider: the pack is incomplete or meta tile grid is wrong.
