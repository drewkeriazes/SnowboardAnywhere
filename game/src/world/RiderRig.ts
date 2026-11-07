import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RiderMaterials } from './RiderModel';

/**
 * Skeletal rider (FEAT-048): one bone hierarchy with Mixamo-style names, a smooth skinned body
 * (tubes along the bones with blended weights at the joints, so elbows and knees bend instead of
 * stacking boxes), and the board or skis as rigid meshes the feet are pinned to by two-bone IK.
 *
 * Bind pose: standing, facing -Z, arms hanging down (-Y), all bone rotations identity. Rider frame
 * (the `lean` group from RiderView): board nose -Z, up +Y; a snowboarder's chest faces +X.
 * Bone names follow Mixamo so a rigged glTF can later take over the mesh with the same solver.
 */

export const BONES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'] as const;
export type BoneName = typeof BONES[number];

const PARENT: Record<BoneName, BoneName | null> = {
  Hips: null, Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck',
  LeftArm: 'Spine2', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightArm: 'Spine2', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg',
};
/** Offsets from the parent in the bind pose (m). Pelvis to ankle 0.93 m; head top about 1.84 m. */
const OFFSET: Record<BoneName, [number, number, number]> = {
  Hips: [0, 1.0, 0], Spine: [0, 0.1, 0], Spine1: [0, 0.13, 0], Spine2: [0, 0.13, 0], Neck: [0, 0.17, 0], Head: [0, 0.08, 0],
  LeftArm: [-0.19, 0.13, 0], LeftForeArm: [0, -0.28, 0], LeftHand: [0, -0.26, 0],
  RightArm: [0.19, 0.13, 0], RightForeArm: [0, -0.28, 0], RightHand: [0, -0.26, 0],
  LeftUpLeg: [-0.1, -0.07, 0], LeftLeg: [0, -0.44, 0], LeftFoot: [0, -0.42, 0],
  RightUpLeg: [0.1, -0.07, 0], RightLeg: [0, -0.44, 0], RightFoot: [0, -0.42, 0],
};
const BI = (n: BoneName) => BONES.indexOf(n);
/** Ankle above the boot sole. */
export const ANKLE_H = 0.1;
/** boot sole centre ahead of the ankle along the boot (m) */
export const SOLE_FWD = 0.06;

export interface RiderRig {
  /** add to the lean group; holds the bones and the skinned meshes */
  body: THREE.Group;
  bones: Record<BoneName, THREE.Bone>;
  /** the board (or both skis) group, child of lean */
  board: THREE.Group;
  /** rigid parts the feet ride on: one snowboard, or one per ski. Rest transforms kept for unseating. */
  carriers: { obj: THREE.Object3D; rest: THREE.Matrix4 }[];
  /** ankle targets on the bindings (position and boot orientation), and the carrier each sits on */
  anchors: { l: THREE.Object3D; r: THREE.Object3D; lCarrier: number; rCarrier: number };
  /** meshes hidden in first person (head, torso) */
  headParts: THREE.Object3D[]; coreParts: THREE.Object3D[];
  /** ski pole grips (children of the hand bones); the shaft runs down local -Y */
  lPole?: THREE.Group; rPole?: THREE.Group;
  discipline: 'board' | 'ski';
  /** FEAT-118: the snowboard's bendable parts (deck strips and bindings); undefined for skis */
  flex?: BoardFlex;
}

/** FEAT-118: a bendable strip's rest vertices, and the bindings that ride the bend */
interface FlexMesh { geo: THREE.BufferGeometry; rest: Float32Array; restN: Float32Array }
interface BoardFlex { meshes: FlexMesh[]; bindings: { obj: THREE.Object3D; y: number; z: number; ang: number }[]; amount: number; dir: number }

/** FEAT-118: half the board's length (m), stations walked along it, the back (loaded) foot's place
 *  from the loaded end (t0, 0..1) and the nose (or tail) rise on a full load (m) */
const FLEX_HALF = 0.78, FLEX_N = 41, FLEX_T0 = 0.3, FLEX_RISE = 0.28;
const _bz = new Float32Array(FLEX_N), _by = new Float32Array(FLEX_N), _ba = new Float32Array(FLEX_N);
const _qx = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _ax = new THREE.Vector3(1, 0, 0), _ay = new THREE.Vector3(0, 1, 0);

