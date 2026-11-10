import * as THREE from 'three';
import { treeFadeUniforms, TREE_FADE_VERT, TREE_FADE_FRAG_HEAD, TREE_FADE_FRAG_BODY } from '../TreeFade';
import { treeSnowUniforms, TREE_SNOW_VERT, TREE_SNOW_COMMON, TREE_SNOW_LIGHT } from './snow';

/**
 * FEAT-156: the tree kit's materials. Each LOD draws only inside its distance band (measured from the
 * camera to the tree's base, `uLodCam`, so the shadow pass uses the same distance) and crossfades with
 * its neighbour by a screen-door dither: at an edge the outgoing LOD keeps the Bayer cells under its
 * visibility and the incoming one keeps the rest, so the two together cover the tree once. Instances
 * outside the band collapse in the vertex shader. Shadows switch at the middle of each edge.
 *
 * LOD0 and LOD1 are MeshStandardMaterial (lit, CSM shadows, FEAT-155 see-through fade) with the atlas,
 * vertex colours and an alpha cutoff; back faces keep the bent crown normals instead of flipping them.
 * LOD2 (crossed quads) and the impostor billboards are one ShaderMaterial each: albedo and normal
 * atlases baked from LOD0, lit here like the standard material (Lambert sun plus the hemisphere light),
 * so colour holds across the swap at any time of day.
 *
 * FEAT-157: every one of them draws the snow on the trees (snow.ts): the mesh LODs per fragment, the
 * far ones from a snow mask baked from LOD0 at three loads; and the needles' fill and translucency.
 */

export const kitUniforms = {
  uLodCam: { value: new THREE.Vector3() },
  uWindTime: { value: 0 },
};

/** (fade-in start, fade-in end, fade-out start, fade-out end), metres from the camera */
export type Band = { value: THREE.Vector4 };
export const newBand = (): Band => ({ value: new THREE.Vector4(-2, -1, 1e8, 1e8 + 1) });

const LOD_VERT = /* glsl */ `
  uniform vec3 uLodCam; uniform vec4 uLodBand;
  varying float vLodVis; varying float vLodIn;
  // 0..1 visibility at this distance; isIn is 1 on the fade-in edge, 0 on the fade-out edge
  float lodVis(vec3 o, out float isIn) {
    float d = distance(o, uLodCam);
    float vin = clamp((d - uLodBand.x) / max(uLodBand.y - uLodBand.x, 1e-3), 0.0, 1.0);
    float vout = 1.0 - clamp((d - uLodBand.z) / max(uLodBand.w - uLodBand.z, 1e-3), 0.0, 1.0);
    isIn = d < 0.5 * (uLodBand.y + uLodBand.z) ? 1.0 : 0.0;
    return isIn > 0.5 ? vin : vout;
  }
`;
const LOD_FRAG_HEAD = /* glsl */ `
  varying float vLodVis; varying float vLodIn;
`;
/** the same 8x8 Bayer matrix as TreeFade, for the far shader (which has no see-through fade) */
const BAYER = /* glsl */ `
  float treeBayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
  float treeBayer8(vec2 a) { return treeBayer2(0.25 * a) * 0.0625 + treeBayer2(0.5 * a) * 0.25 + treeBayer2(a); }
`;
/** needs treeBayer8 (TREE_FADE_FRAG_HEAD) */
const LOD_FRAG_BODY = /* glsl */ `
  { float lb = treeBayer8(gl_FragCoord.xy); if (vLodIn > 0.5 ? lb < 1.0 - vLodVis : lb >= vLodVis) discard; }
`;
const COLLAPSE = /* glsl */ `if (vLodVis <= 0.0) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);`;

