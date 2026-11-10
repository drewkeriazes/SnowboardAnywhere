import * as THREE from 'three';

/**
 * FEAT-155: trees that block the view downhill turn see-through. Each frame `TreeFade.update` sets a
 * "view lane" from the chase camera through the rider to a look-ahead point 30 to 60 m along the travel
 * direction (further at speed); the tree shaders measure each tree's distance to that lane in the
 * vertex shader and discard a share of the tree's fragments in a stable screen-space Bayer pattern
 * (dithered transparency: no sorting, depth write on, the shadow pass draws the tree whole). Trees
 * right in front of the lens fade too; a tree within about 1.5 m of where the board will be in the next
 * half second never fades. Uniforms only: no per-tree CPU work.
 */

/** the share of a fully faded tree's fragments that are discarded (crowns; trunks keep more, TRUNK_KEEP) */
const MAX_DISCARD = 0.75;
/** the lowest part of the tree (trunk and lower boughs) fades this much less than the crown */
const TRUNK_KEEP = 0.3;
/** the lane radius (m, past the tree's crown) on the camera-to-rider leg, at the rider, and at the look-ahead point */
const R_CAM = 1.5, R_RIDER = 2.5, R_AHEAD = 4.5;
/** the fade eases out over this many metres past the lane radius, so a tree fades in as the lane sweeps onto it */
const R_SOFT = 1.5;
/** trees whose crown is within this many metres of the camera fade (anything right in front of the lens) */
const R_LENS = 2.5;
/** look-ahead distance: LOOK_MIN m, plus LOOK_PER_MS m per m/s of speed, up to LOOK_MAX */
const LOOK_MIN = 30, LOOK_MAX = 60, LOOK_PER_MS = 1.5;
/** the trees you are about to hit: within KEEP_R m of the board's path over the next KEEP_T s stay solid */
const KEEP_T = 0.5, KEEP_R = 1.5;
/** time constant (s) of the lane's look-ahead point */
const TAU = 0.25;
/** the fade eases fully in or out over this many seconds when the setting or the camera changes */
const SWITCH_S = 0.3;

export const treeFadeUniforms = {
  uFadeCam: { value: new THREE.Vector3() },
  uFadeRider: { value: new THREE.Vector3() },
  uFadeAhead: { value: new THREE.Vector3() },
  uFadeNext: { value: new THREE.Vector3() },
  /** 0..1: how much the fade applies (eases with the setting and the camera mode) */
  uFadeK: { value: 0 },
};

/** vertex shader helpers; `treeFade(base, height, crown, localY)` is 0 (solid) .. 1 (fully faded). three.js world coordinates (y up). */
export const TREE_FADE_VERT = /* glsl */ `
  uniform vec3 uFadeCam; uniform vec3 uFadeRider; uniform vec3 uFadeAhead; uniform vec3 uFadeNext; uniform float uFadeK;
  varying float vTreeFade;
  // the tree as a vertical column (base, height) with a crown radius, against one lane leg a..b whose radius goes ra..rb
  float treeFadeLeg(vec3 a, vec3 b, float ra, float rb, vec3 base, float h, float crown) {
    vec2 ab = b.xz - a.xz;
    float t = clamp(dot(base.xz - a.xz, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
    float y = mix(a.y, b.y, t);
    float dh = max(0.0, length(base.xz - (a.xz + ab * t)) - crown);
    float dv = max(0.0, max(base.y - y, y - (base.y + h)));
    float r = mix(ra, rb, t);
    return 1.0 - smoothstep(r, r + ${R_SOFT.toFixed(2)}, length(vec2(dh, dv)));
  }
  float treeFade(vec3 base, float h, float crown, float localY) {
    if (uFadeK <= 0.0) return 0.0;
    float f = max(treeFadeLeg(uFadeCam, uFadeRider, ${R_CAM.toFixed(2)}, ${R_RIDER.toFixed(2)}, base, h, crown),
                  treeFadeLeg(uFadeRider, uFadeAhead, ${R_RIDER.toFixed(2)}, ${R_AHEAD.toFixed(2)}, base, h, crown));
    // right in front of the lens
    float cy = clamp(uFadeCam.y, base.y, base.y + h);
    float dl = length(vec2(max(0.0, length(uFadeCam.xz - base.xz) - crown), uFadeCam.y - cy));
    f = max(f, 1.0 - smoothstep(${R_LENS.toFixed(2)}, ${(R_LENS + 1).toFixed(2)}, dl));
    // the tree you are about to hit stays solid: the trunk's distance to the board's path over the next half second
    vec2 pn = uFadeNext.xz - uFadeRider.xz;
    float tn = clamp(dot(base.xz - uFadeRider.xz, pn) / max(dot(pn, pn), 1e-4), 0.0, 1.0);
    float dk = length(base.xz - (uFadeRider.xz + pn * tn));
    f *= smoothstep(${KEEP_R.toFixed(2)}, ${(KEEP_R + 1).toFixed(2)}, dk);
    // trunks fade a little less than crowns, so you still sense the obstacle
    f *= mix(${(1 - TRUNK_KEEP).toFixed(2)}, 1.0, smoothstep(0.15, 0.4, localY));
    return f * uFadeK;
  }
`;

