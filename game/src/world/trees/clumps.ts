import * as THREE from 'three';
import type { Pack } from '../../pack/Pack';
import type { HeightSet } from '../../pack/HeightSet';
import { SPECIES, VARIANTS, hash01 } from './species';
import { rng } from './generate';
import { kitUniforms, farLight } from './materials';
import { treeSnowUniforms, TREE_SNOW_VERT, TREE_SNOW_COMMON, TREE_SNOW_LIGHT } from './snow';

/**
 * FEAT-278 prototype (`?canopy=clumps`): the far forest as clump impostors. Whole stands, not trees.
 *
 * Bake (once, at load, about 100 to 150 ms): stand patches (a disc of trees 1.2 x CELL / sqrt 2 in radius whose rim
 * thins, so neighbouring discs on the CELL grid overlap and blend) at four crown covers, two seeds each, built from the
 * kit's own LOD0 trees (spruce, subalpine fir, lodgepole) and rendered orthographically into three atlases, one tile per
 * view: the ground under the stand tilted toward the camera by TILT[i] and seen from a low world elevation EYE, so the
 * trees stay vertical while the ground's spacing is that of a view at ELS[i] over the slope.
 *   albedo  rgb the needles (with a stand ambient occlusion), a coverage; CPU mips that keep each tile's coverage
 *   normal  rgb the crown normal (patch frame), a the depth along the bake view (so the stand cuts into the terrain right)
 *   snow    r, g the kit's snow mask at a moderate and a heavy load, b the height in its tree, a the tree's id; CPU mips,
 *           point-sampled, so a tree's id holds far off
 *
 * Draw: one instanced mesh, one camera-facing card per CELL of forest in the band (where the preset's full-density trees
 * end, out to `far`). A card blends the two tiles either side of the view's elevation over the local slope, shears with
 * the slope across the view, writes the per-texel depth, and stretches up far off as the kit's impostors grow. Its trees
 * are thinned one by one (id against the crown cover the pack's cover levels give at that crown's ground point: the pack
 * level's B, where the drawn trees stand, else a level's forest share R), so runs, glades and stand edges cut through.
 *
 * Placement: per 1 km block, computed once from the cover levels' texture bytes and the mid / far height sets, then the
 * blocks round the camera are packed into one buffer whenever the camera has moved CELL * 2 m or the band changed.
 */

/** prototype tuning from the URL (?clumpgain= &clumpsnow= &clumprho= &clumpthin= &clumpalpha= &clumpmax=) */
const knob = (k: string, d: number): number => { try { const v = Number(new URLSearchParams(location.search).get(k)); return Number.isFinite(v) && v > 0 ? v : d; } catch { return d; } };

/** clump grid (m) and the blocks the placement is computed in */
const CELL = 64;
const BLOCK_CELLS = 16;
const BLOCK = CELL * BLOCK_CELLS;
/** the baked disc's radius: past the circumscribed circle of a CELL square, so neighbours overlap (its rim thins) */
const RD = CELL * Math.SQRT1_2 * 1.2;
/** the disc keeps every tree inside RIM of its radius and thins to RIM_KEEP at its edge */
const RIM = 0.6, RIM_KEEP = 0.25;
/** crown overhang past the disc and the tallest tree (m) */
const OVER = 4;
const HMAX = 30;
/** the depth range the normal atlas's alpha holds (m either side of the card) */
const DMAX = RD + OVER + HMAX;
/** crown cover of each baked class (share of the ground under crowns, union of the overlapping discs) */
const SHARES = [0.08, 0.18, 0.3, 0.48];
const SEEDS = 2;
/** bake elevations (rad over the ground plane) */
const ELS = [3, 12, 25, 45, 70].map((d) => (d * Math.PI) / 180);
const TILE = 192;
const COLS = ELS.length, ROWS = SHARES.length * SEEDS;
/** card width (m) */
const W = 2 * (RD + OVER);
/** the conifers a stand is built from: kit species, share, height range (m) */
const MIX: [number, number, number, number][] = [[0, 0.45, 14, 28], [3, 0.4, 10, 22], [4, 0.15, 12, 22]];

/** crown cover (0..0.75) from a cover level's forest share R (0..1), shader and CPU alike */
const COVER_LO = knob('clumplo', 0.02), COVER_HI = knob('clumphi', 0.75), COVER_MAX = knob('clumpmax', 0.5);
function shareOf(r: number): number { const t = Math.max(0, Math.min(1, (r - COVER_LO) / (COVER_HI - COVER_LO))); return t * t * (3 - 2 * t) * COVER_MAX; }
/**
 * Inside the pack the cover's R is a forest mask (nearly 0 or 1 at 4 m), so the density comes from the pack level's B
 * (FEAT-168: where the drawn trees stand, graded per 4 m cell): crown cover = B * COVER_B, at most COVER_MAX.
 */
const COVER_B = knob('clumpkb', 0.6);
function shareOfB(b: number): number { return Math.min(COVER_MAX, b * COVER_B); }

/**
 * Each tile is a stand on ground that rises away from the camera by TILT[i], seen from the world elevation EYE: the trees
 * stay vertical (as from the snow) while the ground's spacing is that of a view at ELS[i] over the slope (EYE + TILT[i]).
 */
const EYE = (knob('clumpeye', 5) * Math.PI) / 180;
const TILT = ELS.map((e) => e - EYE);
/** the vertical frame of tile i (m, in the bake camera's up axis, from the patch centre on the ground) */
function frame(i: number): [number, number] {
  const r = RD + OVER, k = Math.abs(Math.tan(TILT[i]) * Math.cos(EYE) + Math.sin(EYE));
  return [-r * k - 1, HMAX * Math.cos(EYE) + r * k + 1];
}

interface Tree { s: number; v: number; x: number; y: number; h: number; cr: number; yaw: number }

