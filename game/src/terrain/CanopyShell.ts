import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { CoverLevel } from '../pack/CoverSet';
import { NOISE_GLSL } from './rockShader';

/**
 * FEAT-278 prototype (`?canopy=shell`): the far forest as a low-poly canopy surface instead of flat timber paint.
 *
 * A quadtree of tiles (N x N quads each, 4 m vertex spacing inside the pack's crown map, coarser with distance)
 * draped over the ground at canopy height. Each vertex reads the pack's cover (FEAT-153) on the CPU: the forest
 * share and canopy height, and inside the pack the 4 m crowns map (where the drawn trees stand, cover/pack-stands.png
 * G), box-filtered to the tile's spacing (CoverLevel.crownMips). Where the crowns are, the vertex stands up by the
 * canopy height (jittered per vertex, so the tops are uneven); where they are not, it sinks below the ground, so the
 * terrain's snow shows between stands. At 4 m spacing a lone crown is a single raised vertex: a cone about 5 m across.
 *
 * In a closed stand (the crowns over 16 m), a 4 m vertex between crowns stays at a third of the canopy instead.
 *
 * The shader: on 4 m tiles the geometry is the crowns (dark needles, crown-scale bumps, snow on the tops, snow in a
 * gap where a view from above reaches it). On coarser tiles each pixel marches 8 steps down through a 16 m layer of
 * procedural crown cones (one per 4.5 m cell of a turned, warped lattice, present with the chance the mipmapped 4 m
 * crowns map gives): a grazing view meets crown sides, a view from above finds snow between them, and past a pixel per
 * cell it aliases to the speckle the drawn trees make. Needles take less of the sun (self-shaded crowns). The surface
 * rises out of the ground over the band where the drawn trees end, and sinks back past `far`, where the terrain's
 * canopy lift takes over (Terrain.update moves uLiftNear there).
 *
 * Built on the main thread, a time budget per frame; one shared index buffer; a draw call per visible tile.
 */
const N = 64;
const ROOT_MIN = -16384;
const ROOT_SIZE = 32768;
/** split a tile while the camera is closer than its size times this */
const SPLIT_K = 1.8;
/** m: finest spacing inside the crowns map, and outside it (the mid cover level is 16 m) */
const MIN_RES_CROWNS = 4;
const MIN_RES_OPEN = 16;
/** the crown tops stand this share of the cover's canopy height (cones: the bump's top is near the tree top) */
const TOP_K = 0.9;
const CANOPY_DEFAULT = 16;
const MIN_CANOPY_H = 4;

interface Tile {
  key: string;
  level: number;
  minX: number;
  minY: number;
  size: number;
  res: number;
  mesh: THREE.Mesh | null;
  built: boolean;
  bytes: number;
  lastUsed: number;
}

