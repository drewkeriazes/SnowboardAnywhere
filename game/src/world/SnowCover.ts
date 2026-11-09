import * as THREE from 'three';

/**
 * FEAT-152: the rider set down into deep powder. When the loose snow (`rider.snow.depth`) is BURY_DEPTH
 * (6 in) or deeper, RiderView draws the board, the bindings and the boots lowered into it, and every
 * rider material gets a snow-cover term from here: a fragment below the untouched snow surface (a plane
 * through the snow under the rider, along the ground normal) turns to snow, with a soft, noisy edge a
 * few cm either side of it, so the gear fades into the powder instead of being sliced by the terrain.
 * The terrain itself hides what is deeper. Off (k = 0) the materials draw exactly as before.
 */

/** the loose snow depth (m) from which the board and boots set down into it (6 in), and over how much more it comes all the way in */
export const BURY_DEPTH = 0.15, BURY_RAMP = 0.02;

/** 0 under BURY_DEPTH of loose snow, 1 from BURY_DEPTH + BURY_RAMP */
export function buryGate(depth: number): number {
  const t = Math.max(0, Math.min(1, (depth - BURY_DEPTH) / BURY_RAMP));
  return t * t * (3 - 2 * t);
}

/** the snow-cover albedo: the terrain's typical snow (Tracks' SNOW_RGB, BUG-021) */
const SNOW = [0.83, 0.86, 0.94];
/** the cover's edge: snow from EDGE_LO m below the surface, none from EDGE_HI above it, the noise moving it by up to +-EDGE_NOISE / 2 */
const EDGE_LO = -0.02, EDGE_HI = 0.04, EDGE_NOISE = 0.06;

export interface SnowCoverUniforms {
  /** a point on the untouched snow surface under the rider (three.js world) */
  uSnowOrigin: { value: THREE.Vector3 };
  /** the snow surface's normal there (three.js, unit) */
  uSnowN: { value: THREE.Vector3 };
  /** 0..1 how much the cover applies (0 = off) */
  uSnowCoverK: { value: number };
}

export function snowCoverUniforms(): SnowCoverUniforms {
  return { uSnowOrigin: { value: new THREE.Vector3() }, uSnowN: { value: new THREE.Vector3(0, 1, 0) }, uSnowCoverK: { value: 0 } };
}

const VERT_HEAD = /* glsl */ `
  uniform vec3 uSnowOrigin;
  varying vec3 vSnowRel;
`;
// after skinning and the board's bend, `transformed` is the final object-space position; the offset
// from the origin is taken here so the fragment's noise keeps its precision far from the pack origin
const VERT_BODY = /* glsl */ `
  vSnowRel = (modelMatrix * vec4(transformed, 1.0)).xyz - uSnowOrigin;
`;
const FRAG_HEAD = /* glsl */ `
  uniform vec3 uSnowN;
  uniform float uSnowCoverK;
  varying vec3 vSnowRel;
  float snowCoverHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float snowCoverNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(snowCoverHash(i), snowCoverHash(i + vec3(1, 0, 0)), f.x), mix(snowCoverHash(i + vec3(0, 1, 0)), snowCoverHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(snowCoverHash(i + vec3(0, 0, 1)), snowCoverHash(i + vec3(1, 0, 1)), f.x), mix(snowCoverHash(i + vec3(0, 1, 1)), snowCoverHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  // 0..1 snow over this fragment: under the surface it is snow, a few cm above it clumps of it
  float snowCoverAt() {
    if (uSnowCoverK <= 0.0) return 0.0;
    float h = dot(uSnowN, vSnowRel);
    float n = 0.65 * snowCoverNoise(vSnowRel * 22.0) + 0.35 * snowCoverNoise(vSnowRel * 57.0);
    return uSnowCoverK * (1.0 - smoothstep(${EDGE_LO.toFixed(3)}, ${EDGE_HI.toFixed(3)}, h + (n - 0.5) * ${EDGE_NOISE.toFixed(3)}));
  }
`;

/**
 * Add the snow cover to a MeshStandardMaterial: below the surface its colour, roughness, metalness and
 * normal become the snow's, so it is lit like the snow around it. `u` is shared by all of one rider's materials.
 */
export function addSnowCover(mat: THREE.MeshStandardMaterial, u: SnowCoverUniforms): void {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = VERT_HEAD + shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);
    shader.fragmentShader = FRAG_HEAD + shader.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        float snowCov = snowCoverAt();
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${SNOW.map((c) => c.toFixed(2)).join(', ')}), snowCov);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.9, snowCov);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = mix(metalnessFactor, 0.0, snowCov);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n if (snowCov > 0.0) normal = normalize(mix(normal, normalize((viewMatrix * vec4(uSnowN, 0.0)).xyz), snowCov));');
  };
  mat.customProgramCacheKey = () => 'snowcover';
  mat.needsUpdate = true;
}
