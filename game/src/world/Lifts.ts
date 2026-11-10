import * as THREE from 'three';
import type { LiftFeature } from '../pack/types';
import type { Pack } from '../pack/Pack';
import { LOAD_OFFSET, rideLength, type LiftKind, type LiftLine, type LiftNetwork, type Vec3 } from '../sim/LiftLine';
import { towerGeometry, towerHeadGeometry, footingGeometry, chairGeometry, gondolaGeometry, surfaceHangerGeometry, terminalGeometry, carpetGeometry } from './LiftModels';

/**
 * Lifts: towers, cables with catenary sag, terminals and moving carriers, from OSM aerialways.
 * Kinds: chair (fixed or detachable by capacity), gondola (cabins), surface (platter, T-bar:
 * low cable, hangers, the rider stays on the snow), carpet (a belt on the ground, no cable).
 * Tower positions come from OSM pylons when mapped, otherwise spaced along the line; spans that
 * would run too close to the ground get virtual towers.
 */
const SPEEDS: Record<LiftKind, number> = { chair: 2.6, gondola: 5.0, surface: 2.2, carpet: 0.9 };
const SPACING: Record<LiftKind, number> = { chair: 22, gondola: 60, surface: 10, carpet: 0 };
/** Height of the chair seat below the cable (hanger + chair). */
export const SEAT_DROP = 2.1;
export const CHAIR_SPEED = SPEEDS.chair;

/** A built lift: the line the sims ride (sim/LiftLine) plus its cable curve and chairs. */
export interface LiftRuntime extends LiftLine {
  feature: LiftFeature;
  curve: THREE.Vector3[]; // cable centre line (three.js coords), station a -> station b
  cum: number[]; // cumulative length
  carriers: THREE.InstancedMesh | null;
  nCarriers: number;
  spacing: number;
  offset: number;
  yaw: number;
}

function kindOf(type: string): LiftKind {
  if (type === 'gondola' || type === 'cable_car' || type === 'mixed_lift') return 'gondola';
  if (type === 'platter' || type === 't-bar' || type === 'j-bar' || type === 'rope_tow') return 'surface';
  if (type === 'magic_carpet') return 'carpet';
  return 'chair';
}

// ---------------------------------------------------------------- cables (BUG-029)

const CABLE_DIAMETER = 0.05; // metres; a 1 px GL line is drawn this many pixels wide at most
const CABLE_MIN_ALPHA = 0.15; // far cables stay a faint thread so lifts still read as lifts
const cableViewH = { value: 1080 };
const _size = new THREE.Vector2();
export function setCableViewport(renderer: THREE.WebGLRenderer): void { cableViewH.value = renderer.getDrawingBufferSize(_size).y; }

/**
 * GL lines are never thinner than 1 px, so a far cable drawn solid is 10 to 20 times too heavy.
 * Alpha = the rope's projected width in pixels, clamped to [CABLE_MIN_ALPHA, 1]: solid up close,
 * a faint thread at a distance. The fog chunk still applies, so distant cables also take the haze.
 */
