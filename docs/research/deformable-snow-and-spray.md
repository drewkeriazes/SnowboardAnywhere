# Research: deformable snow trails and powder spray (FEAT-044, #76)

Researched 2026-11-09 against `main` at 393a891 (after FEAT-053 snow conditions merged). Built in PR for #76 (`world/Deform.ts`, `world/Spray.ts`; see `docs/developer-guide.md`), with the differences noted in section 6. The card asks for three things: a rider-local heightfield the near terrain deforms from, the existing ribbon tracks kept for the far trail, and GPU powder spray that scales with edge angle, speed and snow depth. This note checks that pitch against the code, records what published snow-deformation techniques do, and lays out a build order that reuses what the game already has.

## 1. What the game has today

| Piece | Where | What it does | Limit for this card |
|---|---|---|---|
| Board tracks | `game/src/world/Tracks.ts` | Every 0.5 m a cross-section (8 vertices: outer edge, berm lip, wall top, floor, mirrored) is laid across the travel direction into a ring buffer of 6,000 sections per lane (about 3 km). Width from the slip angle, depth 5 cm times powder and edge factors, tilt from the edge angle (a knife cut on a hard carve), a ridge of pushed snow when braking. Fades back in over `FADE` = 600 s, faster while it snows. Drawn as a mesh with vertex colours, depth-biased toward the camera so the sunken floor is not hidden by the terrain. | It is a decal that sits in the terrain, not snow that has moved. The floor is at most about 8 cm down even in powder, and the lips are a few centimetres: fine for a groomer, nothing like a powder trench. |
| Bootprints | `game/src/world/Bootprints.ts` | One InstancedMesh, 4,000 prints, sole-shaped dents with a rim; BUG-020 overlap rules (deepen instead of re-stamp). | Each print is its own rim. BUG-020's issue text already names "one packed surface" in a rider-local texture as the long-term fix and points at this card. |
| Terrain | `game/src/terrain/Terrain.ts`, `TerrainMaterial.ts` | Quadtree chunks of 32 x 32 quads, built on the CPU from the pack heights; the finest level is the fine set's 1 m. Material hooks `onBeforeCompile` (uniforms in `mat.userData.uniforms`, the same pattern `uSkied` uses), with procedural normal detail in `normal_fragment_begin` (drifts, corduroy, FEAT-077 ski-track dents from `trackH`). | Near the rider the vertex spacing is 1 m. A board is 26 cm wide. A heightfield displaced on these vertices can only show something 2 m wide or more. |
| Spray | `game/src/world/RiderView.ts` `updateSpray` | 1,200 CPU particles (Points, 0.28 m sprites, 0.75 alpha, no depth write). Emits from `skid` (up to 10 a frame) and a braking sheet from `scrape` (18 a frame), gravity only, 0.5 to 0.9 s life. BUG-046 tints them with the snow's light at the rider. | No powder term, no edge-angle term, no hang or drift, no landing burst, and the CPU writes every particle every frame. |
| Snow state | `game/src/sim/SnowConditions.ts` (FEAT-053) | `rider.snow`: groomed / powder / chop / ice / slush / rock weights, `depth` (loose snow depth: 2.5 cm groomed, 12 to 40 cm powder), grip, drag. | This is exactly the input the stamp depth and the spray need; nothing in the renderer reads it yet. |
| Render targets | `world/Impostors.ts`, `world/Clouds.ts` | Both render to a `WebGLRenderTarget` with the save-and-restore dance around `renderer.setRenderTarget`. | Proven pattern to copy for the deformation pass. |
| Shadows | `world/Sky.ts` `registerMaterial` | Wraps a material's own `onBeforeCompile` with the CSM hook and keys the program cache on the base hook's source. | New terrain uniforms and shader code go in `TerrainMaterial`'s hook, as before; nothing to do for CSM. Terrain chunks with `castShadow` (res 4 m and finer) use three.js's depth material, which does not run the displacement, so a trench's shadow is the undeformed surface's. At 5 to 30 cm this is invisible; note it, do not fix it. |

## 2. What the published techniques do

