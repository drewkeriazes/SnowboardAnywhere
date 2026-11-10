import * as THREE from 'three';
import { SPECIES, CELL, type Species } from './species';
import { cellRect, barkRect, type UvRect } from './textures';

/**
 * FEAT-156: tree geometry per species, variant and LOD. Every tree is built at unit height with its
 * natural proportions, from a seeded plan (whorls, clumps, stems) that both LODs share so their
 * silhouettes match, then normalised so the crown radius is 1: the instance matrix scales x and z by
 * the crown radius in metres and y by the height. Vertex colours carry the species colour (divided by
 * the atlas cell's mean, so texture times colour lands on the target) and a baked ambient occlusion.
 *
 * LOD0: tapered trunk + alpha-tested branch cards (2 segments, bent down), normals bent outward from
 *       the trunk so the crown shades as one volume.
 * LOD1: trunk + stacked star-edged cones or blobs (opaque, the dense foliage cell), the same bent
 *       normals; aspen keeps a few twig cards, which have nothing solid to stand in for them.
 */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** accumulates one mesh; positions in the unit-height tree frame (natural radius) */
class Builder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];
  /** the crown's reference for the bent normals: radius and the height of its centre */
  normR = 0.15;
  normY = 0.5;
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: THREE.Color, ao: number): number {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.pos.push(x, y, z); this.nor.push(nx / l, ny / l, nz / l); this.uv.push(u, v); this.col.push(c.r * ao, c.g * ao, c.b * ao);
    return this.pos.length / 3 - 1;
  }
  /** the soft crown normal: outward from the trunk, tilted up, the same for both LODs */
  bent(x: number, y: number, z: number): [number, number, number] {
    const r = this.normR;
    return [x / r, 0.55 + 0.35 * (y - this.normY) / Math.max(0.2, 1 - this.normY), z / r];
  }
  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }
  get triangles(): number { return this.idx.length / 3; }

  build(radius: number): THREE.BufferGeometry {
    // normalise: crown radius 1 (x, z divided by the natural radius); normals by the inverse transpose
    const p = new Float32Array(this.pos), n = new Float32Array(this.nor);
    let top = 0;
    for (let i = 1; i < p.length; i += 3) top = Math.max(top, p[i]);
    top = top || 1; // and height 1 at the highest point
    for (let i = 0; i < p.length; i += 3) {
      p[i] /= radius; p[i + 1] /= top; p[i + 2] /= radius;
      const nx = n[i] * radius, ny = n[i + 1] * top, nz = n[i + 2] * radius, l = Math.hypot(nx, ny, nz) || 1;
      n[i] = nx / l; n[i + 1] = ny / l; n[i + 2] = nz / l;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

interface Pt { x: number; y: number; z: number; r: number }

/** a tapered tube along a polyline; each segment maps the bark swatch once (it tiles up the trunk) */
function tube(b: Builder, path: Pt[], sides: number, uv: UvRect, c: THREE.Color, ao: (y: number) => number, _segs = 1, close = false): void {
  for (let s = 0; s < path.length - 1; s++) {
    const p0 = path[s], p1 = path[s + 1];
    const ax = p1.x - p0.x, ay = p1.y - p0.y, az = p1.z - p0.z, al = Math.hypot(ax, ay, az) || 1;
    const dx = ax / al, dy = ay / al, dz = az / al;
    // a frame around the segment
    let ux = 0, uy = 0, uz = 1;
    if (Math.abs(dz) > 0.9) { ux = 1; uz = 0; }
    let px = dy * uz - dz * uy, py = dz * ux - dx * uz, pz = dx * uy - dy * ux; // d x u
    const pl = Math.hypot(px, py, pz); px /= pl; py /= pl; pz /= pl;
    const qx = dy * pz - dz * py, qy = dz * px - dx * pz, qz = dx * py - dy * px; // d x p
    const base = b.pos.length / 3;
    for (let ring = 0; ring < 2; ring++) {
      const p = ring ? p1 : p0;
      for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const nx = px * ca + qx * sa, ny = py * ca + qy * sa, nz = pz * ca + qz * sa;
        b.vert(p.x + nx * p.r, p.y + ny * p.r, p.z + nz * p.r, nx, ny, nz, lerp(uv.u0, uv.u1, i / sides), ring ? uv.v1 : uv.v0, c, ao(p.y));
      }
    }
    for (let i = 0; i < sides; i++) {
      const a = base + i, bb = base + i + 1, c0 = base + sides + 1 + i, d = base + sides + 2 + i;
      b.tri(a, c0, bb); b.tri(bb, c0, d);
    }
  }
  if (close) { // a point cap at the end (a broken or pointed top)
    const e = path[path.length - 1];
    const tip = b.vert(e.x, e.y + e.r * 1.5, e.z, 0, 1, 0, (uv.u0 + uv.u1) / 2, uv.v1, c, ao(e.y));
    const ring0 = b.pos.length / 3 - 1 - (sides + 1);
    for (let i = 0; i < sides; i++) b.tri(ring0 + i, ring0 + i + 1, tip);
  }
}

/**
 * A branch card: from `o` along `dir` for `len`, `width` across, rolled `roll` about its own axis; the
 * outer half bends down by `bend`. 6 vertices, 4 triangles (2 when `single`).
 */
function card(b: Builder, o: THREE.Vector3, dir: THREE.Vector3, len: number, width: number, roll: number, bend: number, uv: UvRect, c: THREE.Color, ao: (x: number, y: number, z: number, t: number) => number, single = false, flipV = false): void {
  const d = dir.clone().normalize();
  // the across vector: horizontal, perpendicular to the branch, then rolled about it
  let side = new THREE.Vector3(-d.z, 0, d.x);
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize().applyAxisAngle(d, roll);
  const down = new THREE.Vector3().crossVectors(side, d).normalize(); // card normal-ish
  if (down.y > 0) down.negate();
  const segs = single ? 1 : 2;
  const pts: THREE.Vector3[] = [o.clone()];
  let cur = o.clone(), cd = d.clone();
  for (let s = 0; s < segs; s++) {
    if (s === 1) cd = cd.clone().multiplyScalar(Math.cos(bend)).addScaledVector(down, Math.sin(bend)).normalize();
    cur = cur.clone().addScaledVector(cd, len / segs);
    pts.push(cur);
  }
  const base = b.pos.length / 3;
  for (let s = 0; s <= segs; s++) {
    const t = s / segs, w = width * (s === 0 ? 0.55 : 1) * 0.5;
    for (let k = 0; k < 2; k++) {
      const sgn = k ? 1 : -1;
      const p = pts[s].clone().addScaledVector(side, sgn * w);
      const [nx, ny, nz] = b.bent(p.x, p.y, p.z);
      const u = lerp(uv.u0, uv.u1, t), v = flipV ? lerp(uv.v1, uv.v0, k) : lerp(uv.v0, uv.v1, k);
      b.vert(p.x, p.y, p.z, nx, ny, nz, u, v, c, ao(p.x, p.y, p.z, t));
    }
  }
  for (let s = 0; s < segs; s++) {
    const a = base + s * 2;
    b.tri(a, a + 1, a + 2); b.tri(a + 1, a + 3, a + 2);
  }
}

/** a star-edged cone (LOD1 tier): `points` tips drooping by `droop`, apex at `top`, a concave underside */
function starCone(b: Builder, y0: number, top: number, r: number, points: number, rot: number, droop: number, uv: UvRect, c: THREE.Color, aoLo: number, cx = 0, cz = 0, under = 0.25): void {
  const n = points * 2;
  const apex = b.pos.length / 3;
  const [anx, any, anz] = b.bent(cx, top, cz);
  b.vert(cx, top, cz, anx, any, anz, (uv.u0 + uv.u1) / 2, uv.v1, c, 1);
  const ring = b.pos.length / 3;
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2, rr = i % 2 ? r * 0.7 : r, yy = y0 - (i % 2 ? 0 : droop * r);
    const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
    const [nx, ny, nz] = b.bent(x, yy, z);
    b.vert(x, yy, z, nx, ny, nz, lerp(uv.u0, uv.u1, i / n), uv.v0, c, aoLo);
  }
  const hub = b.pos.length / 3;
  b.vert(cx, y0 + (top - y0) * under, cz, 0, -1, 0, (uv.u0 + uv.u1) / 2, (uv.v0 + uv.v1) / 2, c, aoLo * 0.6);
  for (let i = 0; i < n; i++) {
    const a = ring + i, bb = ring + ((i + 1) % n);
    b.tri(apex, bb, a); b.tri(hub, a, bb);
  }
}

