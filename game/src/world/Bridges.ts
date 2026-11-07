import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Deck, Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';

/**
 * Bridges. The terrain is bare-earth lidar, which has no bridges, so a run or road that crosses
 * a gully would drop into it. Ways tagged bridge=* in OSM become decks straight away.
 * Two detectors find crossings OSM does not tag:
 * - Dip spans (always on): a ski run whose node sits in a creek bed, with banks 4 m+ higher within
 *   40 m each side and a steep, gully-shaped sag between them. On Vail this finds exactly Cloud 9 -
 *   Lower over the creek by Tea Cup and China Spur (BUG-013), and nothing on open slopes.
 * - Segment chords (`?bridgeguess` only): any run or road segment whose straight line passes 4 m+
 *   above the terrain. Long, sparse bowl runs hang over concave slopes, so this built railings
 *   across Imperial Bowl, Poppyfields and Red Square (BUG-022). Kept for packs built before the
 *   pipeline kept the OSM tag.
 * A deck is registered with the pack (so rider ground follows it), drawn with railings and
 * girders, and its railings are collider walls.
 */
const MIN_SAG = 4; // m the terrain must fall below the chord to count as a gap
const MAX_SPAN = 120; // m longest segment considered by the detector
const SCAN_R = 600; // m around the rider to evaluate segments
const RAIL_H = 1.1;
const DIP_REACH = 40; // m along the way on each side of a dip vertex to look for the rims
const DIP_STEEP = 0.12; // a rim-to-rim span must sag at least this fraction of its length (a gully, not a swale)

interface Candidate { a: [number, number, number]; b: [number, number, number]; hw: number; cx: number; cy: number; steep: number }