/** the instance's base, height and crown radius, the LOD visibility, and the wind sway on `transformed` */
const KIT_BEGIN = /* glsl */ `
  #ifdef USE_INSTANCING
    mat4 ktm = modelMatrix * instanceMatrix;
  #else
    mat4 ktm = modelMatrix;
  #endif
  vec3 kOrigin = ktm[3].xyz;
  { float kIn; vLodVis = lodVis(kOrigin, kIn); vLodIn = kIn; }
  {
    float kPhase = dot(kOrigin.xz, vec2(0.071, 0.113));
    float kSw = uWindK * position.y * position.y * (0.4 + length(position.xz));
    transformed.x += kSw * 0.02 * sin(uWindTime * 1.3 + kPhase);
    transformed.z += kSw * 0.015 * sin(uWindTime * 1.7 + kPhase * 1.3);
  }
  vSnowRel = (ktm * vec4(transformed, 1.0)).xyz - kOrigin;
  vSnowHold = snowHold; vSnowY = position.y;
  treeSnowLoad(kOrigin);
  #ifdef SHRUB
    // FEAT-159: no snow ghosts in the shrub layer; a half-buried mat or sapling holds the mound's snow
    vShrub = aShrub; vShrubH = length(ktm[1].xyz);
    vSnowGhost = 0.0;
    vSnowLoad = max(vSnowLoad, aShrub.y);
  #endif
`;
/** FEAT-157: the snow varyings the mesh LODs pass on (the offset from the tree's base keeps the noise precise far from the origin) */
const SNOW_VERT_HEAD = TREE_SNOW_VERT + /* glsl */ `
  attribute float snowHold;
  varying vec3 vSnowRel; varying float vSnowHold; varying float vSnowY;
  #ifdef SHRUB
    // FEAT-159, per instance: the snow line (share of the height under the snow), the mound cover (0..1)
    // and how high the snow drifts up it (m)
    attribute vec3 aShrub;
    varying vec3 vShrub; varying float vShrubH;
  #endif
`;
const SNOW_FRAG_HEAD = TREE_SNOW_COMMON + /* glsl */ `
  uniform float uSnowK;
  varying vec3 vSnowRel; varying float vSnowHold; varying float vSnowY;
  #ifdef SHRUB
    varying vec3 vShrub; varying float vShrubH;
  #endif
`;
/** after color_fragment: the snow on this fragment, the needle colour under it, and the ghost's alpha */
const SNOW_COLOR = /* glsl */ `
  float snowCov = 0.0;
  vec3 kBentW = normalize((vec4(vNormal, 0.0) * viewMatrix).xyz);
  vec3 kViewW = normalize((vec4(vViewPosition, 0.0) * viewMatrix).xyz);
  vec3 kNeedle = diffuseColor.rgb;
  if (vSnowLoad > 0.001) {
    float sn = treeSnowNoise(vSnowRel * 3.3);
    // the surface's own facing toward the camera: the top of a card or cone, or its underside
    vec3 gN = normalize(cross(dFdx(vSnowRel), dFdy(vSnowRel)));
    if (dot(gN, kViewW) < 0.0) gN = -gN;
    // late in a sunny day the sun side melts back (not on a ghost)
    float load = vSnowLoad * (1.0 - uTreeSnow.y * clamp(dot(kBentW.xz, uTreeSunDir.xz) * 1.5, 0.0, 1.0) * (1.0 - vSnowGhost));
    float a0 = diffuseColor.a;
    diffuseColor.a = treeSnowAlpha(a0, sn, vSnowGhost * vSnowLoad);
    snowCov = treeSnowCov(0.75 * gN.y + 0.25 * kBentW.y, vSnowHold, vSnowY, sn, load, vSnowGhost, uSnowK);
    snowCov = max(snowCov, vSnowGhost * (1.0 - smoothstep(0.3, 0.5, a0))); // the filled gaps are rime
    diffuseColor.rgb = mix(diffuseColor.rgb, TREE_SNOW_ALB * (0.88 + 0.12 * sn), snowCov);
  }
  #ifdef SHRUB
  {
    // FEAT-159: the snow drifted round it where it comes out of the snow (up to vShrub.z: 25 cm on a mat,
    // a few cm on a thin stem), and on a buried mat or sapling the mound over it, a few dark tips showing through
    float sn2 = treeSnowNoise(vSnowRel * 4.1 + 7.0);
    float above = (vSnowY - vShrub.x) * vShrubH;
    float drift = 1.0 - smoothstep(0.2 * vShrub.z, vShrub.z * (0.5 + 0.5 * sn2), above);
    float mound = smoothstep(0.35, 0.7, vShrub.y * (0.7 + 0.6 * sn2));
    float c = max(drift, mound);
    if (c > snowCov) { snowCov = c; diffuseColor.rgb = mix(kNeedle, TREE_SNOW_ALB * (0.9 + 0.1 * sn2), c); }
  }
  #endif
`;
/** snow lies flat: its normal leans toward up so it is lit like the ground; rime on a ghost keeps the crown's round shading */
const SNOW_NORMAL = /* glsl */ `
  if (snowCov > 0.0) normal = normalize(mix(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), 0.6 * snowCov * (1.0 - 0.7 * vSnowGhost)));
`;
/** after the lights: snow's sky light takes the terrain's shade tint; the needles their fill and translucency */
const SNOW_LIGHTS = /* glsl */ `
  reflectedLight.indirectDiffuse *= mix(vec3(1.0), TREE_SNOW_SHADE, snowCov);
  reflectedLight.indirectDiffuse += treeNeedleExtra(kNeedle, kBentW, kViewW, snowCov);
`;

