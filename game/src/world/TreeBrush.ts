import { SPECIES } from './trees/species';
import { crownProfile } from './trees/generate';
import { treeSnowLoadAt, treeSnowUniforms, TREE_SHED_MAX } from './trees/snow';

/**
 * FEAT-217: snow puffs off the boughs when the rider brushes a tree. Each frame `TreeBrush.update` asks
 * the trees (`Vegetation.crownContact`) for the needled crown the rider's body is deepest in. The first
 * touch of a tree drops a share of the snow on its near side, and riding on through it keeps shaking
 * more down, faster and deeper in; standing still in it drops nothing. What falls goes out through the
 * board's spray ring (`Spray.emit`, so no draw call of its own): clumps that fall from bough height and
 * a fine cloud that hangs and drifts, started on the near side of the crown from the contact height to
 * 1.6 m above it, carried a little along with the rider.
 *
 * How much: the tree's snow load (`treeSnowLoadAt`, the one the shader draws; nothing under LOAD_FROM,
 * so none on a spring day, the most on a snow ghost) less what has melted off its sun side, times its
 * size. A tree remembers what it has shed (SHED_KEEP trees at most) and builds back to full over
 * RECOVER_S, so a second pass through the same tree drops less. Aspen and snags hold no snow.
 *
 * The unload: the TREE_SHED_MAX shaken trees nearest the rider go to the tree shader (`uTreeShed`,
 * trees/snow.ts), which draws each one bare on the side the snow fell from, from just under the contact
 * height to about 2.5 m over it, filling back in as the tree builds back. Only the mesh LODs show it (the far
 * ones are past 400 m).
 */

/** a needled crown the rider is in (pack metres), from `crownContact` */
export interface CrownHit {
  /** the tree's base and height (m) */
  x: number; y: number; z: number; h: number;
  /** its drawn crown radius (m) and kit species */
  cr: number; species: number;
  /** 0 (at the crown's edge) .. 1 (CONTACT_DEEP m in, or more) */
  overlap: number;
  /** the height (world z) of the body sample that is deepest in, and the crown's radius there */
  at: number; r: number;
}

/** the trees the rider can brush */
export interface CrownSource { crownContact(x: number, y: number, z: number, out: CrownHit): boolean }
/** where the snow goes (Spray): three.js metres */
export interface PuffSink {
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, kind: number): void;
  commit(): void;
}
/** the rider: pack metres and m/s */
export interface BrushRider { x: number; y: number; z: number; vx: number; vy: number; vz: number }

