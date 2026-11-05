# Research: Three.js rendering stack for a large real-terrain scene (M1, M3, M5)

Researched 2026-11-05 for the SnowboardAnywhere renderer. Target: Three.js r172, WebGL2, 11.6 x 11.7 km resort at 1 m plus a 100 km horizon, ~100k+ trees. Claims are from the linked sources; "reasoned" means our own estimate, not measured.

## 1. Terrain LOD: CDLOD is the right fit

Continuous Distance-Dependent LOD (Strugar 2009) is what every serious heightmap terrain uses and it maps directly to our pack format (power-of-two heightmap tiles at 1/2/4/8 m).

How it works
- One quadtree over the terrain. Each frame, select nodes whose LOD range (a distance band per level) contains the camera distance; children replace parents when closer. Selection is CPU-side and cheap (hundreds of nodes).
- Every selected node draws the SAME flat grid mesh (e.g. 64 x 64 or 128 x 128 quads) with a per-node uniform: world offset, scale, LOD level, morph range. One geometry, many draw calls, or one `BatchedMesh`/instanced draw.
- The vertex shader samples the heightmap texture for height. Vertices morph (lerp) toward the parent level's grid positions as they approach the outer edge of their LOD band, so there is no popping and no cracks between neighbouring levels. No skirts or stitching needed when morphing is done right.
- Frustum-cull nodes using their 3D AABB (needs min/max height per node; precompute in the pack as a tiny `nodes.json`).

