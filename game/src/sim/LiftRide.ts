import * as THREE from 'three';
import type { Rider } from './Rider';
import type { Pack } from '../pack/Pack';
import { CHAIR_SPEED, type LiftRuntime, type Lifts } from '../world/Lifts';

/**
 * Riding a lift back up. Near a bottom terminal and slow, pressing the board key puts the rider
 * on a chair; the rider then follows the cable at chair speed. Pressing the key again skips to
 * the top. At the top the rider is placed a few metres past the terminal, facing downhill.
 */
export class LiftRide {
  lift: LiftRuntime | null = null;
  up = 0; // metres travelled from the bottom terminal
  /** lift the rider could board right now (for the HUD prompt) */
  nearby: LiftRuntime | null = null;
  private readonly seat = new THREE.Vector3();
  private readonly seat2 = new THREE.Vector3();

  constructor(private readonly pack: Pack, private readonly lifts: Lifts) {}

  get riding(): boolean { return this.lift !== null; }

  /** Call every frame before the physics step. Returns true when the rider is on a lift (physics skipped). */
  update(rider: Rider, dt: number, boardPressed: boolean): boolean {
    if (!this.lift) {
      this.nearby = rider.onGround && rider.speed < 4 ? this.lifts.nearestBoardable(rider.x, rider.y) : null;
      if (boardPressed && this.nearby) this.board(rider, this.nearby);
      return this.lift !== null;
    }
    if (boardPressed) this.up = this.lift.length; // skip to the top
    this.up += CHAIR_SPEED * dt;
    if (this.up >= this.lift.length) { this.unload(rider); return false; }
    this.place(rider);
    return true;
  }

  private board(rider: Rider, l: LiftRuntime): void {
    this.lift = l;
    this.up = 0;
    rider.vx = rider.vy = rider.vz = 0; rider.speed = 0; rider.skid = 0; rider.crashed = 0;
    this.place(rider);
  }

  private place(rider: Rider): void {
    const l = this.lift!;
    this.lifts.seatAt(l, this.up, this.seat);
    this.lifts.seatAt(l, Math.min(l.length, this.up + 2), this.seat2);
    rider.x = this.seat.x; rider.y = -this.seat.z; rider.z = this.seat.y;
    rider.onGround = true;
    rider.normal[0] = 0; rider.normal[1] = 0; rider.normal[2] = 1;
    // face the direction of travel
    const dx = this.seat2.x - this.seat.x, dy = -(this.seat2.z - this.seat.z);
    if (Math.hypot(dx, dy) > 0.01) rider.heading = Math.atan2(dx, dy);
    // velocity for the chase camera (it follows the velocity direction above 2.5 m/s)
    const len = Math.hypot(dx, dy) || 1;
    rider.vx = (dx / len) * CHAIR_SPEED; rider.vy = (dy / len) * CHAIR_SPEED;
    rider.speed = CHAIR_SPEED;
  }

  private unload(rider: Rider): void {
    const l = this.lift!;
    this.lift = null;
    // drop in 8 m past the top terminal in the direction of travel, then face downhill
    const dirX = l.top[0] - l.bottom[0], dirY = l.top[1] - l.bottom[1];
    const dl = Math.hypot(dirX, dirY) || 1;
    let x = l.top[0] + (dirX / dl) * 8, y = l.top[1] + (dirY / dl) * 8;
    const n = this.pack.groundNormal(x, y) as number[];
    let heading = Math.hypot(n[0], n[1]) > 0.02 ? Math.atan2(n[0], n[1]) : Math.atan2(-dirX, -dirY);
    rider.reset(x, y, heading);
  }

  /** Leave the lift at the current spot (used on R while riding). */
  cancel(): void { this.lift = null; }
}
