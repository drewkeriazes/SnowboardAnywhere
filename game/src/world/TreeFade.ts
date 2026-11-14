import * as THREE from 'three';

/**
 * FEAT-155: trees that block your view of the run turn see-through, and only those (a tree off to the
 * side with open snow behind it stays solid). Each frame `TreeFade.update` sets the run: from the rider
 * to a look-ahead point 10 to 30 m out (further at speed) along the travel direction, smoothed so linked
 * turns do not sweep it side to side, plus a slower point that keeps the old line faded for a moment
 * after a turn. In the vertex shader each tree's trunk-to-top line and the run are taken into the
 * camera's view plane: a tree fades when its silhouette overlaps the run there (with a RUN_HALF margin
 * either side of the line) and it stands in front of the stretch of run it covers. A faded tree keeps
 * only a share of itself (no sorting, depth write on, the shadow pass draws the tree whole). BUG-125:
 * with MSAA (the canvas and the goggle lens target both have it) the near trees' alpha-to-coverage
 * keeps that share of each pixel's samples, so the resolve blends the tree over what is behind it like
 * real translucency; a screen-door pattern instead read as white speckle against the snow. Without
 * MSAA, and on the LOD1 trees (no alpha-to-coverage), it discards whole fragments in an interleaved
 * gradient noise pattern, fixed to the screen. A tree within about 1 m of where the board will be in the next half second stays solid. Uniforms only:
 * no per-tree CPU work.
 */

/**
 * the share of a fully faded tree that is dropped (crowns; trunks keep more, TRUNK_KEEP). 0.75 keeps exactly one of
 * 4 MSAA samples, an even veil; a share between the coverage steps gets the GPU's own dither (BUG-125).
 */
const MAX_DISCARD = 0.75;
/** the lowest part of the tree (trunk and lower boughs) fades this much less than the crown */
const TRUNK_KEEP = 0.3;
/** how much of the slope either side of the line counts as the run (m, at the run's distance) */
const RUN_HALF = 0.75;
/** the fade eases out over this many metres of clear gap between the tree and the run (at the tree's distance) */
const R_SOFT = 0.75;
/** a tree fades fully once it is this many metres nearer the camera than the run it covers (none when level with it) */
const IN_FRONT = 2;
/** the share of the crown radius (from the pack) that counts as the tree's silhouette (the cone narrows upward) */
const CROWN_K = 0.8;
/** look-ahead distance: LOOK_MIN m, plus LOOK_PER_MS m per m/s of speed, up to LOOK_MAX */
const LOOK_MIN = 10, LOOK_MAX = 30, LOOK_PER_MS = 1;
/** the trees you are about to hit: within KEEP_R m of the board's path over the next KEEP_T s stay solid */
const KEEP_T = 0.5, KEEP_R = 1.5;
/** time constant (s) of the look-ahead point, and of the slow one that keeps the old line faded after a turn */
const TAU = 0.4, TAU_SLOW = 1.5;
/** time constant (s) of the travel direction the run follows */
const TAU_DIR = 0.6;
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
  /** 1 when the frame draws into a multisampled buffer: the fade goes through alpha-to-coverage (SceneRender sets it) */
  uFadeMsaa: { value: 0 },
};

