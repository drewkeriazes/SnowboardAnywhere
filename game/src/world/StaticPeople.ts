import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';
import type { Ground } from '../terrain/Terrain';
import { OUTFIT_PRESETS } from '../ui/Settings';
import { planPeople, type PlannedPerson } from './people/plan';
import { Bake, bakeSitter, bakeSkier, type Outfit } from './people/models';

/**
 * FEAT-307: static people on the runs, for realism and laughs: a pair of skiers stopped across the fall line
 * facing each other, chatting (off to one side of the run; 1 in 10 pairs dead centre, so you have to go
 * round), and a lone snowboarder sitting on the snow facing downhill. Sparse: 0 to 2 per run, many runs none
 * (`people/plan.ts`, seeded per run from features.json, so a run always has the same people). Never near a
 * lift's line or stations, the Free ride start, the landmarks, or on a run named as a terrain park.
 *
 * A planned spot becomes a person once the rider comes within PLACE_R and its mask and 1 m terrain are in:
 * the run's real middle and edges from the groomed mask (the OSM line is not always central), then the spot
 * (the middle, or out toward the planned side) is checked: not in the trees or on rock, not steeper than a
 * person would stop on, not just below a rollover (where a jump would land), clear of the trunks, walls
 * and ropes in the collider. A spot that fails tries the other side, then nearer the middle, then is dropped.
 *
 * Each person is the rider's own rig posed once and baked to a single vertex-coloured mesh (`people/models.ts`):
 * one draw call per pair or sitter, one shared material, nothing animated. Meshes exist only within SHOW_R of
 * the rider and cast shadows within SHADOW_R. Each person is a few cylinders in the collider (a hard obstacle,
 * like a trunk: a square hit at speed crashes). `visible` hides them and takes their colliders out (a later
 * Nature mode, FEAT-309, or a People setting shared with FEAT-308's ghost riders). `?people=center` makes every spot a pair across the
 * middle of its run and `?people=sitters` every spot a sitting snowboarder (the same spots both ways); `?people=off`
 * turns them off.
 */

/** a spot is settled within this distance of the rider (m), once its mask and 1 m terrain are in */
const PLACE_R = 450;
/** meshes are built inside SHOW_R and dropped past DROP_R (m); shadows inside SHADOW_R */
const SHOW_R = 450, DROP_R = 650, SHADOW_R = 200;
/** groomed mask share that counts as the run, how far to look for its edges, the half width taken when it isn't groomed (m) */
const GROOMED = 0.35, EDGE_SEARCH = 60, DEFAULT_HALF = 10, MIN_HALF = 5, MAX_HALF = 40;
/** a spot off to the side stands at least this far from the middle (m) */
const MIN_SIDE = 4;
/** steepest snow a pair / a sitter stops on (deg); a rollover just above (the slope 12 m uphill this much flatter) is a landing (deg) */
const MAX_SLOPE_PAIR = 28, MAX_SLOPE_SIT = 32, ROLLOVER = 8;
/** canopy and rock shares in the mask that rule a spot out */
const MAX_CANOPY = 0.25, MAX_ROCK = 0.3;
/** settled spots per frame (each reads a few hundred mask samples) and meshes baked per frame */
const PER_FRAME = 2;

/** a pair: each skier this far along the contour from the middle, and this far up / down the fall line (m) */
const PAIR_HALF = 0.78, PAIR_STAGGER = 0.24;

/** a collider part: offset from the spot (pack metres), radius, top above the snow */
interface Part { x: number; y: number; r: number; top: number }

interface Spot {
  plan: PlannedPerson;
  state: 'planned' | 'placed' | 'dropped';
  /** where it stands (pack metres) and the snow height there */
  x: number; y: number; z: number;
  /** the fall line (unit, pack x / y) and the slope (radians) */
  fx: number; fy: number; slope: number;
  /** the terrain resolution it was seated on (re-seated when finer arrives) */
  res: number;
  /** pair: +1 / -1, which way along the contour the first skier faces */
  turn: number;
  mesh: THREE.Mesh | null;
  parts: Part[];
  cyl: Float32Array[];
  /** each cylinder's real base and top (hidden, they drop below any rider) */
  tops: [number, number][];
}

export type PeopleMode = 'on' | 'center' | 'sitters' | 'off';

