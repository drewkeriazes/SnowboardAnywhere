import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import { EDGE_FULL, type Rider } from '../sim/Rider';
import { pointAt, type Course } from '../sim/Courses';
import { OFF_COURSE, type GhostSample } from '../sim/TimeTrial';
import { RiderView } from './RiderView';

/**
 * 3D side of time trials: start and finish signs near the rider, the boundary walls of the
 * active course, beacons over the finish and the next checkpoint, and the translucent ghost.
 * Starts (and finishes) within CLUSTER m of each other share one larger sign that lists every
 * course on its own row, so gates never stack.
 */
const CLUSTER = 30;
const WALL_H = 4; // m
const WALL_SPAN = 260; // m along the course shown ahead of / behind the rider
const MAX_GATES = 10;
const GATE_RANGE = 900;
const DIFF_COLOR: Record<string, string> = { novice: '#22c55e', easy: '#22c55e', intermediate: '#2563eb', advanced: '#111111', expert: '#111111', extreme: '#f97316', freeride: '#f97316' };

export class TrialWorld {
  readonly group = new THREE.Group();
  readonly ghost: RiderView;
  private readonly gates = new Map<string, THREE.Group>();
  private readonly poleMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5, metalness: 0.4 });
  /** the ghost as the rider view reads it. BUG-059: with the BUG-056 lead reads (no lead: the steer is
   *  not recorded, as in a replay) and the fields the air and press poses read */
  private readonly fake: Record<string, unknown> = { normal: [0, 0, 1], onGround: true, crashed: 0, edgeAngle: 0, edge: 0, brakePsi: 0, jumpCharge: 0, landingShock: 0, lateralG: 0, skid: 0, brakeAmt: 0, brakeSide: 0, brakeAcc: 0, scrape: 0, slip: 0, speed: 0, vx: 0, vy: 0, airTime: 0,
    lean: 0, flip: 0, flipRate: 0, squat: 0, turnRate: 0, switch: false, goofy: false,
    predictEdge(this: { edge: number }) { return this.edge; }, predictIncline: () => 0, predictLean: () => 0 };
  enabled = false;
  // boundary walls for the active course
  private walls: THREE.Mesh[] = [];
  private wallCourse: Course | null = null;
  private wallCum: number[] = []; // distance along the course of each wall section
  private readonly wallMat = new THREE.MeshBasicMaterial({ color: 0xbfe6ff, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  /** signs: starts and finishes clustered so close ones share a sign */
  private readonly clusters: { kind: 'start' | 'finish'; x: number; y: number; dir: [number, number]; courses: Course[] }[] = [];
  private readonly finishBeacon: THREE.Mesh;
  private readonly checkBeacon: THREE.Mesh;

  constructor(private readonly pack: Pack, private readonly courses: Course[]) {
    this.ghost = new RiderView();
    for (const m of Object.values(this.ghost.mats)) { m.transparent = true; m.opacity = 0.38; m.depthWrite = false; m.color.lerp(new THREE.Color(0x9fd8ff), 0.6); m.emissive = new THREE.Color(0x2a5a80); }
    this.ghost.group.visible = false;
    this.group.add(this.ghost.group);
    const beaconMat = (c: number, o: number) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    // open-ended cones of light: wide at the base, fading up
    this.finishBeacon = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 3.5, 160, 24, 1, true), beaconMat(0xffd23f, 0.35));
    this.finishBeacon.geometry.translate(0, 80, 0);
    this.checkBeacon = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.6, 40, 16, 1, true), beaconMat(0x7dd3fc, 0.35));
    this.checkBeacon.geometry.translate(0, 20, 0);
    this.finishBeacon.visible = this.checkBeacon.visible = false;
    this.group.add(this.finishBeacon, this.checkBeacon);
    // cluster starts and finishes
    for (const c of courses) {
      const n = c.points.length;
      const fx = c.points[n - 1][0] - c.points[n - 2][0], fy = c.points[n - 1][1] - c.points[n - 2][1], fl = Math.hypot(fx, fy) || 1;
      for (const [kind, p, dir] of [['start', c.start, c.dir], ['finish', c.finish, [fx / fl, fy / fl]]] as const) {
        const hit = this.clusters.find((k) => k.kind === kind && Math.hypot(k.x - p[0], k.y - p[1]) < CLUSTER);
        if (hit) { hit.courses.push(c); hit.x = (hit.x * (hit.courses.length - 1) + p[0]) / hit.courses.length; hit.y = (hit.y * (hit.courses.length - 1) + p[1]) / hit.courses.length; }
        else this.clusters.push({ kind, x: p[0], y: p[1], dir: [dir[0], dir[1]], courses: [c] });
      }
    }
  }

  /**
   * Boundary walls, finish beacon and next-checkpoint beacon for `c` (null hides). `along` is the
   * rider's progress, `next` the next target distance, `outside` true while out of bounds.
   */
  updateRoute(c: Course | null, along: number, next: number, time: number, outside = false): void {
    if (!c || !this.enabled) {
      for (const w of this.walls) w.visible = false;
      this.finishBeacon.visible = this.checkBeacon.visible = false;
      return;
    }
    if (c !== this.wallCourse) this.buildWalls(c);
    // only the stretch around the rider: from WALL_SPAN/3 behind to WALL_SPAN ahead
    let first = 0;
    while (first < this.wallCum.length - 1 && this.wallCum[first + 1] < along - WALL_SPAN / 3) first++;
    let last = first;
    while (last < this.wallCum.length - 1 && this.wallCum[last] < along + WALL_SPAN) last++;
    for (const w of this.walls) { w.visible = true; w.geometry.setDrawRange(first * 6, Math.max(0, last - first) * 6); }
    if (outside) this.wallMat.color.setRGB(1, 0.35 + 0.15 * Math.sin(time * 10), 0.35);
    else this.wallMat.color.setRGB(0.75, 0.9, 1);
    // beacons
    const f = c.finish;
    this.finishBeacon.position.set(f[0], this.pack.groundHeight(f[0], f[1]), -f[1]);
    this.finishBeacon.visible = true;
    if (next < c.length - 1) {
      const p = pointAt(c, next);
      this.checkBeacon.position.set(p[0], this.pack.groundHeight(p[0], p[1]), -p[1]);
      this.checkBeacon.visible = true;
    } else this.checkBeacon.visible = false;
  }

  /** Two walls OFF_COURSE m either side of the route, following a smoothed direction so bends stay clean. */
  private buildWalls(c: Course): void {
    for (const w of this.walls) { this.group.remove(w); w.geometry.dispose(); }
    this.walls = [];
    const STEP = 5, SMOOTH = 30;
    const n = Math.max(2, Math.ceil(c.length / STEP) + 1);
    this.wallCum = [];
    const sides: { pos: Float32Array; col: Float32Array }[] = [-1, 1].map(() => ({ pos: new Float32Array(n * 2 * 3), col: new Float32Array(n * 2 * 4) }));
    for (let i = 0; i < n; i++) {
      const d = Math.min(c.length, i * STEP);
      const p = pointAt(c, d), a = pointAt(c, Math.max(0, d - SMOOTH)), b = pointAt(c, Math.min(c.length, d + SMOOTH));
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      const ax = dy / l, ay = -dx / l;
      this.wallCum.push(d);
      [-1, 1].forEach((sgn, k) => {
        const x = p[0] + ax * OFF_COURSE * sgn, y = p[1] + ay * OFF_COURSE * sgn;
        const g = this.pack.groundHeight(x, y);
        const { pos, col } = sides[k];
        pos.set([x, g, -y, x, g + WALL_H, -y], i * 6);
        // faint at the foot, fading out toward the top; ends fade in and out along the course
        const endFade = Math.min(1, d / 40, (c.length - d) / 40);
        col.set([1, 1, 1, 0.32 * endFade, 1, 1, 1, 0], i * 8);
      });
    }
    for (const { pos, col } of sides) {
      const idx: number[] = [];
      for (let i = 1; i < n; i++) { const a = (i - 1) * 2, b = i * 2; idx.push(a, a + 1, b, a + 1, b + 1, b); }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
      geo.setIndex(idx);
      const m = new THREE.Mesh(geo, this.wallMat);
      m.frustumCulled = false; m.renderOrder = 3;
      this.walls.push(m); this.group.add(m);
    }
    this.wallCourse = c;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) { for (const g of this.gates.values()) this.group.remove(g); this.gates.clear(); this.ghost.group.visible = false; this.updateRoute(null, 0, 0, 0); }
  }

  /** Keep signs for the nearest start / finish clusters around (x, y). */
  updateGates(x: number, y: number): void {
    if (!this.enabled) return;
    const near = this.clusters
      .map((k, i) => ({ i, k, d: Math.hypot(k.x - x, k.y - y) }))
      .filter((e) => e.d < GATE_RANGE).sort((a, b) => a.d - b.d).slice(0, MAX_GATES);
    const keep = new Set(near.map((e) => String(e.i)));
    for (const [id, g] of this.gates) if (!keep.has(id)) { this.group.remove(g); this.gates.delete(id); }
    for (const { i, k } of near) if (!this.gates.has(String(i))) { const g = this.buildSign(k); this.gates.set(String(i), g); this.group.add(g); }
  }

  /** One sign for a cluster: header START / FINISH, one row per course (difficulty colour badge + name). */
  private buildSign(k: { kind: 'start' | 'finish'; x: number; y: number; dir: [number, number]; courses: Course[] }): THREE.Group {
    const gate = new THREE.Group();
    const z = this.pack.groundHeight(k.x, k.y);
    gate.position.set(k.x, z, -k.y);
    gate.rotation.y = Math.atan2(-k.dir[0], k.dir[1]); // local X across the course, sign faces up the course
    const rows = k.courses.slice(0, 6);
    const more = k.courses.length - rows.length;
    const single = k.courses.length === 1;
    const tex = signTexture(k.kind === 'start' ? 'START' : 'FINISH', rows, more, single);
    const W = single ? 8 : 9, H = tex.image.height / tex.image.width * W;
    const bottom = k.kind === 'finish' ? 3.2 : 2.4;
    const half = W / 2;
    for (const sx of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, bottom + H, 8), this.poleMat);
      pole.position.set(sx * half, (bottom + H) / 2, 0); pole.castShadow = true; gate.add(pole);
    }
    const face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 });
    const banner = new THREE.Mesh(new THREE.BoxGeometry(W + 0.3, H, 0.06), [this.poleMat, this.poleMat, this.poleMat, this.poleMat, face, face]);
    banner.position.set(0, bottom + H / 2, 0); banner.castShadow = true;
    gate.add(banner);
    return gate;
  }

  /** Show the ghost at a recorded pose, or hide it with null. */
  updateGhost(s: GhostSample | null, dt: number): void {
    if (!s || !this.enabled) { this.ghost.group.visible = false; return; }
    this.ghost.group.visible = true;
    const f = this.fake;
    f.x = s.x; f.y = s.y; f.z = s.z; f.heading = f.boardYaw = s.h; f.lateralG = s.lg; f.edgeAngle = s.e; f.edge = s.e * EDGE_FULL;
    f.switch = (s.f & 8) !== 0; f.goofy = (s.f & 16) !== 0; // FEAT-139: drawn the way round the best run was ridden
    f.onGround = (s.f & 1) !== 0; f.crashed = (s.f & 4) !== 0 ? 1 : 0;
    const n = this.pack.groundNormal(s.x, s.y) as number[];
    f.normal = [n[0], n[1], n[2]];
    this.ghost.update(f as unknown as Rider, dt, (s.f & 2) !== 0);
  }

  dispose(): void { for (const g of this.gates.values()) this.group.remove(g); this.gates.clear(); }
}

