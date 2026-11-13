# Far forest canopy: hiding the snow like real trees (FEAT-278)

Card: [FEAT-278 (#614)](https://github.com/drewkeriazes/SnowboardAnywhere/issues/614). Related: BUG-114 (#612), BUG-074 (#417), BUG-069 (#387), FEAT-154 (#347), FEAT-184 (#434), FEAT-228 (#530), FEAT-236 (#556).

A research and compare card: three ways to draw dense forest at 0.6 to 6 km were prototyped on their own branches, behind a URL flag, and measured against `main` at the same poses, light and settings. Nothing here ships; the winner gets its own build card.

## Recommendation

**Clump impostors.** On Low it turns the flat navy slab into forest that reads close to High in all four views, at noon and at dawn. It is the steadiest of the three in motion. It costs about 0.5 ms of GPU on Low, nothing on Medium, and is slightly cheaper than `main` on High, where it replaces the per-tree impostor ring past 2.5 km and uses about 40 MB less geometry. It needs nothing new in the pack. The canopy shell is the runner-up: just as cheap on the GPU, but its 0.6 to 2 km band reads as dark cones and blotches rather than trees. Shader crowns look good from the snow but cost 3 to 9 ms at 1080p (5 to 15 ms at 1440p), shimmer the most and are too speckled from the air.

What the build card for clumps has to add (from the prototype's gaps, below): more than one species mix, conservative depth so the cards keep early-Z, the bake off the load path, a check of the handover and runtime setting changes in a real ride, and render-budget and synth-pack coverage.

## The problem

At mid distance dense forest reads as flat dark blotches. Thick forest doesn't remove the snow under it; it hides it behind crowns. Past the drawn trees the terrain paints forested ground a flat `timber` colour (`TerrainMaterial.ts`), which has no height, no uneven crown tops and no white between them. On High (Trees and Forest 100%, about 2.1M trees) it looks right, because the trees do the hiding. The Low preset draws trees only to 600 m (`setVegetationBudget(250, 600, false)`), so everything past that is the flat colour: the stills below show it as a navy slab with the ski trails cut into it. Medium scales the reach by 0.6 and looks close to High in these views.

Target look (Drew's Vail dawn photo over the Back Bowls, not committed): dense stands as 3D uneven crown tops with bits of white, sparse stands as single dark trees on white, clean snow between them.

## Views

Fixed poses in `game/tools/canopy-views.json` (pack metres, heading from grid north, vertical FOV 50 degrees). The three ground views are also compare spots in `docs/compare/vail/` (no Street View photo yet).

| View | Pose | What it shows |
|---|---|---|
| `slot-corner` (`the-slot-corner/sun-up`) | x -640, y 368, h 112, pitch -4 | Coming round the corner of The Slot toward the Sun Up Express (Drew's snips) |
| `sign-sunup` (`back-bowls-sign/over-yonder`) | x -690, y 470, h 150, pitch -5 | Just below the Legendary Back Bowls sign toward Sun Up and Over Yonder (BUG-074). At the sign itself (-736, 488) its own trees fill the frame |
| `lower-sunup` (`the-slot-lower/sun-up`) | x -360, y 171, h 125, pitch -2 | Further down The Slot; the far forested ridges on the right are the "good" reference |
| `aerial` | x -727, y 524, h 160, pitch -18, 700 m up | FEAT-154's look from above |

## Method

- **Stills:** `game/tools/canopy_compare.mjs` shoots every view per build at noon (12 h) and low sun (7.6 h), at 1920x1080 and 2560x1440, on each preset (High, Medium, Low as Settings > Graphics sets them, pixel ratio 1, Auto quality off), clear weather, Vail v4 pack, on Drew's RTX 2070 SUPER (ANGLE D3D11, headless). It waits for the tiles, trees and the candidate's own build to settle.
- **Cost:** GPU time per frame from timer queries (`EXT_disjoint_timer_query_webgl2`), median of 30 frames after a 120-frame warm-up; every build measured twice in alternating order and the lower of the two taken. Wall-clock frame times swung by up to 10 ms between identical runs on this PC (the GPU idles at 300 MHz between bursts and the desktop is in use), GPU time by about 0.4 ms; two of the eight passes were still disturbed (main's second pass on Medium and Low, crowns' first on High and Medium), which the minimum discards. Draw calls, triangles and a scene memory estimate (every geometry buffer and texture reachable from the scene, counted once) come from the same frames.
- **Handover:** `game/tools/canopy_clip.mjs` glides the eye camera 500 m down The Slot at 25 m/s looking at the middle of the Sun Up Express, Low and High, 30 fps. Two numbers from each clip's forest band (rows 25 to 60%): spikes in the frame-to-frame difference (a pop) and the temporal second difference (flicker; smooth motion mostly cancels).
- **Baselines:** `main` at each preset. `main` High is the brute-force look the card calls right.

The full set (every build, preset, view and light, 1080p frames and native-pixel 1440p crops, a full-size flip view, and the handover clips) is on the comparison page, a private claude.ai artifact: https://claude.ai/artifact/2gWCh56cdmCCSaZNAceLgA. Grids of Low with each candidate against `main` (1080p, scaled):

| View | Noon | Low sun (7.6 h) |
|---|---|---|
| The Slot corner | ![](../screenshots/far-forest-canopy/slot-corner-12h.jpg) | ![](../screenshots/far-forest-canopy/slot-corner-7.6h.jpg) |
| Below the sign | ![](../screenshots/far-forest-canopy/sign-sunup-12h.jpg) | ![](../screenshots/far-forest-canopy/sign-sunup-7.6h.jpg) |
| Lower toward Sun Up | ![](../screenshots/far-forest-canopy/lower-sunup-12h.jpg) | ![](../screenshots/far-forest-canopy/lower-sunup-7.6h.jpg) |
| Aerial | ![](../screenshots/far-forest-canopy/aerial-12h.jpg) | ![](../screenshots/far-forest-canopy/aerial-7.6h.jpg) |

## The candidates

Each is on its own branch, off this card's branch, behind `?canopy=<name>`; with the flag off each behaves as `main`. All three are built on the client from what the pack already has (cover levels, the 4 m crowns map in `cover/pack-stands.png`, the tree kit). All three follow runtime Trees, Forest and Auto quality changes per frame through the Vegetation bands, with no rebuild (BUG-114); none was checked in a live Auto quality drop.

### 1. Canopy shell (`issue-614-canopy-shell`, `?canopy=shell`)

`game/src/terrain/CanopyShell.ts`: a quadtree of 64x64-quad heightfield tiles from where the drawn trees end out to 10 km, 4 m spacing near, coarser with distance. A vertex over forest stands at canopy height with jittered, uneven tops; one over open ground sinks under the snow. At 4 m a lone crown is its own cone; coarser tiles march 8 steps per pixel through a layer of procedural crown cones so grazing views see crown sides and views from above see snow between them. The terrain drops its flat `timber` under the shell, and the old canopy `lift` takes over at 8 to 10 km. `?canopyfrom=thin` starts it at the impostors' thinning radius instead (fewer tree draws on High, but it looked worse on Medium and High).

### 2. Clump impostors (`issue-614-clump-impostors`, `?canopy=clumps`)

`game/src/world/trees/clumps.ts`: at load, 8 stand patches (4 crown covers x 2 seeds, 712 of the kit's own LOD0 conifers over tilted ground) are rendered from 5 view elevations into albedo, normal plus depth, and snow plus tree-id atlases. Past where full-density trees end (Low 600 m, Medium 1.9 km, High 2.5 km) out to the far edge (6 to 9 km), one camera-facing card per 64 m forest cell picks and blends the two tiles nearest its view angle over the local slope, writes its own depth so bases sink into the terrain, and thins tree by tree against the pack cover so runs and glades cut through cleanly. All cards are one instanced draw. The per-tree impostors dissolve out over the same band, Vegetation stops loading tree cells past it, and the terrain's flat timber steps back there.

### 3. Shader-only crowns (`issue-614-shader-crowns`, `?canopy=crowns`)

`game/src/terrain/canopyCrowns.ts`, spliced into the terrain shader under a define: each 4 m cell of the tree map holds at most one jittered ellipsoid crown from a hash, sized by the canopy height (put in the trees texture's spare A channel). Per pixel the view ray is walked back cell by cell (up to 20) with front-to-back occlusion, so crowns have real parallax and a lit and a shaded side; pixels that show snow walk toward the sun for short crown shadows. Past about 1.7 km (1080p) crowns hand over to 8 m clumps, then to the old flat canopy past about 3.5 km, so the lattice never aliases into moire. Inside the drawn trees' reach it fills only the share the drawn trees leave over, so High and Medium get no double forest.

## Comparison

GPU ms per frame, change against `main` at the same view and preset (lower of two passes). "Ground" is the mean of the three ground views; the aerial is its own column because forest fills most of that frame.

| | `main` ground / aerial | Shell | Crowns | Clumps |
|---|---|---|---|---|
| High 1080p | 10.3 / 15.4 | +0.0 / +0.1 | +2.9 / +8.4 | -0.1 / -0.3 |
| Medium 1080p | 9.4 / 13.8 | +0.1 / +0.1 | +3.5 / +9.1 | +0.1 / -0.1 |
| Low 1080p | 8.6 / 12.5 | +0.2 / +0.2 | +3.3 / +8.3 | +0.6 / +0.5 |
| High 1440p | 14.6 / 22.1 | -0.1 / +0.1 | +5.2 / +14.9 | +0.0 / -1.4 |
| Medium 1440p | 13.4 / 19.9 | +0.3 / +0.1 | +5.1 / +14.0 | +0.6 / +0.1 |
| Low 1440p | 12.5 / 18.1 | +0.4 / +1.1 | +5.1 / +13.4 | +0.8 / +0.9 |

| | Canopy shell | Clump impostors | Shader crowns |
|---|---|---|---|
| **Looks, Low** | Big step up: speckled crown mass with white runs. From the air close to High. From the snow the 0.6 to 2 km band is dark cones and blotches with more white between than High's spires; dark and harsh at dawn | Closest to High in every view, noon and dawn: uneven crown tops, runs and glades cut clean, single trees on sparse slopes. Gaps: a rounder "carpet" than High's spires at 2 to 4 km, smoother skylines, wider-looking trails, less snow speckle in dense stands | Good from the snow: crowns with parallax and white between. From the air too speckled and grey. Flat tops on stands seen edge on (capped walks); no tree silhouettes on ridgelines; at 720p slopes past 2.5 km are still the slab |
| **Looks, Medium and High** | Unchanged (fills only past the impostors) | Close to `main`, slightly greener and smoother past 1.9 / 2.5 km | Unchanged |
| **Flicker in the clip, Low / High** (`main` 2.92 / 3.74) | 3.04 / 3.74 | 2.81 / 3.32, the steadiest | 3.33 / 3.78, the most |
| **Pops in the clip** | None measured | None measured | None measured |
| **Draw calls (1080p)** | Low +77 to +81, Medium +24 to +30, High +15 to +17 | +1 on Low; High 65 fewer (tree draws 99 to 31 to 42) | 0 |
| **Triangles** | Low +0.7 M | Low +0.07 M; High -0.2 M | 0 |
| **GPU memory** | Low 31 to 35 MB, High 7 MB of tile buffers | 24 MB of atlases plus 1 to 3 MB of instances; High drops about 40 MB of tree geometry | None (uses a spare channel) |
| **One-off build** | Low 730 ms over 163 frames, up to 6 to 8 ms in one frame; 23 MB of CPU for the crown pyramid | Bake 85 to 140 ms at load (synchronous), placement spread over frames | None |
| **Pack data** | None new. A per-texel canopy height would help the near band (MapPacker) | None new. Species per cell would allow mixed stands (MapPacker) | None new |
| **Effort to production** | 6 to 9 days | 5 to 8 days | 4 to 7 days, and under 1 ms is not assured |
| **Main risks** | Draw calls on Low; main-thread build hitches; LOD pops between tile levels; looks least like trees near | `gl_FragDepth` costs early-Z on every covered pixel; one conifer mix; repetition on big uniform slopes; trees swap identity in the handover band | Fragment cost scales with on-screen forest, on a terrain shader already over half the frame (FEAT-236); register pressure for every terrain pixel |

The baselines also say something: on this GPU High (2.1M trees and sun shadows) costs only about 1.7 ms more GPU than Low at 1080p (10.3 against 8.6 ms on the ground views). High's price is memory (about 90 MB more geometry), loading and CPU more than GPU time.

## How others draw far forest

Short notes from a survey of public sources, links only, no assets copied. Each was read in the primary source unless it says otherwise.

- **Serious Sam 4** (Croteam, [GDC 2019 slides](https://gpuopen.com/gdc-presentations/2019/gdc-2019-agtd2-4-million-acres-serious-sam-4.pdf)): the closest shipped case, with 50 to 100 km vistas. Near trees, then per-tree 8-direction impostors (2 triangles each; albedo, subsurface, normal, AO and depth), then far forest "splatted into terrain" past the impostors.
- **Bruneton and Neyret 2012** ([CGF](https://diglib.eg.org/handle/10.1111/v31i2pp373-382)): individual trees near; far trees become a view- and light-dependent shader map on the terrain, built for a seamless handover. Academic support for the outermost tier being a shader term, if it is view and light dependent.
- **Mantler and Jeschke 2006** ([paper](https://www.cg.tuwien.ac.at/research/publications/2006/Mantler-06-landscape/Mantler-06-landscape-paper.pdf)): a canopy heightfield scaled by a cover map, ray cast in the terrain shader, gives canopy parallax at distance only; too few steps cause artifacts at grazing angles. Our shader-crowns prototype hit the same cost and grazing limits.
- **Microsoft Flight Simulator** ([SDK species docs](https://docs.flightsimulator.com/html/Content_Configuration/Environment/Vegetation/Species_Definitions.htm)), **Fortnite** ([Impostor Baker](https://dev.epicgames.com/documentation/unreal-engine/impostor-baker-plugin-in-unreal-engine)) and **Ghost Recon Wildlands** ([80.lv interview](https://80.lv/articles/vegetation-generation-in-ghost-recon-wildlands), the Steep engine): per-tree octahedral or hemi-octahedral impostors to the horizon, with extra lighting channels; Wildlands switches denser stands to impostors sooner.
- **Unreal HLOD** ([docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition---hierarchical-level-of-detail-in-unreal-engine)): recommends instanced impostor LODs for trees over merged meshes. Clumps baked by hand appear only as a [forum workaround](https://forums.unrealengine.com/t/trees-for-far-far-away/795892). **Nanite Foliage** ([docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-foliage)) turns distant clusters into voxels, a volumetric far representation that needs compute WebGL2 lacks.
- **Billboard clouds** ([Decoret et al. 2003](https://graphics.cs.yale.edu/publications/billboard-clouds-extreme-model-simplification)) and **hierarchical impostors** ([Meyer, Neyret, Poulin 2001](https://diglib.eg.org/handle/10.2312/EGWR.EGWR01.183-196)): the academic form of clump impostors; the cost they flag is memory per unique stand, which our prototype avoids by reusing 8 patches thinned against the real cover.
- **Horizon Zero Dawn** ([GDC 2017](https://www.guerrilla-games.com/media/News/Files/GDC2017_VanMuijden_GPUBasedProceduralPlacementInHorizonZeroDawn.pdf)): everything placed from 0.5 to 2 m density rasters on the GPU; nothing public on far LOD.
- **X-Plane** ([.for spec](https://developer.x-plane.com/article/forest-for-file-format-specification)): per-tree cards to a cutoff, with nothing past it, which is what produces our blotches.
- **three.js:** [a forest of octahedral impostors](https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735) (200k trees, frame-boundary artifacts, no crossfade) and the [Cinevva browser open-world series](https://app.cinevva.com/hi/blog/2026-05-04-open-world-browser-part-19-imposters) (a million-tree target, popping fixed with hemi-octahedral frames and 2x2 frame blending). No WebGL terrain shader that fakes crowns from a density map was found.
- **No primary source found** for how Steep, Riders Republic, Ghost of Tsushima, Red Dead Redemption 2, Assassin's Creed or Google Earth draw far forest.

The sources agree on the risks: popping at LOD and frame boundaries, shimmer from subpixel crowns, a lighting mismatch between the proxy and the near trees (fixed by baking normal, AO and depth channels, as the clumps prototype does), and view-angle limits (impostors baked for one elevation, heightfields at grazing angles). They favour per-tree impostors in the middle band and a shader term at the far edge; clump impostors as built here sit between the two, and in our measurements they beat both the shader term (cost) and our crossed-quad impostors (cost on High, look on Low).

## Riding the prototypes

The branches stay up, unmerged. To ride one on Drew's PC without copying the pack into a worktree, serve its build with the launcher from this card's worktree:

```
cd C:\Users\Drew\git\wt614-clump-impostors\game; npx vite build
cd C:\Users\Drew\git\wt614\game
$env:SHOT_DIST='C:\Users\Drew\git\wt614-clump-impostors\game\dist'; $env:SHOT_PACKS='C:\Users\Drew\git\SnowboardAnywhere\packs'
node tools/launcher.mjs --port 5191 --no-open
```

then open `http://localhost:5191/?pack=vail&canopy=clumps` (or `shell`, `crowns` with that branch's `dist`). Set Graphics to Low to see the difference; Auto quality changes the reach while riding.

## Tools added

- `game/tools/canopy_compare.mjs`: the stills and cost matrix (`--presets`, `--times`, `--sizes`, `--only`, `--no-shots`; `SHOT_DIST`, `SHOT_PACKS`, `SHOT_QUERY`).
- `game/tools/canopy_clip.mjs`: the handover clip down The Slot (`--preset`, `--time`, `--speed`, `--seconds`, `--path`, `--look`).
- `game/tools/canopy-views.json`: the four views.