/** vertex shader helpers (the tree kit's materials, trees/materials.ts); `treeFade(base, height, crown, localY)` is 0 (solid) .. 1 (fully faded). three.js world coordinates (y up). */
export const TREE_FADE_VERT = /* glsl */ `
  uniform vec3 uFadeCam; uniform vec3 uFadeRider; uniform vec3 uFadeAhead; uniform vec3 uFadeAheadSlow; uniform vec3 uFadeNext; uniform float uFadeK;
  varying float vTreeFade;
  // a point in the camera's view plane: (x, y) over the distance (tan of the angle off the view axis), and the distance
  vec3 treeFadeView(vec3 p) { vec4 v = viewMatrix * vec4(p, 1.0); float d = max(-v.z, 0.05); return vec3(v.xy / d, -v.z); }
  // the closest distance between segments p1..q1 and p2..q2 (2D); t is where on the second it is
  float treeFadeSegs(vec2 p1, vec2 q1, vec2 p2, vec2 q2, out float t) {
    vec2 d1 = q1 - p1, d2 = q2 - p2, r = p1 - p2;
    float a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), s = 0.0;
    t = 0.0;
    if (e < 1e-10) { s = a > 1e-10 ? clamp(-dot(d1, r) / a, 0.0, 1.0) : 0.0; }
    else if (a < 1e-10) { t = clamp(f / e, 0.0, 1.0); }
    else {
      float c = dot(d1, r), b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den, 0.0, 1.0) : 0.0;
      t = (b * s + f) / e;
      if (t < 0.0) { t = 0.0; s = clamp(-c / a, 0.0, 1.0); }
      else if (t > 1.0) { t = 1.0; s = clamp((b - c) / a, 0.0, 1.0); }
    }
    return length(p1 + d1 * s - (p2 + d2 * t));
  }
  // how much the tree (its trunk-to-top line at distance tb.z, silhouette half-width crown) covers the run r..e, seen
  // from the camera, and stands in front of it: the near side of the crown, not the trunk, has to be nearer than the run
  float treeFadeRun(vec3 tb, vec3 tt, float crown, vec3 r, vec3 e) {
    float t;
    float gap = treeFadeSegs(tb.xy, tt.xy, r.xy, e.xy, t);
    float rd = mix(r.z, e.z, t); // the distance of the run where the tree covers it
    float zt = max(tb.z, 0.3);
    float gapM = gap * zt - crown - ${RUN_HALF.toFixed(2)} * zt / rd; // clear metres at the tree's distance
    return (1.0 - smoothstep(0.0, ${R_SOFT.toFixed(2)}, gapM)) * (1.0 - smoothstep(rd - ${IN_FRONT.toFixed(2)}, rd - 0.25, tb.z - crown));
  }
  float treeFade(vec3 base, float h, float crown, float localY) {
    if (uFadeK <= 0.0) return 0.0;
    vec3 tb = treeFadeView(base), tt = treeFadeView(base + vec3(0.0, h, 0.0));
    float f = 0.0;
    if (tb.z + crown > 0.3) { // any of the crown in front of the camera
      vec3 r = treeFadeView(uFadeRider);
      float cw = crown * ${CROWN_K.toFixed(2)};
      f = max(treeFadeRun(tb, tt, cw, r, treeFadeView(uFadeAhead)), treeFadeRun(tb, tt, cw, r, treeFadeView(uFadeAheadSlow)));
    }
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

/**
 * fragment shader. HEAD also holds the 8x8 Bayer matrix the LOD crossfade (trees/materials.ts) uses. BODY goes before
 * the alpha test and drops the faded share of fragments in an interleaved gradient noise pattern when there is no
 * alpha-to-coverage; ALPHA goes after it and scales the coverage instead when there is.
 */
export const TREE_FADE_FRAG_HEAD = /* glsl */ `
  varying float vTreeFade; uniform float uFadeMsaa;
  float treeBayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
  float treeBayer8(vec2 a) { return treeBayer2(0.25 * a) * 0.0625 + treeBayer2(0.5 * a) * 0.25 + treeBayer2(a); }
  // Jimenez's interleaved gradient noise: no repeating grid for the eye to pick out
  float treeIgn(vec2 a) { a = floor(a); return fract(52.9829189 * fract(dot(a, vec2(0.06711056, 0.00583715)))); }
`;
export const TREE_FADE_FRAG_BODY = /* glsl */ `
  #ifdef ALPHA_TO_COVERAGE
    bool treeA2c = uFadeMsaa > 0.5;
  #else
    bool treeA2c = false;
  #endif
  if (!treeA2c && vTreeFade > 0.001 && treeIgn(gl_FragCoord.xy) < vTreeFade * ${MAX_DISCARD.toFixed(2)}) discard;
`;
export const TREE_FADE_FRAG_ALPHA = /* glsl */ `
  #ifdef ALPHA_TO_COVERAGE
    if (treeA2c) diffuseColor.a *= 1.0 - vTreeFade * ${MAX_DISCARD.toFixed(2)};
  #endif
`;

export interface FadeRider { x: number; y: number; z: number; vx: number; vy: number }

/** Per frame: moves the lane with the camera and the rider. */
export class TreeFade {
  private readonly ahead = new THREE.Vector3();
  private readonly aheadSlow = new THREE.Vector3();
  /** the smoothed travel direction (pack x, y) */
  private readonly dir = [0, 1];
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
    // along the travel direction, smoothed so linked turns do not sweep it (where the camera looks when nearly stopped)
    const sp = Math.hypot(r.vx, r.vy);
    let wx: number, wy: number;
    if (sp > 1.5) { wx = r.vx / sp; wy = r.vy / sp; }
    else { camera.getWorldDirection(this.tmp); const l = Math.hypot(this.tmp.x, this.tmp.z) || 1; wx = this.tmp.x / l; wy = -this.tmp.z / l; }
    if (!this.aheadSet) { this.dir[0] = wx; this.dir[1] = wy; }
    else { const kd = 1 - Math.exp(-dt / TAU_DIR); this.dir[0] += (wx - this.dir[0]) * kd; this.dir[1] += (wy - this.dir[1]) * kd; }
    const dl = Math.hypot(this.dir[0], this.dir[1]) || 1;
    const dx = this.dir[0] / dl, dy = this.dir[1] / dl;
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
