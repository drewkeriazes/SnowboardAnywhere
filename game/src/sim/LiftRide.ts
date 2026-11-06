import * as THREE from 'three';
import type { Rider } from './Rider';
import type { Pack } from '../pack/Pack';
import type { Collider } from './Collider';
import { LOAD_OFFSET, type LiftRuntime, type Lifts } from '../world/Lifts';

/**
 * Riding a lift back up. Near a bottom terminal and slow, pressing the board key puts the rider
 * on a chair; the rider then follows the cable at chair speed. Pressing the key again skips to
 * the top; lifts run at RIDE_SPEEDUP x real speed and holding the tuck key multiplies that by FAST_FORWARD. At the top the rider is placed a few metres past the terminal, facing downhill.
 */
export const PROMPT_RANGE = 60; // m: show the boarding card
export const BOARD_RANGE = 14; // m: can press E
export const BOARD_SPEED = 6; // m/s
export const RIDE_SPEEDUP = 4; // real lift speeds feel far too slow in a game: ride at 4x
export const FAST_FORWARD = 5; // extra multiplier while the tuck key is held (20x real)
const UNLOAD_CLEAR = 1.5; // m: unload spot keeps this far from walls, trunks and rocks
const UNLOAD_RUN = 10; // m: and has this much clear snow straight downhill
const UNLOAD_SEARCH = 60; // m: furthest the unload spot may move from the nominal point
const UNLOAD_MIN_SLOPE = 4; // degrees: preferred minimum slope at the unload spot

export class LiftRide {
  lift: LiftRuntime | null = null;
  up = 0; // metres travelled from the bottom terminal
  /** nearest boardable lift within PROMPT_RANGE (for the prompt card), and its distance */
  nearby: LiftRuntime | null = null;
  nearbyDist = Infinity;
  /** cable height at the rider's position along the line (for the rider's own chair hanger) */
  cableY = 0;
  /** true on the frame the chair passes a tower (for the clunk sound) */
  passedTower = false;
  /** true when the current lift carries the rider above the snow (chair, gondola) */
  get airborneRide(): boolean { return !!this.lift && (this.lift.kind === 'chair' || this.lift.kind === 'gondola'); }
  /** true when `nearby` is close and slow enough to board */
  canBoard = false;
  /** reason shown when in range but not boardable: 'fast' | 'air' | '' */
  blocker: 'fast' | 'air' | '' = '';
  private readonly seat = new THREE.Vector3();
  private readonly seat2 = new THREE.Vector3();

  constructor(private readonly pack: Pack, private readonly lifts: Lifts, private readonly collider: Collider | null = null) {}

  get riding(): boolean { return this.lift !== null; }

  /** Call every frame before the physics step. Returns true when the rider is on a lift (physics skipped). */
  /** true while fast-forwarding (for the prompt) */
  fast = false;

  update(rider: Rider, dt: number, boardPressed: boolean, fastHeld = false): boolean {
    if (!this.lift) {
      this.nearby = this.lifts.nearestBoardable(rider.x, rider.y, PROMPT_RANGE);
      this.nearbyDist = this.nearby ? Math.hypot(this.nearby.bottom[0] - rider.x, this.nearby.bottom[1] - rider.y) : Infinity;
      const inZone = this.nearbyDist < BOARD_RANGE;
      this.blocker = !inZone ? '' : !rider.onGround ? 'air' : rider.speed > BOARD_SPEED ? 'fast' : '';
      this.canBoard = inZone && this.blocker === '';
      // loading maze: coast to a stop inside the zone
      if (inZone && rider.onGround && rider.speed > 0.5) { const f = Math.exp(-dt * 1.2); rider.vx *= f; rider.vy *= f; }
      if (boardPressed && this.canBoard && this.nearby) this.board(rider, this.nearby);
      return this.lift !== null;
    }
    const len = this.lifts.rideLength(this.lift);
    if (boardPressed) this.up = len; // skip to the top
    const before = this.up;
    this.fast = fastHeld;
    this.up += this.lift.speed * dt * RIDE_SPEEDUP * (fastHeld ? FAST_FORWARD : 1);
    this.passedTower = this.lift.towerUp.some((t) => t > before + LOAD_OFFSET && t <= this.up + LOAD_OFFSET);
    if (this.up >= len) { this.unload(rider); return false; }
    this.place(rider);
    return true;
  }

  private board(rider: Rider, l: LiftRuntime): void {
    rider.strapInNow(); // walked up on foot: strap in as you load
    this.lift = l;
    this.up = 0;
    rider.vx = rider.vy = rider.vz = 0; rider.speed = 0; rider.skid = 0; rider.crashed = 0;
    this.place(rider);
  }