/** Sign face: a header and one row per course, sized to the number of rows, readable at a distance. */
function signTexture(label: string, rows: Course[], more: number, single: boolean): THREE.CanvasTexture {
  const W = 1024, HEAD = 120, ROW = 84;
  const c = document.createElement('canvas');
  c.width = W; c.height = single ? 140 : HEAD + ROW * rows.length + (more ? 60 : 0) + 16;
  const ctx = c.getContext('2d')!;
  ctx.textBaseline = 'middle';
  if (single) {
    const col = DIFF_COLOR[rows[0].difficulty ?? 'intermediate'] ?? '#2563eb';
    ctx.fillStyle = col; ctx.fillRect(0, 0, W, c.height);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 72px system-ui, sans-serif'; ctx.fillText(label, 32, 72);
    ctx.font = '52px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.fillText(rows[0].name.slice(0, 22), W - 32, 74);
  } else {
    ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, W, c.height);
    ctx.fillStyle = '#facc15'; ctx.fillRect(0, 0, W, HEAD);
    ctx.fillStyle = '#111'; ctx.font = 'bold 80px system-ui, sans-serif'; ctx.fillText(label, 32, HEAD / 2 + 4);
    rows.forEach((r, i) => {
      const y = HEAD + ROW * i + ROW / 2 + 8;
      ctx.fillStyle = DIFF_COLOR[r.difficulty ?? 'intermediate'] ?? '#2563eb';
      ctx.fillRect(32, y - 26, 52, 52);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.strokeRect(32, y - 26, 52, 52);
      ctx.fillStyle = '#fff'; ctx.font = '56px system-ui, sans-serif'; ctx.fillText(r.name.slice(0, 26), 108, y + 2);
    });
    if (more) { ctx.fillStyle = '#cbd5e1'; ctx.font = 'italic 44px system-ui, sans-serif'; ctx.fillText(`+${more} more`, 108, HEAD + ROW * rows.length + 38); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
