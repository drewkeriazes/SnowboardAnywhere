import * as THREE from 'three';
import { type Pack, MOGUL_MAX_RES, MOGUL_SHADE_MAX_RES } from '../pack/Pack';
import { MOGUL_FALL_D } from './Moguls';
import { createTerrainMaterial } from './TerrainMaterial';

/**
 * Chunked quadtree terrain. The root covers the far height set (262 km). Each chunk is an
 * N x N quad grid built on the CPU from pack.height() at the chunk's resolution, with a skirt
 * to hide cracks between LOD levels. World axes: three.js x = east, y = up, z = south (so
 * pack y = -three.z).
 */
const N = 32; // quads per chunk side
/** Colorado treeline (m): forest below it on the far terrain where there is no canopy mask */
const TREELINE = 3480;
function vhash(ix: number, iy: number): number { let h = (ix * 374761393 + iy * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise2(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = vhash(ix, iy), b = vhash(ix + 1, iy), c = vhash(ix, iy + 1), d = vhash(ix + 1, iy + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
/**
 * Forest cover 0..1 where there is no canopy mask (beyond the pack, coarse chunks): conifers
 * below a noisy treeline, thinning on steep ground and in open patches (meadows, ski runs).
 */
function proceduralForest(x: number, y: number, h: number, slope: number): number {
  const tl = TREELINE + (vnoise2(x / 900, y / 900) - 0.5) * 220;
  const below = THREE.MathUtils.smoothstep(tl + 40 - h, 0, 160);
  const patch = vnoise2(x / 420 + 31.7, y / 420 - 12.3) * 0.65 + vnoise2(x / 140, y / 140) * 0.35;
  const open = THREE.MathUtils.smoothstep(patch, 0.3, 0.5);
  const flatOK = 1 - THREE.MathUtils.smoothstep(slope, 0.6, 0.85); // cliffs carry no trees
  const valley = THREE.MathUtils.smoothstep(h, 2450, 2650); // towns and the I-70 corridor are open
  return below * open * flatOK * valley;
}
/** chunks at or below this vertex spacing (m) take baked AO from the pack; coarser ones are open sky */
const AO_MAX_RES = 32;
/** DATA-002: slope (rise/run) the piste direction counts as at least, so corduroy stays on flat groomed cat tracks */
const DIR_MIN_SLOPE = 0.1;
const SPLIT_K = 2.6; // split when distance < size * SPLIT_K
const MAX_BUILDS_PER_FRAME = 10;

interface Chunk {
  key: string;
  level: number;
  x: number; // chunk index at its level
  y: number;
  minX: number;
  minY: number;
  size: number;
  res: number;
  mesh: THREE.Mesh | null;
  dataRes: number; // finest source resolution available when built
  lastUsed: number;
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private readonly pack: Pack;
  private readonly rootMinX: number;
  private readonly rootMinY: number;
  private readonly rootSize: number;
  private readonly chunks = new Map<string, Chunk>();
  private readonly dirty = new Set<string>();
  private frame = 0;
  private readonly maskSample = [0, 0, 0, 0];
  /** chunks selected this frame */
  private visible: Chunk[] = [];
  readonly stats = { chunks: 0, builds: 0, triangles: 0 };

  constructor(pack: Pack) {
    this.pack = pack;
    this.material = createTerrainMaterial();
    const far = pack.meta.terrain.far ?? pack.meta.terrain.mid ?? pack.meta.terrain.fine!;
    this.rootMinX = far.minX;
    this.rootMinY = far.minY;
    this.rootSize = Math.max(far.maxX - far.minX, far.maxY - far.minY);
    for (const s of pack.sets) {
      s.onTileLoaded = (tx, ty) => this.onTileLoaded(s.meta.minX + tx * s.size, s.meta.minY + ty * s.size, s.size, s.meta.res);
    }
    if (pack.mask) pack.mask.onTileLoaded = (tx, ty) => this.onTileLoaded(pack.mask!.meta.minX + tx * pack.mask!.size, pack.mask!.meta.minY + ty * pack.mask!.size, pack.mask!.size, 0);
    if (pack.ao) pack.ao.onTileLoaded = (tx, ty) => this.onTileLoaded(pack.ao!.meta.minX + tx * pack.ao!.size, pack.ao!.meta.minY + ty * pack.ao!.size, pack.ao!.size, 0);
    if (pack.dir) pack.dir.onTileLoaded = (tx, ty) => this.onTileLoaded(pack.dir!.meta.minX + tx * pack.dir!.size, pack.dir!.meta.minY + ty * pack.dir!.size, pack.dir!.size, 0);
    if (pack.moguls) pack.moguls.onTileLoaded = (tx, ty) => this.onTileLoaded(pack.moguls!.meta.minX + tx * pack.moguls!.size, pack.moguls!.meta.minY + ty * pack.moguls!.size, pack.moguls!.size, 0);
  }

  /** FEAT-105: new snow on the rock (0 = today's look, 1 = a powder day) and the downwind direction (three.js x, z). */
  setSnowCover(v: number, windX: number, windZ: number): void {
    const u = this.material.userData.uniforms as { uSnowCover: { value: number }; uSnowLee: { value: THREE.Vector2 } };
    u.uSnowCover.value = Math.max(0, Math.min(1, v));
    const l = Math.hypot(windX, windZ);
    if (l > 1e-6) u.uSnowLee.value.set(windX / l, windZ / l);
  }

  /** FEAT-077: how skied the snow is (0 fresh corduroy .. 1 tracked out and chopped) and how much spring snow (0..1). */
  setSkied(skied: number, spring: number): void {
    const u = this.material.userData.uniforms as { uSkied: { value: number }; uSpring: { value: number } };
    u.uSkied.value = Math.max(0, Math.min(1, skied)); u.uSpring.value = Math.max(0, Math.min(1, spring));
  }

  /** the mogul scale and creep the fine chunks were last (re)built with */
  private mogulBuiltScale = 1;
  private mogulBuiltCreep = 0;

  /**
   * FEAT-059: the mogul field's amplitude multiplier and uphill creep (m). The shaded (coarse) chunks
   * read them live as uniforms; the fine chunks bake the bumps into their geometry from Pack.height,
   * so when either has moved since they were built (a storm softening the field, a season change)
   * they are marked dirty and rebuilt, throttled by MAX_BUILDS_PER_FRAME, to stay in step with physics.
   */
  setMoguls(scale: number, creepM: number): void {
    const u = this.material.userData.uniforms as { uMogulScale: { value: number }; uMogulCreep: { value: number } };
    const sc = Math.max(0, Math.min(1, scale));
    u.uMogulScale.value = sc; u.uMogulCreep.value = creepM;
    if (!this.pack.moguls) return;
    if (Math.abs(sc - this.mogulBuiltScale) <= 0.05 && Math.abs(creepM - this.mogulBuiltCreep) <= 0.3) return;
    this.mogulBuiltScale = sc; this.mogulBuiltCreep = creepM;
    for (const c of this.chunks.values()) if (c.mesh && c.res <= MOGUL_MAX_RES) this.dirty.add(c.key);
  }

  /** Storm flat light: 0 = normal, 1 = overcast (snow relief and glints fade out). */
  setFlatLight(v: number): void {
    (this.material.userData.uniforms as { uFlat: { value: number } }).uFlat.value = v;
  }

  /** BUG-062: the sun's direction (three.js world frame, toward the sun) for the mogul colouring. */
  setSun(dir: THREE.Vector3): void {
    (this.material.userData.uniforms as { uSunDir: { value: THREE.Vector3 } }).uSunDir.value.copy(dir);
  }

  /** BUG-062 `?debug=moguls`: tint the mogul amplitude and show which path draws each chunk. */
  setMogulDebug(on: boolean): void {
    (this.material.userData.uniforms as { uDebugMoguls: { value: number } }).uDebugMoguls.value = on ? 1 : 0;
  }

  /** Finest resolution worth rendering at a point: 1 m inside the fine set, else mid, else far. */
  private minRes(cx: number, cy: number): number {
    const p = this.pack;
    if (p.fine && p.fine.contains(cx, cy)) return p.fine.meta.res;
    if (p.mid && p.mid.contains(cx, cy)) return p.mid.meta.res / 2;
    return (p.far?.meta.res ?? 128) / 2;
  }

  private onTileLoaded(minX: number, minY: number, size: number, res: number): void {
    for (const c of this.chunks.values()) {
      if (!c.mesh) continue;
      if (c.minX < minX + size && c.minX + c.size > minX && c.minY < minY + size && c.minY + c.size > minY) {
        // rebuild if this tile is finer than what the chunk was built from, or it is a mask tile
        if (res === 0 || res < c.dataRes) this.dirty.add(c.key);
      }
    }
  }

  update(camX: number, camY: number, camZ: number): void {
    this.frame++;
    this.visible = [];
    this.select(0, 0, 0, this.rootMinX, this.rootMinY, this.rootSize, camX, camY, camZ);
    // request data for the chunks we want at their resolution
    const want = new Set<string>();
    let builds = 0;
    for (const c of this.visible) {
      want.add(c.key);
      c.lastUsed = this.frame;
      if (c.res <= 8 && this.pack.fine) this.pack.fine.request(c.minX, c.minY, c.minX + c.size, c.minY + c.size);
      else if (c.res <= 64 && this.pack.mid) this.pack.mid.request(c.minX, c.minY, c.minX + c.size, c.minY + c.size);
      else if (this.pack.far) this.pack.far.request(c.minX, c.minY, c.minX + c.size, c.minY + c.size);
      if (c.res <= 8 && this.pack.mask) this.pack.mask.request(c.minX, c.minY, c.minX + c.size, c.minY + c.size);
      if (c.res <= 8 && this.pack.dir) this.pack.dir.request(c.minX, c.minY, c.minX + c.size, c.minY + c.size);
      if (c.res <= AO_MAX_RES && this.pack.ao) this.pack.ao.request(c.minX, c.minY, c.minX + c.size, c.minY + c.size);
      if (c.res <= MOGUL_SHADE_MAX_RES && this.pack.moguls) this.pack.moguls.request(c.minX, c.minY, c.minX + c.size, c.minY + c.size); // FEAT-059: bump geometry on the finest chunks, shading on the next ones
      if ((!c.mesh || this.dirty.has(c.key)) && builds < MAX_BUILDS_PER_FRAME) {
        this.build(c);
        this.dirty.delete(c.key);
        builds++;
      }
    }
    this.stats.builds = builds;
    // show/hide: a chunk is drawn if selected and built; a selected but unbuilt chunk shows its built ancestor instead
    let tris = 0;
    for (const c of this.chunks.values()) {
      if (!c.mesh) continue;
      let show = want.has(c.key);
      if (!show) {
        // keep showing an ancestor while descendants are still building
        show = this.visible.some((v) => v.level > c.level && !v.mesh && this.isAncestor(c, v));
      }
      c.mesh.visible = show;
      if (show) tris += N * N * 2;
      // evict long-unused chunks
      if (!show && this.frame - c.lastUsed > 600) {
        c.mesh.geometry.dispose();
        this.group.remove(c.mesh);
        this.chunks.delete(c.key);
      }
    }
    this.stats.chunks = this.visible.length;
    this.stats.triangles = tris;
    this.material.userData.shader?.uniforms.uTime && (this.material.userData.shader.uniforms.uTime.value = performance.now() / 1000);
  }

  private isAncestor(a: Chunk, d: Chunk): boolean {
    return d.minX >= a.minX && d.minY >= a.minY && d.minX + d.size <= a.minX + a.size && d.minY + d.size <= a.minY + a.size;
  }

  private select(level: number, x: number, y: number, minX: number, minY: number, size: number, cx: number, cy: number, cz: number): void {
    // distance from camera to chunk box (horizontal) plus a vertical term
    const dx = Math.max(minX - cx, 0, cx - (minX + size));
    const dy = Math.max(minY - cy, 0, cy - (minY + size));
    const zmid = (this.pack.meta.zRange[0] + this.pack.meta.zRange[1]) / 2;
    const dz = Math.max(0, Math.abs(cz - zmid) - (this.pack.meta.zRange[1] - this.pack.meta.zRange[0]) / 2);
    const dist = Math.hypot(dx, dy, dz);
    const res = size / N;
    const centreX = minX + size / 2, centreY = minY + size / 2;
    const canSplit = res > this.minRes(centreX, centreY) && level < 14;
    if (canSplit && dist < size * SPLIT_K) {
      const h = size / 2;
      this.select(level + 1, x * 2, y * 2, minX, minY, h, cx, cy, cz);
      this.select(level + 1, x * 2 + 1, y * 2, minX + h, minY, h, cx, cy, cz);
      this.select(level + 1, x * 2, y * 2 + 1, minX, minY + h, h, cx, cy, cz);
      this.select(level + 1, x * 2 + 1, y * 2 + 1, minX + h, minY + h, h, cx, cy, cz);
      return;
    }
    // skip chunks entirely outside any data (far outside the root happens only at the root itself)
    const key = `${level}/${x}/${y}`;
    let c = this.chunks.get(key);
    if (!c) {
      c = { key, level, x, y, minX, minY, size, res, mesh: null, dataRes: Infinity, lastUsed: this.frame };
      this.chunks.set(key, c);
    }
    this.visible.push(c);
  }

  private build(c: Chunk): void {
    const n = N + 1;
    const res = c.res;
    const pack = this.pack;
    const skirt = Math.max(2, res * 3);
    const vertCount = n * n + 4 * n; // grid + skirt ring
    const pos = new Float32Array(vertCount * 3);
    const nor = new Float32Array(vertCount * 3);
    const col = new Float32Array(vertCount * 3);
    const forest = new Float32Array(vertCount);
    const ao = new Float32Array(vertCount);
    // FEAT-059 / BUG-062: mogul amplitude for the shader (x) and which path draws the field here (y:
    // 0 none, 1 shader only, 2 bumps in the geometry too). Every chunk up to MOGUL_SHADE_MAX_RES is
    // shaded per pixel; the finest ones also carry the bumps in their positions, with their vertex
    // normals from the base surface so the shader's analytic bump normal is not doubled (and not the
    // aliased one a 2 m grid makes of a 5.7 m wave).
    const mogul = new Float32Array(vertCount * 2);
    const shadeMoguls = !!pack.moguls && res <= MOGUL_SHADE_MAX_RES;
    const geoMoguls = !!pack.moguls && res <= MOGUL_MAX_RES;
    const mogPath = geoMoguls ? 2 : shadeMoguls ? 1 : 0;
    const aoSet = pack.ao && res <= AO_MAX_RES ? pack.ao : null;
    // footprint for the AO lookup: one 2 m sample near the rider, a 2 x 2 box of samples on coarser chunks
    const aoOff = res > 2 ? res / 4 : 0;
    // groomer corduroy direction (three.js xz, length = slope): the run's axis from the pack's piste
    // direction set (DATA-002) pointed downhill, else the smoothed fall line; heights 6 m either side
    // so the ridges follow the run, not every 1 m bump
    const fall = new Float32Array(vertCount * 2);
    const FR = 6;
    const dirSet = pack.dir && res <= 8 ? pack.dir : null;
    const heights = new Float32Array((n + 2) * (n + 2)); // with a 1-sample border for normals
    // sample base heights (no mogul bumps) including border
    let dataRes = Infinity;
    for (let j = -1; j <= n; j++) {
      const y = c.minY + j * res;
      for (let i = -1; i <= n; i++) {
        const x = c.minX + i * res;
        heights[(j + 1) * (n + 2) + (i + 1)] = pack.height(x, y, res, false);
      }
    }
    dataRes = pack.finestRes(c.minX + c.size / 2, c.minY + c.size / 2);
    const resB = Math.max(res, MOGUL_MAX_RES * 2); // auxiliary samples (ridges, talus, fall line) without the mogul bumps
    const useMask = !!pack.mask && res <= 8;
    let v = 0;
    const H = (i: number, j: number) => heights[(j + 1) * (n + 2) + (i + 1)];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = c.minX + i * res, y = c.minY + j * res;
        const h = H(i, j);
        pos[v * 3] = x; pos[v * 3 + 1] = geoMoguls ? h + pack.bumpAt(x, y) : h; pos[v * 3 + 2] = -y;
        // normal by central differences (pack x east, y north -> three x, -z)
        const nxp = -(H(i + 1, j) - H(i - 1, j)) / (2 * res);
        const nyp = -(H(i, j + 1) - H(i, j - 1)) / (2 * res);
        const len = Math.hypot(nxp, nyp, 1);
        nor[v * 3] = nxp / len; nor[v * 3 + 1] = 1 / len; nor[v * 3 + 2] = -nyp / len;
        // classes
        const slope = Math.acos(1 / len); // radians
        let rock = 0, scree = 0, groom = 0;
        let fo: number;
        if (useMask) {
          const m = pack.mask!.sampleBilinear(x, y, this.maskSample);
          rock = m[0]; scree = m[1]; groom = m[2]; fo = m[3];
        } else fo = proceduralForest(x, y, h, slope);
        forest[v] = fo;
        let a = 1;
        if (aoSet && aoSet.has(x, y)) {
          if (aoOff === 0) a = aoSet.sample(x, y, this.maskSample)[0];
          else {
            a = 0;
            for (let k = 0; k < 4; k++) a += aoSet.sample(x + (k & 1 ? aoOff : -aoOff), y + (k & 2 ? aoOff : -aoOff), this.maskSample)[0];
            a *= 0.25;
          }
        }
        ao[v] = a;
        // exposure (FEAT-020): rock and talus where snow cannot stay, unioned with the imagery mask.
        // The shader thresholds these weights against noise, so 0.5 is where patches start.
        // Steep faces: weight 0.5 at about 45 deg near the rider; coarse chunks average slopes down,
        // so the threshold eases lower with vertex spacing (about 37 deg at 128 m).
        const steepLo = 0.68 - 0.022 * Math.log2(Math.max(1, res));
        const steep = THREE.MathUtils.smoothstep(slope, steepLo, steepLo + 0.2);
        // wind-scoured convex ridges above about 3,250 m: relief over the mean of four neighbours d away
        const d = Math.max(12, res);
        const relief = h - 0.25 * (pack.height(x + d, y, resB) + pack.height(x - d, y, resB) + pack.height(x, y + d, resB) + pack.height(x, y - d, resB));
        const scour = THREE.MathUtils.smoothstep(relief / d, 0.06, 0.2) * THREE.MathUtils.smoothstep(h, 3250, 3550) * (1 - fo);
        rock = Math.max(rock, steep, scour * 0.8);
        // talus apron at the foot of steep faces: the line to a point 15 m uphill is steeper than about
        // 48 deg while the ground here is gentler
        if (res <= 8 && slope > 0.2) {
          const du = 15, gl = Math.hypot(nxp, nyp);
          const up = pack.height(x - (nxp / gl) * du, y - (nyp / gl) * du, resB);
          const talus = THREE.MathUtils.smoothstep((up - h) / du, 0.95, 1.4) * (1 - steep);
          scree = Math.max(scree, talus * 0.9);
        }
        col[v * 3] = rock; col[v * 3 + 1] = scree * (1 - rock); col[v * 3 + 2] = groom * (1 - rock);
        const mog = shadeMoguls ? pack.mogulAmp(x, y, true) * (1 - rock) : 0;
        mogul[v * 2] = mog; mogul[v * 2 + 1] = mogPath;
        if (groom > 0.02 || mog > 0.01) {
          // moguls take the same wide fall line as Pack.bumpAt (BUG-064), so the shaded field matches the
          // bumps in the geometry and the physics; corduroy keeps the 6 m one
          const fr = mog > 0.01 && groom <= 0.02 ? MOGUL_FALL_D : FR;
          const gx = (pack.height(x + fr, y, resB) - pack.height(x - fr, y, resB)) / (2 * fr);
          const gy = (pack.height(x, y + fr, resB) - pack.height(x, y - fr, resB)) / (2 * fr);
          const b = groom > 0.02 && dirSet && dirSet.has(x, y) ? Math.round(dirSet.sample(x, y, this.maskSample)[0] * 255) : 0;
          if (b > 0) {
            // run axis (pack east, north), undirected; take the sense that points downhill. A groomer
            // leaves corduroy on a flat cat track too, so the confidence has a floor the fall line lacks.
            const th = ((b - 1) / 254) * Math.PI;
            let ax = Math.cos(th), ay = Math.sin(th);
            if (ax * gx + ay * gy > 0) { ax = -ax; ay = -ay; }
            const l = Math.max(Math.hypot(gx, gy), DIR_MIN_SLOPE);
            fall[v * 2] = ax * l; fall[v * 2 + 1] = -ay * l; // z = -north
          } else {
            fall[v * 2] = -gx; fall[v * 2 + 1] = gy; // downhill east, and z = -north
          }
        }
        v++;
      }
    }
    // skirt vertices: copies of the edge vertices dropped by `skirt`
    const edge: number[] = [];
    for (let i = 0; i < n; i++) edge.push(i); // south edge (j = 0)
    for (let j = 0; j < n; j++) edge.push(j * n + (n - 1)); // east edge
    for (let i = n - 1; i >= 0; i--) edge.push((n - 1) * n + i); // north edge
    for (let j = n - 1; j >= 0; j--) edge.push(j * n); // west edge
    const skirtStart = v;
    for (let k = 0; k < edge.length; k++) {
      const e = edge[k];
      pos[v * 3] = pos[e * 3]; pos[v * 3 + 1] = pos[e * 3 + 1] - skirt; pos[v * 3 + 2] = pos[e * 3 + 2];
      nor[v * 3] = nor[e * 3]; nor[v * 3 + 1] = nor[e * 3 + 1]; nor[v * 3 + 2] = nor[e * 3 + 2];
      col[v * 3] = col[e * 3]; col[v * 3 + 1] = col[e * 3 + 1]; col[v * 3 + 2] = col[e * 3 + 2]; forest[v] = forest[e]; ao[v] = ao[e];
      fall[v * 2] = fall[e * 2]; fall[v * 2 + 1] = fall[e * 2 + 1]; mogul[v * 2] = mogul[e * 2]; mogul[v * 2 + 1] = mogul[e * 2 + 1];
      v++;
    }
    const idx: number[] = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * n + i, b = a + 1, cc = a + n, d = cc + 1;
        // counter-clockwise seen from above (three.js y-up, z = -north): a(x,y) b(x+1,y) c(x,y+1)
        idx.push(a, b, d, a, d, cc);
      }
    }
    // skirt quads: edge k -> edge k+1 (perimeter order), skirt copies below
    const per = edge.length;
    for (let k = 0; k < per; k++) {
      const e0 = edge[k], e1 = edge[(k + 1) % per];
      if (k % n === n - 1) continue; // corner duplicates between sides
      const s0 = skirtStart + k, s1 = skirtStart + ((k + 1) % per);
      idx.push(e0, s0, e1, e1, s0, s1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('forest', new THREE.BufferAttribute(forest, 1));
    geo.setAttribute('ao', new THREE.BufferAttribute(ao, 1));
    geo.setAttribute('fall', new THREE.BufferAttribute(fall, 2));
    geo.setAttribute('mogul', new THREE.BufferAttribute(mogul, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    if (c.mesh) {
      c.mesh.geometry.dispose();
      c.mesh.geometry = geo;
    } else {
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.name = `chunk ${c.key}`;
      mesh.castShadow = c.res <= 4;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      c.mesh = mesh;
      this.group.add(mesh);
    }
    c.dataRes = dataRes;
  }
}
