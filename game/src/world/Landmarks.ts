import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';

/**
 * Landmarks (FEAT-132): hand-placed iconic signs and spots that OSM doesn't carry, listed per
 * resort below in pack metres (x east, y north). A `gateway` is a timber arch you ride under, built
 * at 1:1 from Drew's photos (FEAT-143): two square posts on concrete footings, a lower rail and a
 * top beam with spacer blocks between them, a black board standing on the top beam between the
 * posts with white small-caps lettering, and snow piled as in the photos. Lettering is our own (a
 * serif face and a plain mountain mark), no resort logos. The posts are collider trunks; the posts
 * and footings re-seat on the ground once the 1 m terrain under them has loaded.
 */
export interface Landmark {
  id: string;
  kind: 'gateway';
  name: string;
  /** pack metres of the arch's centre */
  x: number; y: number;
  /** the direction riders pass through it, degrees clockwise from north; the lettering faces riders coming that way */
  heading: number;
  /** distance between the post centres and the height of the lower rail's underside above the snow (m) */
  span: number; clearance: number;
  /** the board's main text, and the small two-line block at its right end */
  text: string; sub?: [string, string];
  /** where the placement came from */
  source: string;
  /** the resort's default Free ride start: just uphill of it, riding through */
  start?: boolean;
}

export const LANDMARKS: Record<string, Landmark[]> = {
  vail: [
    {
      id: 'back-bowls-gateway', kind: 'gateway', name: 'The Legendary Back Bowls',
      // At the top of Forever just below the summit hub (the tops of Mountaintop, Northwoods and High
      // Noon at 3,429 m, the "ELEV 11,250" on the sign), where the ridge drops south into the bowls.
      // Moved 20 m left of Forever's OSM line so the tall spruce stands 11 m to its right, open slope
      // to its left, as in Drew's photo.
      x: -718.0, y: 495.9, heading: 162, span: 7.1, clearance: 3.55,
      text: 'THE LEGENDARY BACK BOWLS', sub: ['ELEV.', '11,250'],
      source: "Drew's photo; height from the summit lift tops at 3,429 m, placed against the spruce on its right",
      start: true,
    },
  ],
};

/** metres uphill of a start landmark where the rider spawns, facing through it */
const START_BACK = 15;

/**
 * The default Free ride start when a landmark is marked `start` (pack metres, heading in radians
 * clockwise from north, like meta.start), else null so the pack's meta.start is used.
 */
export function landmarkStart(slug: string): { x: number; y: number; heading: number; label: string } | null {
  const l = (LANDMARKS[slug] ?? []).find((m) => m.start);
  if (!l) return null;
  const h = l.heading * Math.PI / 180;
  return { x: l.x - Math.sin(h) * START_BACK, y: l.y - Math.cos(h) * START_BACK, heading: h, label: `Starts at ${l.name}` };
}

// Sizes measured from Drew's photos (FEAT-143), in metres; the ratios are direct, the absolute scale about +-15%.
const POST = 0.42; // square post; posts run from the footing up to the lower rail
const RAIL_H = 0.16, RAIL_D = 0.28; // the lower rail, sitting on the posts at the clearance height
const GAP = 0.19, SPACER_W = 0.3; // the gap between the rail and the top beam, held by short blocks over each post and at the quarter points
const BEAM_H = 0.33, BEAM_D = 0.36; // the top beam
const BEAM_OVER = 0.6; // both beams run this far past each post centre
const BOARD_LEN = 6.7, BOARD_H = 0.53, BOARD_D = 0.1; // the black board on the top beam, between the posts
const BOARD_X = -0.03; // the board's centre across the span (it starts 0.18 m inside the left post, ends 0.25 m inside the right)
const FOOT = 0.58, FOOT_H = 0.88; // dark concrete footing around each post's base, showing above the snow
const SINK = 1.5; // posts run this far below the ground sample so they never float

