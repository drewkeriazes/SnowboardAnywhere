import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { RoadFeature } from '../pack/types';

/**
 * Roads as flat ribbons draped a little above the terrain, one merged mesh per kind group so
 * the whole network is a handful of draw calls. Highways and streets are dark asphalt with a
 * light snow dusting; tracks and paths are packed snow (lighter); footways and steps are
 * skipped at distance. Ribbons are rebuilt against the loaded terrain once per cell when the
 * fine tiles arrive, so they sit on the 1 m surface rather than the pipeline's z.
 */
const LIFT = 0.25; // m above the ground
const KINDS: Record<string, { width: number; color: [number, number, number]; minor: boolean }> = {
  motorway: { width: 22, color: [0.22, 0.22, 0.24], minor: false },
  motorway_link: { width: 9, color: [0.22, 0.22, 0.24], minor: false },
  primary: { width: 10, color: [0.26, 0.26, 0.28], minor: false },
  secondary: { width: 8, color: [0.3, 0.3, 0.32], minor: false },
  tertiary: { width: 7, color: [0.32, 0.32, 0.34], minor: false },
  tertiary_link: { width: 6, color: [0.32, 0.32, 0.34], minor: false },
  residential: { width: 6, color: [0.42, 0.42, 0.45], minor: false },
  unclassified: { width: 5, color: [0.42, 0.42, 0.45], minor: false },
  service: { width: 4, color: [0.5, 0.5, 0.53], minor: true },
  pedestrian: { width: 5, color: [0.62, 0.6, 0.6], minor: true },
  track: { width: 3, color: [0.86, 0.88, 0.92], minor: true },
  path: { width: 1.5, color: [0.84, 0.86, 0.9], minor: true },
  cycleway: { width: 2, color: [0.84, 0.86, 0.9], minor: true },
  footway: { width: 1.5, color: [0.84, 0.86, 0.9], minor: true },
  steps: { width: 1.5, color: [0.7, 0.7, 0.72], minor: true },
};

export class Roads {
  readonly group = new THREE.Group();
  private readonly pack: Pack;
  get material(): THREE.MeshStandardMaterial { return this.mat; }
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
  private readonly major: THREE.Mesh;
  private readonly minor: THREE.Mesh;

  constructor(pack: Pack) {
    this.pack = pack;
    this.major = this.build((k) => !KINDS[k]?.minor);
    this.minor = this.build((k) => !!KINDS[k]?.minor);
    this.group.add(this.major, this.minor);
    // rebuild once the fine tiles near the start are in so ribbons drape on the 1 m surface
    let rebuilt = 0;
    const prev = pack.fine?.onTileLoaded ?? null;
    if (pack.fine) {
      pack.fine.onTileLoaded = (tx, ty) => { prev?.(tx, ty); if (rebuilt < 40) { rebuilt++; this.scheduleRebuild(); } };
    }
  }

  private rebuildTimer: number | null = null;
  private scheduleRebuild(): void {
    if (this.rebuildTimer !== null) return;
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      for (const [mesh, pred] of [[this.major, (k: string) => !KINDS[k]?.minor], [this.minor, (k: string) => !!KINDS[k]?.minor]] as const) {
        const fresh = this.build(pred);
        mesh.geometry.dispose();
        mesh.geometry = fresh.geometry;
      }
    }, 1500);
  }

  /** Hide the minor network beyond a distance (called per frame with the camera position). */
  update(x: number, y: number): void {
    const b = this.pack.meta.bounds;
    const inside = x > b.minX - 2000 && x < b.maxX + 2000 && y > b.minY - 2000 && y < b.maxY + 2000;
    this.minor.visible = inside;
  }

  private height(x: number, y: number, fallback: number): number {
    for (const s of this.pack.sets) { if (s.contains(x, y)) { const h = s.sample(x, y); if (!Number.isNaN(h)) return h; } }
    return fallback;
  }

  private build(pred: (kind: string) => boolean): THREE.Mesh {
    const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
    for (const r of this.pack.features.roads) {
      if (!pred(r.kind)) continue;
      this.ribbon(r, pos, nor, col, idx);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  private ribbon(r: RoadFeature, pos: number[], nor: number[], col: number[], idx: number[]): void {
    const spec = KINDS[r.kind] ?? { width: r.width || 4, color: [0.5, 0.5, 0.53] as [number, number, number], minor: true };
    const w = (r.width && r.width > 0 ? Math.max(r.width, spec.width * 0.6) : spec.width) / 2;
    // densify long segments so the ribbon follows the terrain
    const pts: [number, number, number][] = [];
    for (let i = 0; i < r.points.length; i++) {
      const p = r.points[i];
      if (i > 0) {
        const q = r.points[i - 1];
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        const n = Math.min(40, Math.floor(d / 12));
        for (let k = 1; k < n; k++) { const t = k / n; pts.push([q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t, q[2] + (p[2] - q[2]) * t]); }
      }
      pts.push([p[0], p[1], p[2]]);
    }
    if (pts.length < 2) return;
    const base = pos.length / 3;
    // slight colour variation per road so long highways are not one flat tone
    const v = 0.9 + 0.2 * ((Math.abs(Math.sin(pts[0][0] * 0.013 + pts[0][1] * 0.007)) * 10) % 1);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      const lx = -dy, ly = dx;
      for (const side of [-1, 1]) {
        const x = p[0] + lx * w * side, y = p[1] + ly * w * side;
        const z = this.height(x, y, p[2]) + LIFT;
        pos.push(x, z, -y);
        nor.push(0, 1, 0);
        col.push(spec.color[0] * v, spec.color[1] * v, spec.color[2] * v);
      }
      if (i > 0) {
        const q = base + (i - 1) * 2, n = base + i * 2;
        // skip the quad across a long jump (disconnected pieces in the same way)
        if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) > 200) continue;
        idx.push(q, n, q + 1, q + 1, n, n + 1);
      }
    }
  }
}
