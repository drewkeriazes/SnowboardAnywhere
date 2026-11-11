# Performance log

One row per measurement (the `perf-check` skill). Tree rows come from `cd game && npx vite build && node tools/treeperf.mjs vail <spots> --gpu` on Drew's PC (RTX 2070 SUPER, ANGLE D3D11, 1920 x 1080, eye camera at the `docs/compare/` views); "trees" is the frame with the tree group drawn minus the frame without it, shadow pass included.

| date | commit | pack | view | frame ms (median) | frame calls / tris | tree calls / tris | change |
|---|---|---|---|---|---|---|---|
| 2026-11-10 | 67da46d (main) | vail | blue-sky-hornsilver/east | 7.1 | 834 / 4.78 M | 100 / 2.41 M | before FEAT-158 |
| 2026-11-10 | 67da46d (main) | vail | blue-sky-hornsilver/south | 7.5 | 857 / 4.71 M | 98 / 2.31 M | before FEAT-158 |
| 2026-11-10 | 67da46d (main) | vail | blue-sky-belles-camp/east | 6.8 | 830 / 4.60 M | 106 / 2.27 M | before FEAT-158 |
| 2026-11-10 | 67da46d (main) | vail | blue-sky-petes-express/north | 11.3 | 1354 / 5.63 M | 106 / 2.20 M | before FEAT-158 |
| 2026-11-10 | 67da46d (main) | vail | mid-vail-wildwood/east | 10.4 | 1068 / 4.70 M | 108 / 1.64 M | before FEAT-158 |
| 2026-11-10 | FEAT-158 | vail | blue-sky-hornsilver/east | 7.2 | 813 / 3.61 M | 79 / 1.24 M | near sets culled per tile, shadow prefix, cone undersides out of the shadow pass, far meshes packed to their band |
| 2026-11-10 | FEAT-158 | vail | blue-sky-hornsilver/south | 7.7 | 837 / 3.78 M | 78 / 1.37 M | same |
| 2026-11-10 | FEAT-158 | vail | blue-sky-belles-camp/east | 6.5 | 820 / 3.71 M | 95 / 1.38 M | same |
| 2026-11-10 | FEAT-158 | vail | blue-sky-petes-express/north | 12.5 | 1352 / 4.72 M | 104 / 1.28 M | same |
| 2026-11-10 | FEAT-158 | vail | mid-vail-wildwood/east | 9.4 | 1057 / 4.25 M | 97 / 1.18 M | same |
| 2026-11-10 | 30a335a (main) | vail | blue-sky-hornsilver/east | 8.3 | 836 / 3.64 M | 79 / 1.24 M | FEAT-070 epic done check: all five cards merged (shrubs in), 23 views, these are the worst |
| 2026-11-10 | 30a335a (main) | vail | blue-sky-hornsilver/south | 8.3 | 860 / 3.81 M | 78 / 1.37 M | same |
| 2026-11-10 | 30a335a (main) | vail | blue-sky-belles-camp/north | 10.9 | 1489 / 4.75 M | 109 / 1.36 M | same |
| 2026-11-10 | 30a335a (main) | vail | blue-sky-petes-express/north | 12.0 | 1382 / 4.76 M | 104 / 1.28 M | same |
| 2026-11-10 | 30a335a (main) | vail | blue-sky-petes-express/southwest | 13.6 | 834 / 3.50 M | 89 / 1.05 M | same |
| 2026-11-10 | 30a335a (main) | vail | mid-vail-wildwood/east | 9.6 | 1078 / 4.26 M | 97 / 1.18 M | same |
| 2026-11-10 | 30a335a (main) | vail | born-free/southeast | 11.1 | 1168 / 3.82 M | 98 / 0.74 M | same |

Frame times on this GPU vary by 1 to 3 ms between runs of the same build; the call and triangle counts are repeatable.