const INK = '#f2f0ea', BLACK = '#121418';
/** a serif / slab face for the board; Rockwell on macOS, Georgia on Windows */
const SERIF = 'Rockwell, "Roboto Slab", Georgia, "Times New Roman", serif';
/** the same for the height, from faces with lining figures (Georgia's old-style 250 drops below the line) */
const FIGURES = 'Rockwell, "Roboto Slab", "Times New Roman", serif';

/** CSS font for a bold face whose capitals stand `capH` pixels tall. */
function capFont(g: CanvasRenderingContext2D, capH: number, family = SERIF): string {
  g.font = `bold 100px ${family}`;
  const a = g.measureText('H').actualBoundingBoxAscent || 70;
  return `bold ${(capH * 100 / a).toFixed(1)}px ${family}`;
}

/**
 * Board lettering: white on black, no border. Our own mark at the left (a white diamond about the
 * board's height with a mountain cut out, not a resort logo), the name in small caps (each word's
 * first letter taller), and the small right-aligned block ("ELEV." over the height) at the right.
 */
function boardTexture(text: string, sub: [string, string] | undefined, aspect: number): THREE.CanvasTexture {
  const H = 192, W = Math.round(H * aspect);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = BLACK; g.fillRect(0, 0, W, H);
  // mark: a diamond with two peaks cut out
  const m = H * 0.5, r = H * 0.42, mx = H * 0.08 + r;
  g.fillStyle = INK;
  g.beginPath(); g.moveTo(mx, m - r); g.lineTo(mx + r, m); g.lineTo(mx, m + r); g.lineTo(mx - r, m); g.closePath(); g.fill();
  g.fillStyle = BLACK;
  g.beginPath(); g.moveTo(mx - 0.78 * r, m + 0.3 * r); g.lineTo(mx - 0.18 * r, m - 0.42 * r); g.lineTo(mx + 0.12 * r, m - 0.06 * r);
  g.lineTo(mx + 0.36 * r, m - 0.3 * r); g.lineTo(mx + 0.84 * r, m + 0.3 * r); g.closePath(); g.fill();
  g.fillStyle = INK;
  // the small block at the right end, right-aligned
  let right = W - H * 0.1;
  if (sub) {
    g.font = capFont(g, H * 0.2, FIGURES);
    g.textAlign = 'right'; g.textBaseline = 'alphabetic';
    g.fillText(sub[0], right, H * 0.43); g.fillText(sub[1], right, H * 0.75);
    right -= Math.max(g.measureText(sub[0]).width, g.measureText(sub[1]).width) + H * 0.22;
  }
  // the name in small caps, squeezed horizontally to fill the room between the mark and the block
  const big = H * 0.6, small = big * 0.78, base = H * 0.5 + big / 2;
  const bigFont = capFont(g, big), smallFont = capFont(g, small);
  const runs: { s: string; font: string; w: number }[] = [];
  text.split(' ').forEach((word, i) => {
    if (i > 0) { g.font = bigFont; runs.push({ s: ' ', font: bigFont, w: g.measureText(' ').width }); }
    for (const [s, font] of [[word[0], bigFont], [word.slice(1), smallFont]] as const) {
      if (!s) continue;
      g.font = font; runs.push({ s, font, w: g.measureText(s).width });
    }
  });
  const left = mx + r + H * 0.2, room = right - left, tw = runs.reduce((a, q) => a + q.w, 0);
  g.save(); g.translate(left, base); g.scale(Math.min(1.15, room / tw), 1);
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  let x = 0;
  for (const q of runs) { g.font = q.font; g.fillText(q.s, x, 0); x += q.w; }
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/** Weathered timber grain, streaks running along u (the length of a box built long in x). */
function grainTexture(): THREE.CanvasTexture {
  const W = 512, H = 64;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const row = Array.from({ length: H }, () => rnd());
  for (let y = 0; y < H; y++) {
    const ph = rnd() * 6.28;
    for (let x = 0; x < W; x++) {
      // dark streaks across the rows that wander slowly along the length, plus fine noise
      const yy = y + 2.5 * Math.sin(x * 0.013 + ph * 0.3);
      const streak = 0.5 + 0.5 * Math.sin(yy * 1.7 + row[Math.floor(Math.abs(yy)) % H] * 4);
      const v = 0.8 + 0.16 * streak + 0.06 * (rnd() - 0.5);
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(255 * Math.min(1, v)); img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/**
 * A lumpy snow pile along the top of a box, local x along the length, its base at y = 0. `profile`
 * gives the thickness (0..1 of `h`) along the length (t = 0 at the left end, 1 at the right).
 */
function snowPile(len: number, depth: number, h: number, seed: number, profile: (t: number) => number = () => 1): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(len, 1, depth, Math.max(4, Math.round(len * 6)), 1, 3);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), t = x / len + 0.5;
    const lump = 0.6 + 0.4 * Math.sin(x * 4.1 + seed) * Math.sin(x * 1.7 + seed * 2.3) + 0.15 * Math.sin(x * 11 + seed * 5);
    const end = Math.min(1, (len / 2 - Math.abs(x)) / Math.min(0.2, len / 4)); // rounds off the ends
    const top = h * Math.max(0.15, profile(t)) * Math.max(0.1, lump) * Math.max(0.25, end);
    if (p.getY(i) > 0) {
      p.setY(i, top);
      p.setZ(i, z * (Math.abs(z) > depth * 0.3 ? 0.82 : 1)); // round the shoulders
    } else p.setY(i, -0.02);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Snow hanging over a vertical face, local x along the length: the top edge at y = 0.04, the lumpy
 * lower edge `drop` metres down times `profile` (t = 0 at the left end, 1 at the right).
 */
function snowDrape(len: number, drop: number, thick: number, seed: number, profile: (t: number) => number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(len, 1, thick, Math.max(4, Math.round(len * 8)), 1, 1);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), t = x / len + 0.5;
    if (p.getY(i) > 0) { p.setY(i, 0.04); continue; }
    const lump = 0.75 + 0.25 * Math.sin(x * 7.3 + seed) + 0.12 * Math.sin(x * 19 + seed * 3);
    const end = Math.min(1, (len / 2 - Math.abs(x)) / 0.15);
    p.setY(i, 0.04 - drop * Math.max(0.05, profile(t) * lump * end));
  }
  g.computeVertexNormals();
  return g;
}

/** A lumpy snow bank around a post's base, centred on the ground (its lower half is underground). */
function snowBank(rx: number, h: number, seed: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 20, 10);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.atan2(z, x);
    const k = 1 + 0.18 * Math.sin(a * 3 + seed) + 0.1 * Math.sin(a * 7 + seed * 2);
    // a drift, not a dome: flattened toward its rim so it runs out into the ground, longer uphill (+z)
    const up = y > 0 ? y ** 1.6 : y;
    p.setXYZ(i, x * rx * k, up * h * (0.8 + 0.25 * k), z * rx * (z > 0 ? 1.25 : 0.85) * k);
  }
  g.computeVertexNormals();
  return g;
}