/**
 * FEAT-118: a closed strip along the board (top, base, both edges) with one row of vertices per
 * station, so it can bend. Half-width w(z), from y0 to y1, over z in [z0, z1] (local -Z is the nose).
 */
function flexStrip(w: (z: number) => number, y0: number, y1: number, z0: number, z1: number, rows: number): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
  const face = (x0: number, ya: number, x1: number, yb: number, n: [number, number, number], flip: boolean): void => {
    const base = pos.length / 3;
    for (let i = 0; i < rows; i++) {
      const z = z0 + (z1 - z0) * i / (rows - 1), ww = w(z);
      pos.push(x0 * ww, ya, z, x1 * ww, yb, z); nrm.push(...n, ...n);
      if (i === 0) continue;
      const a = base + 2 * (i - 1), b = a + 1, c = a + 2, d = a + 3; // a,b at z_{i-1}; c,d at z_i
      if (flip) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
    }
  };
  face(-1, y1, 1, y1, [0, 1, 0], false); // top: -x then +x
  face(-1, y0, 1, y0, [0, -1, 0], true); // base
  face(1, y0, 1, y1, [1, 0, 0], true); // toe edge: bottom then top
  face(-1, y0, -1, y1, [-1, 0, 0], false); // heel edge
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.boundingSphere!.radius += FLEX_RISE + 0.05; // room for the bend
  return g;
}

/**
 * FEAT-118: bend the snowboard. `amount` 0 (flat) to 1 (full load), may dip a little below 0 on the
 * pop; `dir` -1 = loaded on the tail (nose up: ollie, tail press), +1 = loaded on the nose (tail up).
 * The loaded end stays flat on the snow up to the back foot (t0); past it the board rises as
 * u^3 (2 - u), which has zero height and zero slope at the foot (no kink) and steepens to the tip.
 * The curve is used as a bend angle walked along the board, so its length stays the same.
 */
export function bendBoard(rig: RiderRig, amount: number, dir: number): void {
  const fx = rig.flex;
  if (!fx) return;
  if (Math.abs(amount) < 1e-4) amount = 0;
  if (amount === fx.amount && (amount === 0 || dir === fx.dir)) return;
  fx.amount = amount; fx.dir = dir;
  const s = dir < 0 ? 1 : -1; // the loaded end's local z sign: tail (+z) for an ollie
  const len = 2 * FLEX_HALF, ds = len / (FLEX_N - 1);
  // walk from the loaded tip toward the other end; station i is the rest point z = s*(HALF - i*ds)
  let x = 0, y = 0;
  for (let i = 0; i < FLEX_N; i++) {
    const t = i / (FLEX_N - 1);
    let slope = 0;
    if (t > FLEX_T0) { const u = (t - FLEX_T0) / (1 - FLEX_T0); slope = amount * FLEX_RISE * (6 * u * u - 4 * u * u * u) / (1 - FLEX_T0) / len; }
    const th = Math.atan(slope);
    if (i > 0) { x += ds * Math.cos(th); y += ds * Math.sin(th); }
    _bz[i] = s * (FLEX_HALF - x); _by[i] = y; _ba[i] = th * s; // +angle about X lifts the nose (-z)
  }
  // a rest z -> its bent station (linear between stations)
  const at = (z: number): [number, number, number] => {
    const f = Math.max(0, Math.min(FLEX_N - 1, (FLEX_HALF - s * z) / ds)), i = Math.min(FLEX_N - 2, Math.floor(f)), k = f - i;
    return [_bz[i] + (_bz[i + 1] - _bz[i]) * k, _by[i] + (_by[i + 1] - _by[i]) * k, _ba[i] + (_ba[i + 1] - _ba[i]) * k];
  };
  for (const m of fx.meshes) {
    const P = m.geo.attributes.position as THREE.BufferAttribute, N = m.geo.attributes.normal as THREE.BufferAttribute;
    const p = P.array as Float32Array, n = N.array as Float32Array, r = m.rest, rn = m.restN;
    for (let v = 0; v < r.length; v += 3) {
      const [bz, by, a] = at(r[v + 2]), c = Math.cos(a), sn = Math.sin(a), h = r[v + 1];
      p[v] = r[v]; p[v + 1] = by + h * c; p[v + 2] = bz + h * sn;
      n[v] = rn[v]; n[v + 1] = rn[v + 1] * c - rn[v + 2] * sn; n[v + 2] = rn[v + 1] * sn + rn[v + 2] * c;
    }
    P.needsUpdate = true; N.needsUpdate = true;
  }
  for (const b of fx.bindings) {
    const [bz, by, a] = at(b.z);
    b.obj.position.set(0, by + b.y * Math.cos(a), bz + b.y * Math.sin(a));
    b.obj.quaternion.copy(_qx.setFromAxisAngle(_ax, a)).multiply(_qy.setFromAxisAngle(_ay, b.ang));
  }
}

