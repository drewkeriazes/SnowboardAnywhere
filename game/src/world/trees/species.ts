/**
 * FEAT-156: the tree species the kit builds, ids as in the pack's tree records (DATA-020; 8 and 9 FEAT-233, packs
 * with `treeSpecies` 3). Every tree is
 * built at unit height; `radius` is the natural crown radius as a share of the height (the card's
 * "width" is the diameter). Colours are sRGB hex; the kit varies them by up to about 6% per variant
 * and per instance.
 */

export type TreeForm = 'spruce' | 'fir' | 'lodgepole' | 'douglas' | 'limber' | 'krummholz' | 'aspen' | 'snag' | 'hardwood' | 'hemlock';

export interface Species {
  id: number;
  name: string;
  form: TreeForm;
  /** natural crown radius / height */
  radius: number;
  /** needle colour range (sRGB hex), dark to light; aspen and snags use it for the twigs */
  needles: [number, number];
  /** bark colour (sRGB hex) */
  bark: number;
  /** atlas cells for the branch cards (see textures.ts CELL) */
  cells: number[];
  /** bark swatch in the atlas (0..7) */
  barkSwatch: number;
  /** trunk radius at the base / height */
  trunk: number;
  /** whorl count range for the conifer forms */
  whorls: [number, number];
  /** cards per whorl range */
  cards: [number, number];
  /** where the foliage starts (share of the height) */
  crownBase: number;
  /** branch pitch below horizontal at the base (rad) and how much the outer half droops further (rad, negative turns up) */
  pitch: number;
  droop: number;
  /** variant weights (4 variants); the last of spruce and fir is the double or broken top */
  weights: [number, number, number, number];
}

export const CELL = {
  spruceA: 0, spruceB: 1, firA: 2, firB: 3,
  douglasA: 4, douglasB: 5, lodgepole: 6, limber: 7,
  aspenA: 8, aspenB: 9, dead: 10, dense: 11,
} as const;

