import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { StandsMeta } from '../pack/types';
import { decodeRGBA } from '../pack/MaskSet';
import type { Collider } from '../sim/Collider';
import { TreeKit, SPECIES_COUNT, VARIANTS, speciesFor, variantFor, crownRadius, hash01, fadeWidth, farFadeWidth, farAttrs, farGeometry, generateStems, setGhostBand, crownWidthsOf, kitUniforms, type FarAttrs, type StandGrid, type CrownWidthsMeta } from './trees';
import { treelineOf } from '../pack/treeline';
import { TreeShade } from './TreeShade';
import { crownOverlap, type CrownHit } from './TreeBrush';
import { ClumpCanopy } from './trees/clumps';

/**
 * Streams tree instances per 1 km cell around the rider and draws them with the FEAT-156 tree kit
 * (trees/): ten species, four variants each, and four LODs picked per tree by its distance from the
 * camera, with a dither crossfade at each edge:
 *   LOD0 branch cards  0..800 m     one InstancedMesh per species x variant, from the trees near the camera
 *   LOD1 cones         b0..b1       the same, from a wider ring (80..400 m originally; none left on High and Medium, where LOD0 reaches the LOD1 edge)
 *   LOD2 crossed quads 400..1500 m  one mesh per cell (all species), from the baked impostor atlas
 *   impostors          1500..4500 m one mesh per cell, camera-facing quads from the same atlas
 * The two near sets are rebuilt on the CPU when the camera has moved part of their margin; the far
 * meshes hold the cell's trees in the 100 m sub-tiles that reach their band, and the shader drops the
 * trees outside it. Distances scale with the graphics setting (setVegetationDensity / setVegetationBudget).
 *
 * FEAT-074: a pack with stand density (meta.stands) holds only the detected crowns; a cell within
 * STAND_MID m past the near radius adds the stems its stand image asks for (trees/stands.ts), so they draw
 * at every near LOD and as impostors in the mid ring, and nothing beyond, where the terrain's cover shades
 * the forest. The Forest setting (setStandDensity) scales only these stems. They are solid (in the collider)
 * only in the cells round the rider.
 *
 * FEAT-158: the near sets are culled per sub-tile against the view (`cull`, before each frame's draw):
 * only the tiles in view, or whose trees' shadows can reach into it, sit at the front of the instance
 * buffers, and of those the ones inside the sun's shadow camera come first, so the shadow pass draws
 * only that prefix. A far mesh repacks its sub-tiles once the camera has moved enough for its band to reach a
 * tile it left out, so the cells round the camera no longer draw every tree as a collapsed quad.
 */
let NEAR_RADIUS = 1500;
/** how far the impostors reach (m); past THIN_RADIUS they thin (BUG-081, trees/materials.ts THIN_GLSL) */
let FAR_RADIUS = 9000;
let THIN_RADIUS = 4500;
/** BUG-081: the impostors reach this many times the thinning start, so the ridges round the resort carry trees */
const FAR_REACH_K = 2;
/**
 * BUG-081: past the generated stems' reach (FEAT-074) a pack draws its detected crowns alone, and on Vail the stems
 * hold 4.2 times the crowns' canopy (crowns 0.064 of the ground, stems 0.28, the same in closed stands). The
 * impostors there grow by about the square root of 5.2 so the crowns stand in for the stems, and the terrain lets
 * them carry the forest (TerrainMaterial FOREST_DRAWN_FAR) instead of laying flat timber over the ground between.
 */
const STEM_GROW = 2.2;
// FEAT-298: a pack with crown widths holds the same canopy with wider crowns and fewer stems, so its crowns grow by
// less: STEM_GROW / sqrt(crownWidths.crownArea), the detected crowns' drawn area over their area at the species radii
/** LOD1 reach as a share of 400 m */
let LOD_K = 1;
/** BUG-107: how far the LOD0 branch cards reach (m), set by the graphics setting (`lod0ForDensity`, 200 m on Low) */
let LOD0_REACH = 800;
/** BUG-107: `?lod0=<m>` in place of the setting's reach, null without it */
let LOD0_OVERRIDE: number | null = null;
/**
 * BUG-107: the LOD0 reach (m) for a Trees setting 0.25..1: High (1) 800, Medium (0.6) 400, the Low preset's 0.3 200, in
 * straight lines between. Drew judged 800 m on High; up to 2026-11-13 it was 80 m, and the cones past it read as stand-ins.
 */
export function lod0ForDensity(k: number): number { return k >= 0.6 ? 400 + (k - 0.6) / 0.4 * 400 : 200 + Math.max(0, k - 0.3) / 0.3 * 200; }
/** FEAT-158: false on the Low preset: LOD1 cones from the camera out, no LOD0 cards */
let LOD0_ON = true;
/** FEAT-167: bumped whenever the radii change, so update() redoes the LOD bands only then */
let bandsVersion = 0;
/** FEAT-074: the share of the stand density drawn (the Forest setting), 0..1 */
let STAND_K = 1;
/** FEAT-074: generated stems reach this far past the near radius, into the impostor ring (m) */
const STAND_MID = 1000;
/** a cell keeps its stems until it is this much farther out (m), so it does not regenerate at each crossing */
const STAND_HYST = 250;
/** generated stems are solid (in the collider) only in cells this close to the rider (m) */
const STAND_COLLIDE = 150;
/** FEAT-074: draw this share (0..1) of the pack's stand density; the detected crowns always draw */
export function setStandDensity(k: number): void { STAND_K = Math.max(0, Math.min(1, k)); }
/** FEAT-292: the clump impostors' band, set each update by the Vegetation that draws them (null: none) */
let CLUMP_BAND: { near: number; fade: number; far: number } | null = null;
/** FEAT-292: the clumps reach at least this far (m), whatever the trees' own reach (`?clumpfar=`) */
const CLUMP_FAR_MIN = 9000;
/** BUG-130: no clumps unless they would draw over at least this many metres past the trees */
const CLUMP_MIN_BAND = 600;
/** BUG-130: the Low preset's fixed reach (setVegetationBudget) is on: there the clumps take over from the trees at it */
let LOW_REACH = false;
/** FEAT-153: how far the drawn forest reaches (m), where the terrain's canopy lift takes over: the tree impostors' far
 *  edge, or the clump impostors' where they draw (FEAT-292) */
export function vegetationFarRadius(): number { return CLUMP_BAND ? CLUMP_BAND.far : FAR_RADIUS; }
/** FEAT-292: where the clump impostors take over from the trees (`near`, over +-`fade`) and how far they reach (m), or null without them */
export function vegetationClumpBand(): { near: number; fade: number; far: number } | null { return CLUMP_BAND; }
/** FEAT-159: the near radius (1500 m at full density); the shrubs scale their 300 m reach by it */
export function vegetationNearRadius(): number { return NEAR_RADIUS; }
/** BUG-081: where the generated stems stop (m), past which the crowns grow to stand in for them */
export function vegetationStemReach(): number { return NEAR_RADIUS + STAND_MID; }
/** BUG-107: `?lod0=<m>`: the LOD0 reach on every setting */
export function setLod0Reach(m: number): void { LOD0_OVERRIDE = Math.max(10, m); bandsVersion++; }
/** Headless / weak GPU (the Low preset): far fewer instances; LOD0 to `lod0` m, 0 for none (LOD1 from the camera out, `?lowgfx`). */
export function setVegetationBudget(near: number, far: number, lod0: number): void { LOW_REACH = true; NEAR_RADIUS = near; FAR_RADIUS = THIN_RADIUS = far; LOD_K = Math.max(0.5, Math.min(1, near / 1500)); LOD0_ON = lod0 > 0; LOD0_REACH = lod0; bandsVersion++; }
/** Scale the near/far radii by a 0.25..1 density (1 = full 1500 m, thinning from 4500 m out to 9000 m); the LOD0 / LOD1 reach scales more gently. */
export function setVegetationDensity(d: number): void { LOW_REACH = false; const k = Math.max(0.25, Math.min(1, d)); NEAR_RADIUS = 1500 * k; THIN_RADIUS = 4500 * k; FAR_RADIUS = THIN_RADIUS * FAR_REACH_K; LOD_K = 0.6 + 0.4 * k; LOD0_ON = true; LOD0_REACH = lod0ForDensity(k); bandsVersion++; }