type W = [BoneName, number][];
interface Ring { y: number; rx: number; rz: number; x?: number; z?: number; w: W }

/** Tube through rings stacked along Y (every bone segment is vertical in the bind pose). Weights
 *  and radii interpolate between rings; ends are capped. */
function tube(rings: Ring[], radial = 12, sub = 2): THREE.BufferGeometry {
  const pos: number[] = [], si: number[] = [], sw: number[] = [], idx: number[] = [];
  const pushW = (w: W) => {
    const m = new Map<number, number>();
    for (const [b, v] of w) m.set(BI(b), (m.get(BI(b)) ?? 0) + v);
    const e = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const s = e.reduce((t, [, v]) => t + v, 0) || 1;
    for (let k = 0; k < 4; k++) { si.push(e[k]?.[0] ?? 0); sw.push(e[k] ? e[k][1] / s : 0); }
  };
  const lerpW = (a: W, b: W, t: number): W => [...a.map(([n, v]) => [n, v * (1 - t)] as [BoneName, number]), ...b.map(([n, v]) => [n, v * t] as [BoneName, number])];
  const all: Ring[] = [];
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      all.push({ y: a.y + (b.y - a.y) * t, rx: a.rx + (b.rx - a.rx) * t, rz: a.rz + (b.rz - a.rz) * t, x: (a.x ?? 0) + ((b.x ?? 0) - (a.x ?? 0)) * t, z: (a.z ?? 0) + ((b.z ?? 0) - (a.z ?? 0)) * t, w: lerpW(a.w, b.w, t) });
    }
  }
  all.push(rings[rings.length - 1]);
  for (const r of all) for (let k = 0; k < radial; k++) {
    const a = (k / radial) * Math.PI * 2;
    pos.push((r.x ?? 0) + Math.cos(a) * r.rx, r.y, (r.z ?? 0) + Math.sin(a) * r.rz); pushW(r.w);
  }
  for (let i = 0; i < all.length - 1; i++) for (let k = 0; k < radial; k++) {
    const a = i * radial + k, b = i * radial + (k + 1) % radial, c = a + radial, d = b + radial;
    // rings run top to bottom or bottom to top; winding fixed below by the normal check
    idx.push(a, b, c, b, d, c);
  }
  for (const [ri, last] of [[0, false], [all.length - 1, true]] as const) {
    const r = all[ri], ci = pos.length / 3;
    pos.push(r.x ?? 0, r.y, r.z ?? 0); pushW(r.w);
    for (let k = 0; k < radial; k++) {
      const a = ri * radial + k, b = ri * radial + (k + 1) % radial;
      if (last) idx.push(ci, a, b); else idx.push(ci, b, a);
    }
  }
  // rings must go downward (y decreasing) for outward faces with this winding; flip otherwise
  if (all[0].y < all[all.length - 1].y) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A plain geometry moved to `at` (bind-pose position) and skinned fully to one bone. */
function rigid(g: THREE.BufferGeometry, bone: BoneName, at: [number, number, number], rotX = 0): THREE.BufferGeometry {
  if (rotX) g.rotateX(rotX);
  g.translate(at[0], at[1], at[2]);
  g.deleteAttribute('uv');
  const n = g.getAttribute('position').count;
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? BI(bone) : 0)), 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  return g;
}

const d2r = Math.PI / 180;