/** a blob (LOD1 clump): a star ring with an apex above and below */
function blob(b: Builder, cx: number, cy: number, cz: number, r: number, hUp: number, hDown: number, points: number, rot: number, uv: UvRect, c: THREE.Color): void {
  const n = points * 2;
  const top = b.pos.length / 3;
  const [tnx, tny, tnz] = b.bent(cx, cy + hUp, cz);
  b.vert(cx, cy + hUp, cz, tnx, tny, tnz, (uv.u0 + uv.u1) / 2, uv.v1, c, 1);
  const ring = b.pos.length / 3;
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2, rr = i % 2 ? r * 0.75 : r;
    const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr, y = cy - (i % 2 ? 0 : 0.15 * hDown);
    const [nx, ny, nz] = b.bent(x, y, z);
    b.vert(x, y, z, nx, ny, nz, lerp(uv.u0, uv.u1, i / n), (uv.v0 + uv.v1) / 2, c, 0.85);
  }
  const bot = b.pos.length / 3;
  b.vert(cx, cy - hDown, cz, 0, -1, 0, (uv.u0 + uv.u1) / 2, uv.v0, c, 0.55);
  for (let i = 0; i < n; i++) {
    const a = ring + i, bb = ring + ((i + 1) % n);
    b.tri(top, bb, a); b.tri(bot, a, bb);
  }
}