export class Landmarks {
  readonly group = new THREE.Group();
  readonly list: Landmark[];
  readonly materials: THREE.Material[];
  private readonly wood = new THREE.MeshStandardMaterial({ color: 0x76604d, map: grainTexture(), roughness: 0.9 });
  private readonly concrete = new THREE.MeshStandardMaterial({ color: 0x6c6a66, roughness: 0.95 });
  private readonly board = new THREE.MeshStandardMaterial({ color: 0x121418, roughness: 0.7 });
  // a little emissive, like the lettering, so the snow stays white when the arch faces away from the sun (FEAT-143)
  private readonly snow = new THREE.MeshStandardMaterial({ color: 0xf6f8fb, emissive: 0x5a5e62, roughness: 0.85 });
  /** per landmark: its root, the two post bases (pack x, y) and the resolution its ground was sampled at */
  private readonly seats: { obj: THREE.Object3D; posts: [number, number][]; res: number }[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly pack: Pack, collider: Collider | null) {
    this.list = LANDMARKS[pack.meta.slug] ?? [];
    this.materials = [this.wood, this.concrete, this.board, this.snow];
    for (const l of this.list) this.build(l, collider);
  }

  private build(l: Landmark, collider: Collider | null): void {
    const root = new THREE.Group();
    root.name = l.name;
    // local frame: x across the run (the span), y up, -z the direction riders travel
    root.rotation.y = -l.heading * Math.PI / 180;
    const half = l.span / 2, beamLen = l.span + 2 * BEAM_OVER;
    // heights above the snow: posts to the clearance, the rail, the gap with its spacers, the top beam, the board
    const railY = l.clearance + RAIL_H / 2, gapY = l.clearance + RAIL_H + GAP / 2;
    const beamTop = l.clearance + RAIL_H + GAP + BEAM_H, beamY = beamTop - BEAM_H / 2;
    const boardY = beamTop + BOARD_H / 2, boardTop = beamTop + BOARD_H;
    const postLen = l.clearance + SINK;
    const wood: THREE.BufferGeometry[] = [], conc: THREE.BufferGeometry[] = [], snow: THREE.BufferGeometry[] = [];
    const box = (w: number, h: number, d: number, x: number, y: number, z: number) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g; };
    // timber is built long in x so the grain runs along each piece; posts are turned upright
    const timber = (len: number, h: number, d: number, x: number, y: number, z: number, upright = false) => {
      const g = new THREE.BoxGeometry(len, h, d);
      if (upright) g.rotateZ(Math.PI / 2);
      g.translate(x, y, z); return g;
    };
    for (const s of [-1, 1]) {
      wood.push(timber(postLen, POST, POST, s * half, postLen / 2 - SINK, 0, true));
      conc.push(box(FOOT, FOOT_H + SINK, FOOT, s * half, (FOOT_H - SINK) / 2, 0));
    }
    wood.push(timber(beamLen, RAIL_H, RAIL_D, 0, railY, 0));
    for (const f of [-1, -0.5, 0, 0.5, 1]) wood.push(timber(SPACER_W, GAP + 0.02, RAIL_D - 0.04, f * half, gapY, 0));
    wood.push(timber(beamLen, BEAM_H, BEAM_D, 0, beamY, 0));
    // the board stands on the top beam between the posts, its lettering on both faces
    const boardMesh = new THREE.Mesh(box(BOARD_LEN, BOARD_H, BOARD_D, BOARD_X, boardY, 0), this.board);
    boardMesh.name = 'sign board'; boardMesh.castShadow = true; root.add(boardMesh);
    // a little emissive so the white paint still reads bright when the board faces away from the sun, as in the photos
    const letters = boardTexture(l.text, l.sub, BOARD_LEN / BOARD_H);
    const face = new THREE.MeshStandardMaterial({ map: letters, emissiveMap: letters, emissive: 0xa0a0a0, roughness: 0.6 });
    this.materials.push(face);
    for (const s of [1, -1]) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_LEN - 0.02, BOARD_H - 0.02), face);
      plane.position.set(BOARD_X, boardY, s * (BOARD_D / 2 + 0.003));
      if (s < 0) plane.rotation.y = Math.PI;
      plane.name = 'sign lettering'; root.add(plane);
    }
    // snow as in the photos: a thick lumpy pile on the left end of the top beam, a ledge along the
    // beam either side of the board's left half, hanging down the beam's uphill face over its left
    // 40% (what a rider sees from below), a small cap over the right post, a thin line on the board,
    // and a bank burying most of the left footing
    const boardL = BOARD_X - BOARD_LEN / 2, boardR = BOARD_X + BOARD_LEN / 2;
    const pile = (x0: number, x1: number, d: number, h: number, y: number, seed: number, profile?: (t: number) => number) => {
      const g = snowPile(x1 - x0, d, h, seed, profile); g.translate((x0 + x1) / 2, y, 0); snow.push(g);
    };
    pile(-beamLen / 2 - 0.03, boardL + 0.12, BEAM_D + 0.08, 0.42, beamTop, 1.3, (t) => 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.25)));
    pile(boardL, -0.3, BEAM_D + 0.06, 0.12, beamTop, 2.9, (t) => (1 - t) ** 0.7);
    pile(boardR - 0.1, beamLen / 2 + 0.02, BEAM_D + 0.04, 0.13, beamTop, 4.4, (t) => Math.sin(Math.PI * t) ** 0.5);
    pile(boardL + 0.02, boardR - 0.02, BOARD_D + 0.03, 0.05, boardTop, 0.7);
    const drape = (x0: number, x1: number, drop: number, side: number, seed: number, profile: (t: number) => number) => {
      const thick = 0.07, g = snowDrape(x1 - x0, drop, thick, seed, profile);
      g.translate((x0 + x1) / 2, beamTop, side * (BEAM_D / 2 + thick / 2 - 0.01)); snow.push(g);
    };
    const left40 = -beamLen / 2 + 0.4 * beamLen;
    drape(-beamLen / 2 - 0.02, left40, 0.27, 1, 0.4, (t) => (t < 0.35 ? 1 : Math.max(0, 1 - (t - 0.35) / 0.65) ** 0.8));
    drape(-beamLen / 2 - 0.02, boardL, 0.16, -1, 1.9, () => 1);
    const bank = snowBank(1.1, 0.72, 2.2); bank.translate(-half, 0, 0); snow.push(bank);
    const parts: [THREE.BufferGeometry[], THREE.Material, string][] = [[wood, this.wood, 'timber'], [conc, this.concrete, 'footings'], [snow, this.snow, 'snow']];
    for (const [gs, m, name] of parts) {
      const mesh = new THREE.Mesh(mergeGeometries(gs), m);
      mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true;
      root.add(mesh);
    }
    // post positions in pack metres (local +x is across the run)
    const h = l.heading * Math.PI / 180;
    const ax = Math.cos(h), ay = -Math.sin(h); // local +x in pack x/y: 90 deg clockwise from the heading
    const posts: [number, number][] = [[l.x - ax * half, l.y - ay * half], [l.x + ax * half, l.y + ay * half]];
    const seat = { obj: root, posts, res: Infinity };
    this.seats.push(seat);
    this.seat(seat, l);
    if (collider) for (const [px, py] of posts) {
      const z = this.pack.terrainHeight(px, py);
      collider.add(px, py, FOOT / 2 + 0.05, z - 10, z + 10, 0);
    }
    this.group.add(root);
  }

  /** Stand the arch on the lower of the two post grounds, at the finest terrain loaded there. */
  private seat(s: { obj: THREE.Object3D; posts: [number, number][]; res: number }, l: Landmark): void {
    const zs = s.posts.map(([x, y]) => this.pack.terrainHeight(x, y)).filter(Number.isFinite);
    if (!zs.length) return;
    s.res = Math.max(...s.posts.map(([x, y]) => this.pack.finestRes(x, y)));
    s.obj.position.set(l.x, Math.min(...zs), -l.y);
  }

  /** Re-seat once finer terrain arrives; returns a landmark the rider just passed through (once per session). */
  maintain(rx: number, ry: number): Landmark | null {
    let passed: Landmark | null = null;
    for (let i = 0; i < this.list.length; i++) {
      const l = this.list[i], s = this.seats[i];
      const d = Math.hypot(rx - l.x, ry - l.y);
      if (d < 600 && s.res > 1) this.seat(s, l); // the 1 m tiles stream in near the rider
      if (d < l.span && !this.seen.has(l.id)) { this.seen.add(l.id); passed = l; }
    }
    return passed;
  }
}