- **Batman: Arkham Origins (GDC 2014, Colin Barré-Brisebois).** Displacement heightmaps are generated at runtime around the player and AIs from an orthographic capture: objects that touch the snow are rendered from below into a height target, the minimum height is kept, and the snow surface displaces from that map (tessellated on PC). Snow replenishes over time because it keeps snowing; only two surfaces are rendered per frame. Sources: [GDC Vault](https://www.gdcvault.com/play/1020177/Deformable-Snow-Rendering-in-Batman), [slides](https://www.slideshare.net/colinbb/gdc2014-deformable-snow-rendering-in-batman-arkham-origins).
- **Rise of the Tomb Raider ("Deferred Snow Deformation", GPU Pro 7, Michels and Sikachev).** The same idea with the cost moved: the heightmap stores the depression only, and the raised rim of pushed snow is reconstructed in the snow's render pass from the depression's neighbourhood, so the stamp pass stays trivial and dense static meshes are not needed. Sources: [chapter listing](https://www.gameenginegems.com/gemsdb/article.php?id=1314), [SIGGRAPH 2015 talk](https://history.siggraph.org/learning/labs-rd-rendering-techniques-in-rise-of-the-tomb-raider).
- Both rely on hardware tessellation for the surface density. WebGL2 has none, so the density has to come from a denser mesh near the rider (section 3.3).

Steep's own implementation is not documented in a source this note could check; the card's "like Steep" is the look target (a real trench with lips, spray that hangs), not a claim about its internals.

## 3. Design

### 3.1 One idea that removes most of the work

The card describes stamping the board footprint into a scrolling heightfield each step. The game already has stamp geometry: the track lanes and the bootprints hold every cross-section's floor, walls, lips, ridge and age, and they already persist for 3 km and fill in over time. So the deformation texture does not need its own stamping, scrolling, persistence or fill-in logic. **Each frame, an orthographic camera looking straight down at a window around the rider renders the existing track lanes and bootprint instances into a render target with a tiny "height offset" shader.** The texture is a top-down raster of geometry the game already maintains; the ribbon ring buffer is the persistence, the ribbon's `age` is the fill-in, and content that leaves the window is simply the ribbon again. Nothing has to scroll.

Consequences:
- The ribbon meshes themselves are hidden inside the window (alpha fades to 0 over the last few metres of the window, a uniform on the track material) and show again outside it. Far trails stay ribbons, as the card asks.
- Bootprints get BUG-020's "one packed surface" for free inside the window: overlapping prints take the deepest depression, and the rim is reconstructed at the edge of the packed area, not per print.
- The stamp pass uses its own small `ShaderMaterial` on the same geometries (swap the material for the pass, or `scene.overrideMaterial` on a layer), not the ribbon's `mat`: the ribbon's vertex hook pushes vertices out by camera distance (`aSpread`) and biases depth toward the camera, both of which would put width and height noise into a top-down capture. The stamp material ignores `aSpread` and the bias and reads a per-vertex height offset. `Lane.shape` already computes that offset (`h * depth + rh`); store it in a new 1-float attribute alongside `aSpread`. Bootprints' geometry heights are in `NOMINAL` units scaled per instance by the shader, so their offset is already in the vertex shader and the stamp material repeats that scaling.

### 3.2 The deformation target

- Window 64 m square around the rider, 512 x 512, RGBA8 (1 MB). Texel 12.5 cm. The window origin snaps to whole texels so the texture does not swim; a uniform `uDeformWin` (origin x, origin z, 1 / size) goes to the terrain and the stamp material. The window centre leads the rider by about a third of the window along the velocity, because the rider looks downhill and the trail behind is the ribbon's job anyway.
- Channels: R = depression in metres times 2 (0 to 0.5 m at 2 mm steps), G = raised snow (lips and the braking ridge) the same way, B = packed amount (0 fresh, 1 polished floor, for shading), A unused. Blend equation `THREE.MaxEquation` on all channels, so overlapping passes take the deepest cut and the highest lip without any ordering. Clear to 0 each frame.
- Cost: the lanes are drawn with `frustumCulled = false`, but the orthographic camera's clip rejects off-window sections in the vertex stage. Worst case about 3 lanes x 6,000 x 14 triangles plus 4,000 prints, into a 512 target, under 0.5 ms. The pass runs every frame while the rider is moving; when the rider is still and nothing is filling in it can run at the track `tick` rate (2 Hz).
- Toggle: `?nodeform` URL parameter and a Settings row, so A/B shots are one reload apart.

### 3.3 Terrain density near the rider

The 1 m near grid is the real obstacle. Options considered:

| Option | Density | Cost | Verdict |
|---|---|---|---|
| Fragment only: normals and shading from the texture, no displacement | n/a | Nearly free | Half the look. No silhouette, the board floats over a painted hole. Keep as the fallback for the Low preset. |
| A separate rider-local "snow carpet" mesh over the terrain | Any | Needs the terrain height on the GPU (a second ortho capture of the chunks) and fights the terrain for depth everywhere it is not deformed | Two passes and z-fighting rules; more code than the next option. |
| Let the quadtree split past the data resolution near the rider | 25 cm within about 40 m | Chunks of 8 m with 32 x 32 quads; a 64 m window is about 64 to 100 such chunks, roughly 130 to 200 k triangles and as many draw calls as chunks (the budget is 1,500 draw calls; the terrain is 300 to 900 today) | **Recommended.** `Terrain.select` already stops at `minRes` (the pack's 1 m); allow two more levels when the chunk centre is within the window and `res > 0.25`. `pack.height` is bilinear so the extra vertices land on the same surface; masks and AO are sampled the same way. |

At 25 cm vertices the geometry carries the broad trench (a powder trench is 40 to 80 cm wide and 10 to 30 cm deep); the full 12.5 cm texture gives the fragment normal its walls and lips. A groomer's 1 cm carve line cannot be a heightfield at any sane size, so on groomed snow the ribbon stays visible inside the window too (the fade uniform is scaled by `1 - groomed` per section, carried in a vertex attribute or simply by the stamp depth being tiny there).

Chunk churn: at 20 m/s the window front sweeps about 2.5 new 8 m chunks per second per row, so around 20 small builds a second. Each samples 1,156 heights, well inside `MAX_BUILDS_PER_FRAME`. Watch the eviction so the 8 m chunks are dropped promptly once they leave the window, or the chunk map grows without bound.

### 3.4 Terrain shader changes (`TerrainMaterial.ts`)

- Vertex: sample `uDeform` at the world xz; offset the vertex along its normal by `lip - depression`, where the lip is attenuated where the depression is non-zero (RoTR's reconstruction: lip only outside the packed area). Fade the offset to 0 over the last 3 m of the window so the deformed chunks meet the 1 m neighbours without a step (the skirts hide the rest).
- Fragment: a detail normal from central differences of the texture at one texel (same construction as the FEAT-077 `trackH` block), scaled by `1 - smoothstep(window edge)`. Inside a depression: kill the corduroy and the drift bump, cut the glint by the packed amount, brighten and cool the floor like the ribbon does (`tone` 1.0 to 1.03 on the floor, the walls in the snow shade colour). Store the packed amount in B so a scraped band reads polished and a powder trench reads soft.
- Both are gated by `#ifdef DEFORM` so the Low preset compiles the old shader.

### 3.5 Stamp depth from the snow state (`Tracks.ts`)

Today `depth = DEPTH * (1 + 0.6 * powder) * ...` with `DEPTH` 5 cm, so even deep powder gets an 8 cm floor. Change the section depth to `max(groomer depth, 0.7 * rider.snow.depth)` when the snow is not groomed, giving 8 to 28 cm trenches in powder with the board width plus the lips widened by the same factor (`lipWidth` already scales with polish; add a powder term). The ribbon drawn outside the window uses the same numbers, which also makes the far trail deeper in powder than it is now. The ridge on a braking stop grows the same way. Boot sink already comes from `bootSink(snow)`.

Nothing else in the stamp needs physics: the cutting-model numbers (edge angle, slip angle, ridge) are already in the section data from FEAT-065 and FEAT-127.

### 3.6 GPU powder spray

Replace the CPU particle loop with a vertex-shader particle system like `world/Snow.ts`: the CPU writes only the newly emitted particles' spawn record (position, velocity, spawn time, seed, kind) into a ring buffer of 8,192; the vertex shader integrates analytically from `uTime`: position = p0 + v0 (1 - e^(-k t)) / k + wind t - g t^2 / 2 on the vertical, with the drag k by kind. Size grows over life (a cloud expands from 0.2 to 1.2 m), alpha fades with a soft sprite, the same BUG-046 light tint. Two kinds:

- **Wisps** (groomers, ice): short life 0.3 to 0.6 s, small, fast, drag high. Emission from `scrape` and `skid` as today, plus a thin sheet off the engaged edge at speed.
- **Clouds** (powder, chop, slush): life 1.5 to 3 s, big, slow, low drag, so they hang and drift on `uSnowLee` wind. This is the Steep look.

Emission rate, per second: `rate = k_kind * speed * sin(|edge|) * (0.3 + snow.depth / 0.3) * (1 + 2 * skid + 3 * scrape)`, capped. The snow leaves the engaged edge on the outside of the turn: direction = the rider's `right` times the edge sign, tilted up by about the edge angle, with half the board's velocity carried along. Spawn along the effective edge (spread the board length when carving, across the band in a hockey stop). Landings: a burst of `landingShock * 60` clouds when `onGround` goes true (the rider computes `landingShock` from the impact speed). The rider's `snow.powder`, `chop` and `slush` weights pick the kind mix.

Budget: 8,192 points are nothing on the GPU; the CPU writes at most a few hundred records a frame. Fits `AutoQuality` as a share like `snow` does.

### 3.7 Quality and fallbacks

| Preset / auto level | Deformation | Near split | Spray |
|---|---|---|---|
| High, auto 0 to 2 | 512 texture, 64 m | 25 cm | 8,192 |
| Medium, auto 3 | 256 texture, 48 m | 50 cm | 4,096 |
| Low, auto 4 | off (fragment normals only, or nothing) | off | 2,048 |

## 4. Build order (one card, three PRs, or split into three cards)

1. **Deformation pass and terrain** (the big one): the ortho capture of lanes and prints, the near split in `Terrain.select`, the vertex offset and fragment normal in `TerrainMaterial`, the window fade on the ribbon, `?nodeform`. Done when a carve on the synth pack shows a real trench with lips in a chase-camera shot and the ribbon takes over seamlessly behind. Tool: a new `game/tools/trailcheck.mjs` to write in this step, modelled on `carveshot.mjs` (tuck, two carves, a stop; shots from the chase camera and straight down, with and without `nodeform`).
2. **Powder depth and shading**: section depth from `rider.snow.depth`, widened lips, packed-amount shading, bootprints into the same target (closes the long-term half of BUG-020). Done when the Back Bowls trench is 15 to 30 cm deep and Born Free stays a 5 cm groove with the corduroy intact beside it.
3. **GPU spray**: the new particle system, wisps and clouds, landing bursts; remove `updateSpray`. Done when a hard turn in powder throws a cloud that hangs for 2 s and drifts, and a groomer gives light wisps.

Check each on Drew's GPU with `--headed` runs; SwiftShader is too slow for a meaningful look at the particles, and `tools/shoot.mjs` with `SHOT_QUERY="&lowgfx"` only proves nothing crashed.

## 5. Risks and open questions

- **Program cache**: the terrain material's hook source changes with `#ifdef DEFORM`; the CSM wrapper keys on the base hook, so toggling at runtime recompiles once. Fine, but do not toggle per frame.
- **Depth bias on the ribbon**: hidden inside the window, so the bias and the displaced terrain never fight. Outside the window the old rules hold.
- **Float precision in the ortho capture**: render in rider-local coordinates (subtract the window origin on the CPU or in the stamp vertex shader), not world metres, or 2 mm steps are lost at Vail's 10 km extents.
- **MaxEquation on RGBA8** is core WebGL2; no extension needed. Check `renderer.capabilities.isWebGL2` and fall back to off.
- **Chunk count**: 64 to 100 extra draw calls is within budget but worth a `perf-check` row before and after (`docs/research/perf-log.md` does not exist yet; the skill says to create it).
- **Replays and ghosts** (`Replay.ts`, `TimeTrial.ts`): the trail is rebuilt from the ribbon as the rider rides, so a replay rewinding past a section shows a trail that is already there. Same as today; not worse.
- **The groomed boundary**: a track that crosses from a groomer into powder changes depth per section; the ribbon already handles that per section, so the texture does too.
- Open: should the window follow the camera rather than the rider in free-fly and replay cameras? Proposal: the rider, always; the camera rarely looks at the near snow from elsewhere.

## 6. What was built (2026-11-09)

All three steps landed in one PR, as one card, and then changed to a hybrid after testing on Drew's GPU.

**The first build** followed sections 3.1 to 3.4: the terrain split to 25 cm inside the window, displaced from the full-resolution texture and took the trench walls from it, and the ribbon hid where the trench was deep. It looked jagged. A texture dump showed why: a powder carve stamps a trench about 3 texels (37 cm) wide with walls narrower than a texel, and the 25 cm vertex grid samples it about one and a half vertices across, so a track running diagonally to the grid aliased into beads and stair-steps while one along an axis looked smooth. Where the window jumped (slowing, stopping), the coarser 1 m chunk showed the same texture until the 25 cm chunks were built, which is why the beads sometimes resolved after a moment. It also added about 120 terrain draw calls and a stream of CPU chunk builds. Section 3.3's estimate that 25 cm vertices would carry the broad trench was wrong for these widths.

**The hybrid** keeps the ribbon as the visible trench everywhere (it is built along the track, so it has no resolution limit) and uses the texture only for a soft sag: shaders read its mipmap at about 1 m per texel, so the GPU's box filter pre-blurs the stamp to the terrain's own vertex spacing. The terrain, the ribbon and the boot prints all sink by the same sag at their vertices, so they stay together. No terrain split, no packed-snow shading, and the boot prints keep their own rims (BUG-020's single packed surface is not delivered by this).

Other differences from the plan:
- The capture renders proxy meshes (the lanes' geometry under a stamp `ShaderMaterial`, a second `InstancedMesh` sharing the boot prints' instance matrices) in a dedicated scene, instead of swapping materials on the real meshes.
- In soft snow the knife-cut collapse is held back to 30 % (the board sinks, the whole base cuts) and the trench is 60 % wider than the board; the floor is capped at 25 cm.
- No `#ifdef DEFORM`: a uniform branch on `uDeformWin.w` turns the shader work off, so no recompile when the setting changes.
- Spray: drag and settling speed per kind in the vertex shader, spawn records uploaded through `addUpdateRange`.