/** a stand patch at crown cover c: clustered conifers in a disc of RD, with a hard core so crowns stay apart */
function genPatch(c: number, seed: number): Tree[] {
  const r = rng(seed);
  let meanA = 0;
  for (const [s, w, h0, h1] of MIX) { const h = (h0 + h1) / 2, cr = SPECIES[s].radius * h; meanA += w * Math.PI * cr * cr; }
  // the plane's density for cover c (Poisson crowns); the discs on the grid together hold CELL^2 of it each
  const n = Math.round(-Math.log(1 - c) / meanA * CELL * CELL);
  const cluster = c < 0.6 ? 0.65 : 0.35;
  const trees: Tree[] = [];
  const grid = new Map<number, Tree[]>();
  const gk = (x: number, y: number): number => (Math.floor(x / 8) + 64) * 256 + Math.floor(y / 8) + 64;
  for (let tries = 0; trees.length < n && tries < n * 40; tries++) {
    let x: number, y: number;
    if (trees.length && r() < cluster) { const p = trees[Math.floor(r() * trees.length)], a = r() * Math.PI * 2, d = 2 + r() * 5; x = p.x + Math.cos(a) * d; y = p.y + Math.sin(a) * d; }
    else { const a = r() * Math.PI * 2, d = RD * Math.sqrt(r()); x = Math.cos(a) * d; y = Math.sin(a) * d; }
    // the disc thins over its outer part so the overlapping discs blend instead of showing their rims
    const rr = Math.hypot(x, y) / RD;
    if (rr > 1 || r() > 1 - (1 - RIM_KEEP) * Math.max(0, Math.min(1, (rr - RIM) / (1 - RIM)))) continue;
    const u = r();
    let acc = 0, m = MIX[0];
    for (const mm of MIX) { acc += mm[1]; if (u < acc) { m = mm; break; } }
    const s = m[0], h = m[2] + (m[3] - m[2]) * r(), cr = SPECIES[s].radius * h;
    let clash = false;
    for (let gx = -1; gx <= 1 && !clash; gx++) for (let gy = -1; gy <= 1 && !clash; gy++) {
      for (const t of grid.get(gk(x + gx * 8, y + gy * 8)) ?? []) if ((t.x - x) ** 2 + (t.y - y) ** 2 < (0.45 * (t.cr + cr)) ** 2) { clash = true; break; }
    }
    if (clash) continue;
    const w = SPECIES[s].weights, vu = r();
    let v = 0, va = 0;
    for (let i = 0; i < VARIANTS; i++) { va += w[i]; if (vu < va) { v = i; break; } }
    const t: Tree = { s, v, x, y, h, cr, yaw: r() * Math.PI * 2 };
    trees.push(t);
    const k = gk(x, y);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(t);
  }
  return trees;
}

/** the bake shader: albedo (with stand AO), normal + depth, or snow mask + height + tree id */
function bakeMat(atlas: THREE.Texture, mode: 'albedo' | 'normal' | 'snow', dir: { value: THREE.Vector3 }, share: { value: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: mode === 'normal' ? { NORMALS: '' } : mode === 'snow' ? { SNOW: '' } : {},
    uniforms: { map: { value: atlas }, uDir: dir, uShare: share, uTreeSnow: { value: new THREE.Vector3() } },
    vertexColors: true,
    vertexShader: /* glsl */ `
      attribute float snowHold;
      uniform vec3 uDir;
      varying vec2 vUv; varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying float vHold; varying float vY; varying float vId; varying float vS;
      void main() {
        vUv = uv; vCol = color;
        mat4 im = instanceMatrix;
        vec4 w = modelMatrix * im * vec4(position, 1.0);
        vN = normalize(transpose(inverse(mat3(im))) * normal);
        vW = w.xyz; vHold = snowHold; vY = position.y;
        vec3 o = im[3].xyz;
        vId = fract(sin(dot(o.xz, vec2(12.9898, 78.233))) * 43758.5453);
        vS = dot(w.xyz, uDir);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map; uniform float uShare;
      varying vec2 vUv; varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying float vHold; varying float vY; varying float vId; varying float vS;
      ${TREE_SNOW_COMMON}
      void main() {
        vec4 t = texture2D(map, vUv);
        if (t.a < 0.5) discard;
        #if defined(SNOW)
          float sn = treeSnowNoise(vW * 3.3);
          vec3 gN = normalize(cross(dFdx(vW), dFdy(vW)));
          if (dot(gN, cameraPosition - vW) < 0.0) gN = -gN;
          float up = 0.75 * gN.y + 0.25 * normalize(vN).y;
          gl_FragColor = vec4(treeSnowCov(up, vHold, vY, sn, 0.5, 0.0, 1.0), treeSnowCov(up, vHold, vY, sn, 1.0, 0.0, 1.0), clamp(vY, 0.0, 1.0), vId);
        #elif defined(NORMALS)
          gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, clamp(vS / ${DMAX.toFixed(1)} * 0.5 + 0.5, 0.0, 1.0));
        #else
          // the stand's own shade: low in the crowns of a closed stand sees little sky
          float ao = mix(1.0, 0.5 + 0.5 * clamp(vY, 0.0, 1.0), clamp(uShare * 1.3, 0.0, 1.0));
          gl_FragColor = vec4(t.rgb * vCol * ao, 1.0);
        #endif
      }`,
    side: THREE.DoubleSide,
  });
}

/** the same 8x8 Bayer matrix as the kit */
const BAYER = /* glsl */ `
  float cBayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
  float cBayer8(vec2 a) { return cBayer2(0.25 * a) * 0.0625 + cBayer2(0.5 * a) * 0.25 + cBayer2(a); }
  vec3 cHash3(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yxz + 33.33); return fract((q.xxy + q.yxx) * q.zyx); }
`;

const SPEC_K = 0.25;
const FAR_GAIN = knob('clumpgain', 1.1);
const SNOW_K = knob('clumpsnow', 0.35);
/** how much taller a stand draws at 6 km and past (STRETCH x; 1 = true size) */
const STRETCH = knob('clumpstretch', 1.6);
/** keep every tree where the local forest share is at least this share of the class's (thin below it) */
const THIN_FULL = knob('clumpthin', 0.6);
/** the coverage cut where the atlas is minified (0.5 where it is magnified): lower keeps the crowns full far off */
const ALPHA_FAR = knob('clumpalpha', 0.5);
/** FEAT-278 refine: where the atlas is minified, each pixel draws one crown (lit or shaded, snowy or bare) with the averaged
 *  chance, instead of the average itself; 0 turns it off. The crown cell is CROWN_CELL m */
