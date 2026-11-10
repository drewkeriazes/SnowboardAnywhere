import * as THREE from 'three';
import { MOGUL_GLSL } from './Moguls';
import { NOISE_GLSL, ROCK_GLSL, rockUniforms } from './rockShader';
import { DEFORM_GLSL, deformUniforms } from '../world/Deform';
import { SNOW_SHADE_TINT } from '../world/snowLook';

/**
 * Snow / rock / scree / groomed material. Per-vertex class weights arrive in the color attribute
 * (r = rock, g = scree or meadow, b = groomed). Detail comes from world-space procedural noise
 * so there are no texture seams between LOD chunks.
 *
 * Groomed vs ungroomed: groomers are smooth, clean snow with corduroy ridges (about 30 cm apart)
 * running down the fall line, lit as small bumps, in groomer-width passes with faint seams; the
 * ridges fade out with distance so they never shimmer. Ungroomed snow (bowls, glades) keeps the
 * stronger drift relief plus wind ripples and more tonal variation. The ridge direction is the run's
 * axis from the pack's piste direction set (DATA-002), else the smoothed fall line from the heights;
 * stripes use 12 fixed world directions, blending the two nearest the local direction, so
 * they stay put on the snow instead of swimming as the slope curves.
 *
 * Snow lighting (FEAT-047): sunlight wraps past the terminator as a blue subsurface glow (light
 * scattered inside the snowpack); shaded snow takes a cool blue tint from the sky; the sun glints
 * off individual crystals (a random facet normal per 4 cm cell lights up when it lines up with the
 * half vector, fading out once cells shrink below a pixel); baked sky visibility from the pack (`ao`
 * attribute) darkens gullies, couloirs and cliff feet, and the canopy darkens the snow under trees.
 * `uFlat` (storm, overcast) flattens the snow relief, turns the glints off and roughens the snow: flat light.
 *
 * Moguls (FEAT-059, BUG-062): every chunk up to MOGUL_SHADE_MAX_RES evaluates the mogul field once per
 * pixel (`mogulField`: height and slope in one analytic evaluation). The slope bends the normal on all of them (the
 * finest chunks carry the bumps in their positions too, with base-surface vertex normals), and the
 * snow is coloured from the bump's own shape so the field reads without a shadow pass: troughs a
 * little darker and bluer, crests brighter and warmer, the side facing away from the sun cooler and
 * darker (a dot of the bump normal with the sun's ground direction), and the face a rider coming
 * downhill rides into slightly darker than the back so the pattern reads under an overhead sun or in
 * flat light. The wrap light and the flat-light normal pull drop 60% on moguls so they keep shape.
 * All of it scales with the bump amplitude, so smooth snow and groomers are untouched.
 *
 * Rock and talus (FEAT-020): the vertex weights (imagery mask unioned with steep faces, wind-scoured
 * ridges and talus aprons from Terrain.build) are thresholds against multi-scale world-space noise,
 * so rock pokes through the snow in crisp patches instead of a wash; flat ledges on the rock's own
 * detail normal keep snow. Surfaces come from rockShader.ts (CC0 photo textures, triplanar).
 *
 * Snow sag (FEAT-044, `world/Deform.ts`): inside the rider-local window the vertex shader sinks each
 * vertex by the soft sag around the tracks and prints (the stamp averaged over about 1 m, fading out
 * over the window's last metres) and the fragment shader tilts the normal by its slope; the sharp
 * trench itself is the ribbon (`Tracks.ts`). `uDeformWin.w` = 0 turns it off (a uniform branch).
 *
 * Distant forest (FEAT-153): past a few hundred metres the forest share comes per pixel from the pack's
 * cover levels (`uCov0..2`, mipmapped, so trails narrower than a far chunk's vertices still show as white
 * cuts), not from the per-vertex value; conifer timber is a dark mass with a crown-scale texture that fades
 * to an even tone once a pixel is wider than a crown. Beyond the instanced trees (`uLiftNear`) the coarse
 * chunks raise forested ground by the `lift` attribute (canopy height x cover) so ridges read as treed.
 *
 * Forest from high up (FEAT-154, `docs/research/far-terrain.md`): how dark forested ground goes is a gap
 * fraction of the cover share and the view angle, less what the drawn trees already cover inside their
 * reach, and sunlit canopy takes only `uCanopySun` of the direct light, so from the air the bowls stay
 * white between their tree islands and timber reads dark instead of grey.
 */