/** the mesh LODs' roughness; the far shader's specular uses the same */
const ROUGHNESS = 0.92;
/**
 * The share of three's direct specular the trees keep: in full, needle cards seen against the sun
 * glow pale (the grazing Fresnel on dark albedo); back-lit conifers should read dark.
 */
const SPEC_K = 0.25;

/**
 * The baked albedo reads a little darker than LOD1's cones at the 400 m swap (the bake samples the
 * card atlas's small mips, averaged in sRGB); measured with treeshot's lods tiles.
 */
const FAR_GAIN = 1.3;

const NORMAL_NO_FLIP = THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '');

export interface TreeMaterialOpts {
  band: Band; wind: { value: number }; alphaToCoverage: boolean;
  /** FEAT-157: the LOD's snow amount factor (1 for the cards) */
  snowK?: number;
  /** FEAT-159: the shrub layer: reads the per-instance `aShrub` (snow line, mound cover), no snow ghosts (its own program) */
  shrub?: boolean;
}

/** LOD0 / LOD1: the standard material with the kit hooks. The hook's source is the same for both, so they share one program. */
export function treeMaterial(atlas: THREE.Texture, o: TreeMaterialOpts): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: ROUGHNESS, metalness: 0 });
  mat.alphaToCoverage = o.alphaToCoverage;
  mat.shadowSide = THREE.DoubleSide;
  const band = o.band, wind = o.wind, snowK = { value: o.snowK ?? 1 };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, treeFadeUniforms, kitUniforms, treeSnowUniforms, { uLodBand: band, uWindK: wind, uSnowK: snowK });
    shader.vertexShader = TREE_FADE_VERT + LOD_VERT + SNOW_VERT_HEAD + 'uniform float uWindTime; uniform float uWindK;\n' + shader.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + KIT_BEGIN)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vTreeFade = treeFade(kOrigin, length(ktm[1].xyz), length(ktm[0].xyz), position.y);
        #ifdef SHRUB
          // FEAT-159: the see-through fade is for crowns that hide the rider; a shrub only fades when over 2.5 m stands above the snow
          if ((1.0 - aShrub.x) * vShrubH < 2.5) vTreeFade = 0.0;
        #endif
        ${COLLAPSE}`);
    shader.fragmentShader = TREE_FADE_FRAG_HEAD + LOD_FRAG_HEAD + SNOW_FRAG_HEAD + TREE_SNOW_LIGHT + shader.fragmentShader
      .replace('#include <clipping_planes_fragment>', `${LOD_FRAG_BODY}\n${TREE_FADE_FRAG_BODY}\n#include <clipping_planes_fragment>`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${SNOW_COLOR}`)
      .replace('#include <normal_fragment_begin>', NORMAL_NO_FLIP)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SNOW_NORMAL}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
 reflectedLight.directSpecular *= ${SPEC_K.toFixed(2)};
 ${SNOW_LIGHTS}`);
  };
  if (o.shrub) mat.defines = { ...mat.defines, SHRUB: '' };
  mat.customProgramCacheKey = () => (o.shrub ? 'treekit-shrub' : 'treekit');
  return mat;
}

/** the shadow pass for LOD0 / LOD1: the same band (a hard switch at the middle of each edge) and sway */
export function treeDepthMaterial(atlas: THREE.Texture, o: TreeMaterialOpts): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.5, side: THREE.DoubleSide });
  const band = o.band, wind = o.wind;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, kitUniforms, treeSnowUniforms, { uLodBand: band, uWindK: wind });
    shader.vertexShader = LOD_VERT + SNOW_VERT_HEAD + 'uniform float uWindTime; uniform float uWindK;\n' + shader.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + KIT_BEGIN)
      .replace('#include <project_vertex>', `#include <project_vertex>
        if (vLodVis < 0.5) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);`);
    // FEAT-157: a snow ghost's filled-in crown casts its shadow too
    shader.fragmentShader = SNOW_FRAG_HEAD + shader.fragmentShader
      .replace('#include <alphatest_fragment>', `if (vSnowGhost > 0.0) diffuseColor.a = treeSnowAlpha(diffuseColor.a, treeSnowNoise(vSnowRel * 3.3), vSnowGhost * vSnowLoad);
        #include <alphatest_fragment>`);
  };
  if (o.shrub) mat.defines = { ...mat.defines, SHRUB: '' };
  mat.customProgramCacheKey = () => (o.shrub ? 'treekit-shrub-depth' : 'treekit-depth');
  return mat;
}