/** colours: the species tint (linear) divided by the atlas cell's mean, varied per variant */
interface Tints { needle: THREE.Color; needleDense: THREE.Color; bark: THREE.Color }
function tints(sp: Species, variant: number, cellMean: number[], barkMean: number[], r: () => number): Tints {
  const needle = new THREE.Color(sp.needles[0]).lerp(new THREE.Color(sp.needles[1]), clamp01(variant / 3 * 0.8 + r() * 0.2));
  const k = 1 + (r() - 0.5) * 0.08;
  needle.multiplyScalar(k);
  const cm = cellMean[sp.cells[0]] || 0.5, dm = cellMean[CELL.dense] || 0.5, bm = barkMean[sp.barkSwatch] || 0.5;
  return {
    needle: needle.clone().multiplyScalar(1 / cm),
    needleDense: needle.clone().multiplyScalar(1 / dm),
    bark: new THREE.Color(sp.bark).multiplyScalar(1 / bm),
  };
}

// ---------------------------------------------------------------- plans

interface Whorl { y: number; r: number; rot: number; cards: number }
interface Clump { x: number; y: number; z: number; r: number }
interface Stem { pts: Pt[] }
interface Plan {
  sp: Species;
  variant: number;
  lean: number; leanAz: number;
  whorls: Whorl[];
  clumps: Clump[];
  stems: Stem[];
  /** top of the foliage and of the trunk */
  crownTop: number; trunkTop: number;
  top: 'leader' | 'double' | 'broken' | 'none';
  stubs: { y: number; az: number; len: number }[];
  seed: number;
}

/** the crown radius profile (share of the max) at t = 0 (crown base) .. 1 (top) */
function profile(form: Species['form'], t: number): number {
  switch (form) {
    case 'spruce': return t < 0.15 ? 0.86 + 0.14 * t / 0.15 : Math.pow(1 - (t - 0.15) / 0.85, 0.92);
    case 'fir': return t < 0.06 ? 0.9 + 0.1 * t / 0.06 : Math.pow(1 - (t - 0.06) / 0.94, 1.12);
    case 'douglas': return t < 0.12 ? 0.85 + 0.15 * t / 0.12 : Math.pow(1 - (t - 0.12) / 0.88, 0.8);
    case 'lodgepole': return Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.95)), 0.7);
    default: return 1 - t;
  }
}

