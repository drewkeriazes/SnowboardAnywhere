import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';
import type { LiftRuntime } from './Lifts';
import { LOAD_OFFSET } from '../sim/LiftLine';

/**
 * FEAT-073: lift-line mazes at the bottom of each chairlift. Behind the loading point, aligned to
 * the cable: parallel lanes of webbing and rope on short posts (2 to 4 lanes by capacity, 18 to 30 m
 * long) that merge before a "wait here" line, then the blue "load here" line where the chair swings
 * in. From the maze mouth two funnel fences flare back up toward the runs that end at the lift.
 * A lift name board stands at the front. Ropes are colliders (the rider slides along them), and the
 * boarding prompt only appears inside the corral (`inGate`).
 * Built lazily once the fine terrain under a lift's base has loaded, so posts sit on the snow.
 */
const LANE_W = 2.2, POST_GAP = 2.5, ROPE_H = 0.95, STOP = 3, MERGE = 4, FUNNEL = 22, FUNNEL_FLARE = 0.5;
/** runs whose lower end is this close to the loading point feed the lift (m) */
const FEED_R = 150;
const BUILD_R = 900;
const C_POST = [0.18, 0.19, 0.21], C_OUTER = [0.95, 0.45, 0.08], C_INNER = [0.12, 0.33, 0.75], C_LOAD = [0.1, 0.25, 0.7], C_WAIT = [0.8, 0.12, 0.1], C_BOARD = [0.24, 0.17, 0.11];

interface Maze { lift: LiftRuntime; built: boolean; ux: number; uy: number; halfW: number; len: number; bx: number; by: number }

export class LiftLines {
  readonly group = new THREE.Group();
  private readonly mazes: Maze[] = [];
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  /** rope colliders, so turning the setting off removes the walls along with the mesh */
  private readonly walls: Float32Array[] = [];
  enabled = true;

  constructor(private readonly pack: Pack, lifts: readonly LiftRuntime[], private readonly collider: Collider | null) {
    this.group.name = 'lift lines';
    for (const l of lifts) {
      if (l.kind !== 'chair') continue; // gondolas load inside their station; surface lifts and carpets have no maze
      const [bx, by] = l.bottom, [tx, ty] = l.top;
      const d = Math.hypot(tx - bx, ty - by);
      if (d < 50) continue;
      const cap = l.feature.capacity ?? 2000;
      const lanes = cap > 2800 ? 4 : cap > 1800 ? 3 : 2;
      this.mazes.push({ lift: l, built: false, ux: (tx - bx) / d, uy: (ty - by) / d, halfW: (lanes * LANE_W) / 2, len: 14 + lanes * 4, bx, by });
    }
  }

  /** Build the mazes within BUILD_R of (x, y) whose ground has loaded. */
  maintain(x: number, y: number): void {
    if (!this.enabled) return;
    for (const m of this.mazes) {
      if (m.built || Math.hypot(m.bx - x, m.by - y) > BUILD_R) continue;
      const g = this.ground(m.bx - m.ux * (STOP + m.len), m.by - m.uy * (STOP + m.len));
      if (Number.isNaN(g) || Number.isNaN(this.ground(m.bx, m.by))) continue;
      this.build(m);
      m.built = true;
    }
  }

  private ground(x: number, y: number): number {
    const f = this.pack.fine;
    return f && f.contains(x, y) ? f.sample(x, y) : NaN;
  }

  /**
   * True when (x, y) is inside the corral or at the loading line of lift `l` (where boarding is
   * allowed). Lifts without a built maze (and every lift with the setting off) allow boarding anywhere
   * in range, as before.
   */
  inGate(l: LiftRuntime, x: number, y: number): boolean {
    if (!this.enabled) return true;
    const m = this.mazes.find((q) => q.lift === l);
    if (!m || !m.built) return true;
    const dx = x - m.bx, dy = y - m.by;
    const along = dx * m.ux + dy * m.uy, across = Math.abs(dx * m.uy - dy * m.ux);
    return along > -(STOP + m.len + 1) && along < LOAD_OFFSET * 0.5 && across < m.halfW + 1.5;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
    if (this.collider) for (const w of this.walls) this.collider.setWallActive(w, on);
  }