/** fragment shader: discard the faded share of the tree in an 8x8 Bayer pattern, fixed to the screen */
export const TREE_FADE_FRAG_HEAD = /* glsl */ `
  varying float vTreeFade;
  float treeBayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
  float treeBayer8(vec2 a) { return treeBayer2(0.25 * a) * 0.0625 + treeBayer2(0.5 * a) * 0.25 + treeBayer2(a); }
`;
export const TREE_FADE_FRAG_BODY = /* glsl */ `
  if (vTreeFade > 0.001 && treeBayer8(gl_FragCoord.xy) < vTreeFade * ${MAX_DISCARD.toFixed(2)}) discard;
`;

/**
 * Add the fade to an instanced tree MeshStandardMaterial (unit tree: base at the origin, height 1
 * along +y, scaled by the instance matrix). Call before the material is registered for CSM.
 */
export function addTreeFade(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, treeFadeUniforms);
    shader.vertexShader = TREE_FADE_VERT + shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      {
        #ifdef USE_INSTANCING
          mat4 tm = modelMatrix * instanceMatrix;
        #else
          mat4 tm = modelMatrix;
        #endif
        float th = length(tm[1].xyz);
        vTreeFade = treeFade(tm[3].xyz, th, length(tm[0].xyz) * 0.25, position.y);
      }`);
    shader.fragmentShader = TREE_FADE_FRAG_HEAD + shader.fragmentShader.replace('#include <clipping_planes_fragment>', `${TREE_FADE_FRAG_BODY}\n#include <clipping_planes_fragment>`);
  };
  mat.customProgramCacheKey = () => 'treefade';
  mat.needsUpdate = true;
}

export interface FadeRider { x: number; y: number; z: number; vx: number; vy: number }

/** Per frame: moves the lane with the camera and the rider. */
export class TreeFade {
  private readonly ahead = new THREE.Vector3();
  private aheadSet = false;
  private readonly tmp = new THREE.Vector3();

  /**
   * `on`: the setting is on and the camera is a third-person one. `groundHeight` gives the terrain under
   * the look-ahead point (pack x east, y north). Snaps the look-ahead point after a teleport.
   */
  update(camera: THREE.Camera, r: FadeRider, groundHeight: (x: number, y: number) => number, dt: number, on: boolean): void {
    const u = treeFadeUniforms;
    dt = Math.max(0, dt);
    const k = 1 - Math.exp(-dt / TAU);
    u.uFadeK.value = Math.max(0, Math.min(1, u.uFadeK.value + (on ? 1 : -1) * dt / SWITCH_S));
    if (u.uFadeK.value === 0) { this.aheadSet = false; return; }
    u.uFadeCam.value.copy(camera.position);
    u.uFadeRider.value.set(r.x, r.z + 1, -r.y);
    u.uFadeNext.value.set(r.x + r.vx * KEEP_T, r.z + 1, -(r.y + r.vy * KEEP_T));
    // along the travel direction, or where the camera looks when slow
    const sp = Math.hypot(r.vx, r.vy);
    let dx: number, dy: number;
    if (sp > 2) { dx = r.vx / sp; dy = r.vy / sp; }
    else {
      camera.getWorldDirection(this.tmp);
      const l = Math.hypot(this.tmp.x, this.tmp.z) || 1;
      dx = this.tmp.x / l; dy = -this.tmp.z / l;
    }
    const d = Math.min(LOOK_MAX, LOOK_MIN + LOOK_PER_MS * sp);
    const ax = r.x + dx * d, ay = r.y + dy * d;
    const gz = groundHeight(ax, ay);
    this.tmp.set(ax, (Number.isFinite(gz) ? gz : r.z) + 1, -ay);
    if (!this.aheadSet || this.tmp.distanceTo(this.ahead) > 40) { this.ahead.copy(this.tmp); this.aheadSet = true; }
    else this.ahead.lerp(this.tmp, k);
    u.uFadeAhead.value.copy(this.ahead);
  }
}