export function buildRig(mats: RiderMaterials, discipline: 'board' | 'ski'): RiderRig {
  const body = new THREE.Group(); body.name = 'rider body';
  const bones = {} as Record<BoneName, THREE.Bone>;
  for (const n of BONES) {
    const b = new THREE.Bone(); b.name = n; b.position.set(...OFFSET[n]); bones[n] = b;
    const p = PARENT[n];
    (p ? bones[p] : body).add(b);
  }
  bones.Hips.rotation.order = 'YXZ';
  body.updateMatrixWorld(true);
  const wp = (n: BoneName) => bones[n].getWorldPosition(new THREE.Vector3());
  const hip = wp('Hips').y, sp2 = wp('Spine2').y;

  // ---- skinned body, bucketed by first-person visibility and material
  const buckets = new Map<string, { part: 'head' | 'core' | 'limbs'; mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
  const put = (part: 'head' | 'core' | 'limbs', mat: THREE.Material, g: THREE.BufferGeometry) => {
    const k = `${part}:${mat.uuid}`;
    if (!buckets.has(k)) buckets.set(k, { part, mat, geos: [] });
    buckets.get(k)!.geos.push(g);
  };
  // pelvis and seat (pants), then the jacket from the hem to the collar
  put('core', mats.pants, tube([
    { y: hip + 0.06, rx: 0.16, rz: 0.11, w: [['Hips', 0.85], ['Spine', 0.15]] }, // BUG-038: waist tucked under the jacket, follows the pelvis
    { y: hip - 0.02, rx: 0.175, rz: 0.12, w: [['Hips', 1]] },
    { y: hip - 0.11, rx: 0.14, rz: 0.1, w: [['Hips', 1]] },
  ]));
  put('core', mats.jacket, tube([
    { y: sp2 + 0.19, rx: 0.07, rz: 0.07, w: [['Neck', 1]] },
    { y: sp2 + 0.15, rx: 0.15, rz: 0.095, w: [['Spine2', 0.7], ['Neck', 0.3]] },
    { y: sp2 + 0.09, rx: 0.2, rz: 0.12, w: [['Spine2', 1]] },
    { y: sp2, rx: 0.19, rz: 0.125, w: [['Spine2', 0.8], ['Spine1', 0.2]] },
    { y: sp2 - 0.11, rx: 0.175, rz: 0.12, w: [['Spine1', 0.6], ['Spine2', 0.4]] },
    { y: hip + 0.15, rx: 0.17, rz: 0.115, w: [['Spine', 0.7], ['Spine1', 0.3]] },
    { y: hip + 0.04, rx: 0.185, rz: 0.13, w: [['Hips', 0.6], ['Spine', 0.4]] },
    // BUG-038: the hem hangs past the pants' waist on the pelvis, a little wider than the seat, so the
    // pants never show between them when the spine bends forward in a tuck
    { y: hip - 0.05, rx: 0.19, rz: 0.135, w: [['Hips', 1]] },
  ]));
  // neck and head
  const head = wp('Head');
  put('head', mats.skin, tube([
    { y: head.y + 0.04, rx: 0.055, rz: 0.055, w: [['Head', 1]] },
    { y: head.y - 0.1, rx: 0.06, rz: 0.06, w: [['Neck', 1]] },
  ], 8, 1));
  put('head', mats.skin, rigid(new THREE.SphereGeometry(0.11, 14, 10), 'Head', [0, head.y + 0.1, -0.01]));
  put('head', mats.helmet, rigid(new THREE.SphereGeometry(0.128, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), 'Head', [0, head.y + 0.115, 0]));
  put('head', mats.goggles, rigid(new THREE.BoxGeometry(0.2, 0.065, 0.06), 'Head', [0, head.y + 0.11, -0.1]));
  // arms: sleeve from inside the shoulder to the cuff, mitten on the hand
  for (const s of ['Left', 'Right'] as const) {
    const A = `${s}Arm` as BoneName, F = `${s}ForeArm` as BoneName, H = `${s}Hand` as BoneName;
    const a = wp(A), f = wp(F), h = wp(H), x = a.x;
    put('limbs', mats.jacket, tube([
      { x, y: a.y + 0.05, rx: 0.06, rz: 0.06, w: [['Spine2', 1]] },
      { x, y: a.y - 0.01, rx: 0.07, rz: 0.068, w: [['Spine2', 0.45], [A, 0.55]] },
      { x, y: a.y - 0.1, rx: 0.062, rz: 0.06, w: [[A, 1]] },
      { x, y: f.y + 0.04, rx: 0.055, rz: 0.055, w: [[A, 1]] },
      { x, y: f.y, rx: 0.053, rz: 0.053, w: [[A, 0.5], [F, 0.5]] },
      { x, y: f.y - 0.05, rx: 0.052, rz: 0.052, w: [[F, 1]] },
      { x, y: h.y + 0.02, rx: 0.048, rz: 0.048, w: [[F, 0.8], [H, 0.2]] },
    ]));
    put('limbs', mats.gloves, tube([
      { x, y: h.y + 0.03, rx: 0.045, rz: 0.042, w: [[F, 0.3], [H, 0.7]] },
      { x, y: h.y - 0.03, rx: 0.05, rz: 0.035, w: [[H, 1]] },
      { x, y: h.y - 0.09, rx: 0.045, rz: 0.03, w: [[H, 1]] },
      { x, y: h.y - 0.12, rx: 0.028, rz: 0.02, w: [[H, 1]] },
    ], 10, 1));
  }
  // legs: baggy pants from inside the pelvis to the boot cuff; boots rigid on the feet
  for (const s of ['Left', 'Right'] as const) {
    const U = `${s}UpLeg` as BoneName, L = `${s}Leg` as BoneName, Ft = `${s}Foot` as BoneName;
    const u = wp(U), k = wp(L), an = wp(Ft), x = u.x;
    put('limbs', mats.pants, tube([
      { x, y: u.y + 0.07, rx: 0.09, rz: 0.09, w: [['Hips', 1]] },
      { x, y: u.y, rx: 0.098, rz: 0.098, w: [['Hips', 0.45], [U, 0.55]] },
      { x, y: u.y - 0.12, rx: 0.092, rz: 0.092, w: [[U, 1]] },
      { x, y: k.y + 0.1, rx: 0.077, rz: 0.077, w: [[U, 1]] },
      { x, y: k.y, rx: 0.072, rz: 0.074, w: [[U, 0.5], [L, 0.5]] },
      { x, y: k.y - 0.09, rx: 0.075, rz: 0.075, w: [[L, 1]] },
      { x, y: an.y + 0.16, rx: 0.074, rz: 0.074, w: [[L, 1]] },
      { x, y: an.y + 0.08, rx: 0.078, rz: 0.078, w: [[L, 0.6], [Ft, 0.4]] },
    ]));
    // boot: sole ANKLE_H under the ankle, toe toward -Z
    put('limbs', mats.boots, rigid(new THREE.BoxGeometry(0.13, 0.12, 0.3), Ft, [x, an.y - ANKLE_H + 0.06, -0.06]));
    put('limbs', mats.boots, rigid(new THREE.CylinderGeometry(0.075, 0.07, 0.14, 10), Ft, [x, an.y + 0.04, 0.005]));
  }
  const skel = new THREE.Skeleton(BONES.map((n) => bones[n]));
  const headParts: THREE.Object3D[] = [], coreParts: THREE.Object3D[] = [];
  for (const b of buckets.values()) {
    const g = mergeGeometries(b.geos, false)!;
    const m = new THREE.SkinnedMesh(g, b.mat);
    m.name = `body ${b.part} ${Object.entries(mats).find(([, v]) => v === b.mat)?.[0] ?? 'mesh'}`; // e.g. 'body limbs gloves'
    m.castShadow = true; m.frustumCulled = false;
    body.add(m);
    m.bind(skel);
    if (b.part === 'head') headParts.push(m); else if (b.part === 'core') coreParts.push(m);
  }

  // ---- board or skis (rigid), with ankle anchors on the bindings
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, name = ''): THREE.Mesh => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = true; o.name = name; return o; };
  const board = new THREE.Group(); board.name = discipline === 'board' ? 'snowboard' : 'skis';
  const carriers: RiderRig['carriers'] = [];
  let anchors: RiderRig['anchors'];
  let flex: BoardFlex | undefined;
  if (discipline === 'board') {
    const deck = new THREE.Group(); deck.name = 'deck'; board.add(deck);
    // FEAT-118: built as bendable strips (a row of vertices every 4 cm) instead of a rigid extrusion.
    // Outline: 0.13 m half-width at the nose tapering to 0.92 of that at the tail, rounded tips.
    const L = FLEX_HALF, Wd = 0.13, tip = 0.12;
    const outline = (z: number): number => {
      const w = Wd * (1 - 0.08 * Math.max(0, Math.min(1, (z + L - tip) / (2 * (L - tip)))));
      const e = Math.abs(z) - (L - tip);
      return e <= 0 ? w : w * Math.sqrt(Math.max(0, 1 - (e / tip) * (e / tip)));
    };
    const flexMeshes: FlexMesh[] = [];
    const strip = (g: THREE.BufferGeometry, m: THREE.Material, name: string): THREE.Mesh => {
      const o = mesh(g, m, 0, 0, 0, name);
      flexMeshes.push({ geo: g, rest: (g.attributes.position.array as Float32Array).slice(), restN: (g.attributes.normal.array as Float32Array).slice() });
      deck.add(o); return o;
    };
    strip(flexStrip(outline, 0, 0.022, -L, L, FLEX_N), mats.board, 'board base').receiveShadow = true;
    strip(flexStrip(() => 0.03, 0.022, 0.026, -0.65, 0.65, 34), mats.jacket, 'topsheet stripe');
    const flexBindings: BoardFlex['bindings'] = [];
    // bindings across the board, highback on the heel edge (-X); duck stance front +15, back -6.
    // Front (nose, -Z) is the left foot in a regular stance.
    const an: THREE.Object3D[] = [];
    for (const [z, ang, which] of [[-0.28, 15, 'front'], [0.3, -6, 'back']] as const) {
      const b = new THREE.Group(); b.name = `binding ${which}`; b.position.set(0, 0.025, z); b.rotation.y = ang * d2r;
      b.add(mesh(new THREE.BoxGeometry(0.3, 0.02, 0.2), mats.boots, 0, 0, 0, 'baseplate')); // top at 0.035
      b.add(mesh(new THREE.BoxGeometry(0.03, 0.26, 0.2), mats.boots, -0.13, 0.13, 0, 'highback'));
      b.add(mesh(new THREE.BoxGeometry(0.2, 0.04, 0.03), mats.boots, 0.02, 0.1, -0.07, 'toe strap'));
      b.add(mesh(new THREE.BoxGeometry(0.2, 0.04, 0.03), mats.boots, 0.02, 0.1, 0.07, 'ankle strap'));
      // ankle above the baseplate; the boot's toe (-Z in the bind pose) turned to the toe edge (+X)
      const a = new THREE.Object3D(); a.name = `ankle anchor ${which}`; a.position.set(-0.04, 0.01 + ANKLE_H, 0); a.rotation.y = -Math.PI / 2; b.add(a);
      deck.add(b); an.push(a);
      flexBindings.push({ obj: b, y: 0.025, z, ang: ang * d2r });
    }
    carriers.push({ obj: deck, rest: deck.matrix.clone() });
    anchors = { l: an[0], r: an[1], lCarrier: 0, rCarrier: 0 };
    flex = { meshes: flexMeshes, bindings: flexBindings, amount: 0, dir: -1 };
  } else {
    const skiShape = new THREE.Shape();
    const sl = 0.85, sw = 0.05;
    skiShape.moveTo(-sw, -sl + 0.1); skiShape.quadraticCurveTo(-sw, -sl, 0, -sl); skiShape.quadraticCurveTo(sw, -sl, sw, -sl + 0.1); skiShape.lineTo(sw, sl); skiShape.lineTo(-sw, sl); skiShape.lineTo(-sw, -sl + 0.1);
    const sg = new THREE.ExtrudeGeometry(skiShape, { depth: 0.015, bevelEnabled: false });
    sg.rotateX(-Math.PI / 2);
    const an: THREE.Object3D[] = [];
    for (const x of [-0.12, 0.12]) {
      const side = x < 0 ? 'left' : 'right';
      const ski = new THREE.Group(); ski.name = `ski ${side}`; ski.position.set(x, 0, 0); board.add(ski);
      const sm = mesh(sg, mats.board, 0, 0, 0, `ski base ${side}`); sm.receiveShadow = true; ski.add(sm);
      ski.add(mesh(new THREE.BoxGeometry(0.09, 0.05, 0.32), mats.boots, 0, 0.03, 0.05, `binding ${side}`)); // top at 0.055
      const a = new THREE.Object3D(); a.name = `ankle anchor ${side}`; a.position.set(0, 0.055 + ANKLE_H, 0.11); ski.add(a);
      ski.updateMatrix();
      carriers.push({ obj: ski, rest: ski.matrix.clone() });
      an.push(a);
    }
    anchors = { l: an[0], r: an[1], lCarrier: 0, rCarrier: 1 };
  }

  let lPole: THREE.Group | undefined, rPole: THREE.Group | undefined;
  if (discipline === 'ski') {
    const pole = (hand: THREE.Bone, side: string): THREE.Group => {
      const grip = new THREE.Group(); grip.name = `pole ${side}`; grip.position.set(0, -0.06, 0); hand.add(grip);
      grip.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, 1.15, 5), mats.helmet, 0, -0.55, 0, `pole shaft ${side}`));
      const basket = mesh(new THREE.TorusGeometry(0.05, 0.008, 5, 10), mats.boots, 0, -1.03, 0, `pole basket ${side}`);
      basket.rotation.x = Math.PI / 2; grip.add(basket);
      return grip;
    };
    lPole = pole(bones.LeftHand, 'left'); rPole = pole(bones.RightHand, 'right');
  }
  return { body, bones, board, carriers, anchors, headParts, coreParts, lPole, rPole, discipline, flex };
}