const DITHER = knob('clumpdither', 1);
const CROWN_CELL = knob('clumpcell', 4.5);
/** FEAT-278 refine: how white a snowy crown draws in the dither (its chance scales so the mean holds) */
const SNOW_PEAK = knob('clumpspeak', 0.4);
/** the share of the canopy the clumps carry: the terrain under them adds what they miss (TerrainMaterial uClump) */
export const CLUMP_RHO = knob('clumprho', 0.7);

/**
 * Read an atlas back and build its mip chain on the CPU: rgb box-filtered; alpha box-filtered and rescaled per tile so the
 * share of texels over 0.5 stays what it is at full size ('albedo', the coverage), or point-sampled ('snow', the tree id).
 */
function cpuMips(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget, mode: 'albedo' | 'snow'): THREE.DataTexture {
  const w0 = rt.width, h0 = rt.height;
  const base = new Uint8Array(w0 * h0 * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w0, h0, base);
  const tilesX = w0 / TILE, tilesY = h0 / TILE;
  const share = new Float32Array(tilesX * tilesY);
  if (mode === 'albedo') {
    for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
      let n = 0;
      for (let y = ty * TILE; y < (ty + 1) * TILE; y++) for (let x = tx * TILE; x < (tx + 1) * TILE; x++) if (base[(y * w0 + x) * 4 + 3] >= 128) n++;
      share[ty * tilesX + tx] = n / (TILE * TILE);
    }
  }
  const mips: { data: Uint8Array; width: number; height: number }[] = [{ data: base, width: w0, height: h0 }];
  let prev = base, w = w0, h = h0, lvl = 0;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), out = new Uint8Array(nw * nh * 4);
    lvl++;
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(h - 1, 2 * y), y1 = Math.min(h - 1, 2 * y + 1);
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(w - 1, 2 * x), x1 = Math.min(w - 1, 2 * x + 1);
        const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4, o = (y * nw + x) * 4;
        for (let k = 0; k < 3; k++) out[o + k] = (prev[a + k] + prev[b + k] + prev[c + k] + prev[d + k] + 2) >> 2;
        out[o + 3] = mode === 'snow' ? prev[a + 3] : (prev[a + 3] + prev[b + 3] + prev[c + 3] + prev[d + 3] + 2) >> 2;
      }
    }
    const ts = TILE >> lvl;
    if (mode === 'albedo' && ts >= 4 && ts << lvl === TILE) {
      const hist = new Uint32Array(256);
      for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
        hist.fill(0);
        for (let y = ty * ts; y < (ty + 1) * ts; y++) for (let x = tx * ts; x < (tx + 1) * ts; x++) hist[out[(y * nw + x) * 4 + 3]]++;
        const want = share[ty * tilesX + tx] * ts * ts;
        let acc = 0, cut = 255;
        for (let v = 255; v > 0; v--) { acc += hist[v]; if (acc >= want) { cut = v; break; } }
        const k = 128 / Math.max(1, cut);
        for (let y = ty * ts; y < (ty + 1) * ts; y++) for (let x = tx * ts; x < (tx + 1) * ts; x++) { const o = (y * nw + x) * 4 + 3; out[o] = Math.min(255, out[o] * k); }
      }
    }
    mips.push({ data: out, width: nw, height: nh });
    prev = out; w = nw; h = nh;
  }
  const tex = new THREE.DataTexture(base, w0, h0, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = mips as unknown as THREE.DataTexture['mipmaps'];
  tex.generateMipmaps = false;
  tex.minFilter = mode === 'snow' ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
  tex.magFilter = mode === 'snow' ? THREE.NearestFilter : THREE.LinearFilter;
  tex.colorSpace = mode === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** one 1 km block of placed clumps (pack frame), computed once */
interface Block { key: number; bx: number; by: number; data: Float32Array; count: number; ready: boolean }

export class ClumpCanopy {
  readonly mesh: THREE.Mesh;
  readonly band = { value: new THREE.Vector4(1e8, 1e8 + 1, 1e8 + 2, 1e8 + 3) };
  private readonly pack: Pack;
  private readonly geo: THREE.InstancedBufferGeometry;
  private iPos: THREE.InstancedBufferAttribute;
  private iMisc: THREE.InstancedBufferAttribute;
  private readonly blocks = new Map<number, Block>();
  private targets: THREE.WebGLRenderTarget[] = [];
  private readonly mat: THREE.ShaderMaterial;
  private readonly cov = {
    uCov0: { value: null as THREE.Texture | null }, uCov1: { value: null as THREE.Texture | null }, uCov2: { value: null as THREE.Texture | null },
    uCovRect: { value: [0, 1, 2].map(() => new THREE.Vector4(-1e7, -1e7, -1e7 + 1000, -1e7 + 1000)) },
    uCovLod: { value: new THREE.Vector3() },
    /** 1 where the level's B holds the drawn trees (the pack level), read as the density there */
    uCovB: { value: new THREE.Vector3() },
    uCovBlend: { value: 500 },
  };
  private covSeen = -1;
  private last = { x: NaN, y: NaN, near: 0, far: 0, blocksReady: 0 };
  private blocksReady = 0;
  /** what the compare tool reads (window.__canopy) */
  readonly stats = { mode: 'clumps', buildMs: 0, bakeMs: 0, mipMs: 0, placeMs: 0, bytes: 0, tiles: 0, busy: 1, trees: 0, blocks: 0 };
  private textures: THREE.DataTexture[] = [];
  private readonly blank: THREE.DataTexture;

  constructor(pack: Pack) {
    this.pack = pack;
    this.blank = new THREE.DataTexture(new Uint8Array(4), 1, 1); this.blank.needsUpdate = true;
    for (const k of ['uCov0', 'uCov1', 'uCov2'] as const) this.cov[k].value = this.blank;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(4 * 1024), 4);
    this.iMisc = new THREE.InstancedBufferAttribute(new Float32Array(4 * 1024), 4);
    g.setAttribute('iPos', this.iPos); g.setAttribute('iMisc', this.iMisc);
    g.instanceCount = 0;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial(); // replaced in bake
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = 'trees clumps';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false; this.mesh.receiveShadow = false;
    this.mesh.visible = false;
  }

  /** render the stand patches into the atlases (synchronous; measured into stats.bakeMs) */
  bake(renderer: THREE.WebGLRenderer, atlas: THREE.Texture, lod0: THREE.BufferGeometry[][]): void {
    const t0 = performance.now();
    const mk = (srgb: boolean): THREE.WebGLRenderTarget => {
      const rt = new THREE.WebGLRenderTarget(COLS * TILE, ROWS * TILE, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
      rt.texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      return rt;
    };
    const albedo = mk(true), normal = mk(false), snow = mk(false);
    this.targets = [albedo, normal, snow];
    const dir = { value: new THREE.Vector3() }, share = { value: 0 };
    const mats = { albedo: bakeMat(atlas, 'albedo', dir, share), normal: bakeMat(atlas, 'normal', dir, share), snow: bakeMat(atlas, 'snow', dir, share) };
    const prevTarget = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    renderer.autoClear = false;
    const clear = new THREE.Color();
    // the needles' mean colour under the cutout so the mips don't fringe
    const sp0 = SPECIES[0], c0 = new THREE.Color(sp0.needles[0]).convertSRGBToLinear().multiplyScalar(0.8);
    let trees = 0;
    const cam = new THREE.OrthographicCamera(-W / 2, W / 2, 1, -1, 1, 400);
    for (let k = 0; k < SHARES.length; k++) {
      for (let sd = 0; sd < SEEDS; sd++) {
        const row = k * SEEDS + sd;
        const list = genPatch(SHARES[k], 1000 + k * 17 + sd * 101);
        trees += list.length;
        const scene = new THREE.Scene();
        const groups = new Map<number, Tree[]>();
        for (const t of list) { const key = t.s * VARIANTS + t.v; (groups.get(key) ?? groups.set(key, []).get(key)!).push(t); }
        const meshes: THREE.InstancedMesh[] = [];
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), scl = new THREE.Vector3();
        const sets: [THREE.InstancedMesh, Tree[]][] = [];
        for (const [key, ts] of groups) {
          const im = new THREE.InstancedMesh(lod0[Math.floor(key / VARIANTS)][key % VARIANTS], mats.albedo, ts.length);
          im.frustumCulled = false;
          scene.add(im); meshes.push(im); sets.push([im, ts]);
        }
        share.value = SHARES[k];
        for (let i = 0; i < ELS.length; i++) {
          // the ground under the stand rises away from the camera (pack +y, three.js -z) by TILT[i]
          const rise = Math.tan(TILT[i]);
          for (const [im, ts] of sets) {
            ts.forEach((t, j) => { q.setFromAxisAngle(up, t.yaw); pos.set(t.x, t.y * rise - 0.3, -t.y); scl.set(t.cr, t.h, t.cr); m4.compose(pos, q, scl); im.setMatrixAt(j, m4); });
            im.instanceMatrix.needsUpdate = true;
          }
          const [v0, v1] = frame(i);
          cam.top = v1; cam.bottom = v0; cam.updateProjectionMatrix();
          cam.position.set(0, 200 * Math.sin(EYE), 200 * Math.cos(EYE));
          cam.up.set(0, 1, 0);
          cam.lookAt(0, 0, 0);
          cam.updateMatrixWorld();
          dir.value.set(0, -Math.sin(EYE), -Math.cos(EYE));
          for (const [name, rt] of [['albedo', albedo], ['normal', normal], ['snow', snow]] as const) {
            scene.overrideMaterial = mats[name];
            if (name === 'normal') clear.setRGB(0.5, 0.8, 0.8, THREE.LinearSRGBColorSpace);
            else if (name === 'snow') clear.setRGB(0, 0, 0.5, THREE.LinearSRGBColorSpace);
            else clear.copy(c0);
            rt.viewport.set(i * TILE, row * TILE, TILE, TILE);
            rt.scissor.set(i * TILE, row * TILE, TILE, TILE);
            rt.scissorTest = true;
            renderer.setRenderTarget(rt);
            renderer.setClearColor(clear, name === 'albedo' ? 0 : 0.5);
            renderer.clear(true, true, false);
            renderer.render(scene, cam);
          }
        }
        for (const m of meshes) m.dispose();
      }
    }
    // mips: the normal + depth atlas on the GPU; the albedo with its coverage kept per tile (as the kit's card atlas,
    // so a stand far off keeps its spires instead of melting to a blob) and the snow atlas point-sampled (a tree's id
    // survives) on the CPU from a read-back
    const empty = new THREE.Scene();
    normal.scissorTest = false; normal.viewport.set(0, 0, normal.width, normal.height); normal.scissor.set(0, 0, normal.width, normal.height);
    normal.texture.generateMipmaps = true;
    renderer.setRenderTarget(normal);
    renderer.render(empty, cam);
    const tm = performance.now();
    const albTex = cpuMips(renderer, albedo, 'albedo'), snowTex = cpuMips(renderer, snow, 'snow');
    // a tile spans ~116 m across but often only ~40 m up, so the vertical squeeze would pick the mip: filter anisotropically
    const aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    albTex.anisotropy = aniso; normal.texture.anisotropy = aniso;
    this.stats.mipMs = Math.round(performance.now() - tm);
    albedo.dispose(); snow.dispose();
    this.targets = [normal];
    this.textures = [albTex, snowTex];
    for (const m of Object.values(mats)) m.dispose();
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    this.mesh.material = this.buildMaterial(albTex, normal.texture, snowTex);
    // prototype debug: the albedo and snow atlases (level 0) as PNG data URLs (window.__clumpAtlas())
    (window as unknown as { __clumpAtlas?: () => string[] }).__clumpAtlas = () => this.textures.map((tex, ti) => {
      const w = tex.image.width, h = tex.image.height, px = tex.image.data as Uint8Array;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d')!, img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = ((h - 1 - y) * w + x) * 4, o = (y * w + x) * 4;
        img.data[o] = px[i]; img.data[o + 1] = px[i + 1]; img.data[o + 2] = px[i + 2]; img.data[o + 3] = ti === 0 ? Math.max(px[i + 3], 40) : 255;
      }
      ctx.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    });
    this.stats.bakeMs = Math.round(performance.now() - t0);
    this.stats.buildMs = this.stats.bakeMs;
    this.stats.trees = trees;
    this.stats.bytes = Math.round(3 * COLS * TILE * ROWS * TILE * 4 * 4 / 3);
  }

  private buildMaterial(albedo: THREE.Texture, normal: THREE.Texture, snow: THREE.Texture): THREE.ShaderMaterial {
    const frames = ELS.map((_, i) => new THREE.Vector2(...frame(i)));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...kitUniforms, ...treeSnowUniforms, ...this.cov,
        uBand: this.band, uAlbedo: { value: albedo }, uNormal: { value: normal }, uSnowMask: { value: snow },
        uEls: { value: ELS }, uFrames: { value: frames }, uShares: { value: SHARES },
        uSunDir: farLight.sunDir, uSunColor: farLight.sunColor, uHemiSky: farLight.hemiSky, uHemiGround: farLight.hemiGround,
      },
      vertexShader: /* glsl */ `
        attribute vec4 iPos; attribute vec4 iMisc;
        uniform vec3 uLodCam; uniform vec4 uBand;
        uniform float uEls[${COLS}]; uniform vec2 uFrames[${COLS}]; uniform float uShares[${SHARES.length}];
        varying vec2 vCard; varying vec4 vTile; varying vec3 vR; varying vec3 vB; varying vec3 vWorld; varying float vShare; varying float vTint; varying float vFlip;
        varying float vLodVis; varying float vLodIn;
        #include <fog_pars_vertex>
        ${TREE_SNOW_VERT}
        void main() {
          vec3 C = iPos.xyz;
          float d = distance(C, uLodCam);
          float vin = clamp((d - uBand.x) / max(uBand.y - uBand.x, 1e-3), 0.0, 1.0);
          float vout = 1.0 - clamp((d - uBand.z) / max(uBand.w - uBand.z, 1e-3), 0.0, 1.0);
          vLodIn = d < 0.5 * (uBand.y + uBand.z) ? 1.0 : 0.0;
          vLodVis = vLodIn > 0.5 ? vin : vout;
          treeSnowLoad(C);
          vec3 toC = C - cameraPosition;
          vec3 V = normalize(toC);
          vec3 n = normalize(vec3(-iMisc.x, 1.0, iMisc.y));
          float el = asin(clamp(dot(-V, n), 0.0, 1.0));
          int i = 0;
          for (int k = 1; k < ${COLS - 1}; k++) if (el >= uEls[k]) i = k;
          float t = clamp((el - uEls[i]) / (uEls[i + 1] - uEls[i]), 0.0, 1.0);
          vec3 Vh = vec3(V.x, 0.0, V.z);
          Vh = length(Vh) > 1e-4 ? normalize(Vh) : vec3(0.0, 0.0, -1.0);
          vec3 R = normalize(cross(Vh, vec3(0.0, 1.0, 0.0)));
          vec3 U = cross(R, V);
          float sR = dot(vec3(iMisc.x, 0.0, -iMisc.y), R);
          vec2 fA = uFrames[i], fB = uFrames[i + 1];
          float vlo = min(fA.x, fB.x), vhi = max(fA.y, fB.y);
          float row = floor(iPos.w);
          // far off the stand stretches up (to STRETCH x by 6 km), as the kit's impostors grow there, so ridgelines keep their tree tops
          float hs = (0.75 + fract(iPos.w) / 0.98 * 0.5) * (1.0 + ${(STRETCH - 1).toFixed(2)} * smoothstep(1500.0, 6000.0, d));
          float u = (position.x - 0.5) * ${W.toFixed(2)};
          float v = mix(vlo, vhi, position.y);
          // the stand's height: the card stretches up (the baked frame is in metres of the bake's own stand)
          vec3 P = C + R * u + U * (v * hs) + vec3(0.0, sR * u, 0.0);
          vCard = vec2(u, v);
          vTile = vec4(float(i), t, row, hs);
          vR = R; vB = -Vh;
          vFlip = iMisc.z;
          vTint = iMisc.w;
          vShare = uShares[int(row) / ${SEEDS}];
          vWorld = P;
          vec4 mvPosition = viewMatrix * vec4(P, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          if (vLodVis <= 0.0) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAlbedo; uniform sampler2D uNormal; uniform sampler2D uSnowMask;
        uniform mat4 projectionMatrix;
        uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uHemiSky; uniform vec3 uHemiGround;
        uniform vec2 uFrames[${COLS}];
        uniform sampler2D uCov0, uCov1, uCov2; uniform vec4 uCovRect[3]; uniform vec3 uCovLod; uniform vec3 uCovB; uniform float uCovBlend;
        ${TREE_SNOW_COMMON}
        ${TREE_SNOW_LIGHT}
        ${BAYER}
        varying vec2 vCard; varying vec4 vTile; varying vec3 vR; varying vec3 vB; varying vec3 vWorld; varying float vShare; varying float vTint; varying float vFlip;
        varying float vLodVis; varying float vLodIn;
        #include <fog_pars_fragment>
        float covW(vec2 p, vec4 r) { vec2 d = min(p - r.xy, r.zw - p); return smoothstep(0.0, uCovBlend, min(d.x, d.y)); }
        vec2 covUV(vec2 p, vec4 r) { return vec2((p.x - r.x) / (r.z - r.x), (r.w - p.y) / (r.w - r.y)); }
        // a level's crown cover: its B (the drawn trees) where it has them, else its forest share R through shareOf
        float levelShare(vec4 t, float hasB) {
          float tt = clamp((t.r - ${COVER_LO.toFixed(3)}) / ${(COVER_HI - COVER_LO).toFixed(3)}, 0.0, 1.0);
          return hasB > 0.5 ? min(t.b * ${COVER_B.toFixed(3)}, ${COVER_MAX.toFixed(3)}) : tt * tt * (3.0 - 2.0 * tt) * ${COVER_MAX.toFixed(3)};
        }
        float coverShare(vec2 p) {
          float f0 = levelShare(textureLod(uCov0, covUV(p, uCovRect[0]), uCovLod.x), uCovB.x);
          float f1 = levelShare(textureLod(uCov1, covUV(p, uCovRect[1]), uCovLod.y), uCovB.y);
          float f2 = levelShare(textureLod(uCov2, covUV(p, uCovRect[2]), uCovLod.z), uCovB.z);
          float w0 = covW(p, uCovRect[0]), w1 = covW(p, uCovRect[1]), w2 = covW(p, uCovRect[2]);
          float f = f0 * w0, c = w0;
          f = mix(f, f1, w1); c = mix(c, 1.0, w1);
          f = mix(f, f2, w2); c = mix(c, 1.0, w2);
          return c > 1e-4 ? f / c : 0.0;
        }
        float kGGX(vec3 n, vec3 l, vec3 v) {
          float a = 0.8464, a2 = a * a;
          vec3 h = normalize(l + v);
          float nl = clamp(dot(n, l), 0.0, 1.0), nv = clamp(abs(dot(n, v)), 1e-3, 1.0), nh = clamp(dot(n, h), 0.0, 1.0), vh = clamp(dot(v, h), 0.0, 1.0);
          float f = 0.04 + 0.96 * exp2((-5.55473 * vh - 6.98316) * vh);
          float gv = nl * sqrt(a2 + (1.0 - a2) * nv * nv), gl = nv * sqrt(a2 + (1.0 - a2) * nl * nl);
          float vis = 0.5 / max(gv + gl, 1e-6);
          float dd = nh * nh * (a2 - 1.0) + 1.0;
          return f * vis * a2 / (3.14159265 * dd * dd) * nl;
        }
        void main() {
          float lb = cBayer8(gl_FragCoord.xy);
          if (vLodIn > 0.5 ? lb < 1.0 - vLodVis : lb >= vLodVis) discard;
          int i = int(vTile.x + 0.5);
          float t = vTile.y, row = vTile.z;
          vec2 fA = uFrames[i], fB = uFrames[i + 1];
          float uT = clamp((vCard.x * vFlip) / ${W.toFixed(2)} + 0.5, 0.0, 1.0);
          float vA = (vCard.y - fA.x) / (fA.y - fA.x), vB = (vCard.y - fB.x) / (fB.y - fB.x);
          float inA = step(0.0, vA) * step(vA, 1.0), inB = step(0.0, vB) * step(vB, 1.0);
          // a half texel inside the tile so the filter does not reach the next one
          float ht = 0.5 / ${TILE.toFixed(1)};
          vec2 uvA = vec2((float(i) + mix(ht, 1.0 - ht, uT)) / ${COLS.toFixed(1)}, (row + mix(ht, 1.0 - ht, clamp(vA, 0.0, 1.0))) / ${ROWS.toFixed(1)});
          vec2 uvB = vec2((float(i + 1) + mix(ht, 1.0 - ht, uT)) / ${COLS.toFixed(1)}, (row + mix(ht, 1.0 - ht, clamp(vB, 0.0, 1.0))) / ${ROWS.toFixed(1)});
          vec4 aA = texture2D(uAlbedo, uvA), aB = texture2D(uAlbedo, uvB);
          float wA = (1.0 - t) * inA * aA.a, wB = t * inB * aB.a;
          float cov = wA + wB;
          // alpha: crisp where the atlas is magnified, a dither of the coverage where it is minified (mips average it)
          vec2 tx = fwidth(uvA) * vec2(${(COLS * TILE).toFixed(1)}, ${(ROWS * TILE).toFixed(1)});
          float mk = smoothstep(0.7, 1.5, max(tx.x, tx.y));
          if (cov <= mix(0.5, ${ALPHA_FAR.toFixed(3)}, mk)) discard;
          float wn = wB / max(cov, 1e-4);
          vec4 nd = mix(texture2D(uNormal, uvA), texture2D(uNormal, uvB), wn);
          vec4 sm = mix(texture2D(uSnowMask, uvA), texture2D(uSnowMask, uvB), wn);
          vec3 albT = mix(aA.rgb, aB.rgb, wn);
          // the crown's point: along the view ray by the baked depth
          float s = (nd.w * 2.0 - 1.0) * ${DMAX.toFixed(1)} * mix(1.0, vTile.w, 0.5);
          vec3 ray = normalize(vWorld - cameraPosition);
          vec3 Pt = vWorld + ray * s;
          // thin to the local forest: a tree stays while its id is under the share here over the class's
          float here = coverShare(vec2(Pt.x, -Pt.z));
          // (where the atlas is minified its id channel is a blur of ids: a dither stands in for it); a stand at least
          // THIN_FULL of the class's share keeps every tree, so the forest stays closed and only runs and glades cut it
          float id = sm.a; // point-sampled mips: a tree's id holds far off
          if (id >= smoothstep(0.0, ${THIN_FULL.toFixed(3)}, here / vShare)) discard;
          vec3 nb = nd.xyz * 2.0 - 1.0;
          nb.x *= vFlip;
          vec3 n = normalize(vR * nb.x + vec3(0.0, 1.0, 0.0) * nb.y + vB * nb.z);
          float load = vSnowLoad * (1.0 - uTreeSnow.y * clamp(dot(n.xz, uTreeSunDir.xz) * 1.5, 0.0, 1.0) * (1.0 - vSnowGhost));
          float scov = (load < 0.5 ? sm.r * load * 2.0 : mix(sm.r, sm.g, load * 2.0 - 1.0)) * ${SNOW_K.toFixed(3)};
          scov = mix(scov, max(scov, sm.g), vSnowGhost);
          // FEAT-278 refine: far off the mips average a stand's snow and sunlit sides into one dark tone (flat from the air,
          // worst at dawn); there a pixel is one crown instead, drawn per crown cell with the averaged chance, so the mean
          // holds and the speckle the drawn trees make comes back
          vec3 hc = cHash3(floor(Pt.xz / ${CROWN_CELL.toFixed(2)}));
          float dk = mk * ${DITHER.toFixed(2)};
          scov = mix(scov, step(hc.x, scov / ${SNOW_PEAK.toFixed(2)}) * ${SNOW_PEAK.toFixed(2)}, dk);
          // (a stand's needles read darker and bluer than one tree's: the light between the crowns is shade; matched to High's stills)
          vec3 needle = albT * vTint * ${FAR_GAIN.toFixed(2)} * vec3(0.7, 0.78, 0.92) * mix(1.0, 0.7 + 0.6 * hc.z, dk);
          vec3 alb = mix(needle, TREE_SNOW_ALB, scov);
          vec3 ns = normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.6 * scov));
          // the stand shades itself: a low sun reaches only the tops of a closed stand
          float sunEl = clamp(uSunDir.y, 0.0, 1.0);
          float lit = smoothstep(0.0, 0.85, sm.b + sunEl * 1.4 - 0.25);
          lit = mix(lit, step(hc.y, lit), dk);
          float selfSh = mix(1.0, lit, clamp(vShare * 1.3, 0.0, 1.0));
          vec3 hemi = mix(uHemiGround, uHemiSky, 0.5 * ns.y + 0.5) * mix(vec3(1.0), TREE_SNOW_SHADE, scov);
          vec3 vv = -ray;
          vec3 col = alb * (uSunColor * max(dot(ns, uSunDir), 0.0) * selfSh + hemi) * 0.31830989 + uSunColor * kGGX(ns, uSunDir, vv) * ${SPEC_K.toFixed(2)} * selfSh
            + treeNeedleExtra(needle, n, vv, scov);
          gl_FragColor = vec4(col, 1.0);
          vec4 cp = projectionMatrix * (viewMatrix * vec4(Pt, 1.0));
          gl_FragDepth = clamp(cp.z / cp.w * 0.5 + 0.5, 0.0, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      fog: true,
      side: THREE.DoubleSide,
    });
    mat.name = 'trees clumps';
    return mat;
  }

  /** hand the loaded cover levels (the finest three, coarsest first, as the terrain) to the shader; true once all are in */
  private syncCover(): boolean {
    const cover = this.pack.cover;
    if (!cover) return true;
    const loaded = cover.levels.filter((l) => l.loaded && l.texture);
    if (loaded.length !== this.covSeen) {
      this.covSeen = loaded.length;
      const use = loaded.slice(-3);
      const keys = ['uCov0', 'uCov1', 'uCov2'] as const;
      for (let i = 0; i < 3; i++) {
        const l = use[i];
        this.cov[keys[i]].value = l ? l.texture! : this.blank;
        if (l) this.cov.uCovRect.value[i].set(...l.rect); else this.cov.uCovRect.value[i].set(-1e7, -1e7, -1e7 + 1000, -1e7 + 1000);
        // read the share over about 12 m round the crown
        this.cov.uCovLod.value.setComponent(i, l ? Math.max(0, Math.log2(12 / l.meta.res)) : 0);
        this.cov.uCovB.value.setComponent(i, l?.hasTrees ? 1 : 0);
      }
      this.cov.uCovBlend.value = cover.meta.blend;
    }
    return loaded.length === cover.levels.length;
  }

  /** crown cover at (x, y) from the finest loaded cover level there (its texture's bytes, as the shader reads them) */
  private shareAt(x: number, y: number): number {
    const cover = this.pack.cover;
    if (!cover) return 0;
    for (let i = cover.levels.length - 1; i >= 0; i--) {
      const l = cover.levels[i], t = l.texture;
      if (!t) continue;
      const r = l.rect, m = Math.min(cover.meta.blend * 0.5, (r[2] - r[0]) * 0.05);
      if (x < r[0] + m || x > r[2] - m || y < r[1] + m || y > r[3] - m) continue;
      const w = l.meta.w, h = l.meta.h, res = l.meta.res, n = l.hasTrees ? 4 : 2, data = t.image.data as Uint8Array;
      const col = Math.min(w - 1, Math.max(0, Math.floor((x - r[0]) / res))), row = Math.min(h - 1, Math.max(0, Math.floor((r[3] - y) / res)));
      const o = (row * w + col) * n;
      return l.hasTrees ? shareOfB(data[o + 2] / 255) : shareOf(data[o] / 255);
    }
    return 0;
  }

  /** the height set a block's ground comes from (the mid set where it reaches, else the far set), requested; null if not loaded yet */
  private heightSet(x0: number, y0: number, x1: number, y1: number): HeightSet | null | 'none' {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    for (const s of [this.pack.mid, this.pack.far]) {
      if (!s || !s.contains(cx, cy)) continue;
      return s.request(x0, y0, x1, y1) ? s : null;
    }
    return 'none';
  }

  /** place a block's clumps: one per forested CELL, its class from the cover there, on the ground with its slope */
  private computeBlock(b: Block): boolean {
    const cover = this.pack.cover;
    const x0 = b.bx * BLOCK, y0 = b.by * BLOCK;
    const hs = this.heightSet(x0 - CELL, y0 - CELL, x0 + BLOCK + CELL, y0 + BLOCK + CELL);
    if (hs === null) return false;
    const hAt = (x: number, y: number): number => {
      if (hs !== 'none') { const h = hs.sample(x, y); if (!Number.isNaN(h)) return h; }
      return this.pack.height(x, y, 64);
    };
    const out = new Float32Array(BLOCK_CELLS * BLOCK_CELLS * 8);
    const smp = [0, 0, 0, 0];
    let n = 0;
    for (let j = 0; j < BLOCK_CELLS; j++) for (let i = 0; i < BLOCK_CELLS; i++) {
      const cx = x0 + (i + 0.5) * CELL, cy = y0 + (j + 0.5) * CELL;
      // crown cover over the cell (7 x 7 samples): the mean, leaning to the densest part (the shader thins the rest)
      let sum = 0, max = 0;
      for (let a = -3; a <= 3; a++) for (let c = -3; c <= 3; c++) {
        const v = this.shareAt(cx + a * 9, cy + c * 9);
        sum += v; max = Math.max(max, v);
      }
      const sh = 0.7 * (sum / 49) + 0.3 * max;
      // the canopy height there (cover G), else the patch's own; a little per clump either way
      let hc = 0;
      if (cover) { cover.sample(cx, cy, smp); hc = smp[1]; }
      const hs = Math.max(0.75, Math.min(1.25, (hc > 4 ? hc / 20 : 1) * (0.9 + 0.2 * hash01(cx, cy, 77))));
      if (sh < 0.01) continue;
      // the class: the baked covers either side of the share, picked by a hash so the mean is right
      let k = 0;
      const u = hash01(cx, cy, 71);
      if (sh <= SHARES[0]) { if (u > sh / SHARES[0] * 1.2) continue; k = 0; }
      else if (sh >= SHARES[SHARES.length - 1]) k = SHARES.length - 1;
      else { while (sh > SHARES[k + 1]) k++; k += u < (sh - SHARES[k]) / (SHARES[k + 1] - SHARES[k]) ? 1 : 0; }
      const seed = hash01(cx, cy, 72) < 0.5 ? 0 : 1;
      const px = cx + (hash01(cx, cy, 73) - 0.5) * 36, py = cy + (hash01(cx, cy, 74) - 0.5) * 36;
      const e = 24, h = hAt(px, py);
      const hx = (hAt(px + e, py) - hAt(px - e, py)) / (2 * e), hy = (hAt(px, py + e) - hAt(px, py - e)) / (2 * e);
      const o = n * 8;
      out[o] = px; out[o + 1] = h; out[o + 2] = -py; out[o + 3] = k * SEEDS + seed + (hs - 0.75) / 0.5 * 0.98;
      out[o + 4] = hx; out[o + 5] = hy; out[o + 6] = hash01(cx, cy, 75) < 0.5 ? -1 : 1; out[o + 7] = 0.92 + 0.16 * hash01(cx, cy, 76);
      n++;
    }
    b.data = out; b.count = n; b.ready = true;
    return true;
  }

  /**
   * Per update: the band (m from the camera) the clumps draw in, `near` fading in over +-`fade`, out by `far`; the camera
   * (pack metres). Computes the blocks the band reaches (within the time budget) and repacks the buffer when needed.
   */
  update(cx: number, cy: number, near: number, fade: number, far: number, budgetMs = 4): void {
    if (!this.targets.length) return;
    const t0 = performance.now();
    this.band.value.set(near - fade, near + fade, far - 300, far);
    const coverIn = this.syncCover();
    const reach = far + RD;
    const bx0 = Math.floor((cx - reach) / BLOCK), bx1 = Math.floor((cx + reach) / BLOCK);
    const by0 = Math.floor((cy - reach) / BLOCK), by1 = Math.floor((cy + reach) / BLOCK);
    let busy = coverIn ? 0 : 1;
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      const key = (by + 4096) * 8192 + bx + 4096;
      const dMin = Math.hypot(Math.max(bx * BLOCK - cx, 0, cx - (bx + 1) * BLOCK), Math.max(by * BLOCK - cy, 0, cy - (by + 1) * BLOCK));
      if (dMin > reach) continue;
      // blocks wholly inside the trees' reach hold no clump that can show
      const dMax = Math.hypot(Math.max(Math.abs(cx - bx * BLOCK), Math.abs(cx - (bx + 1) * BLOCK)), Math.max(Math.abs(cy - by * BLOCK), Math.abs(cy - (by + 1) * BLOCK)));
      if (dMax < near - fade - RD) continue;
      let b = this.blocks.get(key);
      if (!b) { b = { key, bx, by, data: new Float32Array(0), count: 0, ready: false }; this.blocks.set(key, b); }
      if (b.ready) continue;
      if (!coverIn || (budgetMs > 0 && performance.now() - t0 > budgetMs)) { busy++; continue; }
      if (this.computeBlock(b)) this.blocksReady++;
      else busy++;
    }
    // drop blocks well out of reach
    for (const [key, b] of this.blocks) {
      const dMin = Math.hypot(Math.max(b.bx * BLOCK - cx, 0, cx - (b.bx + 1) * BLOCK), Math.max(b.by * BLOCK - cy, 0, cy - (b.by + 1) * BLOCK));
      if (dMin > reach + 3000) { this.blocks.delete(key); this.blocksReady -= b.ready ? 1 : 0; }
    }
    const L = this.last;
    if (this.blocksReady !== L.blocksReady || Math.hypot(cx - L.x, cy - L.y) > CELL * 2 || Math.abs(near - L.near) > 1 || Math.abs(far - L.far) > 1) {
      this.pack_(cx, cy, near - fade - RD, reach);
      L.x = cx; L.y = cy; L.near = near; L.far = far; L.blocksReady = this.blocksReady;
    }
    this.stats.busy = busy;
    this.stats.blocks = this.blocks.size;
    this.stats.placeMs = Math.round((this.stats.placeMs + performance.now() - t0) * 10) / 10;
    this.stats.buildMs = Math.round(this.stats.bakeMs + this.stats.placeMs);
    // FEAT-278 mix: the shell owns window.__canopy and carries these as .clumps
    const w = window as unknown as { __canopy?: { mode?: string; clumps?: unknown } };
    if (w.__canopy?.mode === 'mix') w.__canopy.clumps = this.stats; else w.__canopy = this.stats;
  }

  /** copy the clumps of the ready blocks the annulus lo..hi reaches into the instance buffers */
  private pack_(cx: number, cy: number, lo: number, hi: number): void {
    let total = 0;
    const use: Block[] = [];
    for (const b of this.blocks.values()) {
      if (!b.ready || !b.count) continue;
      const x0 = b.bx * BLOCK, y0 = b.by * BLOCK;
      const dMin = Math.hypot(Math.max(x0 - cx, 0, cx - x0 - BLOCK), Math.max(y0 - cy, 0, cy - y0 - BLOCK));
      const dMax = Math.hypot(Math.max(Math.abs(cx - x0), Math.abs(cx - x0 - BLOCK)), Math.max(Math.abs(cy - y0), Math.abs(cy - y0 - BLOCK)));
      if (dMin > hi || dMax < lo) continue;
      use.push(b); total += b.count;
    }
    if (this.iPos.count < total) {
      const cap = Math.ceil(total * 1.3) + 256;
      this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      this.iMisc = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      this.geo.setAttribute('iPos', this.iPos); this.geo.setAttribute('iMisc', this.iMisc);
    }
    const p = this.iPos.array as Float32Array, m = this.iMisc.array as Float32Array;
    let q = 0;
    for (const b of use) {
      const d = b.data;
      for (let i = 0; i < b.count; i++, q++) {
        const o = i * 8;
        p[q * 4] = d[o]; p[q * 4 + 1] = d[o + 1]; p[q * 4 + 2] = d[o + 2]; p[q * 4 + 3] = d[o + 3];
        m[q * 4] = d[o + 4]; m[q * 4 + 1] = d[o + 5]; m[q * 4 + 2] = d[o + 6]; m[q * 4 + 3] = d[o + 7];
      }
    }
    this.geo.instanceCount = q;
    for (const a of [this.iPos, this.iMisc]) { a.clearUpdateRanges(); if (q) a.addUpdateRange(0, q * 4); a.needsUpdate = true; }
    this.mesh.visible = q > 0;
    this.stats.tiles = q;
    this.stats.bytes = Math.round(3 * COLS * TILE * ROWS * TILE * 4 * 4 / 3) + this.iPos.array.byteLength * 2;
  }

  dispose(): void {
    for (const rt of this.targets) rt.dispose();
    for (const t of this.textures) t.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}
