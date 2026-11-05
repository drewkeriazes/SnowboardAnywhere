import * as THREE from 'three';
import type { LiftFeature } from '../pack/types';
import type { Pack } from '../pack/Pack';

/**
 * Lift towers, cables with catenary sag, terminals and moving chairs.
 * Tower positions come from OSM pylons when mapped, otherwise spaced along the line.
 */
const CHAIR_SPACING = 22; // m along the cable
const CHAIR_SPEED = 2.6; // m/s
/** metres along the line from the station node to where you board / unload */
export const LOAD_OFFSET = 8;

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
  /** distance from the bottom terminal of each tower along the line (sorted ascending) */
  towerUp: number[];
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
      // cable path: station tops and tower tops with catenary sag between. Where a span would
      // run closer than CLEARANCE to the ground (sparse OSM pylons over a convex slope), insert
      // a virtual tower at the worst point and try again.
      const pts: THREE.Vector3[] = [];
      const anchors: [number, number, number][] = [[a[0], a[1], pack.groundHeight(a[0], a[1]) + 6], ...towers.map((t) => [t[0], t[1], t[2] + t[3]] as [number, number, number]), [b[0], b[1], pack.groundHeight(b[0], b[1]) + 6]];
      const CLEARANCE = 7;
      const extra: [number, number, number, number][] = [];
      for (let guard = 0; guard < 60; guard++) {
        let worst = -1, wi = -1, wx = 0, wy = 0;
        for (let i = 0; i < anchors.length - 1; i++) {
          const p0 = anchors[i], p1 = anchors[i + 1];
          const span = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
          if (span < 30) continue;
          const sag = Math.min(6, span * 0.025);
          const n = Math.min(24, Math.max(4, Math.floor(span / 10)));
          for (let k = 1; k < n; k++) {
            const t = k / n;
            const x = p0[0] + (p1[0] - p0[0]) * t, y = p0[1] + (p1[1] - p0[1]) * t;
            const z = p0[2] + (p1[2] - p0[2]) * t - sag * 4 * t * (1 - t);
            const g = pack.groundHeight(x, y);
            const v = g + CLEARANCE - z;
            if (v > worst) { worst = v; wi = i; wx = x; wy = y; }
          }
        }
        if (worst <= 0) break;
        const gz = pack.groundHeight(wx, wy);
        anchors.splice(wi + 1, 0, [wx, wy, gz + 11]);
        extra.push([wx, wy, gz, 11]);
      }
      if (extra.length) {
        const all = [...towers, ...extra];
        towers = all;
        const inst2 = new THREE.InstancedMesh(towerGeo, this.towerMat, extra.length);
        const arms2 = new THREE.InstancedMesh(armGeo, this.towerMat, extra.length);
        extra.forEach((t, i) => {
          this.p.set(t[0], t[2], -t[1]); this.q.identity(); this.s.set(1, t[3], 1); this.m.compose(this.p, this.q, this.s); inst2.setMatrixAt(i, this.m);
          this.p.set(t[0], t[2] + t[3], -t[1]); this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw + Math.PI / 2); this.s.set(1, 1, 1); this.m.compose(this.p, this.q, this.s); arms2.setMatrixAt(i, this.m);
        });
        inst2.instanceMatrix.needsUpdate = true; arms2.instanceMatrix.needsUpdate = true;
        this.group.add(inst2, arms2);
      }
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
      // loading and unloading points: LOAD_OFFSET m along the line from the station node, where the
      // chair leaves / enters the terminal box. Everything (ring, marker, prompt, seat) uses these.
      const lo = upFromA ? a : b, hi = upFromA ? b : a;
      const ux = (hi[0] - lo[0]) / dl, uy = (hi[1] - lo[1]) / dl;
      const bx = lo[0] + ux * LOAD_OFFSET, by = lo[1] + uy * LOAD_OFFSET;
      const tx = hi[0] - ux * LOAD_OFFSET, ty = hi[1] - uy * LOAD_OFFSET;
      const bottom: [number, number, number] = [bx, by, pack.groundHeight(bx, by)];
      const top: [number, number, number] = [tx, ty, pack.groundHeight(tx, ty)];
      const towerUp = towers.map((t) => Math.hypot(t[0] - lo[0], t[1] - lo[1])).sort((p, q) => p - q);
      this.lifts.push({ feature: lift, curve: pts, cum, length, chairs, nChairs, offset: Math.random() * CHAIR_SPACING, lateral: [lx, ly], yaw,
        upFromA, bottom, top, towerUp });
    }
  }

  /** All lifts with a usable cable. */
  get all(): LiftRuntime[] { return this.lifts; }

  /** Floating markers above each bottom terminal (chair glyph + name) and a ring on the snow. */
  readonly markers = new THREE.Group();
  private markerSprites: { sprite: THREE.Sprite; base: THREE.Vector3; lift: LiftRuntime }[] = [];
  private markersBuilt = false;
  buildMarkers(pack: Pack): void {
    if (this.markersBuilt) return;
    this.markersBuilt = true;
    const ringGeo = new THREE.RingGeometry(9, 11, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
    for (const l of this.lifts) {
      if (l.feature.type === 'magic_carpet') continue;
      const [x, y] = l.bottom;
      const z = pack.groundHeight(x, y);
      const tex = makeMarkerTexture(l.feature.name ?? 'Lift');
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: true });
      const sprite = new THREE.Sprite(mat);
      const base = new THREE.Vector3(x, z + 14, -y);
      sprite.position.copy(base);
      sprite.center.set(0.5, 0);
      sprite.renderOrder = 999;
      this.markers.add(sprite);
      this.markerSprites.push({ sprite, base, lift: l });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(x, z + 0.3, -y);
      // tilt the ring to the ground normal so it does not clip into the slope
      const n = pack.groundNormal(x, y) as number[];
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(n[0], n[2], -n[1]).normalize());
      this.markers.add(ring);
    }
  }
  /** Bob and scale the markers; the one the rider can board pulses. */
  updateMarkers(time: number, camX: number, camY: number, boardable: LiftRuntime | null): void {
    for (const m of this.markerSprites) {
      const d = Math.hypot(m.base.x - camX, -m.base.z - camY);
      const vis = d < 1500;
      m.sprite.visible = vis;
      if (!vis) continue;
      const bob = Math.sin(time * 2 + m.base.x * 0.01) * 0.6;
      m.sprite.position.set(m.base.x, m.base.y + bob, m.base.z);
      // keep roughly constant on screen: scale with distance, with floor and ceiling
      const k = Math.min(60, Math.max(6, d * 0.06)) * (m.lift === boardable ? 1 + 0.12 * Math.sin(time * 6) : 1);
      m.sprite.scale.set(k * 2.4, k, 1);
      (m.sprite.material as THREE.SpriteMaterial).opacity = m.lift === boardable ? 1 : 0.85;
    }
  }

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

  /** Rideable cable length between the loading and unloading points. */
  rideLength(l: LiftRuntime): number { return Math.max(1, l.length - 2 * LOAD_OFFSET); }

  /** Seat position (three.js coords) at distance `up` metres from the bottom loading point along the cable. */
  seatAt(l: LiftRuntime, up: number, out: THREE.Vector3): THREE.Vector3 {
    const dd = up + LOAD_OFFSET;
    const d = l.upFromA ? dd : l.length - dd;
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

/** Canvas texture: rounded label with a chair glyph and the lift name. */
function makeMarkerTexture(name: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 214;
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 44px system-ui, sans-serif';
  const w = Math.min(500, ctx.measureText(name).width + 140);
  const x0 = (512 - w) / 2;
  // pill
  ctx.fillStyle = 'rgba(20,24,34,.85)';
  ctx.beginPath(); ctx.roundRect(x0, 60, w, 90, 24); ctx.fill();
  ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 5; ctx.stroke();
  // chair glyph: seat + hanger
  ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 8; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x0 + 50, 72); ctx.lineTo(x0 + 50, 108); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x0 + 28, 108); ctx.lineTo(x0 + 72, 108); ctx.lineTo(x0 + 72, 130); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
  ctx.fillText(name, x0 + 95, 106);
  // pointer
  ctx.fillStyle = '#ffd166';
  ctx.beginPath(); ctx.moveTo(236, 152); ctx.lineTo(276, 152); ctx.lineTo(256, 184); ctx.closePath(); ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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