// ---------------------------------------------------------------- IK

const _v = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new THREE.Vector3());
const _q = [0, 1, 2, 3].map(() => new THREE.Quaternion());
const _m = new THREE.Matrix4();

/** Set a bone's local rotation so its world rotation becomes `qw`. */
export function setWorldQuat(bone: THREE.Object3D, qw: THREE.Quaternion): void {
  const pq = bone.parent ? bone.parent.getWorldQuaternion(_q[3]) : _q[3].identity();
  bone.quaternion.copy(pq.invert().multiply(qw));
  bone.updateMatrixWorld(true);
}

/**
 * Analytic two-bone IK in world space. `upper` and `lower` hang along their local -Y in the bind
 * pose (lengths are the child offsets). The middle joint (knee, elbow) is placed toward `pole`.
 * Returns the distance left between the end joint and the target (0 when reachable).
 */
export function twoBone(upper: THREE.Bone, lower: THREE.Bone, end: THREE.Bone, target: THREE.Vector3, pole: THREE.Vector3): number {
  const a = lower.position.length(), b = end.position.length();
  const H = upper.getWorldPosition(_v[0]);
  const d = _v[1].subVectors(target, H);
  const dist = d.length();
  const c = Math.min(Math.max(dist, Math.abs(a - b) + 0.02), a + b - 1e-4);
  const dn = dist > 1e-6 ? d.multiplyScalar(1 / dist) : d.set(0, -1, 0);
  const cosA = THREE.MathUtils.clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  const p = _v[2].copy(pole).addScaledVector(dn, -pole.dot(dn));
  if (p.lengthSq() < 1e-8) p.set(1, 0, 0).addScaledVector(dn, -dn.x);
  p.normalize();
  const K = _v[3].copy(H).addScaledVector(dn, a * cosA).addScaledVector(p, a * sinA);
  const E = _v[4].copy(H).addScaledVector(dn, c);
  // upper: +Y from the knee up to the hip, -Z toward the pole (the knee's front)
  const y = _v[5].subVectors(H, K).normalize();
  const z = _v[6].copy(p).addScaledVector(y, -p.dot(y)).negate().normalize();
  const x = _v[7].crossVectors(y, z);
  _m.makeBasis(x, y, z);
  const qu = _q[0].setFromRotationMatrix(_m);
  setWorldQuat(upper, qu);
  // lower: same hinge axis x, +Y from the end up to the knee
  y.subVectors(K, E).normalize();
  z.crossVectors(x, y);
  _m.makeBasis(x, y, z);
  setWorldQuat(lower, _q[1].setFromRotationMatrix(_m));
  return E.distanceTo(target);
}

