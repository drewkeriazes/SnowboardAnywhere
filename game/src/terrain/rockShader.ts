import * as THREE from 'three';

/**
 * Shared rock and talus shading (FEAT-020) for the terrain and the instanced rocks, so outcrop
 * meshes and the rock patches on the ground read as one material.
 *
 * Textures: CC0 ambientCG sets prepared by game/tools/prep_textures.py (DATA-005). Albedo is
 * normalised to a mean linear luminance of TEX_MEAN, so `tint / TEX_MEAN` sets the final tone;
 * `_nrm` packs the OpenGL normal x, y in R, G and roughness in B.
 *
 * Cliff rock is triplanar with tangent frames built per projection, so the normal map lights
 * correctly on every face and the photo's layering runs horizontally on cliff faces. Talus is
 * projected from above (it only lies on slopes below its angle of repose). Lichen patches and
 * dark water streaks vary the tone at mid distance; far away the detail fades to the mean colour
 * so the tiling never shows on distant faces.
 */
const TEX_MEAN = 0.35;

export interface RockUniforms {
  uRockAlb: { value: THREE.Texture };
  uRockNrm: { value: THREE.Texture };
  uScreeAlb: { value: THREE.Texture };
  uScreeNrm: { value: THREE.Texture };
  uRockTint: { value: THREE.Color };
  uScreeTint: { value: THREE.Color };
}

let shared: RockUniforms | null = null;

function placeholder(r: number, g: number, b: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** One set of rock uniforms for every material; the textures stream in and swap in place. */
export function rockUniforms(): RockUniforms {
  if (shared) return shared;
  // placeholders: mean grey albedo and a flat normal until the JPEGs arrive
  const grey = Math.round(Math.pow(TEX_MEAN, 1 / 2.2) * 255);
  const u: RockUniforms = {
    uRockAlb: { value: placeholder(grey, grey, grey, true) },
    uRockNrm: { value: placeholder(128, 128, 200, false) },
    uScreeAlb: { value: placeholder(grey, grey, grey, true) },
    uScreeNrm: { value: placeholder(128, 128, 140, false) },
    // Gore Range gneiss and granite: cool mid-to-dark grey, far darker than snow
    uRockTint: { value: new THREE.Color(0.135, 0.14, 0.15) },
    uScreeTint: { value: new THREE.Color(0.17, 0.172, 0.18) },
  };
  const loader = new THREE.TextureLoader();
  const load = (file: string, srgb: boolean, slot: { value: THREE.Texture }) => {
    loader.load(`${import.meta.env.BASE_URL}textures/${file}`, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.needsUpdate = true;
      slot.value = t;
    }, undefined, () => console.warn(`rock texture ${file} failed to load; using flat grey`));
  };
  load('rock_albedo.jpg', true, u.uRockAlb);
  load('rock_nrm.jpg', false, u.uRockNrm);
  load('scree_albedo.jpg', true, u.uScreeAlb);
  load('scree_nrm.jpg', false, u.uScreeNrm);
  shared = u;
  return u;
}

/** Cheap value noise for the fragment shader's global scope: hash3(vec3), vnoise(vec3) in 0..1. */
export const NOISE_GLSL = /* glsl */ `
  float hash3(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
`;

/**
 * GLSL for the fragment shader's global scope. Needs NOISE_GLSL declared before it.
 * rockSurface(): cliff rock at world position `wp` with geometric world normal `ng`, `dist` metres
 * from the camera. Returns albedo; writes the world-space detail normal and roughness.
 * screeSurface(): talus, projected from above.
 */
