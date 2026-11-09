---
name: render-check
description: Verify the game renders and rides correctly without a human watching: build the client, run the headless Playwright screenshot and ride test (game/tools/shoot.mjs), read the stats, and judge the screenshots. Use after any change to terrain, materials, vegetation, physics or the pack loader, and before committing client changes.
---

# Headless render and ride check

## Run
```
cd game && npx tsc --noEmit && npx vite build
node tools/shoot.mjs synth shots          # synthetic pack (generate first: python pipeline/synth_pack.py packs/synth)
node tools/shoot.mjs vail shots-vail      # real pack, once packs/vail exists
```
`tools/shoot.mjs` serves `dist/` plus `../packs` on a local port, loads `index.html?pack=<slug>&headless`, steps frames with `window.__step(n, dt)` and saves PNGs with `window.__shot()` (canvas.toDataURL, so no page.screenshot hangs). Each `settle` prints a JSON line with chunk count, triangle count, tree instances, rider position, speed, onGround and loaded tile counts per height set.

GPU or CPU: every tool launches Chromium through `tools/browser.mjs` (FEAT-146) and prints the renderer it got on the first line, e.g. `GPU: ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 SUPER ...) [gpu]` or `GPU: ... SwiftShader ... (software) [cpu]`. On Windows (Drew's PC) the default is the real GPU, headless; elsewhere it is SwiftShader. Flags on every tool: `--headed` (visible window on the real GPU, stays open until you close it; also `npm run shoot:headed`), `--gpu` (force the real GPU, exits if Chromium falls back to software), `--cpu` (force SwiftShader). Use the GPU for real packs; headless SwiftShader crashes the tab on the full Vail pack once the rider moves.

Playwright: a devDependency of `game/` (`npm i` then `npx playwright install chromium` once per machine). The cloud sandbox falls back to its preinstalled copy at `/opt/npm-tools/node_modules/playwright`. Playwright 1.65.0 shipped without a matching `playwright-core` on 2026-11-05, so the lockfile pins 1.64.1.

## Software GPU rule
On software (cloud sandbox, CI, or `--cpu`) the launcher appends `&lowgfx` to `SHOT_QUERY` automatically. It disables shadow maps, sets pixel ratio 1 and shrinks the tree radius to 250 / 600 m; without it SwiftShader needs about 9 seconds per frame once 180k trees are loaded and the run looks hung. On the real GPU nothing is added. If a run on Drew's PC prints SwiftShader, the GPU path failed: rerun with `--gpu` to get the error instead of a slow run.

## What to look at
- `01_start.png`: rider standing on snow, forest band with visible trail cuts, horizon with distant ridges (not a flat line; if flat, mid/far tiles did not load or `Pack.height` fell through to `zRange[0]`).
- `02_tuck_4s.png`: rider has moved downhill (position changed, speed 10 to 25 m/s on a blue), no tunnelling (z equals ground height), chase camera behind and above.
- `03/04 carve`: heading changed, rider leaning, spray particles visible when skidding.
- `05/06 jump`: `onGround:false` with airTime > 0 during the jump, lands without `CRASH` on a moderate slope.
- `08_far_cam_map.png`: piste overlay lines draped on the surface, colours by difficulty.
- `09/10 free views`: no cracks between LOD chunks (skirts cover them), no popping holes, far ring continuous.
- Stats sanity: chunks 300 to 900, triangles under 2M, `fine` loaded tiles grow as the rider moves, `builds` returns to 0 when idle.

## Judging and recording
Describe each screenshot in one line in the commit message or PR. Put reference screenshots in `docs/renders/<date>-<label>.png` (copy them there by hand) only when the look changes on purpose (new material, new trees); do not commit `game/shots*/`. Tool output is always `NN_label.png` in a `game/shots*/` folder and kept references are dated, so a check run never overwrites one; never point a tool's output folder at `docs/`.

## When it fails
- Blank or black canvas: check `console issues` lines printed at the end for shader compile errors (TerrainMaterial `onBeforeCompile` string replacements silently fail if Three.js changed a chunk name; grep the shader for `vWorldPos`).
- `__step` never defined: `main()` threw before the headless hook; open the page with `?pack=<slug>` in a browser and read the console.
- 404 spam for `trees/` or `rocks/`: empty cells, harmless. 404 for `fine/` tiles near the rider: the pack is incomplete or meta tile grid is wrong.