const _H = new THREE.Vector3(), _T = new THREE.Vector3(), _D = new THREE.Vector3(), _best = new THREE.Vector3();

const _ta = [new THREE.Vector3(), new THREE.Vector3()];
const _qa = [new THREE.Quaternion(), new THREE.Quaternion()];

/**
 * Pin both feet to the binding anchors. First the pelvis is nudged (fewest centimetres) until both
 * ankles are within reach, then each leg is solved and the foot takes the binding's orientation.
 * `poles` are world directions the knees point. Returns the worst ankle-to-binding gap in metres.
 */
export function pinFeet(rig: RiderRig, lPole: THREE.Vector3, rPole: THREE.Vector3): number {
  rig.body.parent?.updateMatrixWorld(true);
  rig.board.updateMatrixWorld(true);
  rig.anchors.l.getWorldPosition(_ta[0]); rig.anchors.r.getWorldPosition(_ta[1]);
  rig.anchors.l.getWorldQuaternion(_qa[0]); rig.anchors.r.getWorldQuaternion(_qa[1]);
  return solveLegs(rig, _ta[0], _ta[1], _qa[0], _qa[1], lPole, rPole);
}

/**
 * Put both ankles on world targets with the given foot orientations (walking, stepping on and off
 * the board). The pelvis is nudged first if a target is out of reach. Returns the worst gap (m).
 */