export interface FarLight {
  sunDir: { value: THREE.Vector3 };
  sunColor: { value: THREE.Color };
  hemiSky: { value: THREE.Color };
  hemiGround: { value: THREE.Color };
}
/** the sun and the ground are the snow module's uniforms, so setting them lights the near needles' extras too */
export const farLight: FarLight = {
  sunDir: treeSnowUniforms.uTreeSunDir,
  sunColor: treeSnowUniforms.uTreeSunColor,
  hemiSky: { value: new THREE.Color(0.8, 0.85, 1) },
  hemiGround: treeSnowUniforms.uTreeGround,
};

/**
 * LOD2 (crossed quads, `billboard` false) or the impostor (camera-facing quad). Per instance: iPos
 * (base, world), iScale (crown radius, height, m), iYaw, iColor (variation), iSpec (kit species).
 */
export function farMaterial(albedo: THREE.Texture, normal: THREE.Texture, snow: THREE.Texture, halfW: number[], angles: number, rows: number, band: Band, billboard: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: billboard ? { BILLBOARD: '' } : {},
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...kitUniforms,
      ...treeSnowUniforms,
      uLodBand: band, uAlbedo: { value: albedo }, uNormal: { value: normal }, uSnowMask: { value: snow },
      uHalfW: { value: halfW }, uAngles: { value: angles }, uRows: { value: rows },
      uSunDir: farLight.sunDir, uSunColor: farLight.sunColor, uHemiSky: farLight.hemiSky, uHemiGround: farLight.hemiGround,
    },
    vertexShader: /* glsl */ `
      attribute vec3 iPos; attribute vec2 iScale; attribute float iYaw; attribute vec3 iColor; attribute float iSpec;
      #ifndef BILLBOARD
        attribute float aCol;
      #endif
      uniform float uHalfW[${halfW.length}]; uniform float uAngles; uniform float uRows;
      varying vec2 vUv; varying vec3 vColor; varying float vYaw; varying vec3 vWorld;
      #include <fog_pars_vertex>
      ${LOD_VERT}
      ${TREE_SNOW_VERT}
      void main() {
        { float isIn; vLodVis = lodVis(iPos, isIn); vLodIn = isIn; }
        treeSnowLoad(iPos);
        int s = int(iSpec + 0.5);
        float hw = uHalfW[s] * iScale.x;
        float col;
        vec3 world;
        #ifdef BILLBOARD
          vec3 toCam = cameraPosition - iPos;
          float viewYaw = atan(toCam.x, toCam.z);
          vec3 right = vec3(cos(viewYaw), 0.0, -sin(viewYaw));
          world = iPos + right * position.x * hw + vec3(0.0, position.y * iScale.y, 0.0);
          col = floor(mod((viewYaw - iYaw) / 6.2831853 * uAngles + 0.5 + uAngles, uAngles));
        #else
          float c = cos(iYaw), sn = sin(iYaw);
          vec3 lp = vec3(position.x * hw, position.y * iScale.y, position.z * hw);
          world = iPos + vec3(lp.x * c + lp.z * sn, lp.y, -lp.x * sn + lp.z * c);
          col = aCol;
        #endif
        vUv = vec2((col + uv.x) / uAngles, (float(s) + uv.y) / uRows);
        vColor = iColor;
        vYaw = iYaw;
        vWorld = world;
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        ${COLLAPSE}
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAlbedo; uniform sampler2D uNormal; uniform sampler2D uSnowMask;
      uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uHemiSky; uniform vec3 uHemiGround;
      ${TREE_SNOW_COMMON}
      ${TREE_SNOW_LIGHT}
      varying vec2 vUv; varying vec3 vColor; varying float vYaw; varying vec3 vWorld;
      #include <fog_pars_fragment>
      // three's GGX specular (F0 0.04, roughness ${ROUGHNESS}): on dark needles it is a good share of what the standard material shows
      float kGGX(vec3 n, vec3 l, vec3 v) {
        float a = ${(ROUGHNESS * ROUGHNESS).toFixed(4)}, a2 = a * a;
        vec3 h = normalize(l + v);
        float nl = clamp(dot(n, l), 0.0, 1.0), nv = clamp(abs(dot(n, v)), 1e-3, 1.0), nh = clamp(dot(n, h), 0.0, 1.0), vh = clamp(dot(v, h), 0.0, 1.0);
        float f = 0.04 + 0.96 * exp2((-5.55473 * vh - 6.98316) * vh);
        float gv = nl * sqrt(a2 + (1.0 - a2) * nv * nv), gl = nv * sqrt(a2 + (1.0 - a2) * nl * nl);
        float vis = 0.5 / max(gv + gl, 1e-6);
        float dd = nh * nh * (a2 - 1.0) + 1.0;
        return f * vis * a2 / (3.14159265 * dd * dd) * nl;
      }
      ${BAYER}
      ${LOD_FRAG_HEAD}
      void main() {
        vec4 a = texture2D(uAlbedo, vUv);
        // FEAT-157: the snow mask baked from LOD0 (moderate, heavy, ghost; alpha the ghost's filled-in crown)
        vec4 m = texture2D(uSnowMask, vUv);
        bool solid = a.a >= 0.4;
        if (!solid && (m.a < 0.4 || treeBayer8(gl_FragCoord.xy) >= smoothstep(0.3, 0.8, vSnowGhost * vSnowLoad))) discard;
        ${LOD_FRAG_BODY}
        vec3 n = texture2D(uNormal, vUv).xyz * 2.0 - 1.0;
        float c = cos(vYaw), s = sin(vYaw);
        n = normalize(vec3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c));
        float load = vSnowLoad * (1.0 - uTreeSnow.y * clamp(dot(n.xz, uTreeSunDir.xz) * 1.5, 0.0, 1.0) * (1.0 - vSnowGhost));
        float cov = load < 0.5 ? m.r * load * 2.0 : mix(m.r, m.g, load * 2.0 - 1.0);
        cov = solid ? mix(cov, m.b, vSnowGhost) : 1.0;
        vec3 needle = a.rgb * vColor * ${FAR_GAIN.toFixed(2)};
        vec3 alb = mix(needle, TREE_SNOW_ALB, cov);
        vec3 ns = normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.6 * cov * (1.0 - 0.7 * vSnowGhost)));
        vec3 hemi = mix(uHemiGround, uHemiSky, 0.5 * ns.y + 0.5) * mix(vec3(1.0), TREE_SNOW_SHADE, cov);
        vec3 v = normalize(cameraPosition - vWorld);
        vec3 col = alb * (uSunColor * max(dot(ns, uSunDir), 0.0) + hemi) * 0.31830989 + uSunColor * kGGX(ns, uSunDir, v) * ${SPEC_K.toFixed(2)}
          + treeNeedleExtra(needle, n, v, cov);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    fog: true,
    side: THREE.DoubleSide,
  });
}

/** the tree height (m) the bake's snow noise is scaled to (sub-pixel at the far LODs' distances anyway) */
const BAKE_H = 15;

/**
 * The bake: unlit albedo (atlas x vertex colour), the crown normal in the tree's own frame, or
 * (FEAT-157) the snow mask: the near shader's snow cover at a moderate load (r), a heavy load (g) and
 * on a snow ghost (b), alpha the ghost's filled-in crown.
 */
export function bakeMaterial(atlas: THREE.Texture, radius: { value: number }, mode: 'albedo' | 'normal' | 'snow'): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: mode === 'normal' ? { NORMALS: '' } : mode === 'snow' ? { SNOW: '' } : {},
    uniforms: { map: { value: atlas }, uR: radius, uTreeSnow: { value: new THREE.Vector3() } },
    vertexColors: true,
    vertexShader: /* glsl */ `
      uniform float uR;
      attribute float snowHold;
      varying vec2 vUv; varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying float vHold; varying float vY;
      void main() {
        vUv = uv; vCol = color;
        vN = normalize(vec3(normal.x / uR, normal.y, normal.z / uR)); // the mesh is scaled (uR, 1, uR) back to its natural shape
        vW = (modelMatrix * vec4(position, 1.0)).xyz; vHold = snowHold; vY = position.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying vec2 vUv; varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying float vHold; varying float vY;
      ${TREE_SNOW_COMMON}
      void main() {
        vec4 t = texture2D(map, vUv);
        #ifdef SNOW
          float sn = treeSnowNoise(vW * ${(BAKE_H * 3.3).toFixed(1)});
          if (treeSnowAlpha(t.a, sn, 1.0) < 0.5) discard;
          vec3 gN = normalize(cross(dFdx(vW), dFdy(vW)));
          if (dot(gN, cameraPosition - vW) < 0.0) gN = -gN;
          float up = 0.75 * gN.y + 0.25 * normalize(vN).y;
          float gap = t.a < 0.5 ? 1.0 : 0.0;
          gl_FragColor = vec4(treeSnowCov(up, vHold, vY, sn, 0.5, 0.0, 1.0), treeSnowCov(up, vHold, vY, sn, 1.0, 0.0, 1.0), max(treeSnowCov(up, vHold, vY, sn, 1.0, 1.0, 1.0), gap), 1.0);
        #else
          if (t.a < 0.5) discard;
          #ifdef NORMALS
            gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, 1.0);
          #else
            gl_FragColor = vec4(t.rgb * vCol, 1.0);
          #endif
        #endif
      }`,
    side: THREE.DoubleSide,
  });
}
