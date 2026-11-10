import * as THREE from 'three';
import { Builder, card, rng, lerp } from './generate';
import { CELL } from './species';
import { cellRect, barkRect, type UvRect } from './textures';

/**
 * FEAT-159: the shrub set (DATA-020's `shrubs/<cx>_<cy>.bin`, kind in field 5), built with the tree
 * kit's Builder and atlas so it shares the trees' material and snow. Every shrub is built at unit height
 * with crown radius 1 like a tree (the instance scales x and z by the record's radius, y by its height):
 *   0 willow        clumps of thin straight red-orange to yellow stems, no leaves
 *   1 juniper       low dark-green mats (a wide, low, irregular dome)
 *   2 sagebrush     grey-green rounded shrubs (a round dome)
 *   3 young conifer a small spruce or fir: the kit's LOD1 (not built here)
 *   4 Gambel oak    leafless grey-brown clumps: a few crooked stems, each with a twig spray
 * Burial, the snow line and the snow mounds are the material's (materials.ts, SHRUB) and Shrubs.ts'.
 */

export const WILLOW = 0, JUNIPER = 1, SAGE = 2, YOUNG_CONIFER = 3, OAK = 4;
export const SHRUB_KINDS = 5;

export interface ShrubKind {
  name: string;
  /** variants built (young conifers use the kit's spruce and fir LOD1, 4 variants each) */
  variants: number;
  /** natural crown radius / height the geometry is built at */
  radius: number;
  /** stem or foliage colour range (sRGB hex), dark to light */
  colour: [number, number];
  /** buried, it still shows as a snow-covered hump this high (m, at most; 0: it just disappears) */
  hump: number;
  /** the share of the snow mound cover it takes once more than half buried (mats and saplings hold it, stems do not) */
  mound: number;
  /** how much it slows a board riding through (0..1 of the brush drag; young conifers over 1.5 m are trunks instead) */
  brush: number;
  /** the triangle budget per shrub (the card's) */
  budget: number;
}

export const SHRUBS: ShrubKind[] = [
  { name: 'willow', variants: 3, radius: 0.42, colour: [0x8a2f1c, 0xb8862e], hump: 0, mound: 0, brush: 0.8, budget: 60 },
  { name: 'juniper', variants: 2, radius: 1.4, colour: [0x2a3c2d, 0x354b37], hump: 0.3, mound: 1, brush: 0.5, budget: 40 },
  { name: 'sagebrush', variants: 2, radius: 0.6, colour: [0x707a66, 0x89927d], hump: 0.25, mound: 0.8, brush: 0.6, budget: 40 },
  { name: 'young conifer', variants: 4, radius: 0, colour: [0, 0], hump: 0.4, mound: 0.9, brush: 1, budget: 96 },
  { name: 'gambel oak', variants: 2, radius: 0.5, colour: [0x4f4339, 0x6e6157], hump: 0, mound: 0, brush: 1, budget: 60 },
];

/** the snow a stem or twig holds (it is near vertical; a little on the upper side) */
const STEM_HOLD = 0.15;

/** a stem as two crossed strips along a polyline (4 triangles per segment), `w` the half-width at each point */
function stem(b: Builder, pts: THREE.Vector3[], w: number[], az: number, uv: UvRect, c: THREE.Color): void {
  for (let k = 0; k < 2; k++) {
    const a = az + k * Math.PI / 2, sx = Math.cos(a), sz = Math.sin(a);
    const base = b.pos.length / 3;
    pts.forEach((p, i) => {
      const t = i / (pts.length - 1), ao = 0.72 + 0.28 * p.y;
      for (const sgn of [-1, 1]) {
        const x = p.x + sx * w[i] * sgn, z = p.z + sz * w[i] * sgn;
        const [nx, ny, nz] = b.bent(x, p.y, z);
        b.vert(x, p.y, z, nx, ny, nz, lerp(uv.u0, uv.u1, sgn < 0 ? 0 : 1), lerp(uv.v0, uv.v1, t), c, ao, STEM_HOLD);
      }
    });
    for (let i = 0; i < pts.length - 1; i++) { const q = base + i * 2; b.tri(q, q + 1, q + 2); b.tri(q + 1, q + 3, q + 2); }
  }
}