export function solveLegs(rig: RiderRig, lAnkle: THREE.Vector3, rAnkle: THREE.Vector3, lQ: THREE.Quaternion, rQ: THREE.Quaternion, lPole: THREE.Vector3, rPole: THREE.Vector3, maxNudge = Infinity): number {
  const B = rig.bones;
  const legs = [[B.LeftUpLeg, B.LeftLeg, B.LeftFoot, lAnkle, lQ, lPole], [B.RightUpLeg, B.RightLeg, B.RightFoot, rAnkle, rQ, rPole]] as const;
  const reach = B.LeftLeg.position.length() + B.LeftFoot.position.length();
  const cMax = reach * 0.985, cMin = 0.3;
  rig.body.parent?.updateMatrixWorld(true);
  let nudged = 0;
  for (let it = 0; it < 6; it++) {
    let worst = 0;
    for (const [up, , , target] of legs) {
      up.getWorldPosition(_H);
      const dist = _D.subVectors(target, _H).length();
      const over = dist > cMax ? dist - cMax : dist < cMin ? dist - cMin : 0; // >0 move toward, <0 away
      if (Math.abs(over) > Math.abs(worst)) { worst = over; _best.copy(_D).normalize().multiplyScalar(over); }
    }
    if (Math.abs(worst) < 1e-4 || nudged >= maxNudge) break;
    // never move the pelvis more than maxNudge in all (walking: a foot left out of reach is a gap, not a collapse)
    const len = _best.length();
    if (nudged + len > maxNudge) _best.multiplyScalar((maxNudge - nudged) / len);
    nudged += _best.length();
    // world shift to the pelvis's parent frame (no scale anywhere in the rider)
    const hips = B.Hips;
    const pq = hips.parent!.getWorldQuaternion(_q[2]).invert();
    hips.position.add(_best.applyQuaternion(pq));
    hips.updateMatrixWorld(true);
  }
  let gap = 0;
  for (const [up, lo, foot, target, q, pole] of legs) {
    _T.copy(target);
    gap = Math.max(gap, twoBone(up, lo, foot, _T, pole));
    setWorldQuat(foot, q);
  }
  return gap;
}