Reference implementation in Three.js: tschie/terrain-cdlod (MIT). It demonstrates quadtree selection and vertex-shader morphing but does NOT use node heights for culling, which leaves holes at screen edges on steep terrain; we must include min/max heights per node. [tschie/terrain-cdlod](https://github.com/tschie/terrain-cdlod)

Recommended parameters for Vail (reasoned)
- Grid 64 x 64 per node, 6 to 7 LOD levels, level 0 = 1 m over 64 m nodes, each level doubles. LOD range of the finest level ~150 m, doubling per level; far ring to 100 km via the 30 m background drawn as a separate coarse CDLOD.
- Height texture: one R16 (or RG8 packed) texture per pack tile, `NearestFilter` for exact physics parity or `LinearFilter` for smooth shading; sample normals from a precomputed RG normal texture rather than finite differences in the shader.
- Keep physics on the CPU against the raw Float32 heightfield (bilinear), not against the rendered morphing mesh; the mismatch is sub-pixel at LOD0 and never matters for a rider.

## 2. Heightmap data in the browser
- 16-bit PNG decodes to 8-bit through the browser's `<img>` path. Options: (a) pack 16 bits into RG of an 8-bit PNG and reconstruct `h = R*256 + G` in the shader, (b) ship raw `Int16Array`/`Float32Array` `.bin` tiles (gzip/brotli compresses terrain well), (c) KTX2/basis (poor for heightfields). (a) is what Terrarium does and keeps caching simple; (b) is simplest for physics since the same array feeds GPU and CPU. Recommend (b) with a `DataTexture` of `HalfFloatType` or `FloatType` (WebGL2 supports `R32F` with `LinearFilter` via `OES_texture_float_linear`; check `renderer.capabilities`).
- Terrarium decode for the Mapterhorn far ring: `h_m = (R * 256 + G + B / 256) - 32768`.

## 3. Trees: use the three.ez stack, do not hand-roll instancing

`@three.ez/instanced-mesh` (agargaro) is an `InstancedMesh2` with per-instance frustum culling (default on), a dynamic BVH for culling and raycast, LOD, shadow LOD, per-instance uniforms, sorting (`createRadixSort`), per-instance visibility/opacity, add/remove. [agargaro/instanced-mesh](https://github.com/agargaro/instanced-mesh)

```js
import { InstancedMesh2 } from '@three.ez/instanced-mesh';
const trees = new InstancedMesh2(conifer0, mat);
trees.addInstances(n, (obj, i) => {
  obj.position.set(x[i], y[i], z[i]);
  obj.scale.setScalar(h[i] / baseHeight);
  obj.rotateY(rot[i]);
});
trees.addLOD(conifer1, mat, 60);     // simplified mesh beyond 60 m
trees.addLOD(conifer2, mat, 200);
trees.addShadowLOD(conifer1);        // cheap geometry for the shadow pass
trees.addShadowLOD(conifer2, 100);   // even cheaper beyond 100 m
```
Signatures per the README: `addLOD(geometry, material, distance)`, `addShadowLOD(geometry, distance?)`. Verify against the installed version's typings before relying on them.

Far trees: octahedral impostors. agargaro's `octahedral-impostor` bakes a hemi-octahedron sprite sheet (`spritesPerSide: 16`, `textureSize: 2048`, `alphaClamp: 0.45`, `parallaxScale: 0.5`) and blends the 3 nearest views in the vertex shader. Their demo: 3072 x 3072 terrain, 200k trees, meshoptimizer-simplified mesh from 15 to 100 m, impostors beyond 100 m, runs on mobile. [discourse thread](https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735), [repo](https://github.com/agargaro/octahedral-impostor)

Companion: `batched-mesh-extensions` adds LOD and culling to `BatchedMesh`, which the same author uses for terrain chunks. [repo](https://github.com/agargaro/batched-mesh-extensions)

Budget: one draw call per LOD level per tree species. 3 species x 3 LODs plus impostors is ~12 draw calls for the whole forest. Sort instances by distance (radix sort) so overdraw from alpha-tested needles is front-to-back.

## 4. Shadows: CSM from three/addons

```js
import { CSM } from 'three/addons/csm/CSM.js';
const csm = new CSM({
  camera, parent: scene, cascades: 3, maxFar: 4000, mode: 'practical',
  shadowMapSize: 2048, lightDirection: sunDir.clone().negate().normalize(), lightIntensity: 3,
});
csm.fade = true;                 // blend cascade edges
csm.setupMaterial(terrainMat);   // every material that receives shadows
csm.setupMaterial(treeMat);
// per frame, before render:
csm.update();
// when camera params or csm settings change:
csm.updateFrustums();
```
Notes: `maxFar` is the shadow distance (3 to 4 km is plenty; beyond that, bake terrain self-shadowing into the normal/AO texture). WebGLRenderer only; WebGPU needs `CSMShadowNode`. The docs typedef lists `lightNear` twice; the second is `lightFar` (default 2000). [three.js CSM docs](https://threejs.org/docs/pages/CSM.html)

A custom terrain ShaderMaterial must include the CSM shader chunks, or use `MeshStandardMaterial` with `onBeforeCompile` injection; `setupMaterial` patches standard materials automatically.

## 5. Sky and sun
- `three/addons/objects/Sky.js` (Preetham) is adequate for M1; drive `sunPosition` from date, time and Vail's lat/lon (39.6, -106.37) with a small solar-position function (NOAA algorithm, ~30 lines).
- For M5, consider a precomputed-scattering sky (Bruneton) for correct aerial perspective over 100 km; Preetham's horizon haze is the main giveaway in long views.
- Fog: height-aware exponential fog in the terrain shader rather than scene fog, so the valley floor hazes more than the ridgelines.

## 6. Snow shading notes (M5)
- Sparkle: screen-space stochastic glints; sample a high-frequency noise normal, threshold `pow(max(dot(reflect(-V, N_glint), L), 0), k)` with k ~ 200 and a density mask; vary with camera motion only (view-dependent, not time-dependent). Deliot & Belcour, "Real-time glints rendering with prefiltered discrete stochastic microfacets" (CGF 2020) is the reference for doing it properly. [paper](https://diglib.eg.org/handle/10.1111/cgf14007)
- Snow is strongly forward-scattering; a cheap wrap-lighting term `max(0, (NdotL + w) / (1 + w))` with w ~ 0.3 plus a blue-tinted (sky colour) ambient in shadow gets most of the look.
- Groomed corduroy: tiling normal map with ridges 1 to 1.5 cm high, 2 to 3 cm period, aligned along the piste direction. Store piste direction in the mask tile (angle byte) so the shader rotates the normal map; unaligned corduroy looks wrong immediately.
- Chop and moguls: low-frequency displacement already in the 1 m heightfield (mogul fields on Highline, Blue Ox, Prima show up in the DEM), plus a high-frequency bump normal.

## 7. meshoptimizer for LODs
`meshoptimizer` (JS bindings) simplifies tree meshes offline or at load; the impostor demo above uses it for terrain and tree LODs.

## Sources
- [tschie/terrain-cdlod](https://github.com/tschie/terrain-cdlod)
- [agargaro/instanced-mesh](https://github.com/agargaro/instanced-mesh)
- [A forest of octahedral impostors (three.js discourse)](https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735)
- [Procedural Instanced Forest (three.js discourse)](https://discourse.threejs.org/t/procedural-instanced-forest-high-performance-real-trees/88610)
- [three.js CSM docs](https://threejs.org/docs/pages/CSM.html)
- [Real-Time Glints Rendering with Prefiltered Discrete Stochastic Microfacets](https://diglib.eg.org/handle/10.1111/cgf14007)