/** three.js's physical direct-light function with the snow wrap/subsurface and glint terms added. */
function snowLightsChunk(): string {
  const src = THREE.ShaderChunk.lights_physical_pars_fragment;
  // whitespace-tolerant: the npm build of three.js strips blank lines from its chunks
  const a = /float dotNL = saturate\( dot\( geometryNormal, directLight\.direction \) \);\s*vec3 irradiance = dotNL \* directLight\.color;/;
  const b = /reflectedLight\.directDiffuse \+= irradiance \* BRDF_Lambert\( material\.diffuseColor \);/;
  if (!a.test(src) || !b.test(src)) throw new Error('TerrainMaterial: three.js lights_physical_pars_fragment changed; update snowLightsChunk');
  return src
    .replace(a, `float dotNLr = dot( geometryNormal, directLight.direction );
	float dotNL = saturate( dotNLr );
	vec3 irradiance = dotNL * directLight.color;
	// snow: light wraps past the terminator, blue from scattering inside the snowpack
	float wrapNL = saturate( ( dotNLr + gWrap ) / ( 1.0 + gWrap ) );
	vec3 snowIrr = irradiance + max( wrapNL - dotNL, 0.0 ) * gSnowW * uSSS * directLight.color;
	// crystal glints: this pixel's facet catches the sun when it lines up with the half vector
	float glint = pow( saturate( dot( gGlintN, normalize( directLight.direction + geometryViewDir ) ) ), 700.0 );
	reflectedLight.directSpecular += directLight.color * ( gGlintW * glint * 9.0 * dotNL );`)
    .replace(b, `reflectedLight.directDiffuse += snowIrr * BRDF_Lambert( material.diffuseColor );`);
}

/** FEAT-153: the canopy lift fades in from the impostors' reach (Vegetation FAR_RADIUS) to full here (m) */
/** FEAT-153: the canopy lift fades in over this many metres from `uLiftNear`, the impostors' reach (Vegetation FAR_RADIUS, set by Terrain.update) */
export const LIFT_RAMP = 2000;
/** FEAT-153: cover level slots in the shader (coarsest first) */
export const COVER_SLOTS = 3;
const EMPTY_RECT = new THREE.Vector4(-1e7, -1e7, -1e7 + 1000, -1e7 + 1000); // weight 0 everywhere, finite uv
function coverUniforms() {
  const blank = new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  blank.needsUpdate = true;
  return {
    uCov0: { value: blank as THREE.Texture }, uCov1: { value: blank as THREE.Texture }, uCov2: { value: blank as THREE.Texture },
    uCovRect: { value: [EMPTY_RECT.clone(), EMPTY_RECT.clone(), EMPTY_RECT.clone()] },
    uCovBlend: { value: 500 },
    uLiftNear: { value: 4500 },
  };
}

