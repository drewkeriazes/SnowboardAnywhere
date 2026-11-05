import * as THREE from 'three';
import type { LiftFeature } from '../pack/types';
import type { Pack } from '../pack/Pack';

/**
 * Lift towers, cables with catenary sag, terminals and moving chairs.
 * Tower positions come from OSM pylons when mapped, otherwise spaced along the line.
 */
const CHAIR_SPACING = 22; // m along the cable
const CHAIR_SPEED = 2.6; // m/s

export interface LiftRuntime {
  feature: LiftFeature;
  curve: THREE.Vector3[]; // cable centre line (three.js coords), station a -> station b
  cum: number[]; // cumulative length
  length: number;
  chairs: THREE.InstancedMesh;
  nChairs: number;
  offset: number;
  lateral: [number, number];
  yaw: number;
  /** true when station a (curve start) is the lower terminal, so riding up means d: 0 -> length */
  upFromA: boolean;
  bottom: [number, number, number]; // pack coords of the lower terminal
  top: [number, number, number];
}

/** Height of the seat below the cable (hanger + chair). */
export const SEAT_DROP = 2.1;
export { CHAIR_SPEED };

export class Lifts {
  readonly group = new THREE.Group();
  private readonly lifts: LiftRuntime[] = [];
  private readonly towerMat = new THREE.MeshStandardMaterial({ color: 0x6d6f73, roughness: 0.6, metalness: 0.4 });
  private readonly cableMat = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
  private readonly chairMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.6, metalness: 0.3 });
  private readonly terminalMat = new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.8 });
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(pack: Pack) {
    const towerGeo = new THREE.CylinderGeometry(0.35, 0.5, 1, 8);
    towerGeo.translate(0, 0.5, 0);
    const armGeo = new THREE.BoxGeometry(5.5, 0.35, 0.5);
    const chairGeo = new THREE.BoxGeometry(2.2, 0.5, 0.6);
    chairGeo.translate(0, -1.8, 0);
    const hangerGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.8, 4);
    hangerGeo.translate(0, -0.9, 0);
    const chairFull = mergeTwo(chairGeo, hangerGeo);

    for (const lift of pack.features.lifts) {
      if (lift.stations.length < 2) continue;
      const a = lift.stations[0], b = lift.stations[lift.stations.length - 1];
      // towers: given, else every 140 m along the line
      let towers = lift.towers;
      if (!towers || towers.length === 0) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.floor(len / 140));
        towers = [];
        for (let i = 1; i < n; i++) {
          const t = i / n;
          const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
          towers.push([x, y, pack.groundHeight(x, y), 11]);
        }
      }
      const dirX = b[0] - a[0], dirY = b[1] - a[1];
      const dl = Math.hypot(dirX, dirY) || 1;
      const lx = dirY / dl, ly = -dirX / dl; // lateral unit
      // tower meshes
      const inst = new THREE.InstancedMesh(towerGeo, this.towerMat, towers.length);
      const arms = new THREE.InstancedMesh(armGeo, this.towerMat, towers.length);
      inst.castShadow = true; arms.castShadow = true;
      const yaw = Math.atan2(dirX, dirY); // heading of the line
      towers.forEach((t, i) => {
        this.p.set(t[0], t[2], -t[1]);
        this.q.identity();
        this.s.set(1, t[3], 1);
        this.m.compose(this.p, this.q, this.s);
        inst.setMatrixAt(i, this.m);
        this.p.set(t[0], t[2] + t[3], -t[1]);
        this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw + Math.PI / 2);
        this.s.set(1, 1, 1);
        this.m.compose(this.p, this.q, this.s);
        arms.setMatrixAt(i, this.m);
      });
      inst.instanceMatrix.needsUpdate = true; arms.instanceMatrix.needsUpdate = true;
      this.group.add(inst, arms);
      // terminals
      for (const st of [a, b]) {
        const term = new THREE.Mesh(new THREE.BoxGeometry(12, 6, 7), this.terminalMat);
        term.position.set(st[0], pack.groundHeight(st[0], st[1]) + 3.5, -st[1]);
        term.rotation.y = -yaw;
        term.castShadow = true; term.receiveShadow = true;
        this.group.add(term);
      }
      // cable path: station tops and tower tops with catenary sag between
      const pts: THREE.Vector3[] = [];
      const anchors: [number, number, number][] = [[a[0], a[1], pack.groundHeight(a[0], a[1]) + 6], ...towers.map((t) => [t[0], t[1], t[2] + t[3]] as [number, number, number]), [b[0], b[1], pack.groundHeight(b[0], b[1]) + 6]];
      for (let i = 0; i < anchors.length - 1; i++) {
        const p0 = anchors[i], p1 = anchors[i + 1];
        const span = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        const sag = Math.min(6, span * 0.025);
        const segs = 8;
        for (let k = 0; k < segs; k++) {
          const t = k / segs;
          const z = p0[2] + (p1[2] - p0[2]) * t - sag * 4 * t * (1 - t);
          pts.push(new THREE.Vector3(p0[0] + (p1[0] - p0[0]) * t, z, -(p0[1] + (p1[1] - p0[1]) * t)));
        }
      }
      const last = anchors[anchors.length - 1];
      pts.push(new THREE.Vector3(last[0], last[2], -last[1]));
      for (const side of [-1, 1]) {
        const offs = pts.map((v) => new THREE.Vector3(v.x + lx * 1.6 * side, v.y, v.z - ly * 1.6 * side));
        const geo = new THREE.BufferGeometry().setFromPoints(offs);
        this.group.add(new THREE.Line(geo, this.cableMat));
      }
      // chairs
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const length = cum[cum.length - 1];
      const nChairs = Math.max(2, Math.floor((2 * length) / CHAIR_SPACING));
      const chairs = new THREE.InstancedMesh(chairFull, this.chairMat, nChairs);
      chairs.castShadow = true;
      this.group.add(chairs);
      const upFromA = a[2] <= b[2];
      this.lifts.push({ feature: lift, curve: pts, cum, length, chairs, nChairs, offset: Math.random() * CHAIR_SPACING, lateral: [lx, ly], yaw,
        upFromA, bottom: upFromA ? [a[0], a[1], a[2]] : [b[0], b[1], b[2]], top: upFromA ? [b[0], b[1], b[2]] : [a[0], a[1], a[2]] });
    }
  }

  /** All lifts with a usable cable. */
  get all(): LiftRuntime[] { return this.lifts; }

  /** Nearest lift whose bottom terminal is within `maxDist` m of a point, or null. Surface lifts (carpets) are skipped. */
  nearestBoardable(x: number, y: number, maxDist = 14): LiftRuntime | null {
    let best: LiftRuntime | null = null, bd = maxDist;
    for (const l of this.lifts) {
      if (l.feature.type === 'magic_carpet') continue;
      const d = Math.hypot(l.bottom[0] - x, l.bottom[1] - y);
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  }

  /** Seat position (three.js coords) at distance `up` metres from the bottom terminal along the cable. */
  seatAt(l: LiftRuntime, up: number, out: THREE.Vector3): THREE.Vector3 {
    const d = l.upFromA ? up : l.length - up;
    this.pointAt(l, Math.max(0, Math.min(l.length, d)), out);
    const side = l.upFromA ? 1 : -1; // the moving chairs use side +1 for the a -> b direction
    out.x += l.lateral[0] * 1.6 * side; out.z -= l.lateral[1] * 1.6 * side; out.y -= SEAT_DROP;
    return out;
  }

  private pointAt(l: LiftRuntime, d: number, out: THREE.Vector3): THREE.Vector3 {
    const cum = l.cum;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    const t = (d - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
    return out.copy(l.curve[lo]).lerp(l.curve[hi], t);
  }

  update(time: number): void {
    for (const l of this.lifts) {
      const [lx, ly] = l.lateral;
      const yaw = l.yaw;
      this.q.setFromAxisAngle(this.tmp2.set(0, 1, 0), -yaw + Math.PI / 2);
      const loop = 2 * l.length;
      for (let i = 0; i < l.nChairs; i++) {
        let d = (i * CHAIR_SPACING + time * CHAIR_SPEED + l.offset) % loop;
        let side = 1;
        if (d > l.length) { d = loop - d; side = -1; } // returning side
        this.pointAt(l, d, this.tmp);
        this.p.set(this.tmp.x + lx * 1.6 * side, this.tmp.y, this.tmp.z - ly * 1.6 * side);
        this.m.compose(this.p, this.q, this.s.set(1, 1, 1));
        l.chairs.setMatrixAt(i, this.m);
      }
      l.chairs.instanceMatrix.needsUpdate = true;
    }
  }
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const geos = [a, b];
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  let base = 0;
  for (const g of geos) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); }
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + base);
    else for (let i = 0; i < p.count; i++) idx.push(i + base);
    base += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}