export const SPECIES: Species[] = [
  { id: 0, name: 'Engelmann spruce', form: 'spruce', radius: 0.13, needles: [0x2f4a3a, 0x3c5a48], bark: 0x5a4a40, cells: [CELL.spruceA, CELL.spruceB], barkSwatch: 0, trunk: 0.014, whorls: [12, 15], cards: [7, 8], crownBase: 0.02, pitch: 0.42, droop: 0.38, weights: [0.29, 0.28, 0.28, 0.15] },
  { id: 1, name: 'aspen', form: 'aspen', radius: 0.17, needles: [0x5f5a55, 0x7a746d], bark: 0xd9d8cf, cells: [CELL.aspenA, CELL.aspenB], barkSwatch: 1, trunk: 0.012, whorls: [9, 12], cards: [2, 3], crownBase: 0.62, pitch: -0.75, droop: -0.15, weights: [0.25, 0.25, 0.25, 0.25] },
  { id: 2, name: 'krummholz', form: 'krummholz', radius: 1.1, needles: [0x29402f, 0x34503f], bark: 0x4e4038, cells: [CELL.spruceA, CELL.spruceB], barkSwatch: 0, trunk: 0.09, whorls: [2, 4], cards: [12, 16], crownBase: 0, pitch: 0.1, droop: 0.15, weights: [0.25, 0.25, 0.25, 0.25] },
  { id: 3, name: 'subalpine fir', form: 'fir', radius: 0.1, needles: [0x2c4a33, 0x33543b], bark: 0x8a8c86, cells: [CELL.firA, CELL.firB], barkSwatch: 2, trunk: 0.012, whorls: [14, 18], cards: [6, 7], crownBase: 0.03, pitch: 0.2, droop: 0.12, weights: [0.29, 0.28, 0.28, 0.15] },
  { id: 4, name: 'lodgepole pine', form: 'lodgepole', radius: 0.09, needles: [0x55613a, 0x606c42], bark: 0x6b5a44, cells: [CELL.lodgepole, CELL.lodgepole], barkSwatch: 3, trunk: 0.011, whorls: [8, 10], cards: [6, 7], crownBase: 0.64, pitch: 0.05, droop: -0.1, weights: [0.25, 0.25, 0.25, 0.25] },
  { id: 5, name: 'Douglas-fir', form: 'douglas', radius: 0.17, needles: [0x34503e, 0x3f5c48], bark: 0x5d4637, cells: [CELL.douglasA, CELL.douglasB], barkSwatch: 4, trunk: 0.016, whorls: [9, 11], cards: [7, 8], crownBase: 0.04, pitch: 0.18, droop: -0.12, weights: [0.25, 0.25, 0.25, 0.25] },
  { id: 6, name: 'limber pine', form: 'limber', radius: 0.35, needles: [0x34503a, 0x3e5a42], bark: 0x8a8278, cells: [CELL.limber, CELL.limber], barkSwatch: 5, trunk: 0.022, whorls: [7, 9], cards: [6, 7], crownBase: 0.14, pitch: -0.2, droop: -0.15, weights: [0.25, 0.25, 0.25, 0.25] },
  { id: 7, name: 'snag', form: 'snag', radius: 0.05, needles: [0x8f8a83, 0x9a958d], bark: 0x8f8a83, cells: [CELL.dead, CELL.dead], barkSwatch: 6, trunk: 0.013, whorls: [0, 6], cards: [1, 1], crownBase: 0.3, pitch: 0.2, droop: 0.1, weights: [0.25, 0.25, 0.25, 0.25] },
  // FEAT-233: the eastern forest in winter. Bare hardwood (oak, beech, maple): a grey-brown twig crown on limbs that hold
  // snow at the forks (`needles` is the twig colour). Eastern hemlock: darker and softer than spruce, drooping sprays.
  { id: 8, name: 'bare hardwood', form: 'hardwood', radius: 0.26, needles: [0x6b6056, 0x83776a], bark: 0x6a6159, cells: [CELL.aspenA, CELL.aspenB], barkSwatch: 4, trunk: 0.016, whorls: [3, 4], cards: [2, 2], crownBase: 0.36, pitch: 0, droop: 0, weights: [0.25, 0.25, 0.25, 0.25] },
  { id: 9, name: 'eastern hemlock', form: 'hemlock', radius: 0.16, needles: [0x22362a, 0x2b4133], bark: 0x5b463a, cells: [CELL.douglasA, CELL.douglasB], barkSwatch: 4, trunk: 0.016, whorls: [12, 14], cards: [7, 8], crownBase: 0.05, pitch: 0.1, droop: 0.2, weights: [0.25, 0.25, 0.25, 0.25] },
];

export const SPECIES_COUNT = SPECIES.length;
export const VARIANTS = 4;

/** a stable 0..1 hash of a position (pack metres), with a salt for independent draws */
export function hash01(x: number, y: number, salt = 0): number {
  let h = Math.imul(Math.round(x * 10) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(y * 10) | 0, 0x165667b1) ^ Math.imul(salt + 1, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The kit species for a pack record. Packs from before DATA-020 (no `treeSpecies` in the meta) have
 * only 0 conifer, 1 aspen and 2 krummholz: their conifers split 60/40 into spruce and subalpine fir. An id past the
 * table (a pack from a newer pipeline) draws as spruce, so an older client still loads a newer pack.
 */
export function speciesFor(packId: number, x: number, y: number, legacy: boolean): number {
  const s = Math.round(packId);
  if (legacy) return s === 0 ? (hash01(x, y, 7) < 0.6 ? 0 : 3) : s === 1 ? 1 : s === 2 ? 2 : 0;
  return s >= 0 && s < SPECIES_COUNT ? s : 0;
}

/** the variant (0..3) of a tree, by the species' weights */
export function variantFor(species: number, x: number, y: number): number {
  const w = SPECIES[species].weights, u = hash01(x, y, 3);
  let acc = 0;
  for (let i = 0; i < VARIANTS; i++) { acc += w[i]; if (u < acc) return i; }
  return VARIANTS - 1;
}

/** the crown radius (m) to draw for a pack tree of height h and crown radius `crown`: the species shape, nudged by the pack's crown */
export function crownRadius(species: number, h: number, crown: number): number {
  const nat = SPECIES[species].radius * h;
  const k = nat > 0 && crown > 0 ? crown / nat : 1;
  return nat * Math.max(0.85, Math.min(1.25, k));
}
