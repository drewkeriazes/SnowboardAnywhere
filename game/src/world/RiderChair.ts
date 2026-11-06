import * as THREE from 'three';
import { chairGeometry, gondolaGeometry } from './LiftModels';
import type { LiftRuntime } from './Lifts';

/**
 * The chair (or gondola cabin) that carries the rider. It follows the rider for the whole ride
 * with the seat under them and faces up the line; during the boarding and unloading dip, when
 * the rider is lowered toward the snow, the hanger stretches up to the cable.
 * Surface lifts and carpets have nothing to show (the rider stays on the snow).
 */
const SEAT_TOP = 0.32; // m above the rider origin where the seated pose's backside rests
const CHAIR_SEAT_TOP = -2.1 + 0.04; // seat top relative to the chair geometry origin (the grip)
const CABIN_FLOOR = -3.75; // gondola floor relative to the cabin origin

export class RiderChair {
  readonly group = new THREE.Group();
  private chair: THREE.Mesh | null = null;
  private kind = '';
  private readonly hanger: THREE.Mesh;

  constructor(private readonly material: THREE.Material) {
    this.hanger = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 6), new THREE.MeshStandardMaterial({ color: 0x22252b, roughness: 0.5, metalness: 0.5 }));
    this.hanger.castShadow = true;
    this.group.add(this.hanger);
    this.group.visible = false;
  }

  /** Per frame. `lift` null hides it. `cableY` is the cable height above the rider. */
  update(lift: LiftRuntime | null, riderX: number, riderY: number, riderZ: number, heading: number, cableY: number): void {
    if (!lift || (lift.kind !== 'chair' && lift.kind !== 'gondola')) { this.group.visible = false; return; }
    const want = lift.kind === 'gondola' ? 'gondola' : `chair${(lift.feature.capacity ?? 2400) >= 3000 ? 6 : (lift.feature.capacity ?? 2400) >= 1800 ? 4 : 2}`;
    if (want !== this.kind) {
      if (this.chair) this.group.remove(this.chair);
      const geo = want === 'gondola' ? gondolaGeometry() : chairGeometry(Number(want.slice(5)));
      this.chair = new THREE.Mesh(geo, this.material);
      this.chair.castShadow = true;
      this.group.add(this.chair);
      this.kind = want;
    }
    this.group.visible = true;
    // origin (grip) placed so the seat top (or cabin floor) is under the rider
    const originY = lift.kind === 'gondola' ? riderZ - CABIN_FLOOR : riderZ + SEAT_TOP - CHAIR_SEAT_TOP;
    this.group.position.set(riderX, originY, -riderY);
    // the chair geometry faces +Z (backrest at -Z); the rider faces along the heading
    this.group.rotation.set(0, -heading + Math.PI, 0);
    // extra hanger from the grip up to the cable during the dip
    const gap = cableY - originY;
    this.hanger.visible = gap > 0.1;
    if (gap > 0.1) { this.hanger.scale.set(1, gap, 1); this.hanger.position.set(0, gap / 2, 0); }
  }
}