export function parsePeopleMode(v: string | null): PeopleMode {
  return v === 'center' || v === 'sitters' ? v : v === 'off' || v === '0' ? 'off' : 'on';
}

const OUTFITS = Object.values(OUTFIT_PRESETS);

export class StaticPeople {
  readonly group = new THREE.Group();
  readonly material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  readonly spots: Spot[];
  /** BUG-088: the terrain; a person is first built once the ground drawn under it has its real heights (null: at once) */
  ground: Ground | null = null;
  private _visible = true;
  private readonly maskTmp = [0, 0, 0, 0];
  private readonly frame = new THREE.Matrix4();
  private readonly tmpM = new THREE.Matrix4();

  constructor(private readonly pack: Pack, private readonly collider: Collider | null, mode: PeopleMode = 'on', avoid: [number, number][] = []) {
    this.group.name = 'static people';
    const plan = mode === 'off' ? [] : planPeople(pack.features, pack.meta.slug, { force: mode === 'on' ? undefined : mode, avoid });
    this.spots = plan.map((p) => ({ plan: p, state: 'planned', x: p.x, y: p.y, z: p.z, fx: p.dx, fy: p.dy, slope: 0, res: Infinity, turn: p.seed < 0.5 ? 1 : -1, mesh: null, parts: [], cyl: [], tops: [] }));
    if (mode === 'off') this._visible = false;
    this.group.visible = this._visible;
  }

  /** FEAT-309's Nature mode (or a People setting with FEAT-308's ghost riders) hides them; hidden, they are not in the collider either */
  get visible(): boolean { return this._visible; }
  set visible(on: boolean) {
    if (on === this._visible) return;
    this._visible = on;
    this.group.visible = on;
    for (const s of this.spots) this.setCollider(s);
  }

  /** counts for the tools (tools/peoplecheck.mjs, __sim.people) */
  get stats(): { planned: number; placed: number; dropped: number; shown: number; pairs: number; centre: number; sitters: number } {
    let placed = 0, dropped = 0, shown = 0, pairs = 0, centre = 0, sitters = 0;
    for (const s of this.spots) {
      if (s.state === 'placed') placed++; else if (s.state === 'dropped') dropped++;
      if (s.mesh?.visible) shown++;
      if (s.plan.kind === 'pair') { pairs++; if (s.plan.center) centre++; } else sitters++;
    }
    return { planned: this.spots.length, placed, dropped, shown, pairs, centre, sitters };
  }

  /** Every frame: settle the spots coming into range, build or drop meshes by distance, re-seat on finer terrain. */
  maintain(rx: number, ry: number): void {
    if (!this.spots.length) return;
    let budget = PER_FRAME;
    for (const s of this.spots) {
      if (s.state === 'dropped') continue;
      const d = Math.hypot(rx - s.x, ry - s.y);
      if (s.state === 'planned') {
        if (d > PLACE_R || budget <= 0) continue;
        const r = this.settle(s);
        if (r === 'wait') continue;
        budget--;
        if ((s.state as Spot['state']) !== 'placed') continue; // settle() may have dropped it
      }
      if (d > DROP_R) { this.dropMesh(s); continue; }
      if (d > SHOW_R) continue;
      // build, or rebuild once finer terrain has loaded under it
      const res = this.pack.finestRes(s.x, s.y);
      if (!s.mesh || res < s.res) {
        if (budget <= 0) continue;
        if (!s.mesh && this.ground && !this.ground.groundReady(s.x - 4, s.y - 4, s.x + 4, s.y + 4)) continue; // BUG-088
        budget--;
        this.seat(s);
        this.build(s);
      }
      if (s.mesh) s.mesh.castShadow = d < SHADOW_R;
    }
  }

  /** the snow's fall line and slope at (x, y) from a 3 m difference of the DEM (not the mogul bumps); null under 3 deg (flat) */
  private fall(x: number, y: number): { fx: number; fy: number; slope: number } | null {
    const h = (px: number, py: number) => this.pack.demHeight(px, py), e = 3;
    const gx = (h(x + e, y) - h(x - e, y)) / (2 * e), gy = (h(x, y + e) - h(x, y - e)) / (2 * e);
    const g = Math.hypot(gx, gy);
    if (g < Math.tan(3 * Math.PI / 180)) return null;
    return { fx: -gx / g, fy: -gy / g, slope: Math.atan(g) };
  }