export const ROCK_GLSL = /* glsl */ `
  uniform sampler2D uRockAlb, uRockNrm, uScreeAlb, uScreeNrm;
  uniform vec3 uRockTint, uScreeTint;
  const float ROCK_TEX_MEAN = ${TEX_MEAN.toFixed(3)};
  vec3 unpackNrm(vec4 t) { vec2 xy = t.rg * 2.0 - 1.0; return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy)))); }
  vec3 rockSurface(vec3 wp, vec3 ng, float dist, out vec3 nW, out float rough) {
    float sc = 1.0 / 5.5; // one texture repeat per 5.5 m of cliff
    vec3 w = pow(abs(ng), vec3(4.0)); w /= (w.x + w.y + w.z);
    vec3 s = vec3(ng.x >= 0.0 ? 1.0 : -1.0, ng.y >= 0.0 ? 1.0 : -1.0, ng.z >= 0.0 ? 1.0 : -1.0);
    // tangent frames: X face T = (0,0,-sx), B = +y; Y face T = (sy,0,0), B = -z; Z face T = (sz,0,0), B = +y
    vec2 uvX = vec2(-wp.z * s.x, wp.y) * sc, uvY = vec2(wp.x * s.y, -wp.z) * sc, uvZ = vec2(wp.x * s.z, wp.y) * sc;
    // offset the projections so the three planes do not repeat the same patch at a corner
    uvY += vec2(0.37, 0.71); uvZ += vec2(0.53, 0.19);
    vec3 aX = texture2D(uRockAlb, uvX).rgb, aY = texture2D(uRockAlb, uvY).rgb, aZ = texture2D(uRockAlb, uvZ).rgb;
    vec4 tX = texture2D(uRockNrm, uvX), tY = texture2D(uRockNrm, uvY), tZ = texture2D(uRockNrm, uvZ);
    vec3 nX = unpackNrm(tX), nY = unpackNrm(tY), nZ = unpackNrm(tZ);
    vec3 pert = w.x * vec3(0.0, nX.y, -s.x * nX.x) + w.y * vec3(s.y * nY.x, 0.0, -nY.y) + w.z * vec3(s.z * nZ.x, nZ.y, 0.0);
    float near = 1.0 - smoothstep(180.0, 900.0, dist);
    nW = normalize(ng + pert * 1.15 * near);
    rough = mix(0.85, 0.55 + 0.45 * (w.x * tX.b + w.y * tY.b + w.z * tZ.b), near);
    vec3 alb = (w.x * aX + w.y * aY + w.z * aZ) / ROCK_TEX_MEAN;
    alb = mix(vec3(1.0), alb, 0.25 + 0.75 * near);
    // macro variation that survives distance: strata bands that follow the slope, lichen, water streaks
    float strata = vnoise(vec3(wp.x * 0.02, wp.y * 0.45 + vnoise(wp * 0.05) * 3.0, wp.z * 0.02));
    float lichen = smoothstep(0.58, 0.78, vnoise(wp * 0.35 + 7.3)) * smoothstep(0.3, 0.6, vnoise(wp * 1.7));
    float streak = smoothstep(0.55, 0.85, vnoise(vec3(wp.x * 1.3, wp.y * 0.06, wp.z * 1.3))) * (1.0 - w.y);
    vec3 tone = uRockTint * (0.8 + 0.4 * strata);
    tone = mix(tone, tone * vec3(1.25, 1.22, 0.95), lichen * 0.6);
    tone *= 1.0 - 0.45 * streak;
    return alb * tone;
  }
  vec3 screeSurface(vec3 wp, vec3 ng, float dist, out vec3 nW, out float rough) {
    vec2 uv = vec2(wp.x, -wp.z) / 3.2;
    vec3 a = texture2D(uScreeAlb, uv).rgb;
    vec4 t = texture2D(uScreeNrm, uv);
    vec3 n = unpackNrm(t);
    float near = 1.0 - smoothstep(120.0, 600.0, dist);
    vec3 t0 = normalize(vec3(1.0, 0.0, 0.0) - ng * ng.x), b0 = normalize(cross(ng, t0));
    // b0 points toward -z on flat ground, matching the texture's v = -z
    nW = normalize(ng + (t0 * n.x + b0 * n.y) * 1.2 * near);
    rough = mix(0.9, 0.5 + 0.5 * t.b, near);
    vec3 alb = mix(vec3(1.0), a / ROCK_TEX_MEAN, 0.3 + 0.7 * near);
    return alb * uScreeTint * (0.85 + 0.3 * vnoise(wp * 0.15));
  }
`;