/** stem colours: the kind's range, divided by the bark swatch's mean so texture x colour lands on it */
function tint(kind: ShrubKind, t: number, mean: number): THREE.Color {
  return new THREE.Color(kind.colour[0]).lerp(new THREE.Color(kind.colour[1]), t).multiplyScalar(1 / (mean || 0.5));
}

/** willow: 10 to 12 straight thin stems fanning out of one root (a winter willow is a mass of upright red stems) */
function willow(v: number, barkMean: number[]): Builder {
  const k = SHRUBS[WILLOW], R = k.radius, r = rng(4100 + v * 37), b = new Builder();
  b.normR = R; b.normY = 0.6;
  const bark = barkRect(2), n = 10 + v;
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + (r() - 0.5) * 0.7;
    const rb = 0.02 + 0.13 * Math.sqrt(r()), lean = 0.06 + 0.32 * r(), top = i === 0 ? 1 : 0.55 + 0.42 * r();
    const dx = Math.cos(az), dz = Math.sin(az), bx = dx * rb, bz = dz * rb;
    const reach = Math.min(R - rb, top * Math.tan(lean));
    stem(b, [new THREE.Vector3(bx, 0, bz), new THREE.Vector3(bx + dx * reach, top, bz + dz * reach)], [0.012, 0.004], az + Math.PI / 4 + r(), bark, tint(k, r(), barkMean[2]));
  }
  return b;
}

/** Gambel oak: 3 or 4 crooked grey stems, each with a twig spray reaching out and up from near its top */
function oak(v: number, cellMean: number[], barkMean: number[]): Builder {
  const k = SHRUBS[OAK], R = k.radius, r = rng(4700 + v * 41), b = new Builder();
  b.normR = R; b.normY = 0.55;
  const bark = barkRect(6), n = 3 + v, twig = cellRect(v ? CELL.aspenB : CELL.aspenA);
  const tc = tint(k, 0.25 + 0.3 * r(), cellMean[v ? CELL.aspenB : CELL.aspenA]);
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + (r() - 0.5) * 0.8;
    const rb = 0.04 + 0.1 * r(), lean = 0.15 + 0.35 * r(), top = i === 0 ? 1 : 0.7 + 0.25 * r();
    const dx = Math.cos(az), dz = Math.sin(az), bx = dx * rb, bz = dz * rb;
    const reach = Math.min(R * 0.6 - rb, top * Math.tan(lean));
    // crooked: the middle point kinks sideways
    const kx = -dz * (r() - 0.5) * 0.12, kz = dx * (r() - 0.5) * 0.12;
    const mid = new THREE.Vector3(bx + dx * reach * 0.45 + kx, top * 0.55, bz + dz * reach * 0.45 + kz);
    const tip = new THREE.Vector3(bx + dx * reach, top, bz + dz * reach);
    stem(b, [new THREE.Vector3(bx, 0, bz), mid, tip], [0.022, 0.014, 0.006], az + Math.PI / 2, bark, tint(k, r(), barkMean[6]));
    // the spray: out from two thirds of the way up, rising, rolled so it is seen from the side
    const o = mid.clone().lerp(tip, 0.4), dir = new THREE.Vector3(dx, 0.7 + 0.4 * r(), dz);
    card(b, o, dir, (R - Math.hypot(o.x, o.z)) * 1.25, R * 0.75, Math.PI / 2 + (r() - 0.5) * 0.6, -0.15, twig, tc, () => 0.85, true);
  }
  return b;
}

/**
 * A rounded dome (juniper, sagebrush): an apex, an upper ring at 55 % of the rise pulled in to 72 %, the
 * widest ring at cy, and a point under it; ring radii jittered by `jit` so the outline is irregular.
 * 4n triangles.
 */
