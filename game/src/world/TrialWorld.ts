import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Rider } from '../sim/Rider';
import { pointAt, type Course } from '../sim/Courses';
import type { GhostSample } from '../sim/TimeTrial';
import { RiderView } from './RiderView';

/**
 * 3D side of time trials: start gates and finish arches for courses near the rider (built on
 * demand, at most MAX_GATES at a time) and the translucent ghost rider.
 */
const MAX_GATES = 10;
const GATE_RANGE = 900;
const DIFF_COLOR: Record<string, string> = { novice: '#22c55e', easy: '#22c55e', intermediate: '#2563eb', advanced: '#111111', expert: '#111111', extreme: '#f97316', freeride: '#f97316' };

export class TrialWorld {
  readonly group = new THREE.Group();
  readonly ghost: RiderView;
  private readonly gates = new Map<string, THREE.Group>();
  private readonly poleMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5, metalness: 0.4 });
  private readonly fake: Record<string, unknown> = { normal: [0, 0, 1], onGround: true, crashed: 0, edgeAngle: 0, jumpCharge: 0, landingShock: 0, lateralG: 0, skid: 0, speed: 0, vx: 0, vy: 0, airTime: 0 };
  enabled = false;
  // wayfinding for the active course
  private route: THREE.Mesh | null = null;
  private routeCourse: Course | null = null;
  private routeCum: number[] = []; // distance along the course of each ribbon section
  private readonly routeMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
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
  }

  /** Show the route, finish beacon and next-checkpoint beacon for `c` (null hides). `along` is the rider's progress, `next` the next target distance. */
  updateRoute(c: Course | null, along: number, next: number, time: number): void {
    if (!c || !this.enabled) {
      if (this.route) this.route.visible = false;
      this.finishBeacon.visible = this.checkBeacon.visible = false;
      return;
    }
    if (c !== this.routeCourse) this.buildRoute(c);
    const route = this.route!;
    route.visible = true;
    // draw only from just behind the rider to the finish
    let first = 0;
    while (first < this.routeCum.length - 1 && this.routeCum[first + 1] < along - 10) first++;
    route.geometry.setDrawRange(first * 6, (this.routeCum.length - 1 - first) * 6);
    this.routeMat.opacity = 0.42 + 0.13 * Math.sin(time * 3);
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

  private buildRoute(c: Course): void {
    if (this.route) { this.group.remove(this.route); this.route.geometry.dispose(); }
    // ribbon 3 m wide every 4 m along the course, draped on the terrain
    const STEP = 4, HALF = 1.5;
    const n = Math.max(2, Math.ceil(c.length / STEP) + 1);
    const pos = new Float32Array(n * 2 * 3);
    const idx: number[] = [];
    this.routeCum = [];
    for (let i = 0; i < n; i++) {
      const d = Math.min(c.length, i * STEP);
      const p = pointAt(c, d), q = pointAt(c, Math.min(c.length, d + 2));
      let dx = q[0] - p[0], dy = q[1] - p[1];
      if (Math.hypot(dx, dy) < 1e-3) { const r = pointAt(c, Math.max(0, d - 2)); dx = p[0] - r[0]; dy = p[1] - r[1]; }
      const l = Math.hypot(dx, dy) || 1; const ax = dy / l, ay = -dx / l;
      for (const [k, sgn] of [[0, -1], [1, 1]] as const) {
        const x = p[0] + ax * HALF * sgn, y = p[1] + ay * HALF * sgn;
        pos.set([x, this.pack.groundHeight(x, y) + 0.15, -y], (i * 2 + k) * 3);
      }
      this.routeCum.push(d);
      if (i > 0) { const a = (i - 1) * 2, b = i * 2; idx.push(a, a + 1, b, a + 1, b + 1, b); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    this.route = new THREE.Mesh(geo, this.routeMat);
    this.route.frustumCulled = false;
    this.route.renderOrder = 2;
    this.group.add(this.route);
    this.routeCourse = c;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) { for (const g of this.gates.values()) this.group.remove(g); this.gates.clear(); this.ghost.group.visible = false; this.updateRoute(null, 0, 0, 0); }
  }

  /** Keep gates for the nearest courses around (x, y). */
  updateGates(x: number, y: number): void {
    if (!this.enabled) return;
    const near = this.courses
      .map((c) => ({ c, d: Math.min(Math.hypot(c.start[0] - x, c.start[1] - y), Math.hypot(c.finish[0] - x, c.finish[1] - y)) }))
      .filter((e) => e.d < GATE_RANGE).sort((a, b) => a.d - b.d).slice(0, MAX_GATES);
    const keep = new Set(near.map((e) => e.c.id));
    for (const [id, g] of this.gates) if (!keep.has(id)) { this.group.remove(g); this.gates.delete(id); }
    for (const { c } of near) if (!this.gates.has(c.id)) { const g = this.buildGates(c); this.gates.set(c.id, g); this.group.add(g); }
  }

  private buildGates(c: Course): THREE.Group {
    const g = new THREE.Group();
    const color = DIFF_COLOR[c.difficulty ?? 'intermediate'] ?? '#2563eb';
    const make = (p: [number, number, number], dir: [number, number], label: string, sub: string, arch: boolean) => {
      const gate = new THREE.Group();
      const z = this.pack.groundHeight(p[0], p[1]);
      gate.position.set(p[0], z, -p[1]);
      gate.rotation.y = Math.atan2(-dir[0], dir[1]); // local X across the course, banner faces up the course
      const half = 4, h = arch ? 4.2 : 3.2;
      for (const s of [-1, 1]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, h, 8), this.poleMat);
        pole.position.set(s * half, h / 2, 0); pole.castShadow = true; gate.add(pole);
      }
      const tex = bannerTexture(label, sub, color);
      const banner = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 0.3, 0.9, 0.06), [
        this.poleMat, this.poleMat, this.poleMat, this.poleMat,
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }),
      ]);
      banner.position.set(0, h - 0.45, 0); banner.castShadow = true;
      gate.add(banner);
      return gate;
    };
    g.add(make(c.start, c.dir, 'START', c.name, false));
    const n = c.points.length;
    const fx = c.points[n - 1][0] - c.points[n - 2][0], fy = c.points[n - 1][1] - c.points[n - 2][1], fl = Math.hypot(fx, fy) || 1;
    g.add(make(c.finish, [fx / fl, fy / fl], 'FINISH', c.name, true));
    return g;
  }

  /** Show the ghost at a recorded pose, or hide it with null. */
  updateGhost(s: GhostSample | null, dt: number): void {
    if (!s || !this.enabled) { this.ghost.group.visible = false; return; }
    this.ghost.group.visible = true;
    const f = this.fake;
    f.x = s.x; f.y = s.y; f.z = s.z; f.heading = s.h; f.lateralG = s.lg; f.edgeAngle = s.e;
    f.onGround = (s.f & 1) !== 0; f.crashed = (s.f & 4) !== 0 ? 1 : 0;
    const n = this.pack.groundNormal(s.x, s.y) as number[];
    f.normal = [n[0], n[1], n[2]];
    this.ghost.update(f as unknown as Rider, dt, (s.f & 2) !== 0);
  }

  dispose(): void { for (const g of this.gates.values()) this.group.remove(g); this.gates.clear(); }
}

function bannerTexture(label: string, sub: string, color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 512; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color; ctx.fillRect(0, 0, 512, 64);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 34px system-ui, sans-serif'; ctx.fillText(label, 16, 33);
  ctx.font = '22px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.fillText(sub.slice(0, 26), 496, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
