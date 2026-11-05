import * as THREE from 'three';
import type { Rider } from '../sim/Rider';
import type { Pack } from '../pack/Pack';

export type CameraMode = 'chase' | 'close' | 'far' | 'free';

/** Third-person chase camera with lag, speed-dependent FOV and terrain avoidance. */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly pack: Pack;
  // free-fly state
  yaw = 0; pitch = -0.2;
  private readonly freePos = new THREE.Vector3();

  constructor(pack: Pack, aspect: number) {
    this.pack = pack;
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.5, 300000);
  }

  snapTo(r: Rider): void {
    this.fwd.set(Math.sin(r.heading), 0, -Math.cos(r.heading));
    this.pos.set(r.x, r.z, -r.y).addScaledVector(this.fwd, -7).add(new THREE.Vector3(0, 3, 0));
    this.look.set(r.x, r.z + 1.2, -r.y);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  cycle(): void {
    const order: CameraMode[] = ['chase', 'close', 'far', 'free'];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
    if (this.mode === 'free') {
      this.freePos.copy(this.camera.position);
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      this.yaw = Math.atan2(d.x, -d.z);
      this.pitch = Math.asin(d.y);
    }
  }

  updateFree(dt: number, keys: Set<string>, mouseDx: number, mouseDy: number): void {
    this.yaw += mouseDx * 0.003; this.pitch = THREE.MathUtils.clamp(this.pitch - mouseDy * 0.003, -1.5, 1.5);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const speed = (keys.has('ShiftLeft') ? 400 : 60) * dt;
    if (keys.has('KeyW') || keys.has('ArrowUp')) this.freePos.addScaledVector(dir, speed);
    if (keys.has('KeyS') || keys.has('ArrowDown')) this.freePos.addScaledVector(dir, -speed);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) this.freePos.addScaledVector(right, -speed);
    if (keys.has('KeyD') || keys.has('ArrowRight')) this.freePos.addScaledVector(right, speed);
    if (keys.has('KeyQ')) this.freePos.y -= speed;
    if (keys.has('KeyE')) this.freePos.y += speed;
    const ground = this.pack.groundHeight(this.freePos.x, -this.freePos.z) + 1.5;
    if (this.freePos.y < ground) this.freePos.y = ground;
    this.camera.position.copy(this.freePos);
    this.camera.lookAt(this.freePos.clone().add(dir));
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
  }

  update(r: Rider, dt: number, tuck: boolean): void {
    if (this.mode === 'free') return;
    const dist = this.mode === 'close' ? 4.5 : this.mode === 'far' ? 12 : 7.5;
    const height = this.mode === 'close' ? 1.8 : this.mode === 'far' ? 4.5 : 2.8;
    // follow the velocity direction when moving, the heading when slow
    const spd = Math.hypot(r.vx, r.vy);
    if (spd > 2.5) this.fwd.set(r.vx / spd, 0, -r.vy / spd);
    else this.fwd.lerp(new THREE.Vector3(Math.sin(r.heading), 0, -Math.cos(r.heading)), Math.min(1, dt * 2)).normalize();
    const riderPos = new THREE.Vector3(r.x, r.z, -r.y);
    this.desired.copy(riderPos).addScaledVector(this.fwd, -dist).add(new THREE.Vector3(0, height - (tuck ? 0.6 : 0), 0));
    // keep the camera above the snow
    const ground = this.pack.groundHeight(this.desired.x, -this.desired.z);
    if (this.desired.y < ground + 1.2) this.desired.y = ground + 1.2;
    const k = 1 - Math.exp(-dt * (r.onGround ? 5 : 3));
    this.pos.lerp(this.desired, k);
    const lookTarget = riderPos.clone().addScaledVector(this.fwd, 4).add(new THREE.Vector3(0, 1.0, 0));
    this.look.lerp(lookTarget, 1 - Math.exp(-dt * 8));
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    const fov = 68 + Math.min(22, r.speed * 0.6) + (tuck ? 4 : 0);
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 4);
    this.camera.updateProjectionMatrix();
  }
}
