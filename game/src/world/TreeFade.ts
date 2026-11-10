import * as THREE from 'three';

/**
 * FEAT-155: trees that block the view downhill turn see-through. Each frame `TreeFade.update` sets the
 * run ahead: from the rider to a look-ahead point 10 to 30 m out (further at speed) along where the
 * camera looks, eased so linked turns do not sweep it side to side, plus a slower point that keeps the
 * old line faded for a moment after a turn. A tree fades when it stands in the view wedge from the
 * camera to the part of the run it would hide: narrow at the lens (so the big trees at the edge of
 * the picture, beside the camera, stay solid) and R_LANE wide on the run (so a tree that faded ahead
 * stays faded as you come up on it and pass). The tree shaders measure this in the vertex shader and
 * discard a share of the tree's fragments in a stable screen-space Bayer pattern
 * (dithered transparency: no sorting, depth write on, the shadow pass draws the tree whole). Trees
 * right in front of the lens fade too; a tree within about 1.5 m of where the board will be in the next
 * half second never fades. Uniforms only: no per-tree CPU work.
 */

/** the share of a fully faded tree's fragments that are discarded (crowns; trunks keep more, TRUNK_KEEP) */
const MAX_DISCARD = 0.75;
/** the lowest part of the tree (trunk and lower boughs) fades this much less than the crown */
const TRUNK_KEEP = 0.3;
/** the view wedge's radius (m, past the tree's crown) at the lens and on the run */
const R_NEAR = 0.75, R_LANE = 3;
/** the fade eases out over this many metres past the radius, so a tree fades in as the wedge sweeps onto it */
const R_SOFT = 1.25;
/** trees whose crown is within this many metres of the camera fade (anything right in front of the lens) */
const R_LENS = 1;
/** look-ahead distance: LOOK_MIN m, plus LOOK_PER_MS m per m/s of speed, up to LOOK_MAX */
const LOOK_MIN = 10, LOOK_MAX = 30, LOOK_PER_MS = 1;
/** the trees you are about to hit: within KEEP_R m of the board's path over the next KEEP_T s stay solid */
const KEEP_T = 0.5, KEEP_R = 1.5;
/** time constant (s) of the look-ahead point, and of the slow one that keeps the old line faded after a turn */
const TAU = 0.4, TAU_SLOW = 1.5;
/** the fade eases fully in or out over this many seconds when the setting or the camera changes */
const SWITCH_S = 0.3;

export const treeFadeUniforms = {
  uFadeCam: { value: new THREE.Vector3() },
  uFadeRider: { value: new THREE.Vector3() },
  uFadeAhead: { value: new THREE.Vector3() },
  uFadeAheadSlow: { value: new THREE.Vector3() },
  uFadeNext: { value: new THREE.Vector3() },
  /** 0..1: how much the fade applies (eases with the setting and the camera mode) */
  uFadeK: { value: 0 },
};

/** vertex shader helpers; `treeFade(base, height, crown, localY)` is 0 (solid) .. 1 (fully faded). three.js world coordinates (y up). */
export const TREE_FADE_VERT = /* glsl */ `
  uniform vec3 uFadeCam; uniform vec3 uFadeRider; uniform vec3 uFadeAhead; uniform vec3 uFadeAheadSlow; uniform vec3 uFadeNext; uniform float uFadeK;
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
  // the view wedge from the camera to the point of the run (rider .. end) this tree would hide
  float treeFadeWedge(vec3 end, vec3 base, float h, float crown) {
    vec2 re = end.xz - uFadeRider.xz;
    float t = clamp(dot(base.xz - uFadeRider.xz, re) / max(dot(re, re), 1e-4), 0.0, 1.0);
    return treeFadeLeg(uFadeCam, mix(uFadeRider, end, t), ${R_NEAR.toFixed(2)}, ${R_LANE.toFixed(2)}, base, h, crown);
  }
  float treeFade(vec3 base, float h, float crown, float localY) {
    if (uFadeK <= 0.0) return 0.0;
    float f = max(treeFadeWedge(uFadeAhead, base, h, crown), treeFadeWedge(uFadeAheadSlow, base, h, crown));
    // right in front of the lens
    float cy = clamp(uFadeCam.y, base.y, base.y + h);
    float dl = length(vec2(max(0.0, length(uFadeCam.xz - base.xz) - crown), uFadeCam.y - cy));
    f = max(f, 1.0 - smoothstep(${R_LENS.toFixed(2)}, ${(R_LENS + 1).toFixed(2)}, dl));
    // the tree you are about to hit stays solid: the trunk's distance to the board's path over the next half second
    vec2 pn = uFadeNext.xz - uFadeRider.xz;
    float tn = clamp(dot(base.xz - uFadeRider.xz, pn) / max(dot(pn, pn), 1e-4), 0.0, 1.0);
    float dk = length(base.xz - (uFadeRider.xz + pn * tn));
    f *= smoothstep(${(KEEP_R - 0.5).toFixed(2)}, ${(KEEP_R + 1.5).toFixed(2)}, dk);
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
  private readonly aheadSlow = new THREE.Vector3();
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
    // along where the camera looks (the chase camera already follows the travel direction, smoothed)
    const sp = Math.hypot(r.vx, r.vy);
    camera.getWorldDirection(this.tmp);
    const l = Math.hypot(this.tmp.x, this.tmp.z) || 1;
    const dx = this.tmp.x / l, dy = -this.tmp.z / l;
    const d = Math.min(LOOK_MAX, LOOK_MIN + LOOK_PER_MS * sp);
    const ax = r.x + dx * d, ay = r.y + dy * d;
    const gz = groundHeight(ax, ay);
    this.tmp.set(ax, (Number.isFinite(gz) ? gz : r.z) + 1, -ay);
    if (!this.aheadSet || this.tmp.distanceTo(this.ahead) > 40) { this.ahead.copy(this.tmp); this.aheadSlow.copy(this.tmp); this.aheadSet = true; }
    else { this.ahead.lerp(this.tmp, k); this.aheadSlow.lerp(this.tmp, 1 - Math.exp(-dt / TAU_SLOW)); }
    u.uFadeAhead.value.copy(this.ahead);
    u.uFadeAheadSlow.value.copy(this.aheadSlow);
  }
}