export class Bridges {
  readonly group = new THREE.Group();
  private readonly pending: Candidate[] = [];
  private readonly seen = new Set<string>();
  private acc = 0;
  private readonly deckMat = new THREE.MeshStandardMaterial({ color: 0xf2f5f8, roughness: 0.9 });
  private readonly woodMat = new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 0.8 });
  private readonly steelMat = new THREE.MeshStandardMaterial({ color: 0x3d4248, roughness: 0.6, metalness: 0.3 });

  constructor(private readonly pack: Pack, private readonly collider: Collider | null, guess = false) {
    const ways: { pts: [number, number, number][]; hw: number; bridge: boolean; run: boolean }[] = [];
    for (const r of pack.features.runs) if (!r.area && r.points.length >= 2) ways.push({ pts: r.points, hw: 3, bridge: !!r.bridge, run: true });
    for (const r of pack.features.roads) if (r.points.length >= 2) ways.push({ pts: r.points, hw: Math.max(2.5, r.width / 2 + 0.5), bridge: !!r.bridge, run: false });
    for (const w of ways) {
      if (w.bridge) {
        // tagged bridge: one straight deck between the abutments (inner nodes may sit over the gap)
        const a = w.pts[0], b = w.pts[w.pts.length - 1];
        this.addBridge(a, b, w.hw);
        continue;
      }
      // BUG-022: ski runs keep the narrow creek-bed dip check (Tea Cup, China Spur); the loose
      // segment-chord detector only runs when asked for
      if (w.run) this.addDips(w.pts, w.hw);
      if (!guess) continue;
      for (let i = 0; i + 1 < w.pts.length; i++) {
        const a = w.pts[i], b = w.pts[i + 1];
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (l < 6 || l > MAX_SPAN) continue;
        this.pending.push({ a, b, hw: w.hw, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, steep: 0.06 });
      }
    }
  }

  /**
   * A run whose OSM node sits in the creek bed follows the ground down and back up, so no single
   * segment spans the gap. Find such dip vertices (local lows with a node 4 m+ higher within
   * DIP_REACH on both sides) and queue the rim-to-rim chord for the same terrain test as a segment.
   */
  private addDips(pts: [number, number, number][], hw: number): void {
    // nearest node on one side that climbs back MIN_SAG above the dip
    const rim = (k: number, dir: -1 | 1): number => {
      let dist = 0;
      for (let i = k + dir; i >= 0 && i < pts.length; i += dir) {
        dist += Math.hypot(pts[i][0] - pts[i - dir][0], pts[i][1] - pts[i - dir][1]);
        if (dist > DIP_REACH) break;
        if (pts[i][2] - pts[k][2] >= MIN_SAG) return i;
      }
      return -1;
    };
    for (let k = 1; k + 1 < pts.length; k++) {
      if (!(pts[k][2] <= pts[k - 1][2] && pts[k][2] < pts[k + 1][2])) continue;
      const i = rim(k, -1), j = rim(k, 1);
      if (i < 0 || j < 0) continue;
      const a = pts[i], b = pts[j];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l < 6 || l > 2 * DIP_REACH) continue;
      this.pending.push({ a, b, hw, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, steep: DIP_STEEP });
    }
  }

  /** Evaluate untested segments near the rider whose fine terrain has loaded. */
  maintain(dt: number, rx: number, ry: number): void {
    this.acc += dt;
    if (this.acc < 0.5 || this.pending.length === 0) return;
    this.acc = 0;
    const fine = this.pack.fine;
    if (!fine) return;
    // rim-to-rim dip spans first: where one fits, a plain segment ending on the gully node is a ramp into it
    for (const dips of [true, false]) this.evaluate(fine, rx, ry, dips);
  }

  private evaluate(fine: NonNullable<Pack['fine']>, rx: number, ry: number, dips: boolean): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const c = this.pending[i];
      if ((c.steep === DIP_STEEP) !== dips) continue;
      if (Math.hypot(c.cx - rx, c.cy - ry) > SCAN_R) continue;
      const l = Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]);
      const n = Math.ceil(l);
      let maxSag = 0, gap = 0, loaded = true;
      for (let k = 0; k <= n; k++) {
        const t = k / n, x = c.a[0] + (c.b[0] - c.a[0]) * t, y = c.a[1] + (c.b[1] - c.a[1]) * t;
        const h = fine.contains(x, y) ? fine.sample(x, y) : NaN;
        if (Number.isNaN(h)) { loaded = false; break; }
        const sag = c.a[2] + (c.b[2] - c.a[2]) * t - h;
        if (sag > maxSag) maxSag = sag;
        if (sag > 1.5) gap++;
      }
      if (!loaded) continue;
      this.pending.splice(i, 1);
      // a real gap: deep, and a good part of the segment hangs over it (not a long gentle dip)
      if (maxSag >= MIN_SAG && maxSag >= c.steep * l && gap >= 0.25 * n) this.addBridge(c.a, c.b, c.hw);
    }
  }

  private addBridge(a: [number, number, number], b: [number, number, number], hw: number): void {
    const key = [a[0], a[1], b[0], b[1]].map((v) => Math.round(v)).join(',');
    const rev = [b[0], b[1], a[0], a[1]].map((v) => Math.round(v)).join(',');
    if (this.seen.has(key) || this.seen.has(rev)) return;
    this.seen.add(key);
    // one deck per crossing: skip a span that lands on a deck already built (run and road copies, dip vs segment)
    for (const t of [0.25, 0.5, 0.75]) {
      if (this.pack.deckHeight(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) > -Infinity) return;
    }
    const lift = 0.15; // snow on the deck
    const d: Deck = { ax: a[0], ay: a[1], az: a[2] + lift, bx: b[0], by: b[1], bz: b[2] + lift, hw };
    this.pack.addDeck(d);
    this.build(d);
  }

  private build(d: Deck): void {
    const dx = d.bx - d.ax, dy = d.by - d.ay, dz = d.bz - d.az;
    const lh = Math.hypot(dx, dy), l3 = Math.hypot(lh, dz);
    const frame = new THREE.Object3D();
    frame.position.set((d.ax + d.bx) / 2, (d.az + d.bz) / 2, -(d.ay + d.by) / 2);
    frame.rotation.set(0, Math.atan2(dy, dx), Math.atan2(dz, lh), 'YZX');
    frame.updateMatrix();
    const piece = (w: number, h: number, depth: number, x: number, y: number, z: number) => {
      const g = new THREE.BoxGeometry(w, h, depth);
      g.translate(x, y, z);
      return g;
    };
    // snow-covered deck and steel girders underneath, a little longer than the span to bite into the banks
    const len = l3 + 4;
    const deck = piece(len, 0.3, d.hw * 2, 0, -0.15, 0);
    const girders = mergeGeometries([piece(len, 1.2, 0.4, 0, -0.9, d.hw - 0.6), piece(len, 1.2, 0.4, 0, -0.9, -(d.hw - 0.6))]);
    // wooden railings: posts every 2.5 m and a top rail on each side
    const wood: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const z = side * (d.hw - 0.1);
      wood.push(piece(l3, 0.12, 0.12, 0, RAIL_H, z), piece(l3, 0.1, 0.08, 0, RAIL_H * 0.5, z));
      for (let s = -l3 / 2; s <= l3 / 2 + 0.01; s += 2.5) wood.push(piece(0.14, RAIL_H, 0.14, s, RAIL_H / 2, z));
    }
    const out: [THREE.BufferGeometry, THREE.Material, string][] = [[deck, this.deckMat, 'bridge deck'], [girders, this.steelMat, 'bridge girders'], [mergeGeometries(wood), this.woodMat, 'bridge railings']];
    for (const [g, m, name] of out) {
      g.applyMatrix4(frame.matrix);
      const mesh = new THREE.Mesh(g, m);
      mesh.name = name;
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    // railings stop the rider (5 m pieces so each wall's z band follows the deck slope)
    if (this.collider) {
      const lx = -dy / lh, ly = dx / lh;
      const n = Math.max(1, Math.ceil(lh / 5));
      for (const side of [-1, 1]) {
        const ox = lx * side * (d.hw - 0.1), oy = ly * side * (d.hw - 0.1);
        for (let i = 0; i < n; i++) {
          const t0 = i / n, t1 = (i + 1) / n;
          const z0 = d.az + dz * t0, z1 = d.az + dz * t1;
          this.collider.addWall(d.ax + dx * t0 + ox, d.ay + dy * t0 + oy, d.ax + dx * t1 + ox, d.ay + dy * t1 + oy, Math.min(z0, z1) - 0.3, Math.max(z0, z1) + RAIL_H);
        }
      }
    }
  }

  get count(): number { return this.pack.decks.length; }
}
