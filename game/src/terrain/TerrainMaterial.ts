import * as THREE from 'three';

/**
 * Snow / rock / scree / groomed material. Per-vertex class weights arrive in the color attribute
 * (r = rock, g = scree or meadow, b = groomed). Detail comes from world-space procedural noise
 * so there are no texture seams between LOD chunks.
 */
export function createTerrainMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.0,
    flatShading: false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uSnow = { value: new THREE.Color(0.93, 0.95, 1.0) };
    shader.uniforms.uSnowShade = { value: new THREE.Color(0.72, 0.80, 0.96) };
    shader.uniforms.uRock = { value: new THREE.Color(0.36, 0.33, 0.30) };
    shader.uniforms.uScree = { value: new THREE.Color(0.55, 0.53, 0.50) };
    shader.uniforms.uGroomed = { value: new THREE.Color(0.97, 0.98, 1.0) };
    (mat as any).userData.shader = shader;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        uniform float uTime;
        uniform vec3 uSnow, uSnowShade, uRock, uScree, uGroomed;
        // cheap value noise
        float hash3(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float vnoise(vec3 x) {
          vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        float fbm2(vec2 p) { return 0.6 * vnoise(vec3(p, 0.0)) + 0.3 * vnoise(vec3(p * 2.1, 1.7)) + 0.1 * vnoise(vec3(p * 4.3, 3.1)); }`)
      .replace('#include <color_fragment>', `
        // class weights from the vertex colour
        float wRock = vColor.r, wScree = vColor.g, wGroom = vColor.b;
        float wSnow = clamp(1.0 - wRock - wScree, 0.0, 1.0);
        vec3 wp = vWorldPos;
        // snow: soft large-scale wind texture + fine grain
        float wind = fbm2(wp.xz * 0.08 + vec2(wp.y * 0.01, 0.0));
        float grain = vnoise(wp * 2.5);
        vec3 snow = mix(uSnowShade, uSnow, 0.55 + 0.45 * wind) * (0.94 + 0.06 * grain);
        // groomed: corduroy stripes along the fall line (approximate: along world x/z blend)
        float cord = 0.5 + 0.5 * sin((wp.x * 0.7 + wp.z * 0.7) * 6.2831 * 1.2);
        vec3 groomed = uGroomed * (0.95 + 0.05 * cord);
        // rock: strata noise
        float strata = fbm2(vec2(wp.y * 0.35, (wp.x + wp.z) * 0.05));
        vec3 rock = uRock * (0.7 + 0.6 * strata);
        vec3 scree = uScree * (0.8 + 0.4 * vnoise(wp * 1.3));
        vec3 base = snow * wSnow + rock * wRock + scree * wScree;
        base = mix(base, groomed, wGroom * wSnow);
        // snow is bright on sunlit faces: handled by lighting; add subtle sparkle facing the camera
        vec3 vdir = normalize(cameraPosition - wp);
        float spark = pow(vnoise(wp * 40.0 + vdir * 3.0), 18.0) * wSnow * 1.5;
        diffuseColor.rgb = base + spark;
        float rough = mix(0.55, 0.95, wRock + wScree);
      `)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness * mix(0.6, 1.0, clamp(vColor.r + vColor.g, 0.0, 1.0));`);
  };
  return mat;
}