/**
 * BUG-121: the impostors run on, thinning, this far (m) past FAR_RADIUS, and end over the last farFadeWidth of it. They
 * used to stop wherever the loaded 1 km cells did (cells whose centre is within FAR_RADIUS plus their half-diagonal), on
 * average about this far out, so on the Low preset whole rows of trees appeared on the skyline as each cell arrived.
 */
const TREE_TAIL = 700;
/** BUG-121: where the drawn trees end (m from the camera) */
const treeEnd = (): number => FAR_RADIUS + TREE_TAIL;
/** BUG-121: where the drawn trees start to go (m, horizontal, from the camera) and where none are left */
export function vegetationTreeEnd(): [number, number] {
  // FEAT-292: with the clump impostors the trees end at the handover instead
  if (CLUMP_BAND) return [CLUMP_BAND.near - CLUMP_BAND.fade, CLUMP_BAND.near + CLUMP_BAND.fade];
  const e = treeEnd();
  return [e - farFadeWidth(e), e];
}
/** the LOD band edges for the current setting (m from the camera), into `out`; out[0] is 0 without LOD0, out[3] is where the trees end */
function edges(out: number[]): void {
  // BUG-107: a LOD0 reach past the LOD1 edge takes that edge out with it (no cones left), up to 0.8 of the near radius
  const b2 = NEAR_RADIUS, b0 = LOD0_ON ? Math.min(LOD0_OVERRIDE ?? LOD0_REACH, b2 * 0.8) : 0;
  const b1 = Math.min(Math.max(400 * LOD_K, b0), b2 * 0.8);
  out[0] = b0; out[1] = b1; out[2] = b2; out[3] = treeEnd();
}

/** sub-tiles per cell side for the near-set gather and the far packing */
const TILES = 10;
/** FEAT-217: the widest crown a rider can brush, plus the body (m): a 40 m spruce's 6.5 m */
const CROWN_REACH = 8;
const TILE_N = TILES * TILES;
/** the near sets are rebuilt once the camera has moved this far from where they were gathered (m) */
const MARGIN0 = 25, MARGIN1 = 60;
/** krummholz flags stream downwind: the prevailing westerlies blow toward +x (east) */
const FLAG_YAW = 0;
/** FEAT-158: the near sets' cull tiles (m), LOD0 and LOD1 */
const NEAR_TILE = [25, 50];
/** a near tile is packed with this much slack round the view (m), so turning repacks only now and then */
const CULL_GROW = [15, 40];
/** the longest shadow a near tree is kept for when its tile is out of view (m) */
const SWEEP_MAX = 200;
/** a far mesh checks its tiles after the camera moves this far (m), and packs this much past its band (m) */
const FAR_CHECK = 15, FAR_GROW = 150;
/** BUG-081: an impostor mesh packs the trees it may show from THIN_SLACK m nearer than the camera, and repacks
 * once the camera has moved half that */
const THIN_SLACK = 400;
/**
 * BUG-121: cells load this far (m) past where the trees end (treeEnd), so a cell's trees and stems are in and built
 * before the camera is close enough for any of them to show; they come in tree by tree over the far edge
 */
const STREAM_AHEAD = 250;
/** BUG-081: the share of the impostors that stay at d m from the camera (trees/materials.ts THIN_GLSL; BUG-121: none past treeEnd) */
const thinKeep = (d: number): number => {
  const e1 = treeEnd(), e0 = e1 - farFadeWidth(e1), t = Math.min(1, Math.max(0, (d - e0) / (e1 - e0)));
  return (d <= THIN_RADIUS ? 1 : (THIN_RADIUS / d) ** 2) * (1 - t * t * (3 - 2 * t));
};

/** one far LOD mesh of a cell: its own instance buffers, holding the trees of the tiles in `mask` */
interface FarMesh {
  mesh: THREE.Mesh;
  attrs: FarAttrs;
  mask: Uint8Array;
  count: number;
  /** BUG-081: the impostors, which thin past THIN_RADIUS; true once a pack left trees out for it */
  thin: boolean;
  thinned: boolean;
  /** where the camera was (pack metres) when the trees were last packed */
  px: number;
  py: number;
  /** where the camera was (pack metres) and the band epoch at the last tile check */
  x: number;
  y: number;
  epoch: number;
}

interface Cell {
  key: string;
  cx: number;
  cy: number;
  /** the records drawn: the pack's (`base`), then the generated stems (FEAT-074) */
  data: Float32Array | null;
  base: Float32Array | null;
  /** FEAT-074: the decoded stand image; 0 not asked, 1 loading, 2 ready, 3 none */
  stand: StandGrid | null;
  standState: number;
  /** the density the stems in `data` were generated at (0 = none) and their collider entries (null = not solid) */
  gen: number;
  col: Float32Array[] | null;
  /** BUG-082: the pack's own trunks' collider entries, removed one by one when the cell drops (never a whole-cell clear) */
  own: Float32Array[] | null;
  /** BUG-082: dropped while its records were still loading, so the load adds nothing */
  dropped: boolean;
  /** per tree: kit species, variant, crown radius (m), yaw, colour variation (3) */
  sp: Uint8Array | null;
  va: Uint8Array | null;
  cr: Float32Array | null;
  yaw: Float32Array | null;
  tint: Float32Array | null;
  /** BUG-081: the impostor thinning draw per tree, 0..1 (trees/materials.ts THIN_GLSL) */
  thin: Float32Array | null;
  /** tree indices grouped by sub-tile; tile t holds order[tileStart[t] .. tileStart[t + 1]) */
  order: Uint32Array | null;
  tileStart: Uint32Array | null;
  zMin: number;
  zMax: number;
  lod2: FarMesh | null;
  imp: FarMesh | null;
  loading: boolean;
  missing: boolean;
  /** FEAT-171: handed to the shade map */
  shaded: boolean;
}

/**
 * One near LOD: an InstancedMesh per species x variant, filled from the trees within `radius` of where
 * it was gathered. The gathered instances are staged per species x variant (`stM`, `stC`, their tile in
 * `stT`; kit combo k holds entries kStart[k] .. kStart[k + 1]); the meshes hold the staged instances of
 * the tiles in `packed`.
 */
interface NearSet {
  lod: 0 | 1;
  meshes: (THREE.InstancedMesh | null)[];
  /** per kit combo: (cell ref, tree index, tile) triples (scratch for the gather) */
  lists: number[][];
  stM: Float32Array;
  stC: Float32Array;
  stT: Int32Array;
  kStart: Int32Array;
  /** per tile, 7 floats: minX, minY, maxX, maxY (pack metres), zMin, zMax (base to top), tallest tree */
  tiles: Float32Array;
  tileCount: number;
  /** per tile: in the buffers; and in the shadow pass's prefix of them */
  packed: Uint8Array;
  cast: Uint8Array;
  x: number;
  y: number;
  radius: number;
  dirty: boolean;
  /** instances gathered, instances in the buffers */
  count: number;
  drawn: number;
}

const newNear = (lod: 0 | 1): NearSet => ({
  lod, meshes: new Array(SPECIES_COUNT * VARIANTS).fill(null), lists: [],
  stM: new Float32Array(0), stC: new Float32Array(0), stT: new Int32Array(0), kStart: new Int32Array(SPECIES_COUNT * VARIANTS + 1),
  tiles: new Float32Array(0), tileCount: 0, packed: new Uint8Array(0), cast: new Uint8Array(0),
  x: NaN, y: NaN, radius: 0, dirty: true, count: 0, drawn: 0,
});