  private build(m: Maze): void {
    const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
    const G = (x: number, y: number) => { const h = this.ground(x, y); return Number.isNaN(h) ? this.pack.groundHeight(x, y) : h; };
    // an axis-aligned box stretched from p to q (pack coords), w wide and h tall, on its base
    const beam = (p: number[], q: number[], w: number, h: number, c: number[]) => {
      const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
      const l = Math.hypot(dx, dy) || 1e-6, sx = (-dy / l) * w / 2, sy = (dx / l) * w / 2;
      const v = [[p[0] - sx, p[1] - sy, p[2]], [p[0] + sx, p[1] + sy, p[2]], [q[0] + sx, q[1] + sy, q[2]], [q[0] - sx, q[1] - sy, q[2]]];
      const top = v.map((a) => [a[0], a[1], a[2] + h]);
      const faces: [number[][], number[]][] = [
        [[top[0], top[1], top[2], top[3]], [0, 0, 1]],
        [[v[1], v[2], top[2], top[1]], [-dy / l, dx / l, 0]],
        [[v[3], v[0], top[0], top[3]], [dy / l, -dx / l, 0]],
        [[v[0], v[1], top[1], top[0]], [-dx / l, -dy / l, -dz / l]],
        [[v[2], v[3], top[3], top[2]], [dx / l, dy / l, dz / l]],
      ];
      for (const [q4, n] of faces) {
        const i0 = pos.length / 3;
        for (const a of q4) { pos.push(a[0], a[2], -a[1]); nor.push(n[0], n[2], -n[1]); col.push(c[0], c[1], c[2]); }
        idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
      }
    };
    const post = (x: number, y: number) => { const z = G(x, y); beam([x - 0.04, y, z - 0.3], [x + 0.04, y, z - 0.3], 0.08, ROPE_H + 0.35, C_POST); };
    // a rope line from a to b (pack x, y) on posts, sagging between them; a collider wall along it
    const rope = (a: number[], b: number[], c: number[], wide: boolean) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L / POST_GAP));
      let px = a[0], py = a[1], pz = G(px, py) + ROPE_H;
      post(px, py);
      for (let i = 1; i <= n; i++) {
        const t = i / n, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = G(x, y) + ROPE_H;
        post(x, y);
        // three pieces per span, the middle 0.12 m lower
        const mx = (px + x) / 2, my = (py + y) / 2, mz = (pz + z) / 2 - 0.12;
        const q1 = [px + (mx - px) * 0.5, py + (my - py) * 0.5, (pz + mz) / 2 - 0.04], q2 = [mx + (x - mx) * 0.5, my + (y - my) * 0.5, (mz + z) / 2 - 0.04];
        for (const [s, e] of [[[px, py, pz], q1], [q1, q2], [q2, [x, y, z]]]) beam(s, e, wide ? 0.04 : 0.025, wide ? 0.08 : 0.025, c);
        if (this.collider) this.walls.push(this.collider.addWall(px, py, x, y, Math.min(pz, z) - ROPE_H - 0.3, Math.max(pz, z) + 0.2));
        px = x; py = y; pz = z;
      }
    };
    const { ux, uy, halfW, len, bx, by } = m;
    const rx = uy, ry = -ux; // to the right of the cable, looking up the line
    const at = (along: number, across: number) => [bx + ux * along + rx * across, by + uy * along + ry * across];
    const front = -STOP, back = -STOP - len;
    const lanes = Math.round((2 * halfW) / LANE_W);
    // outer webbing the full length; the lane ropes stop short of the stop line so the lanes merge
    for (const s of [-1, 1]) rope(at(back, s * halfW), at(front, s * halfW), C_OUTER, true);
    for (let i = 1; i < lanes; i++) rope(at(back, -halfW + i * LANE_W), at(front - MERGE, -halfW + i * LANE_W), C_INNER, false);
    // funnel: two fences from the mouth flaring back toward the runs that end at this lift
    const [fx, fy] = this.feedDir(m);
    for (const s of [-1, 1]) {
      const mouth = at(back, s * halfW);
      // flare outward: along the feed direction plus sideways away from the maze centre line
      const side = [rx * s, ry * s];
      const end = [mouth[0] + fx * FUNNEL + side[0] * FUNNEL * FUNNEL_FLARE, mouth[1] + fy * FUNNEL + side[1] * FUNNEL * FUNNEL_FLARE];
      rope(mouth, end, C_OUTER, true);
    }
    // painted lines on the snow: red "wait here" at the stop line, blue "load here" where the chair comes
    const paint = (along: number, c: number[]) => {
      const a = at(along, -halfW - 0.5), b = at(along, halfW + 0.5);
      const za = G(a[0], a[1]) + 0.03, zb = G(b[0], b[1]) + 0.03;
      beam([a[0], a[1], za], [b[0], b[1], zb], 0.35, 0.01, c);
    };
    paint(front, C_WAIT);
    paint(0, C_LOAD);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.name = `lift line ${m.lift.feature.name ?? ''}`;
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.group.add(mesh);
    this.sign(m, at(front, -halfW - 1.2), G);
  }

  /**
   * Direction (pack x, y, unit) from the maze mouth back up toward the runs that end at the lift:
   * the mean of each feeder run's point 60 m up from its lower end, kept within 75 deg of straight
   * back along the line. Straight back when no run ends here.
   */
  private feedDir(m: Maze): [number, number] {
    let sx = 0, sy = 0;
    for (const r of this.pack.features.runs) {
      if (r.area || r.points.length < 2) continue;
      const p = r.points, a = p[0], b = p[p.length - 1];
      const lowEnd = a[2] < b[2] ? 0 : p.length - 1, step = lowEnd === 0 ? 1 : -1, lo = p[lowEnd];
      if (Math.hypot(lo[0] - m.bx, lo[1] - m.by) > FEED_R) continue;
      // walk 60 m up the run
      let d = 0, i = lowEnd, q = lo;
      while (i + step >= 0 && i + step < p.length && d < 60) { const n = p[i + step]; d += Math.hypot(n[0] - q[0], n[1] - q[1]); q = n; i += step; }
      if (q[2] <= lo[2]) continue;
      const vx = q[0] - m.bx, vy = q[1] - m.by, l = Math.hypot(vx, vy) || 1;
      sx += vx / l; sy += vy / l;
    }
    const bx = -m.ux, by = -m.uy;
    const l = Math.hypot(sx, sy);
    if (l < 1e-3) return [bx, by];
    let fx = sx / l, fy = sy / l;
    const cos = fx * bx + fy * by, lim = Math.cos(75 * Math.PI / 180);
    if (cos < lim) {
      // swing to the 75 deg limit on the same side
      const side = Math.sign(fx * -by + fy * bx) || 1, a = 75 * Math.PI / 180 * side, c = Math.cos(a), s = Math.sin(a);
      fx = bx * c - by * s; fy = bx * s + by * c;
    }
    return [fx, fy];
  }

  /** Lift name board on two posts at the front corner of the maze. */
  private sign(m: Maze, p: number[], G: (x: number, y: number) => number): void {
    const name = m.lift.feature.name ?? 'Chairlift';
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#2b1d12'; ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = '#e8dcc0'; ctx.lineWidth = 6; ctx.strokeRect(8, 8, 496, 112);
    ctx.fillStyle = '#f4ead2'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let size = 64; ctx.font = `bold ${size}px system-ui, sans-serif`;
    while (ctx.measureText(name).width > 470 && size > 24) { size -= 4; ctx.font = `bold ${size}px system-ui, sans-serif`; }
    ctx.fillText(name, 256, 66);
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, side: THREE.DoubleSide }));
    const z = G(p[0], p[1]);
    board.position.set(p[0], z + 1.9, -p[1]);
    board.rotation.y = Math.atan2(m.ux, m.uy) + Math.PI; // faces back down the line, toward riders arriving
    board.name = `lift sign ${name}`;
    this.group.add(board);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.9, 0.08), this.mat);
      leg.position.set(p[0] + m.uy * s * 1.0, z + 0.95, -(p[1] - m.ux * s * 1.0));
      this.group.add(leg);
    }
  }
}