/** heights on the body (m above the board) tested against the crown, and its half width (m) */
const BODY = [0.3, 0.9, 1.6], HALF_W = 0.35;
/** this far inside the crown's edge counts as fully in (m) */
const CONTACT_DEEP = 0.8;
/** the species that hold snow (aspen and snags have no needles) */
const HOLDS = SPECIES.map((s) => s.form !== 'aspen' && s.form !== 'snag');
/** no puff below this load (a spring day's 0.1), full from LOAD_FULL */
const LOAD_FROM = 0.15, LOAD_FULL = 0.75;
/** the share of the near side's snow the first touch drops (at full overlap and speed), and the share a second riding on through it */
const ENTRY = 0.45, RATE = 1.6;
/** particles from shedding all the near-side snow of a full-loaded tree with a 2 m crown */
const FULL = 320;
/** most particles in one frame */
const FRAME_CAP = 96;
/** the shed snow builds back over this many seconds; the most trees remembered */
const RECOVER_S = 240, SHED_KEEP = 256;
/** clumps' share of the particles (the rest is the fine cloud) */
const CLUMPS = 0.6;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number): number => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * 0..1 how deep a rider at (x, y, z) (the board, pack metres) is in the crown of a tree of kit species
 * `sp`, base (tx, ty, tz), height h and crown radius cr; writes the contact height and the crown's radius
 * there into `out` (when it returns more than 0). The crown is the generator's profile from its base
 * (the species' crownBase) to the top.
 */
export function crownOverlap(sp: number, tx: number, ty: number, tz: number, h: number, cr: number, x: number, y: number, z: number, out: CrownHit): number {
  if (!HOLDS[sp] || h <= 0) return 0;
  const d = Math.hypot(x - tx, y - ty);
  if (d >= cr + HALF_W) return 0;
  const s = SPECIES[sp], base = s.crownBase;
  let best = 0;
  for (const b of BODY) {
    const t = ((z + b - tz) / h - base) / (1 - base);
    if (t < 0 || t > 1) continue;
    const r = cr * crownProfile(s.form, t), o = clamp01((r + HALF_W - d) / CONTACT_DEEP);
    if (o > best) { best = o; out.at = z + b; out.r = r; }
  }
  return best;
}

/** what a tree remembers: the share of its near-side snow left and when, its base (pack x / y), the near side (unit) and the contact height above its drawn base (m) */
interface Shed { left: number; t: number; x: number; y: number; dx: number; dy: number; at: number }

/** a stable id for a tree from its base (pack metres, 0.25 m) */
const treeId = (x: number, y: number): number => (Math.round(x * 4) + 2e5) * 1e6 + Math.round(y * 4) + 2e5;

export class TreeBrush {
  /** particles released in the last update, and in all (checks) */
  released = 0;
  total = 0;
  private readonly hit: CrownHit = { x: 0, y: 0, z: 0, h: 0, cr: 0, species: 0, overlap: 0, at: 0, r: 0 };
  /** the tree in contact last frame (-1 none) */
  private cur = -1;
  /** per tree: the share of its near-side snow left when last touched, and when */
  private readonly shed = new Map<number, Shed>();
  /** the same for a replay, which starts from the trees as they are and leaves the live memory alone */
  private readonly replayShed = new Map<number, Shed>();
  private wasLive = true;
  /** the memory drawn on the trees: the live one, or the replay's while it plays */
  private drawn = this.shed;
  private readonly near: { d: number; s: Shed; gone: number }[] = [];
  private time = 0;
  private acc = 0;

  constructor(private readonly trees: CrownSource, private readonly sink: PuffSink) {}

  /** the share of a tree's near-side snow left (1 untouched or built back) */
  left(x: number, y: number, mem = this.shed): number {
    const s = mem.get(treeId(x, y));
    return s ? Math.min(1, s.left + (this.time - s.t) / RECOVER_S) : 1;
  }

  /**
   * Per frame, after the spray's update (the render pose). `active` false (on a lift, the camera
   * detached) only runs the clock; `live` false (a replay or the rewind playing back) shakes the trees
   * without taking their snow, so a replayed pass drops what the live one did. Returns how hard a puff
   * started this frame (0..1, for the thump).
   */
  update(r: BrushRider, dt: number, active = true, live = true): number {
    this.time += dt;
    this.released = 0;
    if (!live && this.wasLive) this.replayShed.clear();
    this.wasLive = live;
    const mem = live ? this.shed : this.replayShed;
    if (active) this.drawn = mem;
    const k = this.brush(r, dt, active, mem);
    this.show(r);
    return k;
  }

  private brush(r: BrushRider, dt: number, active: boolean, mem: Map<number, Shed>): number {
    const hit = this.hit;
    if (!active || !this.trees.crownContact(r.x, r.y, r.z, hit)) { this.cur = -1; this.acc = 0; return 0; }
    const id = treeId(hit.x, hit.y), entry = id !== this.cur;
    this.cur = id;
    const sp = Math.hypot(r.vx, r.vy, r.vz);
    const move = clamp01(0.2 + sp / 10);
    const frac = entry ? ENTRY * (0.5 + 0.5 * hit.overlap) * move : RATE * hit.overlap * move * clamp01(sp / 3) * dt;
    const left = this.left(hit.x, hit.y, mem), drop = left * Math.min(1, frac);
    if (drop <= 0) return 0;
    this.remember(mem, id, left - drop, drop, r, hit);
    const load = treeSnowLoadAt(hit.x, hit.y, hit.z), melt = treeSnowUniforms.uTreeSnow.value.y;
    const snow = smooth(LOAD_FROM, LOAD_FULL, load) * (1 - 0.5 * melt) * Math.max(0.6, Math.min(1.6, hit.cr / 2));
    this.acc += drop * snow * FULL;
    let n = Math.min(FRAME_CAP, Math.floor(this.acc));
    this.acc = Math.min(FRAME_CAP, this.acc - n);
    if (n > 0) this.puff(r, hit, n);
    return entry ? clamp01(drop * snow * 2.5) : 0;
  }

  private remember(mem: Map<number, Shed>, id: number, left: number, drop: number, r: BrushRider, hit: CrownHit): void {
    // the near side and height: the last shed's, blended with what the tree already lost so a second side adds to the first
    let dx = r.x - hit.x, dy = r.y - hit.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.05) { dx /= d; dy /= d; } else { dx = 1; dy = 0; }
    let at = hit.at - (hit.z - 0.3); // above the drawn base (Vegetation puts it 0.3 m under the ground)
    const old = mem.get(id);
    if (old) {
      const gone = Math.max(0, 1 - (old.left + (this.time - old.t) / RECOVER_S)), w = gone / (gone + drop);
      const bx = old.dx * w + dx * (1 - w), by = old.dy * w + dy * (1 - w), bl = Math.hypot(bx, by);
      if (bl > 0.05) { dx = bx / bl; dy = by / bl; }
      at = old.at * w + at * (1 - w);
    }
    mem.delete(id); // re-inserted last: the map keeps the most recent at the end
    mem.set(id, { left, t: this.time, x: hit.x, y: hit.y, dx, dy, at });
    if (mem.size > SHED_KEEP) for (const k of mem.keys()) { mem.delete(k); break; }
  }

  /** the shaken trees nearest the rider to the tree shader (uTreeShed: three.js x, z) */
  private show(r: BrushRider): void {
    const near = this.near;
    let m = 0;
    for (const s of this.drawn.values()) {
      const gone = 1 - Math.min(1, s.left + (this.time - s.t) / RECOVER_S);
      if (gone <= 0.01) continue;
      const e = near[m] ??= { d: 0, s, gone: 0 };
      e.d = Math.hypot(s.x - r.x, s.y - r.y); e.s = s; e.gone = gone; m++;
    }
    near.length = m;
    if (m > TREE_SHED_MAX) near.sort((a, b) => a.d - b.d);
    const u = treeSnowUniforms.uTreeShed.value, n = Math.min(TREE_SHED_MAX, m);
    for (let i = 0; i < n; i++) {
      const s = near[i].s;
      u[2 * i].set(s.x, -s.y, near[i].gone, s.at);
      u[2 * i + 1].set(s.dx, -s.dy, 0, 0);
    }
    treeSnowUniforms.uTreeShedN.value = n;
  }

  /** n particles off the near side of the crown, from the contact height up */
  private puff(r: BrushRider, hit: CrownHit, n: number): void {
    let ux = r.x - hit.x, uy = r.y - hit.y;
    const d = Math.hypot(ux, uy);
    if (d > 0.05) { ux /= d; uy /= d; } else { ux = 1; uy = 0; }
    const s = SPECIES[hit.species], base = s.crownBase, top = hit.z + hit.h;
    for (let i = 0; i < n; i++) {
      const pz = Math.min(top - 0.1, hit.at - 0.2 + 1.8 * Math.random());
      const t = clamp01(((pz - hit.z) / hit.h - base) / (1 - base));
      const rr = hit.cr * crownProfile(s.form, t) * (0.55 + 0.45 * Math.random());
      const side = (Math.random() - 0.5) * 1.6;
      const px = hit.x + ux * rr - uy * side, py = hit.y + uy * rr + ux * side;
      const out = Math.random();
      if (Math.random() < CLUMPS) {
        // a clump: knocked out toward the rider and along with them, then falls (the spray's wisp settling)
        const keep = 0.2 + 0.2 * Math.random(), o = 0.3 + 0.9 * out;
        this.sink.emit(px, pz, -py, ux * o + r.vx * keep, -0.6 + 1.2 * Math.random() + r.vz * keep * 0.5, -(uy * o + r.vy * keep),
          0.9 + 0.7 * Math.random(), 0.16 + 0.12 * Math.random() + (Math.random() < 0.15 ? 0.12 : 0), 0);
      } else {
        // the fine cloud: slow, hangs and drifts on the wind
        const keep = 0.08 + 0.1 * Math.random();
        this.sink.emit(px, pz, -py, ux * 0.4 * out + r.vx * keep + (Math.random() - 0.5) * 0.6, 0.2 + 0.6 * Math.random(), -(uy * 0.4 * out + r.vy * keep) + (Math.random() - 0.5) * 0.6,
          2 + 1.5 * Math.random(), 0.35 + 0.25 * Math.random(), 1);
      }
    }
    this.released = n; this.total += n;
    this.sink.commit();
  }
}
