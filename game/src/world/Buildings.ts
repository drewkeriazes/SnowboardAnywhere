import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { BuildingFeature } from '../pack/types';
import type { Collider } from '../sim/Collider';

/**
 * Buildings extruded from OSM footprints in features.json. Walls and a snow-covered roof are
 * merged into one geometry per 1 km cell (a few draw calls for the whole resort). Lodges and
 * other named on-mountain buildings get a pitched roof; everything else is a flat snow roof.
 * The base is sunk below the footprint's lowest ground sample so nothing floats on a slope.
 */
const SINK = 2.5; // m below the lowest ground point under the footprint

export class Buildings {
  readonly group = new THREE.Group();
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });
  get material(): THREE.MeshStandardMaterial { return this.mat; }

  private readonly collider: Collider | null;

  constructor(pack: Pack, collider: Collider | null = null) {
    this.collider = collider;
    const cells = new Map<string, BuildingFeature[]>();
    for (const b of pack.features.buildings) {
      if (b.points.length < 3) continue;
      const k = `${Math.floor(b.points[0][0] / 1000)}_${Math.floor(b.points[0][1] / 1000)}`;
      let arr = cells.get(k);
      if (!arr) { arr = []; cells.set(k, arr); }
      arr.push(b);
    }
    for (const list of cells.values()) {
      const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
      for (const b of list) this.extrude(pack, b, pos, nor, col, idx);
      if (pos.length === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  private extrude(pack: Pack, b: BuildingFeature, pos: number[], nor: number[], col: number[], idx: number[]): void {
    // footprint in pack coords; drop a duplicated closing point
    let pts = b.points;
    if (pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
    if (pts.length < 3) return;
    // ground: lowest sample under the footprint (zBase from the pipeline as the fallback)
    let zMin = Infinity, zMax = -Infinity;
    for (const p of pts) {
      // only real samples (tiles may not be loaded yet); the pipeline's zBase is the fallback
      let h = NaN;
      for (const s of pack.sets) { if (s.contains(p[0], p[1])) { h = s.sample(p[0], p[1]); if (!Number.isNaN(h)) break; } }
      if (Number.isNaN(h)) continue;
      zMin = Math.min(zMin, h); zMax = Math.max(zMax, h);
    }
    if (!Number.isFinite(zMin)) { zMin = zMax = b.zBase; }
    const base = Math.min(zMin, b.zBase) - SINK;
    const height = Math.max(3, b.height || 5);
    const top = Math.max(zMax, b.zBase) + height;
    const named = !!b.name;
    const kind = b.kind ?? 'yes';
    // colours: timber lodges on the mountain, pale stucco/stone in the villages
    const wall = named ? [0.42, 0.30, 0.20] : kind === 'hotel' || kind === 'apartments' || kind === 'residential' ? [0.80, 0.74, 0.64] : [0.62, 0.55, 0.47];
    const roofSnow = [0.95, 0.96, 1.0];
    // ensure counter-clockwise (positive area) in x/y so wall normals face out
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const a = pts[i], c = pts[(i + 1) % pts.length]; area += a[0] * c[1] - c[0] * a[1]; }
    if (area < 0) pts = [...pts].reverse();
    const n = pts.length;
    if (this.collider) this.collider.addFootprint(pts.map((p) => [p[0], p[1]] as [number, number]), base, top);
    // walls: one quad per edge with a flat normal
    for (let i = 0; i < n; i++) {
      const a = pts[i], c = pts[(i + 1) % n];
      const ex = c[0] - a[0], ey = c[1] - a[1];
      const len = Math.hypot(ex, ey) || 1;
      const nx = ey / len, ny = -ex / len; // outward for CCW footprint (x east, y north)
      const v0 = pos.length / 3;
      for (const [x, y, z] of [[a[0], a[1], base], [c[0], c[1], base], [c[0], c[1], top], [a[0], a[1], top]]) {
        pos.push(x, z, -y); nor.push(nx, 0, -ny); col.push(wall[0], wall[1], wall[2]);
      }
      idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
    }
    // roof: fan triangulation via earcut-free approach (ShapeUtils handles concave footprints)
    const shape = pts.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(shape, []);
    if (named && n <= 8) {
      // pitched roof: ridge along the longest axis, peak 0.35 x width above the eaves
      let cx = 0, cy = 0; for (const p of pts) { cx += p[0] / n; cy += p[1] / n; }
      let best = 0, ax = 1, ay = 0;
      for (let i = 0; i < n; i++) { const a = pts[i], c = pts[(i + 1) % n]; const l = Math.hypot(c[0] - a[0], c[1] - a[1]); if (l > best) { best = l; ax = (c[0] - a[0]) / l; ay = (c[1] - a[1]) / l; } }
      const px = -ay, py = ax; // across the ridge
      let half = 0; for (const p of pts) half = Math.max(half, Math.abs((p[0] - cx) * px + (p[1] - cy) * py));
      const peak = top + Math.min(6, half * 0.7);
      const roofZ = (x: number, y: number) => peak - (Math.abs((x - cx) * px + (y - cy) * py) / Math.max(1, half)) * (peak - top);
      const v0 = pos.length / 3;
      for (const p of pts) { pos.push(p[0], roofZ(p[0], p[1]), -p[1]); nor.push(0, 1, 0); col.push(roofSnow[0], roofSnow[1], roofSnow[2]); }
      // ridge vertices at the two ends of the long axis
      const ends: [number, number][] = [[cx - ax * best * 0.5, cy - ay * best * 0.5], [cx + ax * best * 0.5, cy + ay * best * 0.5]];
      for (const e of ends) { pos.push(e[0], peak, -e[1]); nor.push(0, 1, 0); col.push(roofSnow[0], roofSnow[1], roofSnow[2]); }
      const r0 = v0 + n, r1 = v0 + n + 1;
      for (let i = 0; i < n; i++) {
        const a = v0 + i, c = v0 + ((i + 1) % n);
        const side = (pts[i][0] - cx) * px + (pts[i][1] - cy) * py;
        const [ra, rb] = side >= 0 ? [r1, r0] : [r0, r1];
        idx.push(a, c, ra, a, ra, rb);
      }
      // close the gable ends with the flat top
      for (const t of tris) idx.push(v0 + t[0], v0 + t[1], v0 + t[2]);
    } else {
      const v0 = pos.length / 3;
      for (const p of pts) { pos.push(p[0], top, -p[1]); nor.push(0, 1, 0); col.push(roofSnow[0], roofSnow[1], roofSnow[2]); }
      for (const t of tris) idx.push(v0 + t[0], v0 + t[1], v0 + t[2]);
      // a dark eave strip just under the roof edge so flat roofs read as a building, not a snow pile
      const eave = top - 0.5;
      for (let i = 0; i < n; i++) {
        const a = pts[i], c = pts[(i + 1) % n];
        const ex = c[0] - a[0], ey = c[1] - a[1], len = Math.hypot(ex, ey) || 1;
        const nx = ey / len, ny = -ex / len;
        const w0 = pos.length / 3;
        for (const [x, y, z] of [[a[0], a[1], eave], [c[0], c[1], eave], [c[0], c[1], top + 0.05], [a[0], a[1], top + 0.05]]) {
          pos.push(x + nx * 0.15, z, -(y + ny * 0.15)); nor.push(nx, 0, -ny); col.push(0.25, 0.2, 0.16);
        }
        idx.push(w0, w0 + 1, w0 + 2, w0, w0 + 2, w0 + 3);
      }
    }
  }
}