export class Vegetation {
  readonly group = new THREE.Group();
  readonly kit: TreeKit;
  /** the lit materials (for the cascaded shadows) */
  readonly mat: { lod0: THREE.MeshStandardMaterial; lod1: THREE.MeshStandardMaterial };
  private readonly pack: Pack;
  private readonly collider: Collider | null;
  private readonly cells = new Map<string, Cell>();
  /** instances: in loaded cells; lod0 / lod1: in the near buffers (after culling); far: in the far buffers; *Packs: buffer refills so far */
  readonly stats = { cells: 0, instances: 0, lod0: 0, lod1: 0, far: 0, nearPacks: 0, farPacks: 0, stems: 0, stemGens: 0 };
  /** BUG-063: stop building cell meshes after this many ms per update (0 = no limit; headless keeps 0) */
  budgetMs = 0;
  /** BUG-063: cells in range still downloading or waiting for their meshes after the last update */
  pending = 0;
  private readonly near: NearSet[] = [newNear(0), newNear(1)];
  private impostorsOn = true;
  private readonly cam = new THREE.Vector3(NaN, 0, 0);
  private readonly legacy: boolean;
  /** FEAT-298: the pack's crown widths (record field 4 is the radius to draw, stands carry a width factor), or null */
  private readonly widths: CrownWidthsMeta | null;
  /** the band edges in use and the bandsVersion they were taken at (-1: redo on the next update) */
  private readonly band = [80, 400, 1500, 4500];
  private bandSeen = -1;
  /** bumped whenever the bands are redone, so the far meshes recheck their tiles */
  private bandEpoch = 0;
  /** the cells in range this update (reused, so update() allocates no set per frame) */
  private readonly keep = new Set<string>();
  /** FEAT-171: the drawn trees' shadows past the shadow map, for the terrain shader (after `enableImpostors`) */
  shade: TreeShade | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly sunDir = new THREE.Vector3(0.4, 0.8, 0.4);
  private readonly height = (x: number, y: number): number => this.pack.demHeight(x, y);
  /** FEAT-158: the view the near sets are culled against (none until the first `cull`: everything packed) */
  private readonly frustum = new THREE.Frustum();
  private viewOk = false;
  /** the sun's shadow camera's frustum, or null: every packed tile casts (cascaded shadows, or no `cull` yet) */
  private shadowFrustum: THREE.Frustum | null = null;
  private readonly projView = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  /** gather scratch: a near-grid tile (gy * 65536 + gx) to the near set's tile index */
  private readonly tileIds = new Map<number, number>();
  /** FEAT-074: the tree cells with a stand image */
  private readonly standCells: Set<string>;
  /** FEAT-292: the far forest past the drawn trees as clump impostors (trees/clumps.ts); null when off or the pack has no cover levels */
  clumps: ClumpCanopy | null = null;
  private clumpFarMin = CLUMP_FAR_MIN;

  constructor(pack: Pack, collider: Collider | null) {
    this.pack = pack;
    this.collider = collider;
    this.kit = new TreeKit();
    this.mat = this.kit.mat;
    CLUMP_BAND = null; // FEAT-292: module state, as the radii: this pack's own once its clumps draw
    setGhostBand(treelineOf(pack.meta)); // DATA-021: the uniform is shared, so each pack sets its own
    // packs from before DATA-020 have 0 conifer, 1 aspen, 2 krummholz only
    this.legacy = pack.meta.treeSpecies === undefined;
    this.widths = crownWidthsOf(pack.meta);
    kitUniforms.uKitCore.value = this.widths ? 1 : 0; // FEAT-298: module state, as the radii: this pack's own
    this.standCells = new Set(pack.meta.stands?.cells ?? []);
  }

  /** Bake the LOD2 / impostor atlases (needs the renderer). `on` false: no billboards, LOD2 runs to the far edge. */
  enableImpostors(renderer: THREE.WebGLRenderer, on = true, shadeSize = 2048): void {
    this.kit.bake(renderer);
    this.renderer = renderer;
    if (!this.shade || this.shade.size !== shadeSize) { this.shade?.dispose(); this.shade = shadeSize > 0 ? new TreeShade(shadeSize) : null; for (const c of this.cells.values()) c.shaded = false; }
    this.impostorsOn = on;
    this.bandSeen = -1;
  }
  /**
   * FEAT-292: draw the far forest as clump impostors from where the full-density trees end out to at least `farMin` m
   * (after `enableImpostors`: it bakes from the kit, a few stand tiles per update). Needs the pack's cover levels to
   * place them; without, nothing changes.
   */
  enableClumps(renderer: THREE.WebGLRenderer, farMin = CLUMP_FAR_MIN): void {
    if (this.clumps || !this.pack.cover) return;
    this.clumpFarMin = farMin;
    this.clumps = new ClumpCanopy(this.pack, renderer, this.kit.atlas.texture, this.kit.geo.lod0);
    this.group.add(this.clumps.mesh);
    this.bandSeen = -1;
  }

  /** Light the far LODs like the meshes: the sun (direction toward it) and the hemisphere light. */
  setLight(sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number, hemiSky: THREE.Color, hemiGround: THREE.Color, hemiIntensity: number): void {
    this.kit.setLight(sunDir, sunColor, sunIntensity, hemiSky, hemiGround, hemiIntensity);
    this.sunDir.copy(sunDir);
  }
  /** FEAT-171: where the near trees stop casting into the shadow map (m from the camera): the LOD1 edge's crossfade */
  castReach(): [number, number] { const b1 = this.band[1], f = fadeWidth(b1) / 2; return [b1 - f, b1 + f]; }