  private place(rider: Rider): void {
    const l = this.lift!;
    this.lifts.seatAt(l, this.up, this.seat);
    this.cableY = this.seat.y + l.riderDrop;
    this.lifts.seatAt(l, Math.min(this.lifts.rideLength(l), this.up + 2), this.seat2);
    rider.x = this.seat.x; rider.y = -this.seat.z;
    const len = this.lifts.rideLength(l);
    const ground = this.pack.groundHeight(rider.x, rider.y);
    if (l.kind === 'surface' || l.kind === 'carpet') {
      // towed or carried on the snow
      rider.z = ground;
    } else {
      // the chair dips to the snow at the loading and unloading points
      const edge = Math.min(this.up, len - this.up);
      rider.z = edge < 12 ? ground + 0.7 + (this.seat.y - ground - 0.7) * Math.max(0, edge / 12) : this.seat.y;
    }
    rider.onGround = true;
    rider.normal[0] = 0; rider.normal[1] = 0; rider.normal[2] = 1;
    // face the direction of travel
    const dx = this.seat2.x - this.seat.x, dy = -(this.seat2.z - this.seat.z);
    if (Math.hypot(dx, dy) > 0.01) rider.heading = rider.boardYaw = Math.atan2(dx, dy);
    // velocity for the chase camera (it follows the velocity direction above 2.5 m/s)
    const dl = Math.hypot(dx, dy) || 1;
    rider.vx = (dx / dl) * l.speed; rider.vy = (dy / dl) * l.speed;
    rider.speed = l.speed;
    if (l.kind === 'surface' || l.kind === 'carpet') { const n = this.pack.groundNormal(rider.x, rider.y) as number[]; rider.normal[0] = n[0]; rider.normal[1] = n[1]; rider.normal[2] = n[2]; }
  }

  private unload(rider: Rider): void {
    const l = this.lift!;
    this.lift = null;
    // step off at the top unloading point, a little to the side of the line, facing downhill
    const dirX = l.top[0] - l.bottom[0], dirY = l.top[1] - l.bottom[1];
    const dl = Math.hypot(dirX, dirY) || 1;
    const side = l.upFromA ? 1 : -1;
    const x = l.top[0] + (dirX / dl) * 3 + l.lateral[0] * 3 * side, y = l.top[1] + (dirY / dl) * 3 + l.lateral[1] * 3 * side;
    const spot = this.clearSpot(x, y, Math.atan2(-dirX, -dirY));
    rider.reset(spot[0], spot[1], spot[2]);
  }

  /** Downhill heading at (x, y), or `fallback` on flat ground. */
  private downhill(x: number, y: number, fallback: number): number {
    const n = this.pack.groundNormal(x, y) as number[];
    return Math.hypot(n[0], n[1]) > 0.02 ? Math.atan2(n[0], n[1]) : fallback;
  }

  /**
   * The unloading point is often inside the OSM footprint of the top terminal or a summit lodge.
   * Search rings outward from the nominal point (2 m steps, out to UNLOAD_SEARCH) for the nearest
   * spot clear of buildings and trees with a clear run downhill and at least UNLOAD_MIN_SLOPE; on
   * each ring take the lowest one, which puts the rider on the downhill side. Returns [x, y, heading].
   */
  private clearSpot(x0: number, y0: number, fallback: number): [number, number, number] {
    const col = this.collider;
    if (!col) return [x0, y0, this.downhill(x0, y0, fallback)];
    const free = (x: number, y: number, clear: number): boolean => {
      const z = this.pack.groundHeight(x, y);
      return !Number.isNaN(z) && !col.blocked(x, y, z, clear);
    };
    const runClear = (x: number, y: number, h: number): boolean => {
      const dx = Math.sin(h), dy = Math.cos(h);
      for (let t = 1; t <= UNLOAD_RUN; t++) if (!free(x + dx * t, y + dy * t, 0.5)) return false;
      return true;
    };
    // there is no skating, so prefer a spot steep enough to glide away from; the nearest clear
    // spot on flatter ground is the fallback
    const minNz = Math.cos(UNLOAD_MIN_SLOPE * (Math.PI / 180));
    let flat: [number, number, number] | null = null;
    for (let r = 0; r <= UNLOAD_SEARCH; r += 2) {
      const steps = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / 2);
      let best: [number, number, number] | null = null, bestZ = Infinity;
      let bestFlat: [number, number, number] | null = null, bestFlatZ = Infinity;
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const x = x0 + Math.cos(a) * r, y = y0 + Math.sin(a) * r;
        if (!free(x, y, UNLOAD_CLEAR)) continue;
        const h = this.downhill(x, y, fallback);
        if (!runClear(x, y, h)) continue;
        const z = this.pack.groundHeight(x, y);
        const steep = (this.pack.groundNormal(x, y) as number[])[2] <= minNz;
        if (steep && z < bestZ) { bestZ = z; best = [x, y, h]; }
        if (!steep && z < bestFlatZ) { bestFlatZ = z; bestFlat = [x, y, h]; }
      }
      if (best) return best;
      if (!flat && bestFlat) flat = bestFlat;
    }
    return flat ?? [x0, y0, this.downhill(x0, y0, fallback)];
  }

  /** Leave the lift at the current spot (used on R while riding). */
  cancel(): void { this.lift = null; }
}
