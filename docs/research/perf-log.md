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
