import * as THREE from 'three';

import { PLANE_SPEED } from '../sim/Rider';
import { SNOW_ALBEDO } from './snowLook';

/**
 * FEAT-152: the rider set down into loose snow. From BURY_FROM of loose snow (`rider.snow.depth`), all
 * in by BURY_FULL, RiderView draws the board tail-low and nose-up in it (`buryShape`): the tail sinks
 * with the depth, less as the board planes, and the nose floats near the surface, until slow in deep
 * snow the nose dig (`noseSink`) takes it down too. Every rider material gets a snow-cover term from
 * here: a fragment below the untouched snow surface (a plane through the snow under the rider, along
 * the ground normal) turns to snow, with a soft, noisy edge a few cm either side of it, so the gear fades
 * into the snow instead of being sliced by the terrain. The terrain itself hides what is deeper. Off
 * (k = 0) the materials draw exactly as before: on the groomers (2.5 cm loose), ice and rock.
 */

/** the loose snow depth (m) from which the board sets down into it (2 in: over a groomer's 2.5 cm and
 *  under slush and chop), and the depth it is all in by (4 in: any powder, 12 cm or more) */
export const BURY_FROM = 0.05, BURY_FULL = 0.1;

/** 0 under BURY_FROM of loose snow, 1 from BURY_FULL */
export function buryGate(depth: number): number {
  const t = Math.max(0, Math.min(1, (depth - BURY_FROM) / (BURY_FULL - BURY_FROM)));
  return t * t * (3 - 2 * t);
}

/** the tail's depth as a share of the loose depth when slow and by PLANE_SPEED (planing from TAIL_PLANE_FROM
 *  m/s), no more than TAIL_FAST m by TAIL_FAST_SPEED m/s, and never past TAIL_MAX of the depth */
const TAIL_SLOW = 0.8, TAIL_PLANED = 0.45, TAIL_PLANE_FROM = 3, TAIL_FAST = 0.04, TAIL_FAST_SPEED = 22, TAIL_MAX = 0.9;
/** the nose's depth as a share of the loose depth when slow (none once planing), the nose-down pitch
 *  (rad) a full nose dig takes it to past the tail, and the most the board pitches nose-up (rad) */
const NOSE_SLOW = 0.1, NOSE_DIG = 3 * Math.PI / 180, PITCH_MAX = 12 * Math.PI / 180;

export interface BuryShape {
  /** the board's middle below the snow surface (m) */
  sink: number;
  /** nose-up pitch (rad; negative nose down) */
  pitch: number;
  /** the tail and the nose below the surface (m; the nose can be above it, negative) */
  tail: number; nose: number;
}

const ss = (a: number, b: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Where the board sits in `depth` m of loose snow at `speed` m/s with the nose dig `dig` (0..1,
 * `rider.noseSink`), the board `half` m from its middle to each end. Tail low, nose up: the tail sinks
 * (TAIL_SLOW of the depth slow, TAIL_PLANED by PLANE_SPEED, a few cm at speed) and the nose floats
 * (NOSE_SLOW of the depth slow, at the surface planing); slow, the nose dig takes the nose down to the
 * tail and past it.
 */
export function buryShape(depth: number, speed: number, dig: number, half: number, out: BuryShape): BuryShape {
  const g = buryGate(depth);
  if (g <= 0) { out.sink = out.pitch = out.tail = out.nose = 0; return out; }
  const planing = ss(TAIL_PLANE_FROM, PLANE_SPEED, speed);
  let tail = depth * (TAIL_SLOW + (TAIL_PLANED - TAIL_SLOW) * planing);
  tail += (Math.min(tail, TAIL_FAST) - tail) * ss(PLANE_SPEED, TAIL_FAST_SPEED, speed);
  tail = Math.min(tail, TAIL_MAX * depth);
  let nose = depth * NOSE_SLOW * (1 - planing);
  nose += (Math.min(tail + 2 * half * Math.sin(NOSE_DIG), TAIL_MAX * depth) - nose) * Math.max(0, Math.min(1, dig));
  nose = Math.max(nose, tail - 2 * half * Math.sin(PITCH_MAX)); // no steeper than PITCH_MAX
  out.tail = g * tail; out.nose = g * nose;
  out.sink = (out.tail + out.nose) / 2;
  out.pitch = Math.asin((out.tail - out.nose) / (2 * half));
  return out;
}

/** the snow-cover albedo: the terrain's typical snow (BUG-021) */
const SNOW = SNOW_ALBEDO;
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