  private groomed(x: number, y: number): number {
    return this.pack.mask ? this.pack.mask.sample(x, y, this.maskTmp)[2] : 0;
  }

  /** Find the run's middle and the spot, or drop it (see the class comment). 'wait' while its tiles are not in. */
  private settle(s: Spot): 'wait' | 'done' {
    const p = s.plan, pack = this.pack, mask = pack.mask;
    // the run across the line here: right of its direction is (dy, -dx)
    const nx = p.dy, ny = -p.dx;
    // the mask and the 1 m terrain over the whole span the edges are looked for in
    const tilesIn = [-EDGE_SEARCH, 0, EDGE_SEARCH].every((o) => {
      const x = p.x + nx * o, y = p.y + ny * o;
      const fine = pack.fine;
      return (!mask || !mask.contains(x, y) || mask.has(x, y)) && (!fine || !fine.contains(x, y) || !Number.isNaN(fine.sampleNearest(x, y)));
    });
    if (!tilesIn) return 'wait';
    let mid = 0, half = DEFAULT_HALF;
    if (this.groomed(p.x, p.y) >= GROOMED) {
      let l = 0, r = 0;
      while (r < EDGE_SEARCH && this.groomed(p.x + nx * (r + 1), p.y + ny * (r + 1)) >= GROOMED) r++;
      while (l < EDGE_SEARCH && this.groomed(p.x - nx * (l + 1), p.y - ny * (l + 1)) >= GROOMED) l++;
      mid = (r - l) / 2;
      half = Math.max(MIN_HALF, Math.min(MAX_HALF, (r + l) / 2));
    }
    const offs = p.center ? [mid] : [p.side, -p.side].map((sd) => mid + sd * Math.max(MIN_SIDE, p.frac * half)).concat([mid + p.side * Math.max(MIN_SIDE, 0.35 * half)]);
    for (const o of offs) {
      const x = p.x + nx * o, y = p.y + ny * o;
      if (this.ok(s, x, y)) { s.x = x; s.y = y; s.state = 'placed'; this.seat(s); return 'done'; }
    }
    s.state = 'dropped';
    return 'done';
  }

  /** Can a person stop here? */
  private ok(s: Spot, x: number, y: number): boolean {
    const pack = this.pack;
    if (pack.mask) {
      const m = pack.mask.sample(x, y, this.maskTmp);
      if (m[3] > MAX_CANOPY || m[0] > MAX_ROCK) return false;
    }
    const f = this.fall(x, y);
    const deg = f ? f.slope * 180 / Math.PI : 0;
    if (deg > (s.plan.kind === 'pair' ? MAX_SLOPE_PAIR : MAX_SLOPE_SIT)) return false;
    if (f) {
      // just below a rollover: where a rider coming over it lands
      for (const up of [8, 14]) {
        const u = this.fall(x - f.fx * up, y - f.fy * up);
        const du = u ? u.slope * 180 / Math.PI : 0;
        if (deg - du > ROLLOVER) return false;
      }
    }
    const z = pack.terrainHeight(x, y);
    if (this.collider?.blocked(x, y, z, 2)) return false;
    if (Number.isFinite(this.collider?.floorAt(x, y, z, 3) ?? -Infinity)) return false; // a roof or a deck
    return true;
  }