function makePlan(sp: Species, variant: number): Plan {
  const seed = sp.id * 1000 + variant * 17 + 5;
  const r = rng(seed);
  const plan: Plan = { sp, variant, lean: (r() * 4) * Math.PI / 180, leanAz: r() * Math.PI * 2, whorls: [], clumps: [], stems: [], crownTop: 0.97, trunkTop: 0.97, top: 'none', stubs: [], seed };
  const R = sp.radius;
  const form = sp.form;
  if (form === 'spruce' || form === 'fir' || form === 'douglas' || form === 'lodgepole') {
    plan.top = 'leader';
    if (variant === 3 && (form === 'spruce' || form === 'fir')) plan.top = r() < 0.5 ? 'double' : 'broken';
    if (plan.top === 'broken') { plan.crownTop = 0.86; plan.trunkTop = 0.9; }
    const n = Math.round(lerp(sp.whorls[0], sp.whorls[1], (variant + r()) / 4));
    const y0 = sp.crownBase + (form === 'lodgepole' ? (r() - 0.5) * 0.06 : 0), y1 = plan.crownTop - (plan.top === 'broken' ? 0 : 0.03);
    for (let i = 0; i < n; i++) {
      if (i > 1 && i < n - 2 && r() < 0.08 + 0.04 * variant) continue; // an irregular gap
      const t = (i + 0.3 + (r() - 0.5) * 0.5) / n;
      const y = lerp(y0, y1, t);
      const rr = R * profile(form, clamp01(t)) * (0.88 + 0.24 * r());
      plan.whorls.push({ y, r: Math.max(R * 0.12, rr), rot: r() * Math.PI * 2, cards: Math.round(lerp(sp.cards[0], sp.cards[1], r())) });
    }
    if (form === 'lodgepole') for (let i = 0, k = 2 + Math.floor(r() * 3); i < k; i++) plan.stubs.push({ y: lerp(0.25, sp.crownBase - 0.04, r()), az: r() * Math.PI * 2, len: R * (0.3 + 0.3 * r()) });
  } else if (form === 'limber') {
    const nStems = 2 + (variant % 2) + (r() < 0.3 ? 1 : 0);
    const flat = 0.8 + 0.12 * r();
    for (let s = 0; s < nStems; s++) {
      const az = (s / nStems) * Math.PI * 2 + r() * 0.8, out = R * (0.35 + 0.3 * r());
      const pts: Pt[] = [];
      for (let k = 0; k <= 3; k++) {
        const t = k / 3, bendOut = Math.pow(t, 1.4) * out, twist = Math.sin(t * 3 + s) * R * 0.08;
        pts.push({ x: Math.cos(az) * bendOut - Math.sin(az) * twist, y: t * flat * (0.92 + 0.08 * r()), z: Math.sin(az) * bendOut + Math.cos(az) * twist, r: sp.trunk * (1 - 0.6 * t) / Math.sqrt(nStems) * 1.4 });
      }
      plan.stems.push({ pts });
      const tip = pts[3];
      plan.clumps.push({ x: tip.x, y: tip.y, z: tip.z, r: R * (0.42 + 0.15 * r()) });
      // a bent limb off the stem
      const mid = pts[2], la = az + (r() < 0.5 ? -1 : 1) * (0.6 + 0.6 * r()), ll = R * (0.45 + 0.25 * r());
      const lp: Pt[] = [{ ...mid, r: mid.r * 0.6 }, { x: mid.x + Math.cos(la) * ll * 0.6, y: mid.y + 0.04, z: mid.z + Math.sin(la) * ll * 0.6, r: mid.r * 0.4 }, { x: mid.x + Math.cos(la) * ll, y: mid.y + 0.02 - 0.04 * r(), z: mid.z + Math.sin(la) * ll, r: mid.r * 0.25 }];
      plan.stems.push({ pts: lp });
      plan.clumps.push({ x: lp[2].x, y: lp[2].y, z: lp[2].z, r: R * (0.32 + 0.12 * r()) });
    }
  } else if (form === 'krummholz') {
    const n = 2 + ((variant + Math.floor(r() * 2)) % 3);
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1);
      // the windward lump stands tallest (the flag); the mat streams downwind (+x)
      const x = lerp(-0.45, 0.6, t) * R * 0.8 + (r() - 0.5) * 0.1, z = (r() - 0.5) * 0.5 * R;
      const lr = R * (0.38 + 0.12 * r()) * (1 - 0.25 * t);
      const h = i === 0 ? 0.9 + 0.1 * r() : 0.45 + 0.25 * r() * (1 - t);
      plan.clumps.push({ x, y: h, z, r: lr });
    }
  } else if (form === 'aspen') {
    plan.trunkTop = 0.95;
    const n = Math.round(lerp(sp.whorls[0], sp.whorls[1], r()));
    for (let i = 0; i < n; i++) plan.whorls.push({ y: lerp(sp.crownBase, 0.9, (i + r() * 0.6) / n), r: R * (0.75 + 0.3 * r()) * (1 - 0.35 * i / n), rot: i * 2.4 + r(), cards: Math.round(lerp(sp.cards[0], sp.cards[1], r())) });
  } else if (form === 'snag') {
    plan.top = variant % 2 === 1 ? 'broken' : 'none';
    plan.trunkTop = plan.top === 'broken' ? 0.72 + 0.15 * r() : 1;
    const n = variant === 0 ? 0 : 2 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) plan.stubs.push({ y: lerp(0.3, plan.trunkTop - 0.08, r()), az: r() * Math.PI * 2, len: 0.03 + 0.06 * r() });
  }
  return plan;
}

// ---------------------------------------------------------------- LOD0

function trunkPath(plan: Plan, segs: number, top = plan.trunkTop, taperTo = 0.15): Pt[] {
  const sp = plan.sp, r = rng(plan.seed + 99);
  const pts: Pt[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, y = top * t;
    const wob = sp.form === 'snag' || sp.form === 'krummholz' ? 0.012 : 0.003;
    pts.push({ x: (r() - 0.5) * wob * (i ? 1 : 0), y, z: (r() - 0.5) * wob * (i ? 1 : 0), r: sp.trunk * lerp(1, taperTo, Math.pow(t, 0.9)) * (i === 0 ? 1.25 : 1) });
  }
  return pts;
}