function dome(b: Builder, cy: number, r: number, hUp: number, hDown: number, n: number, jit: number, uv: UvRect, c: THREE.Color, rnd: () => number): void {
  const rot = rnd() * Math.PI * 2;
  const top = b.pos.length / 3;
  { const [nx, ny, nz] = b.bent(0, cy + hUp, 0); b.vert(0, cy + hUp, 0, nx, ny, nz, (uv.u0 + uv.u1) / 2, uv.v1, c, 1); }
  const ring = (y: number, rr: number, off: number, v: number, ao: number, hold: number): number => {
    const first = b.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const a = rot + off + (i / n) * Math.PI * 2, k = rr * (1 - jit + 2 * jit * rnd());
      const x = Math.cos(a) * k, z = Math.sin(a) * k, yy = y + (rnd() - 0.5) * 0.06;
      const [nx, ny, nz] = b.bent(x, yy, z);
      b.vert(x, yy, z, nx, ny, nz, lerp(uv.u0, uv.u1, i / n), v, c, ao, hold);
    }
    return first;
  };
  const r1 = ring(cy + 0.55 * hUp, 0.72 * r, Math.PI / n, lerp(uv.v0, uv.v1, 0.75), 0.95, 0.95);
  const r2 = ring(cy, r, 0, lerp(uv.v0, uv.v1, 0.4), 0.8, 0.7);
  const bot = b.pos.length / 3;
  b.vert(0, cy - hDown, 0, 0, -1, 0, (uv.u0 + uv.u1) / 2, uv.v0, c, 0.5, 0);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    b.tri(top, r1 + j, r1 + i);
    b.tri(r1 + i, r1 + j, r2 + j); b.tri(r1 + i, r2 + j, r2 + i);
    b.tri(bot, r2 + i, r2 + j);
  }
}

/** juniper (a wide low mat) and sagebrush (a round bush): one dome of the dense foliage cell */
function mound(kind: number, v: number, cellMean: number[]): Builder {
  const k = SHRUBS[kind], R = k.radius, r = rng(5300 + kind * 101 + v * 43), b = new Builder();
  const jun = kind === JUNIPER;
  b.normR = R; b.normY = jun ? 0.3 : 0.5;
  const uv = cellRect(CELL.dense), dm = cellMean[CELL.dense] || 0.5;
  const c = new THREE.Color(k.colour[0]).lerp(new THREE.Color(k.colour[1]), 0.3 + 0.5 * r()).multiplyScalar(1 / dm);
  if (jun) dome(b, 0.32, R, 0.68, 0.32, 9, 0.18, uv, c, r);
  else dome(b, 0.48, R, 0.52, 0.48, 9, 0.12, uv, c, r);
  return b;
}

export interface ShrubGeometrySet {
  /** [kind][variant]; young conifers (kind 3) are empty: the kit's LOD1 */
  geo: THREE.BufferGeometry[][];
  /** triangles per kind (the largest variant), and its budget */
  triangles: { kind: string; tris: number; budget: number }[];
  ms: number;
}

/** every shrub kind x variant (young conifers excepted), at unit height and crown radius 1 */
export function buildShrubGeometries(cellMean: number[], barkMean: number[], youngTris = 0): ShrubGeometrySet {
  const t0 = performance.now();
  const geo: THREE.BufferGeometry[][] = [], triangles: ShrubGeometrySet['triangles'] = [];
  SHRUBS.forEach((k, kind) => {
    const list: THREE.BufferGeometry[] = [];
    let tris = 0;
    if (kind !== YOUNG_CONIFER) {
      for (let v = 0; v < k.variants; v++) {
        const b = kind === WILLOW ? willow(v, barkMean) : kind === OAK ? oak(v, cellMean, barkMean) : mound(kind, v, cellMean);
        tris = Math.max(tris, b.triangles);
        list.push(b.build(k.radius));
      }
    } else tris = youngTris;
    geo.push(list);
    triangles.push({ kind: k.name, tris, budget: k.budget });
  });
  return { geo, triangles, ms: performance.now() - t0 };
}