  /** The snow height, fall line and collider parts at its spot, on the terrain loaded now. */
  private seat(s: Spot): void {
    const p = s.plan, pack = this.pack;
    s.res = pack.finestRes(s.x, s.y);
    s.z = pack.terrainHeight(s.x, s.y);
    const f = this.fall(s.x, s.y);
    if (f) { s.fx = f.fx; s.fy = f.fy; s.slope = f.slope; } else { s.fx = p.dx; s.fy = p.dy; s.slope = 0; }
    const cx = -s.fy * s.turn, cy = s.fx * s.turn; // along the contour
    if (p.kind === 'pair') {
      s.parts = [
        { x: -cx * PAIR_HALF - s.fx * PAIR_STAGGER, y: -cy * PAIR_HALF - s.fy * PAIR_STAGGER, r: 0.45, top: 1.8 },
        { x: cx * PAIR_HALF + s.fx * PAIR_STAGGER, y: cy * PAIR_HALF + s.fy * PAIR_STAGGER, r: 0.45, top: 1.8 },
        { x: 0, y: 0, r: 0.45, top: 0.35 }, // the ski tips between them
      ];
    } else {
      s.parts = [
        { x: s.fx * 0.2, y: s.fy * 0.2, r: 0.45, top: 1.1 },
        { x: s.fx * 0.62 + cx * 0.6, y: s.fy * 0.62 + cy * 0.6, r: 0.3, top: 0.35 }, // the board's ends
        { x: s.fx * 0.62 - cx * 0.6, y: s.fy * 0.62 - cy * 0.6, r: 0.3, top: 0.35 },
      ];
    }
    if (!this.collider) return;
    for (const c of s.cyl) this.collider.remove(c);
    // kind 0: a hard obstacle, like a trunk; the real base and top kept for setCollider
    s.tops = s.parts.map((q) => { const g = pack.terrainHeight(s.x + q.x, s.y + q.y); return [g - 1, g + q.top]; });
    s.cyl = s.parts.map((q, i) => this.collider!.add(s.x + q.x, s.y + q.y, q.r, s.tops[i][0], s.tops[i][1], 0));
    this.setCollider(s);
  }

  private setCollider(s: Spot): void {
    s.cyl.forEach((c, i) => {
      const t = s.tops[i];
      c[3] = this._visible ? t[0] : -Infinity; c[4] = this._visible ? t[1] : -Infinity;
    });
  }

  /** Bake its mesh (one geometry: both skiers of a pair, or the sitter), in three.js space at its spot. */
  private build(s: Spot): void {
    this.dropMesh(s);
    const p = s.plan, bake = new Bake();
    const outfit = (k: number): Outfit => OUTFITS[Math.floor(((p.seed * 997 + k * 0.618) % 1) * OUTFITS.length) % OUTFITS.length];
    if (p.kind === 'pair') {
      const cx = -s.fy * s.turn, cy = s.fx * s.turn;
      for (const k of [0, 1]) {
        const sg = k === 0 ? -1 : 1;
        const px = sg * (cx * PAIR_HALF + s.fx * PAIR_STAGGER), py = sg * (cy * PAIR_HALF + s.fy * PAIR_STAGGER);
        const pz = this.pack.terrainHeight(s.x + px, s.y + py) - s.z;
        // the first faces along the contour toward the second, the second back at the first
        const hx = -sg * cx, hy = -sg * cy;
        const rx = hy, ry = -hx; // its right, in pack x / y
        const downhill = rx * s.fx + ry * s.fy >= 0 ? 1 : -1;
        this.frame.makeRotationY(Math.atan2(-hx, hy)).setPosition(px, pz + 0.02, -py); // the skis just on the snow (the drawn terrain is not quite the sampled one)
        bakeSkier(bake, this.frame, outfit(k), s.slope, downhill, (k === 0 ? 1 : -1) * 0.12 * (p.seed - 0.5));
      }
    } else {
      this.frame.makeRotationY(Math.atan2(s.fy, s.fx)).setPosition(0, -0.02, 0);
      bakeSitter(bake, this.frame, outfit(0), s.slope);
    }
    const mesh = new THREE.Mesh(bake.geometry(), this.material);
    mesh.name = p.kind === 'pair' ? 'skier pair' : 'sitting snowboarder';
    mesh.position.set(s.x, s.z, -s.y);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    s.mesh = mesh;
    this.group.add(mesh);
  }

  private dropMesh(s: Spot): void {
    if (!s.mesh) return;
    this.group.remove(s.mesh);
    s.mesh.geometry.dispose();
    s.mesh = null;
  }

  /** where the settled people stand, for the tools: pack metres, the fall line and the kind */
  list(): { id: string; kind: string; center: boolean; run: string | null; x: number; y: number; z: number; fx: number; fy: number; slope: number; shown: boolean }[] {
    return this.spots.filter((s) => s.state === 'placed').map((s) => ({ id: s.plan.id, kind: s.plan.kind, center: s.plan.center, run: s.plan.runName, x: s.x, y: s.y, z: s.z, fx: s.fx, fy: s.fy, slope: s.slope * 180 / Math.PI, shown: !!s.mesh?.visible && this._visible }));
  }

  dispose(): void {
    for (const s of this.spots) { this.dropMesh(s); if (this.collider) for (const c of s.cyl) this.collider.remove(c); s.cyl = []; }
    this.material.dispose();
  }
}
