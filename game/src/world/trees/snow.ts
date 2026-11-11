import * as THREE from 'three';
import { SNOW_ALBEDO, SNOW_SHADE_TINT } from '../snowLook';

/**
 * FEAT-157: snow on the trees, the same in every LOD.
 *
 * Load. `setTreeSnow` sets one load for the day (0 bare .. 1 just after a storm, from the new snow,
 * the snow conditions and the month: `treeSnowState`). Each tree varies it by +-15% and a tree above
 * the snow-ghost band (treeline, 3,450 to 3,560 m) in deep winter goes to a full load with rime (`ghost`).
 *
 * Where it sits (LOD0 and LOD1, per fragment): on the upper side of what you see, from the surface's
 * own facing (screen derivatives, so the top of a card collects snow and its underside stays green),
 * leaning on the crown's bent normal; times the vertex's `snowHold` (most at the base of a branch, less
 * at the tips, none under the cones; trees/generate.ts) and a little more on the lower tiers; broken
 * up by a 0.3 m noise whose threshold falls as the load rises, so light snow is patches and a heavy
 * load covers every upper face. Late on a sunny day, and more in spring, the sun side melts back
 * (`melt`). Snow ghosts take snow on every face and their cards' alpha grows so the gaps fill in.
 *
 * Far LODs: the bake renders the same function at three loads (moderate, heavy, ghost) into a mask
 * atlas; the far shader blends bare, moderate and heavy by the tree's load, so near and far match.
 *
 * Light. Snow takes the terrain's snow albedo and the blue shade tint of its sky light (snowLook.ts),
 * with its normal pulled toward up so it is lit like the ground. Needles get a fill from the snow
 * below (a tree's underside sees bright snow, not black) and a cheap translucency when the sun is
 * behind them, so trees in shade are dark blue-green.
 */

/** FEAT-217: the most shaken trees the near LODs draw bare on their near side */
export const TREE_SHED_MAX = 8;

export interface TreeSnowState {
  /** 0 bare .. 1 heavy */
  load: number;
  /** 0..1: how much the sun side has melted back */
  melt: number;
  /** 0..1: how strongly trees above the ghost line turn into snow ghosts (deep winter) */
  ghost: number;
}

export const treeSnowUniforms = {
  uTreeSnow: { value: new THREE.Vector3(0.4, 0, 0) }, // load, melt, ghost
  /** the snow-ghost band (world y, m): none below x, full from y. 30 m under to 80 m over the treeline (FEAT-070,
   * 3,450 to 3,560 m on Vail; the pack's own treeline since DATA-021, setGhostBand): below it the forest is flocked,
   * not rimed (Hornsilver at 3,380 m in the Feb 2014 photo), krummholz and the top stands are ghosts */
  uGhostZ: { value: new THREE.Vector2(3450, 3560) },
  /** direction toward the sun (world) and its colour x intensity: the translucency and the far LODs */
  uTreeSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.4).normalize() },
  uTreeSunColor: { value: new THREE.Color(3, 3, 3) },
  /** the hemisphere light's ground colour x intensity: the fill from the snow under the crown */
  uTreeGround: { value: new THREE.Color(0.8, 0.8, 0.8) },
  /** FEAT-217: the trees the rider has shaken snow off (TreeBrush), two vec4 a tree: (base x, base z (three.js, = -north),
   * the share of the near side's snow gone, the contact height above the base) and (the near side's direction x, z) */
  uTreeShed: { value: Array.from({ length: 2 * TREE_SHED_MAX }, () => new THREE.Vector4()) },
  uTreeShedN: { value: 0 },
};

export function setTreeSnow(s: TreeSnowState): void {
  treeSnowUniforms.uTreeSnow.value.set(s.load, s.melt, s.ghost);
}