  /**
   * Stream cells around the rider (x, y) and the look-ahead point (ax, ay): a cell's distance is to the
   * nearer of the two. `cam` (three.js world) is where the LOD bands are measured from; it defaults to
   * the last one given, or the rider.
   */
  update(x: number, y: number, ax = x, ay = y, cam?: THREE.Vector3): void {
    const inst = this.pack.meta.instances;
    if (!inst) return;
    if (cam) this.cam.copy(cam);
    else if (Number.isNaN(this.cam.x)) this.cam.set(x, 0, -y);
    this.kit.setView(this.cam, performance.now() / 1000);
    const cpx = this.cam.x, cpy = -this.cam.z;
    // LOD bands for the current setting
    const band = this.band;
    if (this.bandSeen !== bandsVersion) {
      this.bandSeen = bandsVersion;
      this.bandEpoch++;
      edges(band);
      this.kit.setBands(band[0], band[1], band[2], band[3], this.impostorsOn);
      this.kit.setThin(THIN_RADIUS);
      // only a pack with stands has stems to stand in for (older packs hold fill trees instead)
      this.kit.setStemGrow(this.pack.meta.stands && STAND_K > 0 ? NEAR_RADIUS + STAND_MID : 1e8, STEM_GROW / Math.sqrt(this.widths?.crownArea ?? 1));
      for (const n of this.near) n.dirty = true;
    }
    const b0 = band[0], b1 = band[1], b2 = band[2];
    const cs = inst.cellSize;
    // BUG-121: the impostors run on to band[3], thinning out to none, and cells load STREAM_AHEAD past it
    let reachR = band[3] + STREAM_AHEAD;
    if (this.clumps) {
      // FEAT-292, BUG-130: where the clump impostors take over. On the Low preset (LOW_REACH) the trees stop at their
      // 600 m and the clumps carry everything past it: the impostors dissolve out there, the clumps dissolve in over
      // the same metres, and no tree cell past it is loaded. With the Trees setting (Medium, High) the per-tree trees
      // keep their own reach and their own end, which is the look High is judged by, and the clumps only dissolve in
      // over that end's fade; where the trees already reach as far as the clumps would (High) there are none, and
      // they are never baked.
      const far = Math.max(FAR_RADIUS, this.clumpFarMin);
      let c0: number, fc: number;
      if (LOW_REACH) { c0 = FAR_RADIUS; fc = Math.max(40, 0.08 * c0); }
      else { const e1 = treeEnd(), e0 = e1 - farFadeWidth(e1); c0 = (e0 + e1) / 2; fc = (e1 - e0) / 2; }
      if (c0 + fc < far - CLUMP_MIN_BAND) {
        const cb = CLUMP_BAND ?? (CLUMP_BAND = { near: 0, fade: 0, far: 0 });
        cb.near = c0; cb.fade = fc; cb.far = far;
        if (LOW_REACH) {
          if (this.impostorsOn) { this.kit.bands.imp.value.z = c0 - fc; this.kit.bands.imp.value.w = c0 + fc; }
          reachR = Math.min(reachR, c0 + fc + 100);
        }
        this.clumps.update(cpx, cpy, c0, fc, far, this.budgetMs);
      } else if (CLUMP_BAND) { CLUMP_BAND = null; this.clumps.off(); }
    }
    const r = reachR;
    // BUG-081: the far tree ring runs `treeRing` cells past the grid on every side
    const ring = inst.farTreeCells?.length ? (inst.treeRing ?? 0) : 0;
    const cx0 = Math.max(-ring, Math.floor((Math.min(x, ax) - r - inst.minX) / cs)), cx1 = Math.min(inst.cellsX - 1 + ring, Math.floor((Math.max(x, ax) + r - inst.minX) / cs));
    const cy0 = Math.max(-ring, Math.floor((Math.min(y, ay) - r - inst.minY) / cs)), cy1 = Math.min(inst.cellsY - 1 + ring, Math.floor((Math.max(y, ay) + r - inst.minY) / cs));
    const keep = this.keep;
    keep.clear();
    let count = 0, pending = 0, built = 0, farCount = 0, stems = 0;
    const stands = this.pack.meta.stands, standReach = NEAR_RADIUS + STAND_MID;
    const t0 = performance.now();
    const f1 = fadeWidth(b1) / 2, f2 = fadeWidth(b2) / 2;
    // the distances each far LOD draws at (the shader's bands; BUG-121: the last one ends where the trees do)
    const lo2 = b1 - f1, hi2 = this.impostorsOn ? b2 + f2 : band[3], loImp = b2 - f2, hiImp = band[3];
    const far = this.kit.far;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const ccx = inst.minX + (cx + 0.5) * cs, ccy = inst.minY + (cy + 0.5) * cs;
        const d = Math.min(Math.hypot(ccx - x, ccy - y), Math.hypot(ccx - ax, ccy - ay)) - cs * 0.71;
        if (d > reachR) continue;
        const key = `${cx}_${cy}`;
        keep.add(key);
        let cell = this.cells.get(key);
        if (!cell) {
          cell = { key, cx, cy, data: null, base: null, stand: null, standState: 0, gen: 0, col: null, own: null, dropped: false, sp: null, va: null, cr: null, yaw: null, tint: null, thin: null, order: null, tileStart: null, zMin: 0, zMax: 0, lod2: null, imp: null, loading: false, missing: false, shaded: false };
          this.cells.set(key, cell);
        }
        if (!cell.data && !cell.loading && !cell.missing) this.load(cell);
        if (cell.loading) pending++;
        if (!cell.data) continue;
        if (stands) {
          // FEAT-074: the stand's stems in the near and mid rings, solid round the rider
          const want = d < (cell.gen > 0 ? standReach + STAND_HYST : standReach) ? STAND_K : 0;
          if (want > 0 && cell.standState === 0) void this.loadStand(cell, stands);
          if (cell.standState === 1) pending++;
          const target = cell.standState === 2 ? want : 0;
          if (target !== cell.gen) {
            if (this.budgetMs <= 0 || built === 0 || performance.now() - t0 < this.budgetMs) { this.regenerate(cell, target); built++; }
            else pending++;
          }
          const solid = cell.gen > 0 && d < STAND_COLLIDE;
          if (solid !== (cell.col !== null)) this.setSolid(cell, solid);
          stems += (cell.data.length - cell.base!.length) / 6;
        }
        count += cell.data.length / 6;
        if (this.shade && !cell.shaded) { cell.shaded = true; this.shade.addCell(key, inst.minX + cx * cs, inst.minY + cy * cs, cs, cell.data, cell.cr!, cell.sp!, this.height); }
        if (!far) { pending++; continue; } // waiting for the impostor bake
        // which far LODs this cell needs, from the camera's nearest and farthest distance to it
        const minX = inst.minX + cx * cs, minY = inst.minY + cy * cs;
        const dx = Math.max(minX - cpx, 0, cpx - minX - cs), dy = Math.max(minY - cpy, 0, cpy - minY - cs);
        const dMin = Math.hypot(dx, dy);
        const dMax = Math.hypot(Math.max(Math.abs(cpx - minX), Math.abs(cpx - minX - cs)), Math.max(Math.abs(cpy - minY), Math.abs(cpy - minY - cs)));
        const wantLod2 = dMax > lo2 && dMin < hi2;
        const wantImp = this.impostorsOn && dMax > loImp && dMin < hiImp;
        if ((wantLod2 && !cell.lod2) || (wantImp && !cell.imp)) {
          // BUG-063: at least one build per update, then only while inside the time budget
          if (this.budgetMs <= 0 || built === 0 || performance.now() - t0 < this.budgetMs) { this.buildFar(cell, wantLod2, wantImp, lo2, hi2, loImp, hiImp); built++; }
          else pending++;
        }
        // a far mesh repacks its tiles when its band has come to reach one it left out (cheap: no build budget)
        if (cell.lod2) { if (wantLod2) this.checkFar(cell, cell.lod2, lo2, hi2); cell.lod2.mesh.visible = wantLod2 && cell.lod2.count > 0; if (cell.lod2.mesh.visible) farCount += cell.lod2.count; }
        if (cell.imp) { if (wantImp) this.checkFar(cell, cell.imp, loImp, hiImp); cell.imp.mesh.visible = wantImp && cell.imp.count > 0; if (cell.imp.mesh.visible) farCount += cell.imp.count; }
      }
    }
    for (const [key, cell] of this.cells) {
      if (keep.has(key)) continue;
      this.dropCell(cell);
      this.shade?.removeCell(key);
      // BUG-082: only this cell's own trunks and stems; the landmark and building posts and the rocks in its square kilometre stay
      if (cell.col) this.setSolid(cell, false);
      if (cell.own && this.collider) this.collider.removeAll(cell.own);
      cell.own = null;
      cell.dropped = true;
      this.cells.delete(key);
      for (const n of this.near) n.dirty = true;
    }
    // the near sets: regather once the camera has moved part of their margin
    for (const n of this.near) {
      if (n.lod === 0 && b0 <= 0) { if (n.count) this.clearNear(n); continue; } // no LOD0 on this setting
      const margin = n.lod === 0 ? MARGIN0 : MARGIN1;
      const reach = (n.lod === 0 ? b0 + fadeWidth(b0) / 2 : b1 + f1) + margin;
      if (n.dirty || Math.hypot(cpx - n.x, cpy - n.y) > margin || Math.abs(reach - n.radius) > 1) this.gather(n, cpx, cpy, reach);
    }
    if (this.shade && this.renderer) this.shade.update(this.renderer, cpx, cpy, this.sunDir);
    this.pending = pending + (CLUMP_BAND && this.clumps ? this.clumps.busy : 0);
    this.stats.cells = this.cells.size;
    this.stats.instances = count;
    this.stats.stems = stems;
    this.stats.lod0 = this.near[0].drawn;
    this.stats.lod1 = this.near[1].drawn;
    this.stats.far = farCount;
  }

  /**
   * FEAT-158: before each draw, with the camera it is drawn from and the single shadow-casting sun (null
   * with cascaded shadows: every packed tile casts): repack a near set when a tile now in view (or
   * throwing its shadow into it) is not in its buffers, or one inside the shadow camera is not in the
   * shadow pass's prefix. Without a call nothing is culled.
   */
  cull(camera: THREE.Camera, sun: THREE.DirectionalLight | null = null): void {
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.viewOk = true;
    const castMode = !!sun !== !!this.shadowFrustum;
    if (sun) { sun.updateMatrixWorld(); sun.target.updateMatrixWorld(); sun.shadow.updateMatrices(sun); this.shadowFrustum = sun.shadow.getFrustum(); }
    else this.shadowFrustum = null;
    for (const n of this.near) {
      if (n.tileCount === 0) continue;
      if (castMode) { this.packNear(n); continue; }
      for (let t = 0; t < n.tileCount; t++) {
        if (n.packed[t] ? !n.cast[t] && this.castWanted(n, t, 0) : this.tileWanted(n, t, 0)) { this.packNear(n); break; }
      }
    }
    this.stats.lod0 = this.near[0].drawn;
    this.stats.lod1 = this.near[1].drawn;
  }

  /** whether a near tile's trees can show: inside the LOD's band and in view, or casting a shadow into it (`grow` m of slack) */
  private tileWanted(n: NearSet, t: number, grow: number): boolean {
    const tl = n.tiles, o = t * 7;
    const minX = tl[o], minY = tl[o + 1], maxX = tl[o + 2], maxY = tl[o + 3], zMin = tl[o + 4], zMax = tl[o + 5], hMax = tl[o + 6];
    const cpx = this.cam.x, cpy = -this.cam.z, cpz = this.cam.y;
    // the band (the shader's, measured to the tree's base): LOD0 to b0, LOD1 from b0 to b1
    const b0 = this.band[0], b1 = this.band[1];
    const lo = n.lod === 0 || b0 <= 0 ? -Infinity : b0 - fadeWidth(b0) / 2;
    const hi = n.lod === 0 ? b0 + fadeWidth(b0) / 2 : b1 + fadeWidth(b1) / 2;
    const dMin = Math.hypot(Math.max(minX - cpx, 0, cpx - maxX), Math.max(minY - cpy, 0, cpy - maxY));
    if (dMin > hi + grow) return false;
    const dMax = Math.hypot(Math.max(Math.abs(cpx - minX), Math.abs(cpx - maxX)), Math.max(Math.abs(cpy - minY), Math.abs(cpy - maxY)), Math.max(Math.abs(cpz - zMin), Math.abs(cpz - zMax)));
    if (dMax < lo - grow) return false;
    if (!this.viewOk) return true;
    // the tile's box in three.js world (x east, y up, z = -north), grown, and stretched away from the sun by its longest shadow
    const b = this.box;
    b.min.set(minX - grow, zMin - grow, -maxY - grow);
    b.max.set(maxX + grow, zMax + grow, -minY + grow);
    const s = this.sunDir, hz = Math.hypot(s.x, s.z);
    if (this.renderer?.shadowMap.enabled !== false && hz > 1e-3) {
      const len = Math.min(SWEEP_MAX, hMax * hz / Math.max(s.y, 0.05));
      const ox = -s.x / hz * len, oz = -s.z / hz * len;
      if (ox < 0) b.min.x += ox; else b.max.x += ox;
      if (oz < 0) b.min.z += oz; else b.max.z += oz;
    }
    return this.frustum.intersectsBox(b);
  }

  /** whether a packed near tile is inside the sun's shadow camera (`grow` m of slack) */
  private castWanted(n: NearSet, t: number, grow: number): boolean {
    if (!this.shadowFrustum) return true;
    const tl = n.tiles, o = t * 7, b = this.box;
    b.min.set(tl[o] - grow, tl[o + 4] - grow, -tl[o + 3] - grow);
    b.max.set(tl[o + 2] + grow, tl[o + 5] + grow, -tl[o + 1] + grow);
    return this.shadowFrustum.intersectsBox(b);
  }

  private async load(cell: Cell): Promise<void> {
    cell.loading = true;
    const ins = this.pack.meta.instances;
    const listed = ins?.treeCells;
    // a cell with no detected crowns may still have a stand (FEAT-074): it loads empty and generates its stems
    const empty = (): void => { if (this.standCells.has(cell.key)) { cell.base = cell.data = new Float32Array(0); this.prepare(cell); } else cell.missing = true; };
    // BUG-081: the crowns outside the pack bounds, in the ring and the grid's edge cells
    const farListed = ins?.farTreeCells?.includes(cell.key) ?? false;
    const inGrid = !!ins && cell.cx >= 0 && cell.cy >= 0 && cell.cx < ins.cellsX && cell.cy < ins.cellsY;
    const ownListed = inGrid && (!listed || listed.includes(cell.key));
    if (!ownListed && !farListed) { empty(); cell.loading = false; return; } // empty cell, no request
    try {
      const get = async (dir: string, want: boolean): Promise<Float32Array | null> => {
        if (!want) return null;
        const resp = await fetch(`${this.pack.baseUrl}/${dir}/${cell.key}.bin`);
        return resp.ok ? new Float32Array(await resp.arrayBuffer()) : null;
      };
      const [own, far] = await Promise.all([get('trees', ownListed), get('farTrees', farListed)]);
      if (cell.dropped) return; // BUG-082: the rider left before it arrived; a later visit loads a new cell
      if (!own && !far) { empty(); return; }
      let data = own ?? far!;
      if (own && far) { data = new Float32Array(own.length + far.length); data.set(own); data.set(far, own.length); }
      cell.base = cell.data = data;
      this.prepare(cell);
      if (this.collider && own) {
        // the far crowns stand outside the pack, where nobody rides
        const d = own, col: Float32Array[] = cell.own = new Array(d.length / 6);
        for (let i = 0, k = 0; i < d.length; i += 6, k++) {
          const h = d[i + 3];
          col[k] = this.collider.add(d[i], d[i + 1], Math.max(0.15, h * 0.02), d[i + 2] - 1, d[i + 2] + h);
        }
      }
      for (const n of this.near) n.dirty = true;
    } catch {
      cell.missing = true;
    } finally {
      cell.loading = false;
    }
  }

  /** FEAT-074: fetch and decode a cell's stand image */
  private async loadStand(cell: Cell, st: StandsMeta): Promise<void> {
    cell.standState = 1;
    if (!this.standCells.has(cell.key)) { cell.standState = 3; return; }
    try {
      const resp = await fetch(`${this.pack.baseUrl}/stands/${cell.key}.png`);
      if (!resp.ok) { cell.standState = 3; return; }
      const bmp = await createImageBitmap(await resp.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const px = decodeRGBA(bmp, st.size, st.size * 2);
      bmp.close();
      const inst = this.pack.meta.instances!;
      cell.stand = { px, size: st.size, res: st.res, minX: inst.minX + cell.cx * inst.cellSize, minY: inst.minY + cell.cy * inst.cellSize, zBase: st.zBase, zScale: st.zScale, hStep: st.hStep };
      cell.standState = 2;
    } catch {
      cell.standState = 3;
    }
  }

  /** FEAT-074: redo a cell's records with its stand's stems at density k (0 = the pack's crowns only), then its LODs and shade */
  private regenerate(cell: Cell, k: number): void {
    const solid = cell.col !== null;
    if (solid) this.setSolid(cell, false);
    const base = cell.base!, stems = k > 0 && cell.stand ? generateStems(cell.stand, k, this.widths) : null;
    if (stems && stems.length) { const d = new Float32Array(base.length + stems.length); d.set(base); d.set(stems, base.length); cell.data = d; }
    else cell.data = base;
    cell.gen = k;
    this.stats.stemGens++;
    this.prepare(cell);
    this.dropCell(cell); // the far meshes rebuild with the new records
    if (this.shade && cell.shaded) { this.shade.removeCell(cell.key); cell.shaded = false; }
    for (const n of this.near) n.dirty = true;
    if (solid && k > 0) this.setSolid(cell, true);
  }

  /** FEAT-074: put a cell's generated stems in the collider, or take them out */
  private setSolid(cell: Cell, on: boolean): void {
    if (!on) { if (cell.col && this.collider) this.collider.removeAll(cell.col); cell.col = null; return; }
    const col: Float32Array[] = [];
    if (this.collider) {
      const d = cell.data!;
      for (let i = cell.base!.length; i < d.length; i += 6) {
        const h = d[i + 3];
        col.push(this.collider.add(d[i], d[i + 1], Math.max(0.15, h * 0.02), d[i + 2] - 1, d[i + 2] + h));
      }
    }
    cell.col = col;
  }

  /** the cell keys over cx0..cx1 x cy0..cy1, row by row; rebuilt only when the range changes, so the per-frame lookups allocate nothing */
  private nearKeys(cx0: number, cx1: number, cy0: number, cy1: number): string[] {
    const r = this.keyRange;
    if (r[0] !== cx0 || r[1] !== cx1 || r[2] !== cy0 || r[3] !== cy1) {
      r[0] = cx0; r[1] = cx1; r[2] = cy0; r[3] = cy1;
      this.keyCache.length = 0;
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.keyCache.push(`${cx}_${cy}`);
    }
    return this.keyCache;
  }
  private readonly keyCache: string[] = [];
  private readonly keyRange = [NaN, NaN, NaN, NaN];

  /**
   * FEAT-217: the needled crown (of the trees drawn) a rider at (x, y, z) (the board, pack metres) is
   * deepest in, into `out`; false when the body touches none (`TreeBrush.ts`, `crownOverlap`).
   */
  crownContact(x: number, y: number, z: number, out: CrownHit): boolean {
    const inst = this.pack.meta.instances;
    if (!inst) return false;
    const cs = inst.cellSize, ts = cs / TILES, reach = CROWN_REACH;
    let best = 0;
    const cx0 = Math.floor((x - reach - inst.minX) / cs), cx1 = Math.floor((x + reach - inst.minX) / cs);
    const cy0 = Math.floor((y - reach - inst.minY) / cs), cy1 = Math.floor((y + reach - inst.minY) / cs);
    const keys = this.nearKeys(cx0, cx1, cy0, cy1);
    for (let cy = cy0, k = 0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++, k++) {
      const cell = this.cells.get(keys[k]);
      if (!cell || !cell.order || z > cell.zMax || z + 2 < cell.zMin) continue;
      const d = cell.data!, cr = cell.cr!, sp = cell.sp!, minX = inst.minX + cx * cs, minY = inst.minY + cy * cs;
      const tx0 = Math.max(0, Math.floor((x - reach - minX) / ts)), tx1 = Math.min(TILES - 1, Math.floor((x + reach - minX) / ts));
      const ty0 = Math.max(0, Math.floor((y - reach - minY) / ts)), ty1 = Math.min(TILES - 1, Math.floor((y + reach - minY) / ts));
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        const t = ty * TILES + tx;
        for (let j = cell.tileStart![t]; j < cell.tileStart![t + 1]; j++) {
          const i = cell.order![j], o = i * 6, r = cr[i] + 0.5;
          if (Math.abs(d[o] - x) > r || Math.abs(d[o + 1] - y) > r) continue;
          const k = crownOverlap(sp[i], d[o], d[o + 1], d[o + 2], d[o + 3], cr[i], x, y, z, this.contact);
          if (k > best) {
            best = k;
            out.x = d[o]; out.y = d[o + 1]; out.z = d[o + 2]; out.h = d[o + 3]; out.cr = cr[i]; out.species = sp[i];
            out.overlap = k; out.at = this.contact.at; out.r = this.contact.r;
          }
        }
      }
    }
    return best > 0;
  }
  /**
   * FEAT-217: the tree whose trunk the rider at (x, y, z) (pack metres) is up against: the nearest base
   * within its collider radius (max(0.15, h * 0.02), as `Collider` has it) plus `reach` m, any species,
   * written into `out` with overlap 1, the contact at 0.9 m up. False when there is none.
   */
  trunkAt(x: number, y: number, z: number, reach: number, out: CrownHit): boolean {
    const inst = this.pack.meta.instances;
    if (!inst) return false;
    const cs = inst.cellSize, ts = cs / TILES, R = reach + 1;
    let best = Infinity;
    const cx0 = Math.floor((x - R - inst.minX) / cs), cx1 = Math.floor((x + R - inst.minX) / cs);
    const cy0 = Math.floor((y - R - inst.minY) / cs), cy1 = Math.floor((y + R - inst.minY) / cs);
    const keys = this.nearKeys(cx0, cx1, cy0, cy1);
    for (let cy = cy0, k = 0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++, k++) {
      const cell = this.cells.get(keys[k]);
      if (!cell || !cell.order || z > cell.zMax || z + 2 < cell.zMin) continue;
      const d = cell.data!, minX = inst.minX + cx * cs, minY = inst.minY + cy * cs;
      const tx0 = Math.max(0, Math.floor((x - R - minX) / ts)), tx1 = Math.min(TILES - 1, Math.floor((x + R - minX) / ts));
      const ty0 = Math.max(0, Math.floor((y - R - minY) / ts)), ty1 = Math.min(TILES - 1, Math.floor((y + R - minY) / ts));
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        const t = ty * TILES + tx;
        for (let j = cell.tileStart![t]; j < cell.tileStart![t + 1]; j++) {
          const i = cell.order![j], o = i * 6, h = d[o + 3];
          if (z < d[o + 2] - 1 || z > d[o + 2] + h) continue;
          const gap = Math.hypot(d[o] - x, d[o + 1] - y) - Math.max(0.15, h * 0.02);
          if (gap < reach && gap < best) {
            best = gap;
            out.x = d[o]; out.y = d[o + 1]; out.z = d[o + 2]; out.h = h; out.cr = cell.cr![i]; out.species = cell.sp![i];
            out.overlap = 1; out.at = z + 0.9; out.r = cell.cr![i];
          }
        }
      }
    }
    return best < Infinity;
  }
  private readonly contact: CrownHit = { x: 0, y: 0, z: 0, h: 0, cr: 0, species: 0, overlap: 0, at: 0, r: 0 };

  /** per-tree species, variant, crown, yaw and colour, and the sub-tile index for the near gather */
  private prepare(cell: Cell): void {
    const d = cell.data!, n = d.length / 6;
    const inst = this.pack.meta.instances!;
    const sp = new Uint8Array(n), va = new Uint8Array(n), cr = new Float32Array(n), yaw = new Float32Array(n), tint = new Float32Array(n * 3), thin = new Float32Array(n);
    const tileOf = new Uint16Array(n), counts = new Uint32Array(TILE_N + 1);
    const ts = inst.cellSize / TILES, minX = inst.minX + cell.cx * inst.cellSize, minY = inst.minY + cell.cy * inst.cellSize;
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * 6, x = d[o], y = d[o + 1], h = d[o + 3];
      const s = speciesFor(d[o + 5], x, y, this.legacy);
      sp[i] = s; va[i] = variantFor(s, x, y);
      cr[i] = crownRadius(s, h, d[o + 4], this.widths !== null);
      yaw[i] = s === 2 ? FLAG_YAW + (hash01(x, y, 11) - 0.5) * 0.7 : hash01(x, y, 5) * Math.PI * 2;
      // colour variation: about +-6% brightness and a slight hue shift
      const b = 0.94 + 0.12 * hash01(x, y, 13);
      tint[i * 3] = b * (0.97 + 0.06 * hash01(x, y, 17)); tint[i * 3 + 1] = b; tint[i * 3 + 2] = b * (0.97 + 0.06 * hash01(x, y, 19));
      thin[i] = hash01(x, y, 23);
      const tx = Math.min(TILES - 1, Math.max(0, Math.floor((x - minX) / ts))), ty = Math.min(TILES - 1, Math.max(0, Math.floor((y - minY) / ts)));
      tileOf[i] = ty * TILES + tx; counts[tileOf[i] + 1]++;
      zMin = Math.min(zMin, d[o + 2]); zMax = Math.max(zMax, d[o + 2] + h);
    }
    for (let t = 0; t < TILE_N; t++) counts[t + 1] += counts[t];
    const order = new Uint32Array(n), fill = counts.slice(0, TILE_N);
    for (let i = 0; i < n; i++) order[fill[tileOf[i]]++] = i;
    cell.sp = sp; cell.va = va; cell.cr = cr; cell.yaw = yaw; cell.tint = tint; cell.thin = thin; cell.order = order; cell.tileStart = counts;
    cell.zMin = n ? zMin : 0; cell.zMax = n ? zMax : 0;
  }

  /** the far meshes of a cell (built once with buffers for all its trees, then repacked and shown or hidden as the camera moves) */
  private buildFar(cell: Cell, lod2: boolean, imp: boolean, lo2: number, hi2: number, loImp: number, hiImp: number): void {
    const far = this.kit.far!, n = cell.data!.length / 6;
    const make = (template: THREE.InstancedBufferGeometry, mat: THREE.Material, name: string, lo: number, hi: number): FarMesh => {
      const attrs = farAttrs(n);
      const g = farGeometry(template, attrs);
      g.boundingSphere = new THREE.Sphere();
      const m = new THREE.Mesh(g, mat);
      m.name = `trees ${cell.cx}_${cell.cy} ${name}`;
      m.castShadow = false; m.receiveShadow = false;
      this.group.add(m);
      const f: FarMesh = { mesh: m, attrs, mask: new Uint8Array(TILE_N), count: 0, thin: name === 'impostor', thinned: false, px: 0, py: 0, x: this.cam.x, y: -this.cam.z, epoch: this.bandEpoch };
      this.packFar(cell, f, lo, hi);
      return f;
    };
    if (lod2 && !cell.lod2) cell.lod2 = make(this.kit.crossed, far.lod2, 'lod2', lo2, hi2);
    if (imp && !cell.imp) cell.imp = make(this.kit.billboard, far.imp, 'impostor', loImp, hiImp);
  }

  /** the camera's 2D nearest and 3D farthest distance to a cell's tile t (pack metres) */
  private tileRange(cell: Cell, t: number, out: number[]): void {
    const inst = this.pack.meta.instances!, ts = inst.cellSize / TILES;
    const minX = inst.minX + cell.cx * inst.cellSize + (t % TILES) * ts, minY = inst.minY + cell.cy * inst.cellSize + Math.floor(t / TILES) * ts;
    const cpx = this.cam.x, cpy = -this.cam.z, cpz = this.cam.y;
    out[0] = Math.hypot(Math.max(minX - cpx, 0, cpx - minX - ts), Math.max(minY - cpy, 0, cpy - minY - ts));
    out[1] = Math.hypot(Math.max(Math.abs(cpx - minX), Math.abs(cpx - minX - ts)), Math.max(Math.abs(cpy - minY), Math.abs(cpy - minY - ts)), Math.max(Math.abs(cpz - cell.zMin), Math.abs(cpz - cell.zMax)));
  }
  private readonly range = [0, 0];

  /** after the camera has moved FAR_CHECK m (or the bands changed): repack if the band now reaches a tile left out */
  private checkFar(cell: Cell, f: FarMesh, lo: number, hi: number): void {
    const cpx = this.cam.x, cpy = -this.cam.z;
    if (f.epoch === this.bandEpoch && Math.hypot(cpx - f.x, cpy - f.y) < FAR_CHECK) return;
    f.x = cpx; f.y = cpy;
    const forced = f.epoch !== this.bandEpoch;
    f.epoch = this.bandEpoch;
    // BUG-081: the trees left out for thinning come back as the camera closes in
    if (f.thinned && Math.hypot(cpx - f.px, cpy - f.py) > THIN_SLACK / 2) { this.packFar(cell, f, lo, hi); return; }
    const ts = cell.tileStart!, rg = this.range;
    for (let t = 0; t < TILE_N; t++) {
      if (f.mask[t] || ts[t + 1] === ts[t]) continue;
      this.tileRange(cell, t, rg);
      if (rg[0] <= hi && rg[1] >= lo) { this.packFar(cell, f, lo, hi); return; }
    }
    if (forced) this.packFar(cell, f, lo, hi); // new bands: drop the tiles they no longer reach
  }

  /** fill a far mesh's buffers with the trees of the tiles within FAR_GROW m of its band, and fit its bounding sphere */
  private packFar(cell: Cell, f: FarMesh, lo: number, hi: number): void {
    this.stats.farPacks++;
    const d = cell.data!, a = f.attrs, ts = cell.tileStart!, order = cell.order!, rg = this.range;
    const inst = this.pack.meta.instances!, tw = inst.cellSize / TILES;
    const pos = a.iPos.array as Float32Array, sc = a.iScale.array as Float32Array, yw = a.iYaw.array as Float32Array, col = a.iColor.array as Float32Array, spc = a.iSpec.array as Float32Array;
    let q = 0, tx0 = TILES, tx1 = -1, ty0 = TILES, ty1 = -1;
    const th = cell.thin!;
    f.px = this.cam.x; f.py = -this.cam.z; f.thinned = false;
    for (let t = 0; t < TILE_N; t++) {
      f.mask[t] = 0;
      if (ts[t + 1] === ts[t]) continue;
      this.tileRange(cell, t, rg);
      if (rg[0] > hi + FAR_GROW || rg[1] < lo - FAR_GROW) continue;
      f.mask[t] = 1;
      const tx = t % TILES, ty = Math.floor(t / TILES);
      tx0 = Math.min(tx0, tx); tx1 = Math.max(tx1, tx); ty0 = Math.min(ty0, ty); ty1 = Math.max(ty1, ty);
      // BUG-081: only the impostors that can show from THIN_SLACK m nearer (the shader thins the rest out)
      const keep = f.thin ? thinKeep(Math.max(0, rg[0] - THIN_SLACK)) : 1;
      if (keep < 1) f.thinned = true;
      for (let j = ts[t]; j < ts[t + 1]; j++) {
        const i = order[j], o = i * 6;
        if (th[i] >= keep) continue;
        pos[q * 3] = d[o]; pos[q * 3 + 1] = d[o + 2] - 0.3; pos[q * 3 + 2] = -d[o + 1];
        sc[q * 2] = cell.cr![i]; sc[q * 2 + 1] = d[o + 3];
        yw[q] = cell.yaw![i];
        col[q * 3] = cell.tint![i * 3]; col[q * 3 + 1] = cell.tint![i * 3 + 1]; col[q * 3 + 2] = cell.tint![i * 3 + 2];
        spc[q] = cell.sp![i] + th[i] * 0.98; // BUG-081: the species, and the thinning draw in its fraction
        q++;
      }
    }
    f.count = q;
    const g = f.mesh.geometry as THREE.InstancedBufferGeometry;
    g.instanceCount = q;
    for (const [attr, k] of [[a.iPos, 3], [a.iScale, 2], [a.iYaw, 1], [a.iColor, 3], [a.iSpec, 1]] as const) {
      attr.clearUpdateRanges(); if (q) attr.addUpdateRange(0, q * k); attr.needsUpdate = true;
    }
    if (q) {
      const minX = inst.minX + cell.cx * inst.cellSize + tx0 * tw, minY = inst.minY + cell.cy * inst.cellSize + ty0 * tw;
      const sx = (tx1 - tx0 + 1) * tw, sy = (ty1 - ty0 + 1) * tw;
      g.boundingSphere!.center.set(minX + sx / 2, (cell.zMin + cell.zMax) / 2, -(minY + sy / 2));
      g.boundingSphere!.radius = Math.hypot(sx / 2, sy / 2, (cell.zMax - cell.zMin) / 2 + 30);
    }
  }

  private dropCell(cell: Cell): void {
    for (const f of [cell.lod2, cell.imp]) if (f) { this.group.remove(f.mesh); f.mesh.geometry.dispose(); }
    cell.lod2 = cell.imp = null;
  }

  private clearNear(n: NearSet): void {
    for (const m of n.meshes) if (m) m.visible = false;
    n.tileCount = 0; n.count = 0; n.drawn = 0; n.x = n.y = NaN; n.radius = 0;
  }

  /** refill a near set from the trees within `radius` of (x, y) (pack metres): stage them per kit combo, then pack the wanted tiles */
  private gather(n: NearSet, x: number, y: number, radius: number): void {
    const inst = this.pack.meta.instances!, cs = inst.cellSize, ts = cs / TILES, r2 = radius * radius;
    const lists = n.lists, ids = this.tileIds, gs = NEAR_TILE[n.lod];
    ids.clear();
    for (let k = 0; k < SPECIES_COUNT * VARIANTS; k++) (lists[k] ??= []).length = 0;
    const cellRefs: Cell[] = [];
    let tiles = n.tiles, tc = 0;
    for (const cell of this.cells.values()) {
      if (!cell.order) continue;
      const minX = inst.minX + cell.cx * cs, minY = inst.minY + cell.cy * cs;
      if (x + radius < minX || x - radius > minX + cs || y + radius < minY || y - radius > minY + cs) continue;
      const ci = cellRefs.push(cell) - 1, d = cell.data!;
      const tx0 = Math.max(0, Math.floor((x - radius - minX) / ts)), tx1 = Math.min(TILES - 1, Math.floor((x + radius - minX) / ts));
      const ty0 = Math.max(0, Math.floor((y - radius - minY) / ts)), ty1 = Math.min(TILES - 1, Math.floor((y + radius - minY) / ts));
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        const t = ty * TILES + tx;
        let lastKey = -1, id = -1;
        for (let j = cell.tileStart![t]; j < cell.tileStart![t + 1]; j++) {
          const i = cell.order![j], o = i * 6, ex = d[o] - x, ey = d[o + 1] - y;
          if (ex * ex + ey * ey > r2) continue;
          // the tree's cull tile on the near grid
          const gx = Math.floor((d[o] - inst.minX) / gs), gy = Math.floor((d[o + 1] - inst.minY) / gs), key = gy * 65536 + gx;
          if (key !== lastKey) {
            lastKey = key;
            id = ids.get(key) ?? -1;
            if (id < 0) {
              id = tc++; ids.set(key, id);
              if (tiles.length < tc * 7) { const nt = new Float32Array(Math.max(tc * 7 * 2, 64 * 7)); nt.set(tiles); tiles = nt; }
              const b = id * 7;
              tiles[b] = inst.minX + gx * gs; tiles[b + 1] = inst.minY + gy * gs; tiles[b + 2] = inst.minX + (gx + 1) * gs; tiles[b + 3] = inst.minY + (gy + 1) * gs;
              tiles[b + 4] = Infinity; tiles[b + 5] = -Infinity; tiles[b + 6] = 0;
            }
          }
          const b = id * 7, z = d[o + 2], h = d[o + 3];
          if (z < tiles[b + 4]) tiles[b + 4] = z;
          if (z + h > tiles[b + 5]) tiles[b + 5] = z + h;
          if (h > tiles[b + 6]) tiles[b + 6] = h;
          lists[cell.sp![i] * VARIANTS + cell.va![i]].push(ci, i, id);
        }
      }
    }
    n.tiles = tiles; n.tileCount = tc;
    if (n.packed.length < tc) { n.packed = new Uint8Array(Math.max(tc * 2, 64)); n.cast = new Uint8Array(n.packed.length); }
    // stage every gathered instance (matrix and colour) grouped by kit combo
    let total = 0;
    for (let k = 0; k < SPECIES_COUNT * VARIANTS; k++) total += lists[k].length / 3;
    if (n.stT.length < total) { const cap = Math.ceil(total * 1.5) + 64; n.stM = new Float32Array(cap * 16); n.stC = new Float32Array(cap * 3); n.stT = new Int32Array(cap); }
    const m = n.stM, c = n.stC, st = n.stT;
    let e = 0;
    for (let k = 0; k < SPECIES_COUNT * VARIANTS; k++) {
      n.kStart[k] = e;
      const list = lists[k];
      for (let q = 0; q < list.length; q += 3, e++) {
        const cell = cellRefs[list[q]], i = list[q + 1], o = i * 6, d = cell.data!;
        const s = cell.cr![i], h = d[o + 3], a = cell.yaw![i], ca = Math.cos(a), sa = Math.sin(a), b = e * 16;
        // rotation about y by the yaw, scale (crown, height, crown), at the base (three.js: x east, y up, z = -north)
        m[b] = ca * s; m[b + 1] = 0; m[b + 2] = -sa * s; m[b + 3] = 0;
        m[b + 4] = 0; m[b + 5] = h; m[b + 6] = 0; m[b + 7] = 0;
        m[b + 8] = sa * s; m[b + 9] = 0; m[b + 10] = ca * s; m[b + 11] = 0;
        m[b + 12] = d[o]; m[b + 13] = d[o + 2] - 0.3; m[b + 14] = -d[o + 1]; m[b + 15] = 1;
        c[e * 3] = cell.tint![i * 3]; c[e * 3 + 1] = cell.tint![i * 3 + 1]; c[e * 3 + 2] = cell.tint![i * 3 + 2];
        st[e] = list[q + 2];
      }
    }
    n.kStart[SPECIES_COUNT * VARIANTS] = e;
    n.x = x; n.y = y; n.radius = radius; n.dirty = false; n.count = total;
    this.packNear(n);
  }

  /**
   * copy the staged instances of the wanted tiles (with CULL_GROW m of slack) to the front of each mesh's
   * buffers, those in the shadow camera first: the shadow pass draws `userData.cast` of them
   */
  private packNear(n: NearSet): void {
    this.stats.nearPacks++;
    const packed = n.packed, cast = n.cast;
    for (let t = 0; t < n.tileCount; t++) { packed[t] = this.tileWanted(n, t, CULL_GROW[n.lod]) ? 1 : 0; cast[t] = packed[t] && this.castWanted(n, t, CULL_GROW[n.lod]) ? 1 : 0; }
    const sm = n.stM, sc = n.stC, st = n.stT;
    let drawn = 0;
    for (let k = 0; k < SPECIES_COUNT * VARIANTS; k++) {
      const e0 = n.kStart[k], e1 = n.kStart[k + 1];
      let mesh = n.meshes[k];
      if (e1 === e0) { if (mesh) mesh.visible = false; continue; }
      if (!mesh || mesh.instanceMatrix.count < e1 - e0) {
        if (mesh) { this.group.remove(mesh); mesh.dispose(); }
        const s = Math.floor(k / VARIANTS), v = k % VARIANTS, cap = Math.ceil((e1 - e0) * 1.5) + 16;
        mesh = new THREE.InstancedMesh(n.lod === 0 ? this.kit.geo.lod0[s][v] : this.kit.geo.lod1[s][v], n.lod === 0 ? this.kit.mat.lod0 : this.kit.mat.lod1, cap);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        mesh.name = `trees lod${n.lod} ${s}.${v}`;
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        mesh.customDepthMaterial = n.lod === 0 ? this.kit.depth.lod0 : this.kit.depth.lod1;
        mesh.frustumCulled = false; // the set surrounds the camera; packNear culls it per tile
        // the shadow pass draws only the prefix inside the shadow camera, and of each tree only the triangles that cast (generate.ts)
        const im = mesh, cc = im.geometry.userData.castCount as number | undefined;
        im.onBeforeShadow = () => { im.userData.full = im.count; im.count = im.userData.cast; if (cc !== undefined) im.geometry.drawRange.count = cc; };
        im.onAfterShadow = () => { im.count = im.userData.full; im.geometry.drawRange.count = Infinity; };
        n.meshes[k] = mesh;
        this.group.add(mesh);
      }
      const m = mesh.instanceMatrix.array as Float32Array, c = mesh.instanceColor!.array as Float32Array;
      let q = 0, nc = 0;
      for (let pass = 1; pass >= 0; pass--) {
        for (let e = e0; e < e1; e++) {
          const tt = st[e];
          if (!packed[tt] || cast[tt] !== pass) continue;
          for (let w = 0, a = e * 16, b = q * 16; w < 16; w++) m[b + w] = sm[a + w];
          c[q * 3] = sc[e * 3]; c[q * 3 + 1] = sc[e * 3 + 1]; c[q * 3 + 2] = sc[e * 3 + 2];
          q++;
        }
        if (pass === 1) nc = q;
      }
      mesh.count = q;
      mesh.userData.cast = nc;
      mesh.castShadow = nc > 0;
      mesh.visible = q > 0;
      if (q) {
        mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, q * 16); mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.clearUpdateRanges(); mesh.instanceColor!.addUpdateRange(0, q * 3); mesh.instanceColor!.needsUpdate = true;
      }
      drawn += q;
    }
    n.drawn = drawn;
  }
}
