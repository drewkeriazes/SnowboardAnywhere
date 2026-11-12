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

Look (headed, `--shots`, the three modes on the same frames after a restart at the spawn): on mid (`--emulate-coarse`) the 4 and 8 m ring goes visibly softer, its small rolls smoothed out; built from a 4 m box average (`--look4`, how the set would look) it cannot be told from today. The ride is the same in all three (physics and prefetch keep reading fine). So the set changes nothing a player sees or feels, and on its own buys only the heap and the download. In a boot zip (FEAT-230, #538) it is what lets the ring look finished with only the fine tiles round the start; the findings are on that card.

## BUG-087: tile decode stalls while riding (2026-11-11)

`node tools/tileperf.mjs vail 60 --gpu --straight`, same setup as FEAT-229 above, now also reporting ao and moguls. Main-thread decode per tile (median of the run, max in brackets); "riding" is the 60 s ride, 3 to 9 tiles per set:

| set | before, riding | before, load | dir / ao / moguls on the 2D canvas | after (2D canvas + fenced mask readback), riding | after, load |
|---|---|---|---|---|---|
| dir | 24.1 (40.3) | 2.8 (14.4) | 0.7 to 0.9 (1.1) | 0.6 to 0.9 (1.1) | 0.6 (0.8) |
| ao | 26.3 (58.7) | 2.9 (25.8) | 0.7 to 0.8 (1.0) | 0.5 to 0.6 (0.7) | 0.6 (1.7) |
| moguls | 12.0 (41.1) | 2.5 (18.6) | 0.8 to 0.9 (1.0) | 0.6 to 0.7 (0.8) | 0.6 (1.1) |
| mask | 1.4 (1.5) | 2.2 (4.9) | **19.5 to 22.7 (42.5)** | 1.3 to 1.4 (1.7) | 1.5 to 2.0 (2.9) |

The cause was the synchronous `readPixels` in `decodeRGBA`: on its own (no game rendering) a tile reads back in about 1.3 ms, but while the game renders it waits for the frame's GPU work, and whichever readback runs first pays it. Moving the greyscale sets (ao, dir, moguls) to the 2D canvas, which is exact for them (byte-identical on 40 tiles each; it is not for the mask, whose alpha would wipe RGB), handed the whole wait to the mask, so the mask reads back into a GPU buffer and copies out once a fence passes. All 212 resident mask, dir, ao and moguls tiles are byte-identical to the old decode, and the ride covers the same 1,154.9 m. Settled 15.0 to 15.3 s (16.1 before), ride frame time median 9.1 to 9.8 ms, p95 11.4 to 12.4 (10.1 / 12.8 before). Not changed: `CoverSet` and the stand images (`Vegetation`) still use the synchronous `decodeRGBA`; the cover loads once at the start and Vail has no stand images.

## FEAT-086: the full scene in real play (2026-11-11)

`node tools/playperf.mjs vail --gpu [--vsync | --headed] [--ablate] [--at -3256,2723]` on 23245d6 (main), quality high, auto quality off, 1920 x 1080. Stand = 6 s after a restart at the spot (the rider slides to about 10 km/h); tuck = 10 s with ArrowUp. Frame ms median / p95 / max, frames over 33 ms; main thread median. Report: `docs/research/perf-pass-2026-11.md`.

| browser, mode | place | stand | tuck | calls / tris | heap |
|---|---|---|---|---|---|
| Chrome, DevTools window, vsync | start | 9.9 / 13.0 / 20.3, 0 | 10.3 / 17.7 / 45.0, 5 | 712 to 745 / 3.30 to 3.47 M | 1.09 to 1.13 GB |
| Playwright Chromium, headed, vsync | start | 22.4 / 26.5 / 105, 3; main 10.1 | 19.9 / 22.8 / 30.0, 0; main 8.2 | 687 to 705 / 3.2 M | 1.1 GB |
| Playwright Chromium, headless, vsync off (2 runs) | start | 18.9 to 19.2 / 29 to 32 / 343, 9 to 10 | 12.2 to 13.0 / 80 to 105 / 177, 56 to 66 | 686 to 703 / 3.15 to 3.23 M | 1.08 to 1.14 GB |
| Playwright Chromium, headless, vsync off (2 runs) | Born Free | 14.0 to 14.8 / 53 to 55 / 115, 28 to 37 | 13.4 to 14.5 / 55 to 62 / 140, 55 to 58 | 929 to 938 / 3.23 to 3.30 M | 1.30 GB |

Vsync off queues frames and stalls them (100 to 370 ms, headed or not, with the main thread idle or blocked in WebGL); it is right for medians and `--ablate`, not for stutter. Ablation (eye camera, vsync off): start 18.1 ms, terrain 10.3, sun 4.6, shadow pass 1.8, hemisphere light 1.3, clouds 1.3; Born Free 11.8 ms, terrain 3.1, shadow pass 2.9, bridges 2.5 (180 calls), roads 1.7, lifts 1.5, trees 1.3. Cards: FEAT-236 (#556) terrain, FEAT-237 (#557) shadows, BUG-090 (#558) heap.

## FEAT-229 steps 2 to 4: the 4 m height set, and the FEAT-230 boot zip measured and parked (2026-11-12)

The 4 m set is in this PR (#583); the boot zip is not. FEAT-230 (#538) is parked: the boot zip saves about 30 s once per download, but holds only 19 of Vail's 144 tree cells, none of the far tree ring and 19 of 144 ao tiles, so the first ride shows a forest that stops on a 1 km cell line across the bowls and a bare horizon, then pops in when the rest lands. The boot code and `tileperf.mjs --get` were taken out of the PR (the code is at 73a8f2a in its history); the numbers below are the record.

`cd game && npx vite build && node tools/tileperf.mjs vail 60 --gpu --straight --get <catalog> --mbps <N> [--full]` on Drew's PC (RTX 2070 SUPER, ANGLE D3D11, headless, 1920 x 1080), branch `issue-538-boot-pack`. The pack is a copy of the Vail pack on disk with the coarse set added (`python pipeline/coarse_set.py`, MapPacker) and `formatVersion` set to 1 for the test; the zips are MapPacker's `boot_split.py` and `zip_pack` output in a scratch folder with a local catalog, served by tileperf at the given rate. Nothing was published. Time to first ride = download and unzip (in Node, as the dev server does) + page load to settled (tileperf's load: frames back to back until nothing is in flight or building). Other sessions shared the GPU, so page load times spread by several seconds between runs of the same mode and ride frame times are not comparable here.

Zips: full 254 MB; boot 71 MB (cover 17.6, fine 14.2 in 52 tiles, coarse 14, mid 12, features 3.5, trees 2.9 in 19 cells, far 2.8, mask 2.4, ao 1.3), round meta.start (Born Free) and the game's start (the Back Bowls gateway), 1 km plus 300 m along the 15 runs that pass them; rest 183 MB.

| start, link | full zip: download / page load / first ride | boot zip: download / page load / first ride | rest in |
|---|---|---|---|
| Born Free (`SHOT_QUERY=&x=-3246.3&y=2241.8&h=-2.7`), 50 Mbit/s, 2 runs each | 43.0 / 19.8 / **62.7 s**; 42.1 / 17.0 / **59.0 s** | 11.7 / 14.9 / **26.6 s**; 11.7 / 20.0 / **31.7 s** | 43.4 to 43.9 s after the click, 10.6 to 15.1 s into the ride |
| Back Bowls gateway (the game's Vail start), 100 Mbit/s | 22.9 / 31.1 / **54.1 s**; 22.2 / 19.8 / **42.1 s** | 6.3 / 26.0 / **32.4 s**; 6.2 / 23.9 / **30.1 s** | 24.5 to 26.6 s, before the ride started |
| Back Bowls gateway, 50 Mbit/s | | 11.8 / 20.9 / **32.6 s**; 12.0 / 23.6 / **35.6 s** | 43.9 to 46.3 s, 8.5 to 9.4 s into the ride |

The pack already on disk (no download) settles in 18.6 to 29.4 s at the Back Bowls gateway and 21.9 s at Born Free in the same session, so the page load column is the same work in every mode; the boot zip takes the download from 42 to 43 s to 12 s at 50 Mbit/s (6 s at 100). In every boot run the rider stayed on the 1 m heights (the boot area is wider than what a 60 s tuck from these starts reached before the rest came), and after the rest the chunks settled in 0.6 to 1.5 s.

Leaving the boot area (`--get` on a 300 m boot zip with no run corridors, 54 MB, at 25 Mbit/s, Born Free, `--shots`): the rest landed 49 s into the ride; the rider spent 50 batches (12.5 s) off the 1 m heights while the pack was partial, about 890 m from the start, riding the coarse (4 m) set, with the physics warning naming the rest. Stills against the same frames on the whole pack: the ground, the far terrain and the 4 and 8 m ring look the same; the tree cells outside the boot area are missing until the rest lands (the cover levels still colour the forest), then they and the fine chunks come in. No holes, no errors.

FEAT-229 step 4, the same run on the whole pack at Born Free: at load, fine 12 tiles, 3.1 MB, decode 29 ms, plus coarse 6 tiles, 2.4 MB, 18 ms (step 1: fine 46 tiles, 12.0 MB, 69 to 70 ms); over load and ride, fine 18 tiles, 4.6 MB, 40 ms, plus coarse 9 tiles, 3.2 MB, 23 ms (step 1: fine 58 to 62 tiles, 15.0 to 16.2 MB, 86 to 89 ms). No fine tile is fetched for a 4 or 8 m chunk any more. The look of the ring is step 1's `--look4` (the same box average), which could not be told from 1 m.