/** DATA-021: put the snow-ghost band at this resort's treeline (m) */
export function setGhostBand(treeline: number): void {
  treeSnowUniforms.uGhostZ.value.set(treeline - 30, treeline + 80);
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const smooth = (a: number, b: number, x: number): number => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** how deep in the winter a month is (1..12; index 0 repeats Dec): 1 Jan to Mar, 0.7 in Dec (early season, so only a partial ghost), 0 in summer */
export function winterDepth(month: number): number {
  return [0.7, 1, 1, 1, 0.75, 0.4, 0.15, 0, 0, 0, 0.15, 0.6, 0.7][Math.round(month)] ?? 0;
}

/** the load on the trees at the base of the season, before any new snow */
const BASE_LOAD = { fresh: 0.55, mid: 0.35, spring: 0.12 } as const;

/**
 * The day's snow on the trees. `newSnow` is the shared snowCover (FEAT-105: 0 .. 1 after a storm),
 * `day` the snow conditions, `month` 1..12, `hour` local, `clear` 0..1 how much sun gets through.
 */
export function treeSnowState(newSnow: number, day: 'fresh' | 'mid' | 'spring', month: number, hour: number, clear: number): TreeSnowState {
  const w = winterDepth(month) * (day === 'spring' ? 0.6 : 1);
  const base = BASE_LOAD[day] * (0.4 + 0.6 * w);
  const load = base + (1 - base) * clamp01(newSnow * 1.5);
  // the sun side melts back from late morning, most by mid-afternoon; much more in spring
  const warm = day === 'spring' ? 0.9 : day === 'mid' ? 0.45 : 0.2;
  const melt = clamp01(warm * smooth(10.5, 15, hour) * (1 - smooth(17, 19, hour) * 0.3) * clear * (1 - newSnow));
  const ghost = day === 'spring' ? 0 : smooth(0.55, 0.95, w);
  return { load, melt, ghost };
}

/**
 * FEAT-217: the load on one tree (0..1) as `TREE_SNOW_VERT` gives it, for a tree whose base is at (x, y, z)
 * (pack metres: x east, y north, z up): the day's load +-15 % by the tree, or the snow-ghost load in the
 * ghost band. The hash is the shader's in double precision, so a tree may land a few percent off the
 * one drawn; the share of it that has melted off the sun side is `uTreeSnow.y`.
 */
export function treeSnowLoadAt(x: number, y: number, z: number): number {
  const u = treeSnowUniforms.uTreeSnow.value, gz = treeSnowUniforms.uGhostZ.value;
  const m = (v: number): number => ((v % 4096) + 4096) % 4096; // GLSL mod of the three.js x and z (= -north)
  const s = Math.sin(m(x) * 12.9898 + m(-y) * 78.233) * 43758.5453, h = s - Math.floor(s);
  const g = u.z * smooth(gz.x, gz.y, z + (h - 0.5) * 50);
  return Math.max(clamp01(u.x * (0.85 + 0.3 * h)), g);
}

/** the per-tree load and ghost share (vertex shaders; `o` is the tree's base, world) */
export const TREE_SNOW_VERT = /* glsl */ `
  uniform vec3 uTreeSnow; uniform vec2 uGhostZ;
  uniform vec4 uTreeShed[${2 * TREE_SHED_MAX}]; uniform int uTreeShedN;
  varying float vSnowLoad; varying float vSnowGhost;
  // FEAT-217 (the mesh LODs): the near side's direction (xy), the share of its snow gone and the contact height above the base
  varying vec4 vSnowShed;
  void treeSnowShed(vec3 o) {
    vSnowShed = vec4(0.0);
    for (int i = 0; i < ${TREE_SHED_MAX}; i++) {
      if (i >= uTreeShedN) break;
      vec4 a = uTreeShed[2 * i];
      vec2 d = o.xz - a.xy;
      if (dot(d, d) < 0.04) { vSnowShed = vec4(uTreeShed[2 * i + 1].xy, a.zw); break; }
    }
  }
  void treeSnowLoad(vec3 o) {
    float h = fract(sin(dot(mod(o.xz, 4096.0), vec2(12.9898, 78.233))) * 43758.5453);
    float g = uTreeSnow.z * smoothstep(uGhostZ.x, uGhostZ.y, o.y + (h - 0.5) * 50.0);
    vSnowGhost = g;
    vSnowShed = vec4(0.0);
    vSnowLoad = max(clamp(uTreeSnow.x * (0.85 + 0.3 * h), 0.0, 1.0), g);
  }
`;

/** shared fragment helpers: the noise, the coverage and the snow colours */
export const TREE_SNOW_COMMON = /* glsl */ `
  uniform vec3 uTreeSnow;
  varying float vSnowLoad; varying float vSnowGhost; varying vec4 vSnowShed;
  const vec3 TREE_SNOW_ALB = vec3(${SNOW_ALBEDO.map((c) => c.toFixed(3)).join(', ')});
  const vec3 TREE_SNOW_SHADE = vec3(${SNOW_SHADE_TINT.map((c) => c.toFixed(3)).join(', ')});
  float treeSnowHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float treeSnowNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(treeSnowHash(i), treeSnowHash(i + vec3(1, 0, 0)), f.x), mix(treeSnowHash(i + vec3(0, 1, 0)), treeSnowHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(treeSnowHash(i + vec3(0, 0, 1)), treeSnowHash(i + vec3(1, 0, 1)), f.x), mix(treeSnowHash(i + vec3(0, 1, 1)), treeSnowHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  // 0..1 snow on a fragment: up = how much the visible face looks up, hold = the vertex's snowHold,
  // y = height in the tree (0 base .. 1 top), n = the 0.3 m noise, load = the tree's load, ghost 0..1
  // k scales the amount for a LOD whose surfaces stand in for many cards (LOD1's cones)
  float treeSnowCov(float up, float hold, float y, float n, float load, float ghost, float k) {
    // a heavy load drapes over the edges of the boughs, not only their flat tops (the cards; a cone's
    // sides already stand in for them)
    float drape = k >= 1.0 ? load : 0.0;
    float face = smoothstep(-0.3 * drape, 0.5 - 0.2 * drape, up);
    float amount = load * hold * (1.1 - 0.3 * y) * k;
    float cov = face * smoothstep(-0.12, 0.12, amount * 1.35 - 1.0 + n);
    // rime: a ghost is white on every side, a little patchy
    return max(cov, ghost * load * smoothstep(-0.1, 0.25, n + 0.3 * up));
  }
  // the cards' alpha grows on a ghost so the gaps between the sprays fill in
  float treeSnowAlpha(float a, float n, float ghost) { return clamp(a * (1.0 + 2.0 * ghost) + 0.3 * ghost * n, 0.0, 1.0); }
`;

/** the snow, fill and translucency on the shared needle and snow lighting (both shaders); `alb` is the needle albedo */
export const TREE_SNOW_LIGHT = /* glsl */ `
  uniform vec3 uTreeSunDir; uniform vec3 uTreeSunColor; uniform vec3 uTreeGround;
  // what the needles add to the standard lighting: v toward the camera, n the crown normal (world), all unshadowed
  vec3 treeNeedleExtra(vec3 alb, vec3 n, vec3 v, float cov) {
    // the snow under the crown lights its underside (a share of the hemisphere's ground term the
    // standard material already gives it), tinted a little blue-green like the light through the boughs
    vec3 fill = uTreeGround * vec3(0.85, 1.0, 1.05) * 0.35 * clamp(0.6 - 0.6 * n.y, 0.0, 1.0);
    // translucency: the sun behind the needles shows through them, yellow-green
    float back = pow(clamp(dot(-v, uTreeSunDir), 0.0, 1.0), 4.0) * smoothstep(0.0, 0.15, uTreeSunDir.y);
    vec3 trans = uTreeSunColor * vec3(0.9, 1.15, 0.5) * 0.35 * back;
    return alb * (fill + trans) * (1.0 - cov) * 0.31830989;
  }
`;