Riding (FEAT-158, a 20 s tuck with carves alternating every 1.5 s from the Vail spawn, chase camera): `Vegetation.update` + `cull` median 0.10 ms, p95 0.20 ms, max 1.5 ms per frame; 62 near-set and 1 far repack.

## FEAT-229 step 1: fine, mask and dir tiles at the Born Free start (2026-11-11)

`cd game && npx vite build && node tools/tileperf.mjs vail 60 --gpu --straight [--emulate-coarse]` on Drew's PC (RTX 2070 SUPER, ANGLE D3D11, headless, 1920 x 1080, local server), branch `issue-537-tile-measure` on 4db2efe. Load: frames back to back with the warm-up budgets from session ready until nothing is in flight or building ("settled"). Ride: a 60 s straight tuck from the Vail start (Born Free), 1,305 m, top 123 km/h. `--emulate-coarse` drops the fine requests of 4 and 8 m chunks, which then build from mid: the most a 4 m set could save, since its own few tiles are not fetched. Two runs of each, interleaved; ranges are over both. Decode is main-thread time (copy and conversion after `createImageBitmap`); the PNG decode itself runs off the main thread.

| | today | 4 and 8 m chunks without fine (emulated) |
|---|---|---|
| session ready / its first frame done | 1.8 s / 8.1 to 8.3 s | 1.7 to 1.8 s / 8.0 to 8.1 s |
| last fine tile in | 12.2 s | 1.7 s (spawn box only) |
| last mask and dir tile in | 12.1 to 12.2 s | 12.1 to 12.2 s |
| settled | 14.8 to 15.0 s | 14.6 to 14.7 s |
| fine tiles at load: fetched, MB, decode | 46, 12.0 MB, 69 to 70 ms (1.5 ms a tile, max 5.1) | 12, 3.1 MB, 18 to 25 ms |
| fine resident at the start | 46: 6 for 1 and 2 m chunks, **40 only for 4 and 8 m chunks** | 12 |
| fine resident at the ride's end | 58 to 62: 6 for 1 and 2 m chunks, 39 to 42 only for 4 and 8 m, 13 to 14 kept but unused | 19 to 22 |
| fine over the whole run: fetched, MB, decode | 58 to 62, 15.0 to 16.2 MB, 86 to 89 ms; 4 and 8 m only: 39 to 40 tiles, 10.1 to 10.5 MB (65 to 67%), 56 to 57 ms (63 to 66%) | 19 to 22, 4.9 to 5.7 MB, 34 to 37 ms |
| ride frame ms (15-frame means): median / p95 | 8.6 to 8.8 / 11.1 to 11.2 | 8.5 to 8.8 / 11.1 to 11.4 |

Mask and dir (2 m, 1 km tiles; the card leaves them as they are): 15 each at the start, 11 of them only for 4 and 8 m chunks; 18 to 20 over the run, 13 to 14 only for 4 and 8 m. Dir tiles take 27 to 35 ms each on the main thread while riding (max 51 to 63 ms), 82 to 96% of it for 4 and 8 m chunks: BUG-087 (#542). Mask tiles take 1.2 to 1.5 ms while riding.

**Verdict: not worth building for load or decode time.** The 4 and 8 m only tiles are two thirds of the fine tiles fetched and of fine decode, but that decode is under 60 ms of main-thread time in a whole run, and the load does not settle sooner without them (14.6 to 14.7 s against 14.8 to 15.0 s, within run-to-run noise). The first frame (6.3 s: shader compile and the first chunk builds) and the mask and dir tiles set the load; responses wait for the main thread while that frame runs (fetch wall time about 6 s a tile). What a 4 m set would still buy: about 40 MB less JS heap (40 fewer 1 MB Float32 tiles resident) and about 10 MB less to download per session, which counts on a hosted build over a slow link, not locally (first-download size is FEAT-230, #538). Caveats: headless with a local server, so no network time; one run of each mode crashed about 15 s in at the same spot (1,181 m) and the tile counts held.