function applyLean(b: Builder, plan: Plan): void {
  const tx = Math.tan(plan.lean) * Math.cos(plan.leanAz), tz = Math.tan(plan.lean) * Math.sin(plan.leanAz);
  for (let i = 0; i < b.pos.length; i += 3) { const y = b.pos[i + 1]; b.pos[i] += y * tx; b.pos[i + 2] += y * tz; }
}

function lod0(plan: Plan, cellMean: number[], barkMean: number[]): Builder {
  const sp = plan.sp, form = sp.form, R = sp.radius;
  const r = rng(plan.seed + 1);
  const tn = tints(sp, plan.variant, cellMean, barkMean, r);
  const b = new Builder();
  b.normR = R; b.normY = form === 'krummholz' ? 0.3 : form === 'limber' || form === 'aspen' || form === 'lodgepole' ? 0.75 : 0.45;
  const bark = barkRect(sp.barkSwatch);
  const trunkAo = (y: number): number => form === 'aspen' || form === 'snag' || form === 'lodgepole' ? 0.85 + 0.15 * y : 0.4 + 0.2 * y;
  const cardAo = (rLocal: number) => (x: number, y: number, z: number, t: number): number => {
    const out = clamp01(Math.hypot(x, z) / Math.max(1e-3, rLocal));
    return (0.5 + 0.5 * out) * (0.78 + 0.22 * clamp01(y)) * (0.9 + 0.1 * t);
  };
  const tmpO = new THREE.Vector3(), tmpD = new THREE.Vector3();

  if (form === 'spruce' || form === 'fir' || form === 'douglas' || form === 'lodgepole') {
    tube(b, trunkPath(plan, 4), 7, bark, tn.bark, trunkAo, 2);
    plan.whorls.forEach((w, wi) => {
      const t = clamp01((w.y - sp.crownBase) / Math.max(0.1, plan.crownTop - sp.crownBase));
      const cell = cellRect(sp.cells[wi % sp.cells.length]);
      for (let j = 0; j < w.cards; j++) {
        const az = w.rot + (j / w.cards) * Math.PI * 2 + (r() - 0.5) * 0.5;
        let pitch = sp.pitch * (0.8 + 0.4 * r()), bend = sp.droop * (0.7 + 0.6 * r());
        if (form === 'spruce') { pitch += 0.3 * (1 - t); bend += 0.2 * (1 - t); }
        if (form === 'fir' && t > 0.75) { pitch = -0.35 * (t - 0.6) * 2.5; bend = -0.2; } // upright tips near the spire
        if (form === 'douglas') bend -= 0.1 * t;
        const len = w.r * (0.9 + 0.2 * r());
        const trunkR = sp.trunk * (1 - w.y * 0.85);
        tmpD.set(Math.cos(az) * Math.cos(pitch), -Math.sin(pitch), Math.sin(az) * Math.cos(pitch));
        tmpO.set(Math.cos(az) * trunkR, w.y + (r() - 0.5) * 0.01, Math.sin(az) * trunkR);
        const roll = (j % 2 ? 1 : -1) * (0.35 + 0.5 * r());
        const width = len * (form === 'lodgepole' ? 1.35 : 1.2);
        card(b, tmpO, tmpD, len, width, roll, bend, cell, tn.needle, cardAo(w.r));
      }
    });
    // inner fill: vertical cards along the trunk so you can't see straight through the core
    const fillCell = cellRect(sp.cells[0]);
    const yb = form === 'lodgepole' ? sp.crownBase + 0.04 : 0.06, fillH = (plan.crownTop - yb) / 2.2;
    for (let k = 0; k < 3; k++) for (let j = 0; j < 2; j++) {
      const az = plan.seed + k * 1.1 + j * Math.PI / 2;
      const yy = yb + k * fillH * 0.62;
      const rr = R * profile(form, clamp01((yy + fillH * 0.5 - sp.crownBase) / (plan.crownTop - sp.crownBase))) * 0.9;
      tmpO.set(0, yy, 0); tmpD.set(0, 1, 0);
      card(b, tmpO, tmpD, fillH * 1.1, rr * 1.6, az, 0, fillCell, tn.needle, () => 0.55, true);
    }
    // the leader (one or two), or a dead stub for a broken top
    const leaderCell = cellRect(sp.cells[0]);
    if (plan.top === 'leader' || plan.top === 'double') {
      const tops = plan.top === 'double' ? [-1, 1] : [0];
      for (const s of tops) {
        const lx = s * R * 0.12, lean = s * 0.25;
        for (let k = 0; k < 2; k++) {
          tmpO.set(lx, plan.crownTop - 0.07, 0); tmpD.set(Math.sin(lean), 1, 0);
          card(b, tmpO, tmpD, 0.1, R * 0.5, k * Math.PI / 2 + 0.3, 0, leaderCell, tn.needle, () => 1, true);
        }
      }
    } else if (plan.top === 'broken') {
      tube(b, [{ x: 0, y: plan.crownTop - 0.02, z: 0, r: sp.trunk * 0.3 }, { x: 0.004, y: plan.trunkTop, z: 0, r: sp.trunk * 0.18 }], 4, bark, tn.bark, () => 0.9);
    }
    for (const st of plan.stubs) {
      tmpO.set(0, st.y, 0); tmpD.set(Math.cos(st.az), -0.25, Math.sin(st.az));
      card(b, tmpO, tmpD, st.len, st.len * 0.7, 0.4, 0.2, cellRect(CELL.dead), new THREE.Color(0x8a837b).multiplyScalar(1 / (cellMean[CELL.dead] || 0.5)), () => 0.8, true);
    }
  } else if (form === 'limber') {
    for (const s of plan.stems) tube(b, s.pts, s.pts[0].r > sp.trunk * 0.5 ? 6 : 4, bark, tn.bark, trunkAo, 2);
    const cell = cellRect(sp.cells[0]);
    for (const c of plan.clumps) {
      const n = Math.round(lerp(sp.cards[0], sp.cards[1], r()));
      for (let j = 0; j < n; j++) {
        // tufts point out and up from the clump centre, a few flat on top (flat-topped crown)
        const az = (j / n) * Math.PI * 2 + r() * 0.6, up = j === 0 ? 1.2 : 0.15 + 0.5 * r();
        tmpD.set(Math.cos(az) * Math.cos(up), Math.sin(up), Math.sin(az) * Math.cos(up));
        tmpO.set(c.x - tmpD.x * c.r * 0.2, c.y - 0.03, c.z - tmpD.z * c.r * 0.2);
        card(b, tmpO, tmpD, c.r * (1.05 + 0.3 * r()), c.r * 1.3, (j % 2 ? 1 : -1) * (0.4 + 0.5 * r()), 0.15, cell, tn.needle, (x, y, z) => 0.6 + 0.4 * clamp01(Math.hypot(x - c.x, z - c.z) / c.r));
      }
    }
  } else if (form === 'krummholz') {
    tube(b, [{ x: -0.2 * R, y: 0, z: 0, r: sp.trunk }, { x: 0, y: 0.35, z: 0.02, r: sp.trunk * 0.6 }], 5, bark, tn.bark, () => 0.5);
    const cells = [cellRect(sp.cells[0]), cellRect(sp.cells[1])];
    plan.clumps.forEach((c, ci) => {
      const n = ci === 0 ? 18 : 15;
      for (let j = 0; j < n; j++) {
        // flagged: branches stream downwind (+x); the windward side is bare
        const az = (r() - 0.5) * (ci === 0 ? 1.8 : 3.4), up = -0.15 + 0.6 * r();
        tmpD.set(Math.cos(az) * Math.cos(up), Math.sin(up), Math.sin(az) * Math.cos(up));
        const hgt = c.y * (0.35 + 0.65 * r());
        tmpO.set(c.x - c.r * 0.35, hgt - 0.1, c.z + (r() - 0.5) * c.r * 0.5);
        card(b, tmpO, tmpD, c.r * (0.9 + 0.5 * r()), c.r * 1.1, (j % 2 ? 1 : -1) * (0.5 + 0.6 * r()), 0.25, cells[j % 2], tn.needle, (x, y) => 0.55 + 0.45 * clamp01(y / c.y), true);
      }
    });
  } else if (form === 'aspen') {
    tube(b, trunkPath(plan, 4, plan.trunkTop, 0.25), 7, bark, tn.bark, trunkAo, 3);
    const twig = [cellRect(sp.cells[0]), cellRect(sp.cells[1])];
    const twigC = tn.needle;
    for (const w of plan.whorls) {
      for (let j = 0; j < w.cards; j++) {
        const az = w.rot + (j / w.cards) * Math.PI * 2, up = 0.65 + 0.35 * r();
        tmpD.set(Math.cos(az) * Math.cos(up), Math.sin(up), Math.sin(az) * Math.cos(up));
        const trunkR = sp.trunk * (1 - w.y * 0.7);
        tmpO.set(Math.cos(az) * trunkR, w.y, Math.sin(az) * trunkR);
        const len = w.r / Math.cos(up) * 0.85;
        // a thin branch, then twig cards on it (two crossed)
        const end = tmpO.clone().addScaledVector(tmpD, len * 0.6);
        tube(b, [{ x: tmpO.x, y: tmpO.y, z: tmpO.z, r: sp.trunk * 0.3 }, { x: end.x, y: end.y, z: end.z, r: sp.trunk * 0.12 }], 3, barkRect(sp.barkSwatch), tn.bark, () => 0.9);
        for (let k = 0; k < 2; k++) card(b, tmpO.clone().addScaledVector(tmpD, len * 0.15), tmpD, len, len * 0.7, k * Math.PI / 2 + r() * 0.4, -0.1, twig[(j + k) % 2], twigC, () => 0.95, true);
      }
    }
    // the top twigs
    for (let k = 0; k < 3; k++) { tmpO.set(0, plan.trunkTop - 0.1, 0); tmpD.set((r() - 0.5) * 0.4, 1, (r() - 0.5) * 0.4); card(b, tmpO, tmpD, 0.12, 0.1, k * 1.05, 0, twig[k % 2], twigC, () => 1, true); }
  } else if (form === 'snag') {
    tube(b, trunkPath(plan, 3, plan.trunkTop, plan.top === 'broken' ? 0.5 : 0.05), 6, bark, tn.bark, () => 0.85, 2, true);
    for (const st of plan.stubs) {
      const o = { x: Math.cos(st.az) * sp.trunk * 0.8, y: st.y, z: Math.sin(st.az) * sp.trunk * 0.8 };
      tube(b, [{ ...o, r: sp.trunk * 0.3 }, { x: o.x + Math.cos(st.az) * st.len, y: o.y - st.len * 0.2, z: o.z + Math.sin(st.az) * st.len, r: sp.trunk * 0.05 }], 3, bark, tn.bark, () => 0.8);
    }
    if (plan.variant >= 2) for (let k = 0; k < 2; k++) {
      const az = r() * Math.PI * 2, y = lerp(0.4, plan.trunkTop - 0.1, r());
      tmpO.set(0, y, 0); tmpD.set(Math.cos(az), -0.1, Math.sin(az));
      card(b, tmpO, tmpD, 0.12, 0.09, 0.8, 0.1, cellRect(CELL.dead), tn.needle, () => 0.85, true);
    }
  }
  applyLean(b, plan);
  return b;
}

