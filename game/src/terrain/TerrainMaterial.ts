import * as THREE from 'three';

/**
 * Snow / rock / scree / groomed material. Per-vertex class weights arrive in the color attribute
 * (r = rock, g = scree or meadow, b = groomed). Detail comes from world-space procedural noise
 * so there are no texture seams between LOD chunks.
 *
 * Groomed vs ungroomed: groomers are smooth, clean snow with corduroy ridges (about 30 cm apart)
 * running down the fall line, lit as small bumps, in groomer-width passes with faint seams; the
 * ridges fade out with distance so they never shimmer. Ungroomed snow (bowls, glades) keeps the
 * stronger drift relief plus wind ripples and more tonal variation. The fall line comes from the
 * normal; stripes use 12 fixed world directions, blending the two nearest the local fall line, so
 * they stay put on the snow instead of swimming as the slope curves.
 *
 * Snow lighting (FEAT-047): sunlight wraps past the terminator as a blue subsurface glow (light
 * scattered inside the snowpack); shaded snow takes a cool blue tint from the sky; the sun glints
 * off individual crystals (a random facet normal per 4 cm cell lights up when it lines up with the
 * half vector, fading out once cells shrink below a pixel); baked sky visibility from the pack (`ao`
 * attribute) darkens gullies, couloirs and cliff feet, and the canopy darkens the snow under trees.
 * `uFlat` (storm) flattens the snow relief and turns the glints off: flat light.
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
	float wrapNL = saturate( ( dotNLr + uWrap ) / ( 1.0 + uWrap ) );
	vec3 snowIrr = irradiance + max( wrapNL - dotNL, 0.0 ) * gSnowW * uSSS * directLight.color;
	// crystal glints: this pixel's facet catches the sun when it lines up with the half vector
	float glint = pow( saturate( dot( gGlintN, normalize( directLight.direction + geometryViewDir ) ) ), 700.0 );
	reflectedLight.directSpecular += directLight.color * ( gGlintW * glint * 9.0 * dotNL );`)
    .replace(b, `reflectedLight.directDiffuse += snowIrr * BRDF_Lambert( material.diffuseColor );`);
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
    uRock: { value: new THREE.Color(0.36, 0.33, 0.30) },
    uScree: { value: new THREE.Color(0.55, 0.53, 0.50) },
    uGroomed: { value: new THREE.Color(0.97, 0.98, 1.0) },
    /** sky fill on shaded snow: cool blue, not grey */
    uShadeTint: { value: new THREE.Color(0.80, 0.93, 1.22) },
    /** subsurface colour of the wrapped sunlight */
    uSSS: { value: new THREE.Color(0.30, 0.48, 0.80) },
    uWrap: { value: 0.45 },
    uGlint: { value: 1.0 },
    uFlat: { value: 0.0 },
    /** baked AO strength (1 = as baked; debug A/B with 0) */
    uAO: { value: 1.0 },
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
        varying float vAO;
        varying float vForest;
        varying vec2 vFall;
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
        vFall = fall;
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
        uniform float uTime;
        uniform vec3 uSnow, uSnowShade, uRock, uScree, uGroomed, uShadeTint, uSSS;
        uniform float uWrap, uGlint, uFlat, uAO;
        // set in main() before lighting, read by the snow terms in RE_Direct_Physical
        float gSnowW;
        vec3 gGlintN;
        float gGlintW;
        // cheap value noise
        float hash3(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float vnoise(vec3 x) {
          vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
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
        }`)
      .replace('#include <color_fragment>', `
        // class weights from the vertex colour
        float wRock = vColor.r, wScree = vColor.g, wGroom = vColor.b;
        float wSnow = clamp(1.0 - wRock - wScree, 0.0, 1.0);
        vec3 wp = vWorldPos;
        // ungroomed snow: large wind-scoured tone, wind ripples (stretched along the prevailing
        // westerly), fine grain
        float wind = fbm2(wp.xz * 0.08 + vec2(wp.y * 0.01, 0.0));
        float ripple = vnoise(vec3(wp.x * 0.35, 0.0, wp.z * 1.6)) * (1.0 - smoothstep(30.0, 140.0, length(cameraPosition - wp)));
        float grain = vnoise(wp * 2.5);
        vec3 snow = mix(uSnowShade, uSnow, 0.45 + 0.55 * wind) * (0.93 + 0.05 * grain + 0.04 * ripple);
        // groomed: clean, even snow with corduroy ridges down the fall line and groomer passes
        float passTone, seam;
        vec4 cd = corduroy(wp, vFall, passTone, seam);
        vec3 groomed = uGroomed * (0.975 + 0.025 * passTone) * (0.97 + 0.03 * cd.x) * (1.0 - 0.05 * seam);
        // rock: strata noise
        float strata = fbm2(vec2(wp.y * 0.35, (wp.x + wp.z) * 0.05));
        vec3 rock = uRock * (0.7 + 0.6 * strata);
        vec3 scree = uScree * (0.8 + 0.4 * vnoise(wp * 1.3));
        vec3 base = snow * wSnow + rock * wRock + scree * wScree;
        base = mix(base, groomed, wGroom * wSnow);
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
        float dist = length(cameraPosition - wp);
        float fd = smoothstep(2500.0, 6000.0, dist) * vForest;
        float speck = vnoise(wp * 0.02) * 0.6 + vnoise(wp * 0.11) * 0.4;
        vec3 timber = mix(vec3(0.06, 0.08, 0.06), vec3(0.14, 0.16, 0.13), speck);
        timber = mix(timber, snow * 0.8, smoothstep(0.62, 0.9, speck) * 0.6); // snowy gaps between crowns
        base = mix(base, timber, fd * 0.9);
        gSnowW = wSnow * (1.0 - fd);
        gGlintW *= wSnow * (1.0 - wGroom * 0.6) * (1.0 - fd);
        diffuseColor.rgb = base;
        float rough = mix(0.55, 0.95, wRock + wScree);
      `)
      // snow gets a soft bump so faces lit head-on (south-facing bowls with a southern sun) still show
      // drifts and relief instead of a flat white sheet
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          vec3 wpn = vWorldPos;
          float e = 0.6;
          // drifts (20 m), lumps and old tracks (7 m), wind crust (3 m)
          #define SNOWH(q) (fbm2((q) * 0.05) * 2.0 + fbm2((q) * 0.14) * 1.1 + fbm2((q) * 0.35) * 0.5)
          float h0 = SNOWH(wpn.xz);
          float hx = SNOWH(wpn.xz + vec2(e, 0.0));
          float hz = SNOWH(wpn.xz + vec2(0.0, e));
          vec3 bump = normalize(vec3(-(hx - h0) / e, 1.0, -(hz - h0) / e));
          float snowW = clamp(1.0 - vColor.r - vColor.g, 0.0, 1.0);
          float gW = vColor.b * snowW;
          // drift relief: strong on ungroomed snow, almost flat on a groomer
          float wS = snowW * (1.0 - 0.85 * vColor.b);
          vec3 wn = normalize(vWorldNormal);
          vec3 t = normalize(cross(wn, vec3(0.0, 0.0, 1.0)));
          vec3 b = cross(wn, t);
          vec3 pn = normalize(t * bump.x + wn * bump.y + b * bump.z);
          vec3 nn = normalize(mix(wn, pn, 0.8 * wS));
          // corduroy ridges tilt the normal across the fall line (about 1 cm high, 30 cm apart)
          float pT, sm;
          vec4 cdn = corduroy(wpn, vFall, pT, sm);
          vec3 acrossW = normalize(vec3(cdn.z, 0.0, cdn.w) - wn * dot(vec3(cdn.z, 0.0, cdn.w), wn));
          nn = normalize(nn - acrossW * cdn.y * 0.15 * gW);
          // flat light: under overcast the eye loses the snow's shape; pull snow normals toward up
          nn = normalize(mix(nn, vec3(0.0, 1.0, 0.0), 0.6 * uFlat * snowW));
          normal = normalize((viewMatrix * vec4(nn, 0.0)).xyz);
        }`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        {
          // baked sky visibility with a contrast curve (most of the snow's light is direct sun, so
          // occluding only the sky fill barely shows), faded out before the chunks that carry no AO
          // (coarser than 32 m, beyond ~5 km); plus shade under the canopy (tree wells) near the trees
          float aoK = uAO * (1.0 - smoothstep(3500.0, 5000.0, dist));
          float aoT = mix(1.0, pow(vAO, 1.8), aoK) * (1.0 - 0.28 * vForest * (1.0 - fd));
          reflectedLight.indirectDiffuse *= aoT * mix(vec3(1.0), uShadeTint, wSnow * (1.0 - 0.6 * uFlat));
          reflectedLight.indirectSpecular *= aoT;
          // gullies and couloirs read in depth in sun too, and it stands in for self-shadowing past the shadow maps
          reflectedLight.directDiffuse *= mix(1.0, aoT, 0.45);
        }`)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness * mix(0.6, 1.0, clamp(vColor.r + vColor.g, 0.0, 1.0));`);
  };
  return mat;
}