function hash2(ix: number, iy: number): number { let h = (ix * 374761393 + iy * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise2(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
const smooth = (x: number, a: number, b: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export interface CanopyStats { mode: 'shell'; buildMs: number; bytes: number; tiles: number; busy: number; builds: number; buildFrames: number; maxFrameMs: number; drawn: number }

export class CanopyShell {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly stats: CanopyStats = { mode: 'shell', buildMs: 0, bytes: 0, tiles: 0, busy: 0, builds: 0, buildFrames: 0, maxFrameMs: 0, drawn: 0 };
  /** ms of builds per frame (at least one build) */
  budgetMs = 3;
  private readonly pack: Pack;
  private readonly tiles = new Map<string, Tile>();
  private visible: Tile[] = [];
  private frame = 0;
  private readonly index: THREE.BufferAttribute;
  private readonly crowns: CoverLevel | null;
  private readonly cs = [0, 0, 0, 0];
  private readonly cc = [0, 0];
  /** (rise start, rise end, sink start, sink end), m from the camera */
  readonly range = new THREE.Vector4(1e9, 1e9 + 1, 2e9, 2e9 + 1);

  constructor(pack: Pack, shared: Record<string, { value: unknown }>) {
    this.pack = pack;
    this.group.name = 'canopy shell';
    this.crowns = pack.cover?.levels.find((l) => l.meta.crowns) ?? null;
    this.index = this.buildIndex();
    this.material = this.createMaterial(shared);
  }

  /** the near edge and ramp (the shell rises over it) and the far edge; m */
  setRange(riseStart: number, riseEnd: number, far: number, farRamp: number): void {
    this.range.set(riseStart, Math.max(riseEnd, riseStart + 1), far - farRamp, far);
  }

  private ready(): boolean {
    const c = this.pack.cover;
    return !!c && c.levels.every((l) => l.loaded) && (!this.crowns || !!this.crowns.crownMips);
  }

  update(cx: number, cy: number, cz: number): void {
    this.frame++;
    this.visible = [];
    this.select(0, ROOT_MIN, ROOT_MIN, ROOT_SIZE, cx, cy, cz);
    const want = new Set<string>();
    let busy = 0, builds = 0;
    const t0 = performance.now();
    const ok = this.ready();
    for (const t of this.visible) {
      want.add(t.key);
      t.lastUsed = this.frame;
      if (t.built) continue;
      if (ok && (builds === 0 || performance.now() - t0 < this.budgetMs)) { this.build(t); builds++; }
      else busy++;
    }
    if (builds) {
      const ms = performance.now() - t0;
      this.stats.buildMs += ms; this.stats.builds += builds; this.stats.buildFrames++;
      this.stats.maxFrameMs = Math.max(this.stats.maxFrameMs, ms);
    }
    let bytes = this.index.array.byteLength, drawn = 0;
    for (const t of this.tiles.values()) {
      bytes += t.bytes;
      if (!t.mesh) { if (this.frame - t.lastUsed > 600) this.tiles.delete(t.key); continue; }
      let show = want.has(t.key);
      // keep an ancestor while its selected descendants build
      if (!show) show = this.visible.some((v) => !v.built && v.level > t.level && v.minX >= t.minX && v.minY >= t.minY && v.minX + v.size <= t.minX + t.size && v.minY + v.size <= t.minY + t.size);
      t.mesh.visible = show;
      if (show) drawn++;
      if (!show && this.frame - t.lastUsed > 600) {
        t.mesh.geometry.dispose(); this.group.remove(t.mesh); this.tiles.delete(t.key);
      }
    }
    this.stats.bytes = bytes; this.stats.tiles = this.tiles.size; this.stats.busy = busy; this.stats.drawn = drawn;
  }

  private minRes(x: number, y: number): number {
    const r = this.crowns?.rect;
    return r && x > r[0] && x < r[2] && y > r[1] && y < r[3] ? MIN_RES_CROWNS : MIN_RES_OPEN;
  }

  private select(level: number, minX: number, minY: number, size: number, cx: number, cy: number, cz: number): void {
    const zr = this.pack.meta.zRange, zmid = (zr[0] + zr[1]) / 2;
    const dx = Math.max(minX - cx, 0, cx - minX - size), dy = Math.max(minY - cy, 0, cy - minY - size);
    const dz = Math.max(0, Math.abs(cz - zmid) - (zr[1] - zr[0]) / 2);
    const d = Math.hypot(dx, dy, dz);
    if (d > this.range.w) return;
    const dMax = Math.hypot(Math.max(Math.abs(cx - minX), Math.abs(cx - minX - size)), Math.max(Math.abs(cy - minY), Math.abs(cy - minY - size)), Math.abs(cz - zr[0]) + 50);
    if (dMax < this.range.x) return; // wholly inside the drawn trees
    const res = size / N;
    if (res > this.minRes(minX + size / 2, minY + size / 2) && d < size * SPLIT_K) {
      const h = size / 2;
      this.select(level + 1, minX, minY, h, cx, cy, cz);
      this.select(level + 1, minX + h, minY, h, cx, cy, cz);
      this.select(level + 1, minX, minY + h, h, cx, cy, cz);
      this.select(level + 1, minX + h, minY + h, h, cx, cy, cz);
      return;
    }
    const key = `${level}/${Math.round(minX)}/${Math.round(minY)}`;
    let t = this.tiles.get(key);
    if (!t) { t = { key, level, minX, minY, size, res, mesh: null, built: false, bytes: 0, lastUsed: this.frame }; this.tiles.set(key, t); }
    this.visible.push(t);
  }

  private buildIndex(): THREE.BufferAttribute {
    const n = N + 1, idx: number[] = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
    // skirt: the perimeter (south, east, north, west) and its dropped copies after the grid
    const per = 4 * N;
    for (let k = 0; k < per; k++) {
      const e0 = this.edge(k), e1 = this.edge((k + 1) % per), s0 = n * n + k, s1 = n * n + ((k + 1) % per);
      idx.push(e0, s0, e1, e1, s0, s1);
    }
    return new THREE.BufferAttribute(new Uint16Array(idx), 1);
  }

  /** the grid index of perimeter vertex k (counter-clockwise from the south-west corner) */
  private edge(k: number): number {
    const n = N + 1, s = Math.floor(k / N), o = k % N;
    if (s === 0) return o; // south, west to east
    if (s === 1) return o * n + N; // east, south to north
    if (s === 2) return N * n + (N - o); // north, east to west
    return (N - o) * n; // west, north to south
  }

  /** canopy at (x, y) for a tile of spacing `res`: [shell height above ground (m), crown cover 0..1] */
  private canopyAt(x: number, y: number, res: number, out: number[]): void {
    const cover = this.pack.cover!;
    const cs = this.cs;
    const cw = cover.sample(x, y, cs);
    let f = cw > 0 ? cs[0] : 0;
    const H = cs[1] > MIN_CANOPY_H ? cs[1] : CANOPY_DEFAULT;
    let c = f, dense = f;
    const cl = this.crowns;
    if (cl?.crownMips) {
      const w = cl.weight(x, y, cover.meta.blend);
      if (w > 0) {
        cl.sampleCrowns(x, y, res, this.cc);
        f += (this.cc[0] - f) * w;
        c += (this.cc[1] - c) * w;
        // how closed the stand is round here (the crowns over about 16 m)
        if (res <= 4) { cl.sampleCrowns(x, y, 16, this.cc); dense += (this.cc[1] - dense) * w; }
      }
    }
    // the stand forms where the crowns are; at 4 m a crown cell alone is a cone, coarser tiles show stands
    const lo = res <= 4 ? 0.2 : res <= 8 ? 0.12 : 0.06, hi = res <= 4 ? 0.55 : res <= 8 ? 0.45 : 0.4;
    const form = smooth(c, lo, hi);
    const ix = Math.round(x / res), iy = Math.round(y / res);
    const jit = res <= 8 ? 0.65 + 0.7 * hash2(ix, iy) : 0.75 + 0.3 * hash2(ix, iy) + 0.2 * vnoise2(x / 45, y / 45);
    const top = H * TOP_K * jit * (0.7 + 0.3 * c);
    const sink = 3 + (res <= 8 ? 1.0 : 0.6) * res; // coarse: shallow, so a stand's edge does not pull in by most of a vertex
    // at 4 m, the gaps inside a closed stand hold the lower crowns and the shade under them, not the ground: they
    // stand at a third of the canopy (the shader shows snow there when seen from above)
    const floor = res <= 4 ? -sink + smooth(dense, 0.6, 0.9) * (0.35 * top + sink) : -sink;
    out[0] = form * top + (1 - form) * floor;
    out[1] = c;
  }

  private build(t: Tile): void {
    t.built = true;
    const n = N + 1, res = t.res, B = n + 2;
    const hs = new Float32Array(B * B), hag = new Float32Array(B * B), cov = new Float32Array(B * B);
    const o = [0, 0];
    let any = false;
    for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) {
      const x = t.minX + i * res, y = t.minY + j * res, k = (j + 1) * B + i + 1;
      this.canopyAt(x, y, res, o);
      const g = this.pack.height(x, y, res, false);
      hs[k] = g + o[0]; hag[k] = o[0]; cov[k] = o[1];
      if (o[0] > 0.5 && i >= 0 && j >= 0 && i < n && j < n) any = true;
    }
    if (!any) return; // no forest in this tile
    const vc = n * n + 4 * N;
    const pos = new Float32Array(vc * 3), nor = new Int8Array(vc * 4), can = new Float32Array(vc * 3);
    let v = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++, v++) {
      const k = (j + 1) * B + i + 1;
      pos[v * 3] = t.minX + i * res; pos[v * 3 + 1] = hs[k]; pos[v * 3 + 2] = -(t.minY + j * res);
      const nx = -(hs[k + 1] - hs[k - 1]) / (2 * res), ny = -(hs[k + B] - hs[k - B]) / (2 * res), l = Math.hypot(nx, ny, 1);
      nor[v * 4] = Math.round(127 * nx / l); nor[v * 4 + 1] = Math.round(127 / l); nor[v * 4 + 2] = Math.round(-127 * ny / l);
      can[v * 3] = hag[k]; can[v * 3 + 1] = cov[k]; can[v * 3 + 2] = res;
    }
    const drop = 3 + res + 40;
    for (let k = 0; k < 4 * N; k++, v++) {
      const e = this.edge(k);
      pos[v * 3] = pos[e * 3]; pos[v * 3 + 1] = pos[e * 3 + 1] - drop; pos[v * 3 + 2] = pos[e * 3 + 2];
      for (let q = 0; q < 3; q++) nor[v * 4 + q] = nor[e * 4 + q];
      can[v * 3] = can[e * 3]; can[v * 3 + 1] = can[e * 3 + 1]; can[v * 3 + 2] = res;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 4, true));
    geo.setAttribute('canopy', new THREE.BufferAttribute(can, 3));
    geo.setIndex(this.index);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `canopy ${t.key}`;
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    t.mesh = mesh;
    t.bytes = pos.byteLength + nor.byteLength + can.byteLength;
    this.group.add(mesh);
  }

  private createMaterial(shared: Record<string, { value: unknown }>): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    const uniforms = {
      uShellRange: { value: this.range },
      uTreeMap: shared.uTreeMap, uTreeMapRect: shared.uTreeMapRect, uCovBlend: shared.uCovBlend,
      uShellSnow: { value: new THREE.Color(0.93, 0.95, 1.0) },
      /** the share of the sun the needles return (shaded needles inside the crowns) */
      uNeedleSun: { value: 0.32 },
      /** how much snow the crowns hold on their tops (0..1) */
      uCrownSnow: { value: 0.3 },
    };
    mat.userData.uniforms = uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 canopy;
          uniform vec4 uShellRange;
          varying vec3 vSWorld; varying vec3 vSNormal; varying vec3 vCanopy;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            vec3 swl = (modelMatrix * vec4(transformed, 1.0)).xyz;
            float sd = distance(cameraPosition, swl);
            // rise out of the ground where the drawn trees end, sink back where the terrain's lift takes over
            float sk = smoothstep(uShellRange.x, uShellRange.y, sd) * (1.0 - smoothstep(uShellRange.z, uShellRange.w, sd));
            float drop = (1.0 - sk) * (max(canopy.x, 0.0) + 4.0);
            transformed.y -= drop;
            vCanopy = vec3(canopy.x - drop, canopy.y, canopy.z);
          }`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vSWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vSNormal = normalize(mat3(modelMatrix) * objectNormal);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vSWorld; varying vec3 vSNormal; varying vec3 vCanopy;
          uniform sampler2D uTreeMap; uniform vec4 uTreeMapRect; uniform float uCovBlend;
          uniform vec3 uShellSnow; uniform float uNeedleSun, uCrownSnow;
          float gNeedle;
          vec3 gCrownN;
          ${NOISE_GLSL}
          float shCovW(vec2 p, vec4 r) { vec2 d = min(p - r.xy, r.zw - p); return smoothstep(0.0, uCovBlend, min(d.x, d.y)); }
          vec2 shCovUV(vec2 p, vec4 r) { return vec2((p.x - r.x) / (r.z - r.x), (r.w - p.y) / (r.w - r.y)); }
          // crown-scale bumps (about 3 to 6 m), pack frame
          float crownH(vec2 p) { return vnoise(vec3(p * 0.28, 0.0)) * 0.65 + vnoise(vec3(p * 0.61, 3.1)) * 0.35; }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            vec3 wp = vSWorld;
            vec2 pxy = vec2(wp.x, -wp.z);
            vec3 V = normalize(cameraPosition - wp);
            vec3 nW = normalize(vSNormal);
            // where the drawn trees stand (4 m, mipmapped), else the vertex's cover
            vec2 tuv = shCovUV(pxy, uTreeMapRect);
            float tw = shCovW(pxy, uTreeMapRect);
            float crownTex = texture2D(uTreeMap, tuv).b;
            float cc = clamp(mix(vCanopy.y, crownTex, tw), 0.0, 1.0);
            // sub-texel crowns fade out once a pixel is wider than a crown
            float pixM = length(fwidth(wp));
            float detK = 1.0 - smoothstep(1.2, 4.0, pixM);
            float ch = crownH(pxy);
            float above = smoothstep(-1.0, 1.0, vCanopy.x);
            float geoK = 1.0 - smoothstep(4.0, 8.0, vCanopy.z);
            float topK = smoothstep(0.3, 0.9, nW.y);
            // near tiles (4 m) carry their crowns in the geometry: the canopy is what stands above the ground,
            // with crown-scale bumps and snow on their tops
            float snowNear = uCrownSnow * topK * mix(0.12, smoothstep(0.62, 0.9, ch), detK);
            vec3 colNear = mix(mix(vec3(0.016, 0.031, 0.029), vec3(0.04, 0.066, 0.058), mix(0.5, ch, detK)), uShellSnow * 0.9, snowNear);
            // a gap in a closed stand: snow on the ground in the crowns' shade where a view from above reaches it
            float muN = clamp(dot(nW, V), 0.05, 1.0);
            float gapVis = (1.0 - cc) * pow(1.0 - cc * 0.5, (1.0 + 4.0 * sqrt(1.0 - muN * muN)) / muN) * smoothstep(0.5, 0.2, cc);
            colNear = mix(colNear, uShellSnow * 0.55, gapVis);
            float e = 0.8;
            float hx = crownH(pxy + vec2(e, 0.0)) - ch, hy = crownH(pxy + vec2(0.0, e)) - ch;
            vec3 nNear = normalize(nW + detK * 3.0 * vec3(-hx / e, 0.0, hy / e));
            // coarse tiles: a relief march through a layer of crown cones under the surface (CROWN_D deep, a cone per
            // CROWN_CELL cell of a turned, warped lattice, there with the chance the crowns map gives), so a grazing view
            // sees tall crowns against each other and a view from above sees snow between them; past a pixel per
            // cell it aliases to the light / dark / white speckle the drawn trees make
            vec3 colFar = vec3(0.0); vec3 nFar = nW; float snowFar = 0.0, canFar = 0.0;
            if (geoK < 1.0) {
              const float CROWN_D = 16.0, CROWN_CELL = 4.5;
              vec2 warp = 0.9 * vec2(vnoise(vec3(pxy * 0.09, 1.0)), vnoise(vec3(pxy * 0.09, 6.0)));
              float covE = clamp(sqrt(cc) * 1.05, 0.0, 1.0);
              vec3 rd = -V;
              float down = max(-dot(rd, nW), 0.04);
              float len = min(CROWN_D / down, 6.0 * CROWN_CELL);
              const int STEPS = 8;
              float hitY = -1.0; vec2 hq = vec2(0.0); float hcell = 0.0;
              for (int i = 0; i < STEPS; i++) {
                float t = len * (float(i) + 0.5) / float(STEPS);
                vec3 P = wp + rd * t;
                float y = CROWN_D - t * down; // height above the layer's floor
                vec2 cq = mat2(0.866, 0.5, -0.5, 0.866) * vec2(P.x, -P.z) / CROWN_CELL + warp;
                vec2 cell = floor(cq);
                vec2 q = fract(cq) - 0.5 - 0.4 * (vec2(hash3(vec3(cell, 3.0)), hash3(vec3(cell, 5.0))) - 0.5);
                float hs = hash3(vec3(cell, 9.0));
                float on = step(hash3(vec3(cell, 7.0)), covE);
                float hcone = on * CROWN_D * (0.6 + 0.4 * hs) * max(1.0 - length(q) / 0.62, 0.0);
                if (y < hcone) { hitY = y; hq = q; hcell = hs; break; }
              }
              if (hitY >= 0.0) {
                float rq = length(hq);
                nFar = normalize(nW + vec3(hq.x, 0.0, -hq.y) / max(rq, 1e-3) * 1.6);
                snowFar = uCrownSnow * topK * (1.0 - smoothstep(0.08, 0.22, rq)) * step(0.55, hcell) * mix(1.0, 0.4, smoothstep(2.0, 8.0, pixM));
                // deeper in the canopy is darker (the crowns shade each other)
                vec3 nd = mix(vec3(0.016, 0.031, 0.029), vec3(0.04, 0.066, 0.058), hcell) * (0.45 + 0.55 * hitY / CROWN_D);
                colFar = mix(nd, uShellSnow * 0.9, snowFar);
                canFar = 1.0;
              } else if (len * down < CROWN_D * 0.98) {
                // a grazing ray that ran out of steps inside the canopy: the shaded inside of the stand
                colFar = vec3(0.012, 0.024, 0.023); canFar = 1.0;
              } else {
                colFar = uShellSnow * mix(1.0, 0.6, cc);
              }
            }
            vec3 col = mix(colFar, colNear, geoK);
            float canopyK = mix(canFar, 1.0, geoK) * above;
            float snowK = mix(snowFar, snowNear, geoK);
            // bits of the shell below the canopy (stand edges, the skirt) are snow on the ground
            diffuseColor.rgb = mix(uShellSnow, col, above);
            gNeedle = canopyK * (1.0 - clamp(snowK, 0.0, 1.0));
            gCrownN = normalize(mix(nFar, nNear, geoK));
          }`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(gCrownN, 0.0)).xyz);`)
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
          reflectedLight.directDiffuse *= mix(1.0, uNeedleSun, gNeedle);
          reflectedLight.indirectDiffuse *= mix(1.0, 0.7, gNeedle);`);
    };
    return mat;
  }
}