// ---------------------------------------------------------------- LOD1

function lod1(plan: Plan, cellMean: number[], barkMean: number[]): Builder {
  const sp = plan.sp, form = sp.form, R = sp.radius;
  const r = rng(plan.seed + 1);
  const tn = tints(sp, plan.variant, cellMean, barkMean, r);
  const b = new Builder();
  b.normR = R; b.normY = form === 'krummholz' ? 0.3 : form === 'limber' || form === 'aspen' || form === 'lodgepole' ? 0.75 : 0.45;
  const bark = barkRect(sp.barkSwatch), dense = cellRect(CELL.dense);
  // seen from 80 m and more, the cards' inner shade and gaps read as a darker mass than the bent-normal shell
  const c = tn.needleDense.clone().multiplyScalar(0.82);
  if (form === 'spruce' || form === 'fir' || form === 'douglas' || form === 'lodgepole') {
    const lodge = form === 'lodgepole';
    tube(b, trunkPath(plan, 1, lodge ? sp.crownBase + 0.1 : 0.3, 0.6), 5, bark, tn.bark, () => 0.7);
    const tiers = lodge ? 2 : 4;
    const y0 = sp.crownBase, y1 = plan.crownTop;
    const ws = plan.whorls;
    for (let k = 0; k < tiers; k++) {
      // the tier spans its share of the crown; its radius is the widest whorl in it, so the outline matches LOD0's cards
      const ta = k / tiers, tb = (k + 1) / tiers;
      const ya = lerp(y0, y1, ta), yb = lerp(y0, y1, tb);
      let rr = 0;
      for (const w of ws) if (w.y >= ya - 0.02 && w.y < yb + 0.02) rr = Math.max(rr, w.r);
      if (rr === 0) rr = R * profile(form, ta);
      const top = k === tiers - 1 ? (plan.top === 'broken' ? y1 : 1) : lerp(y0, y1, Math.min(1, tb + 0.18));
      const droop = form === 'spruce' ? 0.35 : form === 'fir' ? 0.12 : lodge ? 0 : 0.15;
      starCone(b, ya - (form === 'spruce' ? 0.03 : 0.015), top, rr * (lodge ? 0.9 : 0.86), 5, r() * 6.28, droop, dense, c, 0.6, 0, 0, lodge && k === 0 ? 0.1 : 0.25);
    }
  } else if (form === 'limber') {
    for (const s of plan.stems.filter((s) => s.pts.length === 4)) tube(b, [s.pts[0], s.pts[3]], 4, bark, tn.bark, () => 0.75);
    const clumps = [...plan.clumps].sort((a, b2) => b2.r - a.r).slice(0, 3);
    for (const cl of clumps) blob(b, cl.x, cl.y, cl.z, cl.r * 1.25, cl.r * 0.55, cl.r * 0.5, 5, r() * 6.28, dense, c);
  } else if (form === 'krummholz') {
    for (const cl of plan.clumps.slice(0, 3)) blob(b, cl.x + cl.r * 0.35, cl.y * 0.55, cl.z, cl.r * 1.2, cl.y * 0.45, cl.y * 0.55, 5, r() * 6.28, dense, c);
  } else if (form === 'aspen') {
    tube(b, trunkPath(plan, 2, plan.trunkTop, 0.3), 5, bark, tn.bark, () => 0.9, 3);
    const twig = cellRect(sp.cells[0]);
    for (let k = 0; k < 3; k++) {
      const az = k * Math.PI / 3 + 0.2;
      const o = new THREE.Vector3(0, sp.crownBase - 0.02, 0), d = new THREE.Vector3(0, 1, 0);
      card(b, o, d, 1 - sp.crownBase, R * 2.0, az, 0, twig, tn.needle, () => 0.9, true, true);
    }
  } else if (form === 'snag') {
    tube(b, trunkPath(plan, 2, plan.trunkTop, plan.top === 'broken' ? 0.5 : 0.05), 5, bark, tn.bark, () => 0.85, 2, true);
    for (const st of plan.stubs.slice(0, 3)) {
      const o = { x: 0, y: st.y, z: 0 };
      tube(b, [{ ...o, r: sp.trunk * 0.35 }, { x: Math.cos(st.az) * st.len, y: st.y - st.len * 0.2, z: Math.sin(st.az) * st.len, r: sp.trunk * 0.05 }], 3, bark, tn.bark, () => 0.8);
    }
  }
  applyLean(b, plan);
  return b;
}

