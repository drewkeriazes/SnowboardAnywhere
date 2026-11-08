import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';

/**
 * Landmarks (FEAT-132): hand-placed iconic signs and spots that OSM doesn't carry, listed per
 * resort below in pack metres (x east, y north). A `gateway` is a timber arch you ride under: two
 * square posts on concrete footings, a heavy crossbeam, and a long black board on top with white
 * capitals, snow piled on the board and the beam. Lettering is our own (a condensed sans and a
 * plain mountain mark), no resort logos. The posts are collider trunks; the posts and footings
 * re-seat on the ground once the 1 m terrain under them has loaded.
 */
export interface Landmark {
  id: string;
  kind: 'gateway';
  name: string;
  /** pack metres of the arch's centre */
  x: number; y: number;
  /** the direction riders pass through it, degrees clockwise from north; the lettering faces riders coming that way */
  heading: number;
  /** distance between the post centres and the height of the beam's underside (m) */
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
      // On Forever just below the summit hub (the tops of Mountaintop, Northwoods and High Noon at
      // 3,429 m, the "ELEV 11,250" on the sign), where the ridge drops south into the bowls.
      x: -736.4, y: 487.8, heading: 162, span: 5.0, clearance: 3.6,
      text: 'THE LEGENDARY BACK BOWLS', sub: ['ELEV', '11,250'],
      source: "Drew's photo; position from the summit lift tops at 3,429 m and the run Forever",
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

const POST = 0.36; // square post (m)
const BEAM_H = 0.42, BEAM_D = 0.4, BEAM_OVER = 0.55; // crossbeam height, depth, overhang past each post
const BOARD_H = 0.62, BOARD_D = 0.12; // the black sign board on top of the beam
const FOOT = 0.7, FOOT_H = 0.8; // concrete footing around each post's base (m), showing above the snow
const SINK = 1.5; // posts run this far below the ground sample so they never float

/** Board lettering: black, a white mountain mark at the left, the name in condensed caps, the small block at the right. */
function boardTexture(text: string, sub: [string, string] | undefined, aspect: number): THREE.CanvasTexture {
  const H = 128, W = Math.round(H * aspect);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#121418'; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 3; g.strokeRect(4, 4, W - 8, H - 8);
  g.fillStyle = '#f4f2ec';
  // mark: two overlapping peaks in a diamond, our own (not a resort logo)
  const m = H * 0.5, mx = H * 0.62;
  g.save(); g.translate(mx, m); g.rotate(Math.PI / 4); g.fillRect(-H * 0.24, -H * 0.24, H * 0.48, H * 0.48); g.restore();
  g.fillStyle = '#121418';
  g.beginPath(); g.moveTo(mx - H * 0.26, m + H * 0.1); g.lineTo(mx - H * 0.06, m - H * 0.14); g.lineTo(mx + H * 0.04, m - H * 0.02); g.lineTo(mx + H * 0.12, m - H * 0.1); g.lineTo(mx + H * 0.28, m + H * 0.1); g.closePath(); g.fill();
  g.fillStyle = '#f4f2ec';
  // the small block at the right end
  let right = W - H * 0.25;
  if (sub) {
    g.font = `bold ${H * 0.22}px "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const bw = Math.max(g.measureText(sub[0]).width, g.measureText(sub[1]).width);
    const bx = W - H * 0.2 - bw / 2;
    g.fillText(sub[0], bx, H * 0.36); g.fillText(sub[1], bx, H * 0.64);
    right = bx - bw / 2 - H * 0.3;
  }
  // the name, squeezed horizontally to fit between the mark and the block
  const left = mx + H * 0.5;
  g.font = `bold ${H * 0.62}px "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = 'left'; g.textBaseline = 'middle';
  const tw = g.measureText(text).width, room = right - left;
  g.save(); g.translate(left, H * 0.54); g.scale(Math.min(1, room / tw), 1); g.fillText(text, 0, 0); g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/** A lumpy snow cap along the top of a box (local x along the length). */
function snowCap(len: number, depth: number, h: number, seed: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(len, h, depth + 0.06, Math.max(4, Math.round(len * 3)), 2, 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    if (y > 0) {
      const bump = 0.5 + 0.5 * Math.sin(x * 2.3 + seed) * Math.sin(x * 0.9 + seed * 2);
      const edge = Math.min(1, (len / 2 - Math.abs(x)) / 0.25); // taper at the ends
      p.setY(i, y * (0.4 + 0.9 * bump) * Math.max(0.2, edge));
    }
  }
  g.computeVertexNormals();
  return g;
}

export class Landmarks {
  readonly group = new THREE.Group();
  readonly list: Landmark[];
  readonly materials: THREE.Material[];
  private readonly wood = new THREE.MeshStandardMaterial({ color: 0x5a4130, roughness: 0.92 });
  private readonly concrete = new THREE.MeshStandardMaterial({ color: 0x6f6e6a, roughness: 0.95 });
  private readonly board = new THREE.MeshStandardMaterial({ color: 0x121418, roughness: 0.7 });
  private readonly snow = new THREE.MeshStandardMaterial({ color: 0xf6f8fb, roughness: 0.85 });
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
    const half = l.span / 2;
    const beamY = l.clearance + BEAM_H / 2, beamLen = l.span + POST + 2 * BEAM_OVER;
    const postLen = l.clearance + BEAM_H + SINK;
    const wood: THREE.BufferGeometry[] = [], conc: THREE.BufferGeometry[] = [], snow: THREE.BufferGeometry[] = [];
    const box = (w: number, h: number, d: number, x: number, y: number, z: number) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g; };
    for (const s of [-1, 1]) {
      wood.push(box(POST, postLen, POST, s * half, postLen / 2 - SINK, 0));
      conc.push(box(FOOT, FOOT_H + SINK, FOOT, s * half, (FOOT_H - SINK) / 2, 0));
    }
    wood.push(box(beamLen, BEAM_H, BEAM_D, 0, beamY, 0));
    // the board sits on the beam, a little shorter, its lettering on both faces
    const boardLen = beamLen - 0.2, boardY = l.clearance + BEAM_H + BOARD_H / 2;
    const boardMesh = new THREE.Mesh(box(boardLen, BOARD_H, BOARD_D, 0, boardY, 0), this.board);
    boardMesh.name = 'sign board'; boardMesh.castShadow = true; root.add(boardMesh);
    const face = new THREE.MeshStandardMaterial({ map: boardTexture(l.text, l.sub, boardLen / BOARD_H), roughness: 0.6 });
    this.materials.push(face);
    for (const s of [1, -1]) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(boardLen - 0.04, BOARD_H - 0.04), face);
      plane.position.set(0, boardY, s * (BOARD_D / 2 + 0.003));
      if (s < 0) plane.rotation.y = Math.PI;
      plane.name = 'sign lettering'; root.add(plane);
    }
    // snow piled on the board and on the beam ends, deeper at the left end like the photo
    const cap = snowCap(boardLen, BOARD_D, 0.16, 1.7); cap.translate(0, boardY + BOARD_H / 2 + 0.05, 0); snow.push(cap);
    for (const s of [-1, 1]) {
      const end = snowCap(BEAM_OVER + POST, BEAM_D, s < 0 ? 0.3 : 0.14, 3 + s); end.translate(s * (beamLen / 2 - (BEAM_OVER + POST) / 2), beamY + BEAM_H / 2 + 0.06, 0); snow.push(end);
    }
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
