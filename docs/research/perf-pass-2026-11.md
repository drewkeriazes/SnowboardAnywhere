# Performance pass, November 2026 (FEAT-086)

The full Vail scene in real play, profiled on Drew's PC on 2026-11-11: RTX 2070 SUPER, ANGLE D3D11, 1920 x 1080, quality high (the defaults: shadows on, tree and forest density 1, pixel ratio 1), auto quality off so the settings hold. Build: `main` at 23245d6. Two places: the Vail start (the Back Bowls gateway sign, open bowl) and the Born Free compare spot (`docs/compare/vail/born-free`, Lionshead, in the trees). Raw runs are in `docs/research/perf-log.md`.

## How it was measured

- **`game/tools/playperf.mjs`** (new): the game's own frame loop (no `?headless`), from the main menu's Ride button to riding, in Playwright's Chromium on the GPU. It times every frame and the main-thread work in it, splits that work by system (the per-frame methods on `window.__sim`, timed in place), matches slow frames against what changed in them (shader programs, geometry, textures, tree repacks, tiles, terrain builds, heap drops), counts the typed arrays in the heap, and with `--ablate` times the frame with each scene group hidden in turn. Nothing is read back from the canvas, so this is also the card's "timing mode without the readback" (`aerial.mjs` and `treeperf.mjs` already time with a 1-pixel flush).
- **The Chrome DevTools MCP** (the `perf-check` skill), in Chrome on the desktop. It works, but rAF in that window drops to 1 fps whenever another window covers it, which happened twice; a trace taken that way is useless. `playperf.mjs` runs off screen (or `--headed` in a window that opens in front) and gives the same numbers every run.
- **Vsync matters.** With vsync and the frame cap off (`playperf.mjs` default), the frame interval shows what the GPU allows, which is right for medians and for `--ablate`. But the page can then queue frames faster than the GPU presents them, and the queue stalls for 100 to 370 ms at a time, headed or not. Those stalls are not in play: with `--vsync` the same tuck has no frame over 33 ms. Stutter numbers below are with vsync on.

## Numbers against the budgets

| budget (perf-check skill) | measured | |
|---|---|---|
| frame under 16 ms | **Chrome (DevTools window):** 9.9 ms median standing, 10.3 ms tucking (about 95 fps). **Playwright Chromium, headed, vsync:** 22.4 ms standing, 19.9 ms tucking (p95 26.5 / 22.8) | over in Playwright's Chromium, under in Chrome; same GPU, same settings. The relative costs below hold in both. |
| no main-thread task over 50 ms while riding | main thread per frame: median 8 to 11 ms, max 15 to 20 ms (vsync on) | within; the frame is **GPU-bound** |
| draw calls under 1,500 | 690 to 705 at the start, 930 to 940 in the forest | within |
| triangles under 2 M | 3.2 to 3.3 M, shadow pass included (`renderer.info` counts both) | over as counted; the main pass alone is not separated |
| tree instances under 1.5 M | 1.27 M at the start, 1.15 M in the forest | within |
| JS heap under 600 MB | **1.1 to 1.3 GB** | **over, twice** |
| stutter | vsync on, tucking: 0 frames over 33 ms in 10 s (max 30 ms). At the start: 3 in 6 s, one of 105 ms that had terrain chunk builds and new geometry in it | one real hitch at the start |

Main-thread time per frame by system (vsync off, means): `renderer.render` 16 to 21 ms (WebGL submission plus waits on the GPU), terrain update 0.7 to 1.5, lifts 0.4, deform 0.1 to 0.5, everything else (trees, shrubs, rider physics, rider view, camera, tracks) under 0.2 each. Game logic is under 2 ms; the cost is in drawing.

## What the frame is made of

`playperf.mjs --ablate`, eye camera at the spot looking down the fall line, vsync off, 3 s per group; the noise floor is about 1 ms (a group that draws nothing still moves by up to 1.3 ms).

| hidden | start (18.1 ms) | calls | forest (11.8 ms) | calls |
|---|---|---|---|---|
| terrain | **10.3 ms** | 372 | **3.1 ms** | 380 |
| sun (shadow lookups in every lit fragment) | **4.6 ms** | 0 | 1.0 ms | 0 |
| shadow map pass | 1.8 ms | | **2.9 ms** | |
| hemisphere light | 1.3 ms | 0 | | |
| clouds | 1.3 ms | 1 | 0.5 ms | 1 |
| bridges | | 6 | **2.5 ms** | **180** |
| roads | | 2 | 1.7 ms | 2 |
| lifts | | 89 | 1.5 ms | 140 |
| trees | 0.1 ms | 90 (1.2 M triangles) | 1.3 ms | 99 |

## Top three costs

1. **Terrain fragment shading: FEAT-236 (#556).** Over half the frame where the terrain fills the screen (10.3 of 18.1 ms at the start), for under 1 M triangles: the cost is per pixel, in the multi-octave noise, cover lookups and snow detail that run at every distance.
2. **Sun shadows: FEAT-237 (#557).** 4.6 ms of PCF-soft lookups plus a 1.8 ms shadow pass at the start; the pass is 2.9 ms in the forest.
3. **JS heap at twice the budget: BUG-090 (#558).** About 590 MB of the 1.1 to 1.3 GB is typed arrays: ao tiles 137 MB (greyscale kept as RGBA, like moguls 45 to 68 MB and dir 15 to 28 MB), the terrain chunks' CPU vertex arrays 101 to 107 MB, tree cell records 59 to 66 MB, tree meshes 52 MB, fine tiles 46 to 62 MB, and the menu's ghost riders 28 MB, still loaded while riding. No GC pauses showed up in the frame times.

Smaller, not carded: the bridges at Lionshead take 180 draw calls (one mesh per piece) and about 2.5 ms; worth merging if the forest frame matters. The first frames at the start build terrain chunks in a 105 ms hitch.

## What the JavaScript profile shows, and why it misleads

A sampling profile of the tuck (`playperf.mjs --profile` on an unminified build) puts the top self time in WebGL calls: `uniform4fv` 12%, `vertexAttribPointer` 11%, `bufferSubData` 10%, `uniformMatrix4fv` 8%. The scene itself does little that would cost that: per frame it uploads about 35 KB of snow puffs and the lift chairs' instance matrices, switches material 48 times, and has 172 draws that share a geometry (rocks and lift towers). The frame is GPU-bound, so whichever WebGL call fills the command buffer waits for the GPU, and the profile spreads that wait across the calls. The ablation, which times the whole frame, is the measure to trust.