export interface TreeGeometrySet {
  /** [species][variant] */
  lod0: THREE.BufferGeometry[][];
  lod1: THREE.BufferGeometry[][];
  /** triangles per species and LOD (the largest variant) */
  triangles: { species: string; lod0: number; lod1: number }[];
  ms: number;
}

export function buildTreeGeometries(cellMean: number[], barkMean: number[]): TreeGeometrySet {
  const t0 = performance.now();
  const lod0s: THREE.BufferGeometry[][] = [], lod1s: THREE.BufferGeometry[][] = [];
  const triangles: TreeGeometrySet['triangles'] = [];
  for (const sp of SPECIES) {
    const a: THREE.BufferGeometry[] = [], c: THREE.BufferGeometry[] = [];
    let t0max = 0, t1max = 0;
    for (let v = 0; v < 4; v++) {
      const plan = makePlan(sp, v);
      const b0 = lod0(plan, cellMean, barkMean), b1 = lod1(plan, cellMean, barkMean);
      t0max = Math.max(t0max, b0.triangles); t1max = Math.max(t1max, b1.triangles);
      a.push(b0.build(sp.radius)); c.push(b1.build(sp.radius));
    }
    lod0s.push(a); lod1s.push(c);
    triangles.push({ species: sp.name, lod0: t0max, lod1: t1max });
  }
  return { lod0: lod0s, lod1: lod1s, triangles, ms: performance.now() - t0 };
}

/**
 * LOD2: two crossed quads (4 triangles) for every species; the shader scales them per instance and
 * samples the impostor atlas's front (column 0) and side (column 2) views. `aCol` is the column.
 */
export function crossedQuads(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const y0 = -0.04, y1 = 1.04;
  // quad A in the x-y plane (seen from +z: column 0), quad B in the z-y plane (seen from +x: column 2, u runs toward -z)
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, y0, 0, 1, y0, 0, 1, y1, 0, -1, y1, 0, 0, y0, 1, 0, y0, -1, 0, y1, -1, 0, y1, 1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setAttribute('aCol', new THREE.Float32BufferAttribute([0, 0, 0, 0, 2, 2, 2, 2], 1));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}

/** the impostor billboard: one camera-facing quad */
export function billboardQuad(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const y0 = -0.04, y1 = 1.04;
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, y0, 0, 1, y0, 0, 1, y1, 0, -1, y1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}