export function createTerrainMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.0,
    flatShading: false,
  });
  // uniforms live outside the hook so settings (flat light) can change them before the first compile
  const uniforms = {
    uTime: { value: 0 },
    uSnow: { value: new THREE.Color(0.93, 0.95, 1.0) },
    uSnowShade: { value: new THREE.Color(0.72, 0.80, 0.96) },
    uGroomed: { value: new THREE.Color(0.97, 0.98, 1.0) },
    /** sky fill on shaded snow: cool blue, not grey */
    uShadeTint: { value: new THREE.Color(...SNOW_SHADE_TINT) },
    /** subsurface colour of the wrapped sunlight */
    uSSS: { value: new THREE.Color(0.30, 0.48, 0.80) },
    uWrap: { value: 0.45 },
    uGlint: { value: 1.0 },
    uFlat: { value: 0.0 },
    uSnowCover: { value: 0.0 },
    /** FEAT-077: how skied the snow is (0 fresh corduroy .. 1 tracked out) and spring snow (0..1) */
    uSkied: { value: 0.0 },
    uSpring: { value: 0.0 },
    uSnowLee: { value: new THREE.Vector2(1, 0) },
    /** FEAT-059: mogul field amplitude multiplier and uphill creep (m) for the shaded coarse chunks */
    uMogulScale: { value: 1.0 },
    uMogulCreep: { value: 0.0 },
    /** BUG-062: direction toward the sun (three.js world frame) for the mogul colouring; `?debug=moguls` */
    uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.74) },
    uDebugMoguls: { value: 0.0 },
    /** baked AO strength (1 = as baked; debug A/B with 0) */
    uAO: { value: 1.0 },
    /** FEAT-154 look switches for A/B stills (`tools/aerial.mjs`): x = 1 drops the forest darkening, y the rock
     *  and talus, z the snow drift normals; w = 1 paints the forest darkening red */
    uDebugFar: { value: new THREE.Vector4(0, 0, 0, 0) },
    /** FEAT-154: the share of the canopy the drawn trees cover inside their reach (the ground adds the rest),
     *  the share of the sun a sunlit canopy returns (shaded needles and crown sides), and how much of a
     *  forested pixel is timber rather than snow between the crowns. Tuned from 500 to 900 m up on Vail. */
    uForestDrawn: { value: 0.7 },
    uCanopySun: { value: 0.3 },
    uTimberMix: { value: 0.97 },
    /** FEAT-154: the rectangle (pack minX, minY, maxX, maxY) holding tree instances; none by default */
    uTreeRect: { value: EMPTY_RECT.clone() },
    ...rockUniforms(),
    ...deformUniforms,
    ...coverUniforms(),
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    (mat as any).userData.shader = shader;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float forest;
        attribute vec2 fall;
        attribute float ao;
        attribute vec4 mogul;
        attribute float lift;
        uniform float uLiftNear;
        varying float vAO;
        varying float vForest;
        varying vec2 vFall;
        varying vec4 vMogul;
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        ${DEFORM_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // FEAT-153: forested ground stands up by its canopy past the instanced trees, so ridges read as treed
        if (lift > 0.0) {
          vec3 wl = (modelMatrix * vec4(transformed, 1.0)).xyz;
          transformed.y += lift * smoothstep(uLiftNear, uLiftNear + ${LIFT_RAMP.toFixed(1)}, distance(cameraPosition, wl));
        }
        // FEAT-044: the snow sags softly around the tracks and prints inside the deformation window
        if (uDeformWin.w > 0.0) {
          vec2 duv = deformUV((modelMatrix * vec4(transformed, 1.0)).xz);
          float df = deformFade(duv);
          if (df > 0.0) transformed.y += deformSag(duv) * df;
        }`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
        vFall = fall;
        vMogul = mogul;
        vAO = ao;
        vForest = forest;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', snowLightsChunk())
      .replace('#include <common>', `#include <common>
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        varying float vForest;
        varying float vAO;
        varying vec2 vFall;
        varying vec4 vMogul;
        uniform float uMogulScale, uMogulCreep, uDebugMoguls;
        uniform vec3 uSunDir;
        uniform float uTime;
        uniform vec3 uSnow, uSnowShade, uGroomed, uShadeTint, uSSS;
        uniform float uWrap, uGlint, uFlat, uAO;
        uniform vec4 uDebugFar;
        uniform float uForestDrawn, uCanopySun, uLiftNear, uTimberMix;
        uniform vec4 uTreeRect;
        #define AO_POW 2.6
        #define AO_DIRECT 0.6
        // FEAT-075: forest darkening from FOREST_NEAR (full by FOREST_FULL, m); canopy cover FOREST_LO..FOREST_HI maps to 0..1
        #define FOREST_NEAR 350.0
        #define FOREST_FULL 1000.0
        #define FOREST_LO 0.08
        #define FOREST_HI 0.45
        uniform float uSnowCover;
        uniform float uSkied, uSpring;
        uniform vec2 uSnowLee;
        // FEAT-153: forest cover levels, coarsest first (rect = minX, minY, maxX, maxY in pack metres)
        uniform sampler2D uCov0, uCov1, uCov2;
        uniform vec4 uCovRect[3];
        uniform float uCovBlend;
        #define COVER_NEAR 300.0
        #define COVER_FULL 600.0
        float covW(vec2 p, vec4 r) { vec2 d = min(p - r.xy, r.zw - p); return smoothstep(0.0, uCovBlend, min(d.x, d.y)); }
        vec2 covUV(vec2 p, vec4 r) { return vec2((p.x - r.x) / (r.z - r.x), (r.w - p.y) / (r.w - r.y)); }
        // forest share (x) blended finest over coarsest, and how much of it is data (y). All three are
        // sampled unconditionally so the mip selection never sits in non-uniform control flow.
        vec2 coverForest(vec2 p) {
          float f0 = texture2D(uCov0, covUV(p, uCovRect[0])).r;
          float f1 = texture2D(uCov1, covUV(p, uCovRect[1])).r;
          float f2 = texture2D(uCov2, covUV(p, uCovRect[2])).r;
          float w0 = covW(p, uCovRect[0]), w1 = covW(p, uCovRect[1]), w2 = covW(p, uCovRect[2]);
          float f = f0 * w0, c = w0;
          f = mix(f, f1, w1); c = mix(c, 1.0, w1);
          f = mix(f, f2, w2); c = mix(c, 1.0, w2);
          return vec2(c > 1e-4 ? f / c : 0.0, c);
        }
        // set in main() before lighting, read by the snow terms in RE_Direct_Physical
        float gSnowW;
        vec3 gGlintN;
        float gGlintW;
        float gWrap;
        // BUG-062: the mogul field at this pixel (amplitude in m after the snow weight and distance fade,
        // bump normal in the world frame, height 0 trough .. 1 crest), set in main() before the normal pass
        float gMogA;
        vec3 gMogN;
        float gMogT;
        float gMogK; // 0..1 mask of the field's strength for the colouring and the lighting tweaks
        ${DEFORM_GLSL}
        ${NOISE_GLSL}
        ${ROCK_GLSL}
        ${MOGUL_GLSL}
        // BUG-062: the mogul field at a point as vec3(height, dh/dx, dh/dy), pack frame and metres: the
        // one place the shader samples it, height and slope in a single evaluation (FEAT-147: rider lines)
        vec3 mogulField(vec2 pxy, vec2 fall, float amp, float creep) { return mogulHG(pxy, fall, amp, creep); }
        float fbm2(vec2 p) { return 0.6 * vnoise(vec3(p, 0.0)) + 0.3 * vnoise(vec3(p * 2.1, 1.7)) + 0.1 * vnoise(vec3(p * 4.3, 3.1)); }
        // corduroy across the fall line. Returns x = ridge profile (-1..1, already faded by distance),
        // y = ridge slope for the bump, zw = the across-slope direction in world xz. Also outputs the
        // groomer pass tone (0..1) and a seam weight.
        const float CORD_FREQ = 3.3;   // ridges per metre
        const float PASS_W = 4.2;      // groomer width, m
        vec4 corduroy(vec3 wp, vec2 fallDir, out float passTone, out float seam) {
          // smoothed downhill direction from the chunk build (length = slope); ridges fade on flats
          float nl = length(fallDir);
          vec2 down = nl > 1e-4 ? fallDir / nl : vec2(0.0, 1.0);
          float conf = mix(0.35, 1.0, smoothstep(0.03, 0.08, nl));
          float a = atan(-down.x, down.y); // angle of the across-slope direction, mod pi below
          a = mod(a, 3.14159265);
          float bin = 3.14159265 / 12.0;
          float k0 = floor(a / bin), t = smoothstep(0.25, 0.75, fract(a / bin));
          vec2 d0 = vec2(cos(k0 * bin), sin(k0 * bin)), d1 = vec2(cos((k0 + 1.0) * bin), sin((k0 + 1.0) * bin));
          float u0 = dot(wp.xz, d0), u1 = dot(wp.xz, d1);
          float u = mix(u0, u1, t);
          // fade as the ridges approach pixel size
          float fw = fwidth(u * CORD_FREQ);
          float aa = (1.0 - smoothstep(0.2, 0.55, fw)) * conf;
          float r0 = sin(u0 * CORD_FREQ * 6.2831853), r1 = sin(u1 * CORD_FREQ * 6.2831853);
          float c0 = cos(u0 * CORD_FREQ * 6.2831853), c1 = cos(u1 * CORD_FREQ * 6.2831853);
          float ridge = mix(r0, r1, t) * aa, slope = mix(c0, c1, t) * aa;
          float pu = u / PASS_W;
          passTone = hash3(vec3(floor(pu), 3.0, 11.0));
          float pf = abs(fract(pu) - 0.5) * 2.0; // 1 at a pass edge
          seam = smoothstep(0.93, 1.0, pf) * (1.0 - smoothstep(0.3, 1.2, fwidth(pu) * 8.0));
          return vec4(ridge, slope, normalize(mix(d0, d1, t)));
        }
        // FEAT-077 skied snow: three families of ski tracks, each a set of sinuous grooves (about 10 cm
        // wide, 2 to 3 cm deep) roughly down the fall line, swinging through turns; about half the slots
        // in each family hold a track, so they cross and break up. Height in -1..0.
        float trackH(vec2 p, vec2 down) {
          vec2 acr = vec2(-down.y, down.x);
          float al = dot(p, down), ac = dot(p, acr), h = 0.0;
          for (int i = 0; i < 3; i++) {
            float fi = float(i);
            float S = 1.3 + 0.55 * fi, A = 1.1 + 0.9 * fi, w = 0.28 - 0.06 * fi;
            float v = ac + A * sin(al * w + fi * 2.1) + 0.7 * vnoise(vec3(p * 0.12, fi * 7.0));
            float on = step(0.45, hash3(vec3(floor(v / S), fi, 5.0)));
            float d = (fract(v / S) - 0.5) * S;
            h -= on * exp(-d * d / 0.003);
          }
          return max(h, -1.0);
        }
        vec2 fallDown(vec2 fallDir) { float nl = length(fallDir); return nl > 1e-4 ? fallDir / nl : vec2(0.0, 1.0); }`)
      .replace('#include <color_fragment>', `
        // class weights from the vertex colour
        float wRockV = vColor.r, wScreeV = vColor.g, wGroom = vColor.b;
        vec3 wp = vWorldPos;
        float dist = length(cameraPosition - wp);
        vec3 ngW = normalize(vWorldNormal);
        // ungroomed snow: large wind-scoured tone, wind ripples (stretched along the prevailing
        // westerly), fine grain
        float wind = fbm2(wp.xz * 0.08 + vec2(wp.y * 0.01, 0.0));
        float ripple = vnoise(vec3(wp.x * 0.35, 0.0, wp.z * 1.6)) * (1.0 - smoothstep(30.0, 140.0, length(cameraPosition - wp)));
        float grain = vnoise(wp * 2.5);
        // FEAT-092: the wind tone is a near-field detail; past a few hundred metres it averages out to an
        // even tone (real snow is evenly toned at distance, shaded only by the terrain), so no blotches
        float windAmt = mix(0.55, 0.1, smoothstep(80.0, 700.0, dist));
        vec3 snow = mix(uSnowShade, uSnow, 1.0 - windAmt + windAmt * wind) * (0.93 + 0.05 * grain + 0.04 * ripple);
        // groomed: clean, even snow with corduroy ridges down the fall line and groomer passes
        float passTone, seam;
        vec4 cd = corduroy(wp, vFall, passTone, seam);
        // FEAT-077: skiing wipes the corduroy out, spring sun softens it
        float cordK = (1.0 - 0.85 * uSkied) * (1.0 - 0.5 * uSpring);
        vec3 groomed = uGroomed * (0.975 + 0.025 * passTone) * (0.97 + 0.03 * cd.x * cordK) * (1.0 - 0.05 * seam * cordK);
        // tracked-out snow is a touch greyer in the grooves; spring snow is wet: warmer and a little darker
        float trackFade = 1.0 - smoothstep(25.0, 70.0, dist);
        float th = uSkied > 0.01 ? trackH(wp.xz, fallDown(vFall)) * trackFade : 0.0;
        groomed *= 1.0 + 0.035 * th * uSkied;
        snow *= 1.0 + 0.03 * th * uSkied;
        vec3 springTint = vec3(0.975, 0.955, 0.925);
        groomed = mix(groomed, groomed * springTint, uSpring);
        snow = mix(snow, snow * springTint, uSpring);
        // rock and talus poke through the snow: the weight is a threshold against multi-scale noise
        // (fine octave fades with distance), with a narrow soft edge that widens far away
        float fineOct = 1.0 - smoothstep(60.0, 300.0, dist);
        float bn = vnoise(wp * 0.09) * 0.5 + vnoise(wp * 0.31 + 3.1) * 0.3 + mix(0.5, vnoise(wp * 1.1 + 7.7), fineOct) * 0.2;
        float edge = 0.025 + 0.1 * smoothstep(150.0, 3000.0, dist);
        vec3 rockN; float rockR;
        vec3 rockAlb = rockSurface(wp, ngW, dist, rockN, rockR);
        // FEAT-105: new snow (uSnowCover 0..1) buries the rock from its edges in: the threshold shifts,
        // so the same noise makes a ragged shrinking edge. Faces steeper than about 55 deg shed it and
        // stay dark; faces looking downwind (uSnowLee) load up more
        float holds = smoothstep(0.5, 0.64, ngW.y);
        float snowShift = uSnowCover * 0.3 * holds * (1.0 + 0.5 * dot(ngW.xz, uSnowLee));
        float rockCov0 = smoothstep(0.5 - edge, 0.5 + edge, wRockV + (bn - 0.5) * 0.6);
        float rockCov = smoothstep(0.5 - edge, 0.5 + edge, wRockV + (bn - 0.5) * 0.6 - snowShift);
        // ledges and benches hold snow: the rock's own detail normal decides, so snow lines its ledges;
        // with new snow the cracks and benches fill first (a lower threshold)
        float ledge = smoothstep(mix(0.8, 0.72, uSnowCover), mix(0.93, 0.85, uSnowCover), rockN.y + (vnoise(wp * 0.6) - 0.5) * 0.12);
        rockCov *= 1.0 - 0.9 * ledge;
        // newly buried rock is fresh snow: brighter, less grain
        float fresh = clamp(rockCov0 - rockCov, 0.0, 1.0);
        snow = mix(snow, vec3(0.97, 0.98, 1.0), 0.7 * fresh);
        vec3 screeN; float screeR;
        vec3 screeAlb = screeSurface(wp, ngW, dist, screeN, screeR);
        float bn2 = vnoise(wp * 0.17 + 11.0) * 0.6 + mix(0.5, vnoise(wp * 0.8 + 5.0), fineOct) * 0.4;
        // winter buries most talus: only part of a full-weight field shows
        float screeCov = smoothstep(0.5 - edge, 0.5 + edge, wScreeV * 0.65 + (bn2 - 0.5) * 0.7 - snowShift) * (1.0 - rockCov);
        rockCov *= 1.0 - uDebugFar.y; screeCov *= 1.0 - uDebugFar.y;
        float wSnow = 1.0 - rockCov - screeCov;
        vec3 base = snow * wSnow + rockAlb * rockCov + screeAlb * screeCov;
        base = mix(base, groomed, wGroom * wSnow);
        // BUG-062: the mogul field, once per pixel (pack frame: x east, y = -world z north), fading out
        // where the 4 to 7 m pattern would shimmer; the colouring rule below, the normal pass reuses it
        gMogA = vMogul.x * uMogulScale * wSnow * (1.0 - smoothstep(900.0, 1600.0, dist));
        gMogN = vec3(0.0, 1.0, 0.0);
        gMogT = 0.5;
        gMogK = smoothstep(0.05, 0.5, gMogA);
        gWrap = uWrap;
        if (gMogA > 0.005) {
          vec2 pxy = vec2(wp.x, -wp.z);
          // FEAT-147: the field's own 30 m downhill vector (pack frame), the slope as its length
          vec2 pf = vMogul.zw;
          vec3 mf = mogulField(pxy, pf, gMogA, uMogulCreep);
          // pack +y is world -z, so the z slope is the negative of the y slope
          gMogN = normalize(vec3(-mf.y, 1.0, mf.z));
          // 0 trough .. 1 crest of a typical bump here (FEAT-147: sized by the slope, the vertex fall's
          // length); the tallest of the +-30% spread clamp
          gMogT = clamp(mf.x / (gMogA * mogulSize(length(pf))), 0.0, 1.0);
          // colouring from the bump's own shape, no shadow pass: the sun term is the bump normal's tilt
          // toward the sun's ground direction (already scaled by cos(elevation), gone in flat light); the
          // downhill term darkens the face that tilts uphill, the front a rider coming down rides into
          float sunK = dot(gMogN.xz, uSunDir.xz) * (1.0 - uFlat);
          float frontK = -dot(gMogN.xz, fallDown(vec2(pf.x, -pf.y)));
          float lum = 1.0 + gMogK * (0.14 * (gMogT - 0.5) + 0.22 * sunK - 0.06 * frontK);
          // troughs and the shaded sides go a little blue (snow in its own shade), crests a touch warm
          float warmth = saturate(0.5 + (gMogT - 0.5) + 0.8 * sunK);
          vec3 hue = mix(vec3(0.955, 0.98, 1.035), vec3(1.015, 1.0, 0.985), warmth);
          base *= lum * mix(vec3(1.0), hue, gMogK);
          // the wrapped sunlight lifts the dark sides; let moguls keep their shade
          gWrap = uWrap * (1.0 - 0.6 * gMogK);
        }
        // FEAT-044: where the snow sags (the window fade and its uv, for the normal below)
        float dFade = 0.0; vec2 dUV = vec2(0.0);
        if (uDeformWin.w > 0.0) { dUV = deformUV(wp.xz); dFade = deformFade(dUV); }
        // glints: about one 4 cm cell in twelve holds a crystal facet tilted at random off the surface;
        // RE_Direct_Physical lights it when it faces the half vector. Gone once cells are sub-pixel.
        vec3 gc = wp * 25.0;
        vec3 gci = floor(gc);
        vec3 gr = vec3(hash3(gci + 11.1), hash3(gci + 23.7), hash3(gci + 37.3)) * 2.0 - 1.0;
        vec3 gn = normalize(normalize(vWorldNormal) + gr * 0.55);
        gGlintN = normalize((viewMatrix * vec4(gn, 0.0)).xyz);
        float gdot = 1.0 - smoothstep(0.12, 0.32, length(fract(gc) - 0.5));
        float gpix = length(fwidth(gc));
        gGlintW = step(0.92, hash3(gci + 5.3)) * gdot * (1.0 - smoothstep(0.35, 1.0, gpix)) * uGlint * (1.0 - uFlat);
        // distant forest: past the instanced trees, forested ground reads as dark conifer green
        // speckled with snow (real distant Colorado slopes are mostly dark timber, not white)
        // FEAT-075: forested ground goes dark from just past the instanced trees' detail (350 m, full by
        // 1 km), not only beyond 2.5 km, so valley forest reads as a dark mass like the photos. The canopy
        // cover is low in the data (BUG-028), so it is lifted; runs and bowls (no canopy) stay white.
        // FEAT-153: past COVER_NEAR the forest comes per pixel from the cover levels (already a share of
        // ground under closed canopy, so only a mild S curve keeps mip-averaged trail edges from greying)
        vec2 cov = coverForest(vec2(wp.x, -wp.z));
        float covK = cov.y * smoothstep(COVER_NEAR, COVER_FULL, dist);
        float forestV = mix(vForest, cov.x, covK);
        float forestK = mix(smoothstep(FOREST_LO, FOREST_HI, vForest), smoothstep(0.1, 0.9, cov.x), covK);
        // FEAT-154: how much of this ground a viewer sees as canopy (a gap fraction). With a share s of the
        // ground under crowns, a sight line at cosine mu to the ground misses the crowns with probability
        // (1 - s)^(1/mu): grazing views (from the snow) see a closed mass, views from above see the openings.
        // Inside the trees' reach the drawn trees already cover rho = uForestDrawn of the canopy, so the
        // ground adds only what they miss, 1 - ((1 - s) / (1 - rho s))^(1/mu); before this the ground went
        // grey under trees that were already drawn, so sparse stands in the bowls read as grey blobs from
        // the air. Outside the pack's tree instances (uTreeRect) nothing is drawn, so there the ground carries
        // the forest from the first metre instead of fading in from FOREST_NEAR.
        vec2 pxyF = vec2(wp.x, -wp.z);
        vec2 trd = min(pxyF - uTreeRect.xy, uTreeRect.zw - pxyF);
        float treeHere = smoothstep(0.0, 300.0, min(trd.x, trd.y));
        float viewMu = clamp(dot(ngW, normalize(cameraPosition - wp)), 0.12, 1.0);
        float rho = uForestDrawn * treeHere * (1.0 - smoothstep(uLiftNear - 800.0, uLiftNear, dist));
        float sK = min(forestK, 0.999);
        float seen = 1.0 - pow((1.0 - sK) / (1.0 - rho * sK), 1.0 / viewMu);
        float fd = mix(1.0, smoothstep(FOREST_NEAR, FOREST_FULL, dist), treeHere) * seen;
        fd *= 1.0 - uDebugFar.x;
        // FEAT-075: conifer canopy in sun is dark (shaded needles and crowns), dark green-black in the photos.
        // FEAT-153: crowns (about 6 m) texture it while a pixel is smaller than a crown and fade to an even
        // tone beyond, with a faint stand-scale variation; no 50 m snow blotches at a distance
        float pixM = length(fwidth(wp));
        float crownK = 1.0 - smoothstep(1.0, 5.0, pixM);
        float crown = vnoise(wp * 0.17) * 0.65 + vnoise(wp * 0.47 + 2.3) * 0.35;
        float stand = vnoise(wp * 0.007 + 5.1);
        vec3 timber = mix(vec3(0.03, 0.045, 0.035), vec3(0.08, 0.1, 0.075), mix(0.4, crown, crownK) * 0.75 + stand * 0.25);
        timber = mix(timber, snow * 0.8, smoothstep(0.62, 0.9, crown) * crownK * 0.6); // snowy gaps between crowns
        base = mix(base, timber, fd * uTimberMix);
        gSnowW = wSnow * (1.0 - fd);
        gGlintW *= wSnow * (1.0 - wGroom * 0.6) * (1.0 - fd) * (1.0 - 0.6 * uSpring); // wet spring snow sparkles less
        diffuseColor.rgb = base;
        if (uDebugFar.w > 0.5) diffuseColor.rgb = mix(vec3(0.9), vec3(0.9, 0.1, 0.1), fd);
        // BUG-062 ?debug=moguls: amplitude as a tint, green where the bumps are in the geometry, red where
        // the shader alone draws them, faint magenta on chunks too coarse for either
        if (uDebugMoguls > 0.5) {
          float ampRaw = vMogul.x * uMogulScale;
          vec3 pathCol = vMogul.y > 1.5 ? vec3(0.1, 0.9, 0.2) : vec3(1.0, 0.25, 0.1);
          diffuseColor.rgb = mix(diffuseColor.rgb, pathCol, 0.8 * smoothstep(0.0, 0.5, ampRaw));
          if (vMogul.y < 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.3, 0.9), 0.2);
        }
      `)
      // snow gets a soft bump so faces lit head-on (south-facing bowls with a southern sun) still show
      // drifts and relief instead of a flat white sheet
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          vec3 wpn = vWorldPos;
          float e = 0.6;
          // drifts (20 m), lumps and old tracks (7 m), wind crust (3 m)
          // FEAT-092: the 20 m drift octave shades into soft cloudy blotches a few hundred metres off, so
          // it fades with distance; the 7 m and 3 m octaves keep the snow textured out there
          float bigK = 1.0 - 0.75 * smoothstep(150.0, 600.0, length(cameraPosition - wpn));
          #define SNOWH(q) (fbm2((q) * 0.05) * 2.0 * bigK + fbm2((q) * 0.14) * 1.1 + fbm2((q) * 0.35) * 0.5)
          float h0 = SNOWH(wpn.xz);
          float hx = SNOWH(wpn.xz + vec2(e, 0.0));
          float hz = SNOWH(wpn.xz + vec2(0.0, e));
          vec3 bump = normalize(vec3(-(hx - h0) / e, 1.0, -(hz - h0) / e));
          float snowW = wSnow;
          float gW = vColor.b * snowW;
          // drift relief: strong on ungroomed snow, almost flat on a groomer
          float wS = snowW * (1.0 - 0.85 * vColor.b);
          vec3 wn = normalize(vWorldNormal);
          vec3 t = normalize(cross(wn, vec3(0.0, 0.0, 1.0)));
          vec3 b = cross(wn, t);
          vec3 pn = normalize(t * bump.x + wn * bump.y + b * bump.z);
          vec3 nn = normalize(mix(wn, pn, 0.8 * wS * (1.0 - uDebugFar.z)));
          // corduroy ridges tilt the normal across the fall line (about 1 cm high, 30 cm apart)
          float pT, sm;
          vec4 cdn = corduroy(wpn, vFall, pT, sm);
          vec3 acrossW = normalize(vec3(cdn.z, 0.0, cdn.w) - wn * dot(vec3(cdn.z, 0.0, cdn.w), wn));
          nn = normalize(nn - acrossW * cdn.y * 0.15 * gW * (1.0 - 0.85 * uSkied) * (1.0 - 0.5 * uSpring));
          // FEAT-077: ski tracks dent every skied surface; chop (lumpy, cut-up powder) roughens the
          // ungroomed snow, less in spring when it has melted smooth
          if (uSkied > 0.01) {
            float tf = 1.0 - smoothstep(25.0, 70.0, length(cameraPosition - wpn));
            vec2 dn = fallDown(vFall);
            float et = 0.04;
            float t0 = trackH(wpn.xz, dn), tx = trackH(wpn.xz + vec2(et, 0.0), dn), tz = trackH(wpn.xz + vec2(0.0, et), dn);
            float depth = 0.025 * uSkied * tf * snowW;
            vec3 tb = vec3(-(tx - t0) / et * depth, 1.0, -(tz - t0) / et * depth);
            nn = normalize(t * tb.x + nn * tb.y + b * tb.z);
            float ec = 0.2;
            #define CHOPH(q) (fbm2((q) * 0.9) * 0.35 + fbm2((q) * 2.2) * 0.15)
            float c0 = CHOPH(wpn.xz), cx = CHOPH(wpn.xz + vec2(ec, 0.0)), cz = CHOPH(wpn.xz + vec2(0.0, ec));
            float chop = uSkied * (1.0 - 0.7 * uSpring) * wS * (1.0 - smoothstep(40.0, 120.0, length(cameraPosition - wpn)));
            vec3 cb = normalize(vec3(-(cx - c0) / ec, 1.0, -(cz - c0) / ec));
            nn = normalize(mix(nn, normalize(t * cb.x + nn * cb.y + b * cb.z), 0.6 * chop));
          }
          // FEAT-044: the sag's slope tilts the normal (the vertex normals do not see the displacement)
          if (dFade > 0.0) {
            vec2 slope = deformSagSlope(dUV) * dFade * snowW;
            nn = normalize(vec3(nn.x - slope.x, nn.y, nn.z - slope.y));
          }
          // FEAT-059 / BUG-062: the mogul bump normal from the colour pass, on every shaded chunk (the
          // finest ones carry the bumps as geometry too, with base-surface vertex normals)
          if (gMogA > 0.005) nn = normalize(t * gMogN.x + nn * gMogN.y + b * gMogN.z);
          // rock and talus carry their own photo normals
          nn = normalize(nn * max(wSnow, 1e-3) + rockN * rockCov + screeN * screeCov);
          // flat light: under overcast the eye loses the snow's shape; pull snow normals toward up
          // (much less on moguls, BUG-062, so the bumps keep some shape to ride by)
          nn = normalize(mix(nn, vec3(0.0, 1.0, 0.0), 0.6 * uFlat * snowW * (1.0 - 0.6 * gMogK)));
          normal = normalize((viewMatrix * vec4(nn, 0.0)).xyz);
        }`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        {
          // baked sky visibility with a contrast curve (most of the snow's light is direct sun, so
          // occluding only the sky fill barely shows), faded out before the chunks that carry no AO
          // (coarser than 32 m, beyond ~5 km); plus shade under the canopy (tree wells) near the trees
          float aoK = uAO * (1.0 - smoothstep(3500.0, 5000.0, dist));
          // FEAT-092: a steeper curve so gullies read in depth (was pow 1.8)
          float aoT = mix(1.0, pow(vAO, AO_POW), aoK) * (1.0 - 0.28 * forestV * (1.0 - fd));
          reflectedLight.indirectDiffuse *= aoT * mix(vec3(1.0), uShadeTint, wSnow * (1.0 - 0.6 * uFlat));
          reflectedLight.indirectSpecular *= aoT;
          // gullies and couloirs read in depth in sun too, and it stands in for self-shadowing past the shadow maps
          reflectedLight.directDiffuse *= mix(1.0, aoT, AO_DIRECT);
          // FEAT-154: sunlit canopy is mostly shaded needles and the shadow sides of crowns, so the forest
          // takes a fraction of the sun the bare slope would (without it sunlit timber read mid grey)
          reflectedLight.directDiffuse *= mix(1.0, uCanopySun, fd);
        }`)
      .replace('#include <roughnessmap_fragment>', `
        // flat light: no sheen toward a sun hidden behind cloud, so the snow goes fully rough
        float roughnessFactor = roughness * mix(0.6, 1.1, uFlat) * wSnow + rockR * rockCov + screeR * screeCov;
        roughnessFactor = mix(roughnessFactor, 1.0, fd); // FEAT-075: canopy has no snow sheen`);
  };
  return mat;
}