/** Seated: the feet are posed by FK, so hang each carrier from its foot (the board from the front
 *  foot, each ski from its own boot). */
export function hangCarriersFromFeet(rig: RiderRig): void {
  const B = rig.bones;
  rig.body.parent?.updateMatrixWorld(true);
  const done = new Set<number>();
  for (const [foot, anchor, ci] of [[B.LeftFoot, rig.anchors.l, rig.anchors.lCarrier], [B.RightFoot, rig.anchors.r, rig.anchors.rCarrier]] as const) {
    if (done.has(ci)) continue;
    done.add(ci);
    const c = rig.carriers[ci].obj;
    // anchor relative to its carrier, then carrier world = foot world * inverse(that)
    c.updateMatrixWorld(true);
    const rel = _m.copy(c.matrixWorld).invert().multiply(anchor.matrixWorld);
    const want = new THREE.Matrix4().copy(foot.matrixWorld).multiply(rel.invert());
    const local = new THREE.Matrix4().copy(c.parent!.matrixWorld).invert().multiply(want);
    local.decompose(c.position, c.quaternion, c.scale);
    c.updateMatrixWorld(true);
  }
}

export function restCarriers(rig: RiderRig): void {
  for (const c of rig.carriers) c.rest.decompose(c.obj.position, c.obj.quaternion, c.obj.scale);
}