export function cableMaterial(): THREE.LineBasicMaterial {
  const mat = new THREE.LineBasicMaterial({ color: 0x4a4f55, transparent: true });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCableViewH = cableViewH;
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', `uniform float uCableViewH;\nvarying float vCover;\nvoid main() {`)
      .replace('#include <project_vertex>', `#include <project_vertex>
  // projected rope width in pixels: diameter * focal length (px) / distance
  vCover = clamp(${CABLE_DIAMETER.toFixed(3)} * projectionMatrix[1][1] * 0.5 * uCableViewH / max(-mvPosition.z, 1.0), ${CABLE_MIN_ALPHA.toFixed(2)}, 1.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'varying float vCover;\nvoid main() {')
      .replace('#include <opaque_fragment>', 'diffuseColor.a *= vCover;\n#include <opaque_fragment>');
  };
  return mat;
}

export class Lifts implements LiftNetwork<LiftRuntime> {
  readonly group = new THREE.Group();
  private readonly lifts: LiftRuntime[] = [];
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 });
  get material(): THREE.MeshStandardMaterial { return this.mat; }
  /** haul rope (BUG-029): steel grey, fogged like the terrain, and faded by how much of a pixel a ~5 cm rope covers */
  private readonly cableMat = cableMaterial();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly seat = new THREE.Vector3();
  private readonly geos = {
    tower: towerGeometry(), head: towerHeadGeometry(), footing: footingGeometry(),
    chair2: chairGeometry(2), chair4: chairGeometry(4), chair6: chairGeometry(6), gondola: gondolaGeometry(),
    platter: surfaceHangerGeometry(false), tbar: surfaceHangerGeometry(true), carpet: carpetGeometry(),
    termChair: terminalGeometry('chair'), termGondola: terminalGeometry('gondola'), termSurface: terminalGeometry('surface'),
  };

  private readonly pack: Pack;
  /** one group per lift so a lift can be rebuilt on better terrain */
  private readonly liftGroups: THREE.Group[] = [];
  /** terrain level each lift was built on: 0 none (station heights only), 1 mid (16 m), 2 fine (1 m) */
  private readonly level: number[] = [];
  private maintainAcc = 0;

  constructor(pack: Pack) {
    this.pack = pack;
    for (const lift of pack.features.lifts) {
      if (lift.stations.length < 2) continue;
      const { rt, group } = this.build(lift);
      this.lifts.push(rt); this.liftGroups.push(group); this.level.push(0);
      this.group.add(group);
    }
  }

  /**
   * Height of the loaded terrain at (x, y), or NaN when no tile covering it has loaded yet.
   * Never the zRange fallback: building on that put cables and terminals underground (BUG-011).
   */
  private realGround(x: number, y: number): number {
    for (const s of this.pack.sets) { if (s.contains(x, y)) { const h = s.sample(x, y); if (!Number.isNaN(h)) return h; } }
    return NaN;
  }

  /** Build one lift's meshes and runtime. Station z comes from the pipeline (1 m DEM). */
  private build(lift: LiftFeature): { rt: LiftRuntime; group: THREE.Group } {
    const group = new THREE.Group();
    group.name = `lift ${lift.name ?? '(unnamed)'}`;
    const a = lift.stations[0], b = lift.stations[lift.stations.length - 1];
    const kind = kindOf(lift.type);
    const dirX = b[0] - a[0], dirY = b[1] - a[1];
    const dl = Math.hypot(dirX, dirY) || 1;
    const lx = dirY / dl, ly = -dirX / dl; // lateral unit
    const yaw = Math.atan2(dirX, dirY); // heading of the line
    // ground along the line: loaded terrain where we have it, else straight between the station heights
    const lineZ = (x: number, y: number) => { const t = Math.max(0, Math.min(1, ((x - a[0]) * dirX + (y - a[1]) * dirY) / (dl * dl))); return a[2] + (b[2] - a[2]) * t; };
    const ground = (x: number, y: number) => { const h = this.realGround(x, y); return Number.isNaN(h) ? lineZ(x, y) : h; };
    const upFromA = a[2] <= b[2];
    const lo = upFromA ? a : b, hi = upFromA ? b : a;
    const ux = (hi[0] - lo[0]) / dl, uy = (hi[1] - lo[1]) / dl;
    const bx = lo[0] + ux * LOAD_OFFSET, by = lo[1] + uy * LOAD_OFFSET;
    const tx = hi[0] - ux * LOAD_OFFSET, ty = hi[1] - uy * LOAD_OFFSET;
    const bottom: [number, number, number] = [bx, by, ground(bx, by)];
    const top: [number, number, number] = [tx, ty, ground(tx, ty)];

    if (kind === 'carpet') {
      const pts: THREE.Vector3[] = [];
      const n = Math.max(2, Math.ceil(dl / 4));
      for (let i = 0; i <= n; i++) { const t = i / n; const x = a[0] + dirX * t, y = a[1] + dirY * t; pts.push(new THREE.Vector3(x, ground(x, y) + 0.05, -y)); }
      for (let i = 0; i < n; i++) {
        const p0 = pts[i], p1 = pts[i + 1];
        const seg = new THREE.Mesh(this.geos.carpet, this.mat);
        seg.position.copy(p0).lerp(p1, 0.5);
        seg.scale.set(1, 1, p0.distanceTo(p1) + 0.05);
        seg.lookAt(p1);
        seg.name = 'carpet';
        seg.receiveShadow = true;
        group.add(seg);
      }
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      return { group, rt: { feature: lift, kind, speed: SPEEDS.carpet, riderDrop: 0, curve: pts, cum, length: cum[cum.length - 1], carriers: null, nCarriers: 0, spacing: 0, offset: 0, lateral: [lx, ly], yaw, upFromA, bottom, top, towerUp: [] } };
    }

    const towerH = kind === 'surface' ? 4.5 : kind === 'gondola' ? 14 : 11;
    const termH = kind === 'surface' ? 3.6 : 7.5; // cable height at the terminals
    // towers: OSM pylons (heights from the pipeline), else every 140 m (60 m for surface lifts)
    let towers = lift.towers;
    if (!towers || towers.length === 0) {
      const n = Math.max(1, Math.floor(dl / (kind === 'surface' ? 60 : 140)));
      towers = [];
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const x = a[0] + dirX * t, y = a[1] + dirY * t;
        towers.push([x, y, ground(x, y), towerH]);
      }
    } else towers = towers.map((t) => [t[0], t[1], t[2], kind === 'surface' ? towerH : t[3]]);
    // terminals sit on the station heights from the 1 m DEM
    const anchors: [number, number, number][] = [[a[0], a[1], a[2] + termH], ...towers.map((t) => [t[0], t[1], t[2] + t[3]] as [number, number, number]), [b[0], b[1], b[2] + termH]];
    // ground clearance: where a span runs closer than CLEARANCE to loaded terrain, insert a virtual
    // tower at the worst point. Points without loaded terrain are skipped (not guessed).
    const CLEARANCE = kind === 'surface' ? 2.6 : 7;
    for (let guard = 0; guard < 80; guard++) {
      let worst = 0, wi = -1, wx = 0, wy = 0;
      for (let i = 0; i < anchors.length - 1; i++) {
        const p0 = anchors[i], p1 = anchors[i + 1];
        const span = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        if (span < 25) continue;
        const sag = this.sag(span, kind);
        const n = Math.min(60, Math.max(4, Math.floor(span / 8)));
        for (let k = 1; k < n; k++) {
          const t = k / n;
          const x = p0[0] + (p1[0] - p0[0]) * t, y = p0[1] + (p1[1] - p0[1]) * t;
          const g = this.realGround(x, y);
          if (Number.isNaN(g)) continue;
          const z = p0[2] + (p1[2] - p0[2]) * t - sag * 4 * t * (1 - t);
          const v = g + CLEARANCE - z;
          if (v > worst) { worst = v; wi = i; wx = x; wy = y; }
        }
      }
      if (wi < 0) break;
      const gz = this.realGround(wx, wy);
      anchors.splice(wi + 1, 0, [wx, wy, gz + towerH]);
      towers.push([wx, wy, gz, towerH]);
    }
    // tower meshes: mast (scaled), head, footing
    const masts = new THREE.InstancedMesh(this.geos.tower, this.mat, towers.length);
    const heads = new THREE.InstancedMesh(this.geos.head, this.mat, towers.length);
    const feet = new THREE.InstancedMesh(this.geos.footing, this.mat, towers.length);
    masts.name = 'towers'; heads.name = 'tower heads'; feet.name = 'tower footings';
    masts.castShadow = true; heads.castShadow = true;
    const headQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
    towers.forEach((t, i) => {
      this.p.set(t[0], t[2], -t[1]); this.q.identity(); this.s.set(1, t[3], 1); this.m.compose(this.p, this.q, this.s); masts.setMatrixAt(i, this.m);
      this.p.set(t[0], t[2] + t[3], -t[1]); this.s.set(1, 1, 1); this.m.compose(this.p, headQ, this.s); heads.setMatrixAt(i, this.m);
      this.p.set(t[0], t[2] - 0.3, -t[1]); this.m.compose(this.p, this.q, this.s); feet.setMatrixAt(i, this.m);
    });
    masts.instanceMatrix.needsUpdate = true; heads.instanceMatrix.needsUpdate = true; feet.instanceMatrix.needsUpdate = true;
    group.add(masts, heads, feet);
    // terminals: building at each station node, facing the line
    const termGeo = kind === 'gondola' ? this.geos.termGondola : kind === 'surface' ? this.geos.termSurface : this.geos.termChair;
    for (const [st, towardOther] of [[a, 1], [b, -1]] as const) {
      const term = new THREE.Mesh(termGeo, this.mat);
      term.name = towardOther === 1 ? 'terminal A' : 'terminal B';
      term.position.set(st[0], st[2], -st[1]);
      term.rotation.y = -yaw + (towardOther === 1 ? Math.PI : 0);
      term.castShadow = true; term.receiveShadow = true;
      group.add(term);
    }
    // cable path with catenary sag between anchors
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      const p0 = anchors[i], p1 = anchors[i + 1];
      const span = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const sag = this.sag(span, kind);
      const segs = Math.max(4, Math.min(12, Math.round(span / 20)));
      for (let k = 0; k < segs; k++) {
        const t = k / segs;
        const z = p0[2] + (p1[2] - p0[2]) * t - sag * 4 * t * (1 - t);
        pts.push(new THREE.Vector3(p0[0] + (p1[0] - p0[0]) * t, z, -(p0[1] + (p1[1] - p0[1]) * t)));
      }
    }
    const last = anchors[anchors.length - 1];
    pts.push(new THREE.Vector3(last[0], last[2], -last[1]));
    const lateralOff = kind === 'surface' ? 0.9 : 1.6;
    for (const side of [-1, 1]) {
      const offs = pts.map((v) => new THREE.Vector3(v.x + lx * lateralOff * side, v.y, v.z - ly * lateralOff * side));
      const cable = new THREE.Line(new THREE.BufferGeometry().setFromPoints(offs), this.cableMat);
      cable.name = side < 0 ? 'cable left' : 'cable right';
      cable.onBeforeRender = setCableViewport;
      group.add(cable);
    }
    // carriers
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const length = cum[cum.length - 1];
    const spacing = SPACING[kind];
    const nCarriers = Math.max(2, Math.floor((2 * length) / spacing));
    const seats = (lift.capacity ?? 2400) >= 3000 ? 6 : (lift.capacity ?? 2400) >= 1800 ? 4 : 2;
    const carrierGeo = kind === 'gondola' ? this.geos.gondola : kind === 'surface' ? (lift.type === 't-bar' ? this.geos.tbar : this.geos.platter) : seats === 6 ? this.geos.chair6 : seats === 4 ? this.geos.chair4 : this.geos.chair2;
    const carriers = new THREE.InstancedMesh(carrierGeo, this.mat, nCarriers);
    carriers.name = 'carriers';
    carriers.castShadow = true;
    group.add(carriers);
    const riderDrop = kind === 'gondola' ? 3.3 : kind === 'surface' ? 0 : SEAT_DROP;
    const towerUp = towers.map((t) => Math.hypot(t[0] - lo[0], t[1] - lo[1])).sort((p, q) => p - q);
    const rt: LiftRuntime = { feature: lift, kind, speed: SPEEDS[kind], riderDrop, curve: pts, cum, length, carriers, nCarriers, spacing, offset: Math.random() * spacing, lateral: [lx, ly], yaw, upFromA, bottom, top, towerUp };
    (rt as any).lateralOff = lateralOff;
    return { rt, group };
  }

  /** Rebuild lift i on the terrain loaded now; the runtime object keeps its identity (a ride in progress continues). */
  private rebuild(i: number, level: number): void {
    const old = this.liftGroups[i];
    this.group.remove(old);
    old.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      else if ((o as THREE.Line).isLine) (o as THREE.Line).geometry.dispose();
    });
    const rt = this.lifts[i];
    const offset = rt.offset;
    const { rt: fresh, group } = this.build(rt.feature);
    Object.assign(rt, fresh, { offset });
    this.liftGroups[i] = group;
    this.level[i] = level;
    this.group.add(group);
    this.placeMarker(rt);
  }

  /**
   * Called every frame: rebuild lifts as better terrain arrives. Level 1 once the mid set covers
   * the whole line; level 2 (1 m) for lifts whose bottom is within 400 m of the rider once the
   * fine tiles along the line are in.
   */
  maintain(dt: number, riderX: number, riderY: number): void {
    this.maintainAcc += dt;
    if (this.maintainAcc < 0.5) return;
    this.maintainAcc = 0;
    let rebuilt = 0;
    for (let i = 0; i < this.lifts.length && rebuilt < 2; i++) {
      const l = this.lifts[i].feature, st = l.stations;
      const xs = st.map((p) => p[0]), ys = st.map((p) => p[1]);
      const x0 = Math.min(...xs) - 30, x1 = Math.max(...xs) + 30, y0 = Math.min(...ys) - 30, y1 = Math.max(...ys) + 30;
      if (this.level[i] < 1 && this.pack.mid && this.pack.mid.request(x0, y0, x1, y1)) { this.rebuild(i, 1); rebuilt++; continue; }
      if (this.level[i] < 2 && this.pack.fine) {
        const b = this.lifts[i].bottom;
        if (Math.hypot(b[0] - riderX, b[1] - riderY) > 400) continue;
        if ((x1 - x0) * (y1 - y0) > 4e6) continue; // very long lines: mid level is enough
        if (this.pack.fine.request(x0, y0, x1, y1)) { this.rebuild(i, 2); rebuilt++; }
      }
    }
  }

  private sag(span: number, kind: LiftKind): number { return kind === 'surface' ? Math.min(1.2, span * 0.012) : Math.min(6, span * 0.025); }

  /** All lifts. */
  get all(): LiftRuntime[] { return this.lifts; }

  /** Floating markers above each loading point (chair glyph + name) and a ring on the snow. */
  readonly markers = new THREE.Group();
  private markerSprites: { sprite: THREE.Sprite; base: THREE.Vector3; lift: LiftRuntime; ring: THREE.Mesh }[] = [];
  private markersBuilt = false;
  buildMarkers(pack: Pack): void {
    if (this.markersBuilt) return;
    this.markersBuilt = true;
    const ringGeo = new THREE.RingGeometry(9, 11, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
    for (const l of this.lifts) {
      const [x, y] = l.bottom;
      const z = l.bottom[2];
      const tex = makeMarkerTexture(l.feature.name ?? 'Lift', l.kind);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: true });
      const sprite = new THREE.Sprite(mat);
      const base = new THREE.Vector3(x, z + 14, -y);
      sprite.position.copy(base);
      sprite.center.set(0.5, 0);
      sprite.renderOrder = 999;
      sprite.name = `marker ${l.feature.name ?? '(unnamed)'}`;
      this.markers.add(sprite);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.name = `marker ring ${l.feature.name ?? '(unnamed)'}`;
      this.markers.add(ring);
      this.markerSprites.push({ sprite, base, lift: l, ring });
      this.placeMarker(l);
    }
  }
  /** Put a lift's marker and ring on the current ground at its loading point. */
  private placeMarker(l: LiftRuntime): void {
    const m = this.markerSprites.find((e) => e.lift === l);
    if (!m) return;
    const [x, y] = l.bottom;
    const z = l.bottom[2];
    m.base.set(x, z + 14, -y);
    m.ring.position.set(x, z + 0.3, -y);
    const n = this.pack.groundNormal(x, y) as number[];
    m.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(n[0], n[2], -n[1]).normalize());
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
      const k = Math.min(60, Math.max(6, d * 0.06)) * (m.lift === boardable ? 1 + 0.12 * Math.sin(time * 6) : 1);
      m.sprite.scale.set(k * 2.4, k, 1);
      (m.sprite.material as THREE.SpriteMaterial).opacity = m.lift === boardable ? 1 : 0.85;
    }
  }

  /** Nearest lift whose loading point is within `maxDist` m of a point, or null. */
  nearestBoardable(x: number, y: number, maxDist = 14): LiftRuntime | null {
    let best: LiftRuntime | null = null, bd = maxDist;
    for (const l of this.lifts) {
      const d = Math.hypot(l.bottom[0] - x, l.bottom[1] - y);
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  }

  /** Rideable length between the loading and unloading points. */
  rideLength(l: LiftRuntime): number { return rideLength(l); }

  /** Rider position (pack coords) at distance `up` metres from the loading point along the line. */
  seatAt(l: LiftRuntime, up: number, out: Vec3): Vec3 {
    const p = this.seat; // three.js coords along the curve
    const dd = up + LOAD_OFFSET;
    const d = l.upFromA ? dd : l.length - dd;
    this.pointAt(l, Math.max(0, Math.min(l.length, d)), p);
    if (l.kind !== 'carpet') { // a carpet carries you on the belt
      const side = l.upFromA ? 1 : -1;
      const off = ((l as any).lateralOff as number) ?? 1.6;
      p.x += l.lateral[0] * off * side; p.z -= l.lateral[1] * off * side; p.y -= l.riderDrop;
    }
    out.x = p.x; out.y = -p.z; out.z = p.y;
    return out;
  }

  private pointAt(l: LiftRuntime, d: number, out: THREE.Vector3): THREE.Vector3 {
    const cum = l.cum;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    const t = (d - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
    return out.copy(l.curve[lo]).lerp(l.curve[hi], t);
  }

  /** Move the carriers. `hide`: the rider's own chair position; the line's carrier nearest it is hidden. */
  update(time: number, hide: THREE.Vector3 | null = null): void {
    for (const l of this.lifts) {
      if (!l.carriers) continue;
      let hideI = -1, hideD = 6;
      const [lx, ly] = l.lateral;
      const off = ((l as any).lateralOff as number) ?? 1.6;
      this.q.setFromAxisAngle(this.tmp2.set(0, 1, 0), -l.yaw);
      const loop = 2 * l.length;
      for (let i = 0; i < l.nCarriers; i++) {
        let d = (i * l.spacing + time * l.speed + l.offset) % loop;
        let side = 1;
        if (d > l.length) { d = loop - d; side = -1; } // returning side
        this.pointAt(l, d, this.tmp);
        this.p.set(this.tmp.x + lx * off * side, this.tmp.y, this.tmp.z - ly * off * side);
        if (hide) { const d = Math.hypot(this.p.x - hide.x, this.p.z - hide.z); if (d < hideD) { hideD = d; hideI = i; } }
        this.m.compose(this.p, this.q, this.s.set(1, 1, 1));
        l.carriers.setMatrixAt(i, this.m);
      }
      if (hideI >= 0) { this.m.makeScale(0, 0, 0); l.carriers.setMatrixAt(hideI, this.m); }
      l.carriers.instanceMatrix.needsUpdate = true;
    }
  }
}

/** Canvas texture: rounded label with a lift glyph and the name. */
function makeMarkerTexture(name: string, kind: LiftKind): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 214;
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 44px system-ui, sans-serif';
  const w = Math.min(500, ctx.measureText(name).width + 140);
  const x0 = (512 - w) / 2;
  ctx.fillStyle = 'rgba(20,24,34,.85)';
  ctx.beginPath(); ctx.roundRect(x0, 60, w, 90, 24); ctx.fill();
  ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 5; ctx.stroke();
  ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 8; ctx.lineCap = 'round';
  if (kind === 'gondola') { ctx.beginPath(); ctx.moveTo(x0 + 50, 70); ctx.lineTo(x0 + 50, 90); ctx.stroke(); ctx.strokeRect(x0 + 32, 90, 36, 40); }
  else if (kind === 'carpet') { ctx.beginPath(); ctx.moveTo(x0 + 26, 118); ctx.lineTo(x0 + 74, 100); ctx.stroke(); }
  else if (kind === 'surface') { ctx.beginPath(); ctx.moveTo(x0 + 50, 70); ctx.lineTo(x0 + 50, 120); ctx.stroke(); ctx.beginPath(); ctx.arc(x0 + 50, 126, 10, 0, Math.PI * 2); ctx.stroke(); }
  else { ctx.beginPath(); ctx.moveTo(x0 + 50, 72); ctx.lineTo(x0 + 50, 108); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x0 + 28, 108); ctx.lineTo(x0 + 72, 108); ctx.lineTo(x0 + 72, 130); ctx.stroke(); }
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
  ctx.fillText(name, x0 + 95, 106);
  ctx.fillStyle = '#ffd166';
  ctx.beginPath(); ctx.moveTo(236, 152); ctx.lineTo(276, 152); ctx.lineTo(256, 184); ctx.closePath(); ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
