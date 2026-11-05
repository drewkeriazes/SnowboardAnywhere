import * as THREE from 'three';
import type { Rider } from '../sim/Rider';
import type { Pack } from '../pack/Pack';

export type CameraMode = 'chase' | 'close' | 'far' | 'fp' | 'free';

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
  // first-person state
  /** free look while riding a lift (radians, relative to the heading) */
  lookYaw = 0; lookPitch = 0;
  private fpRoll = 0;
  private fpBob = 0;
  private fpDip = 0;
  private readonly fpFwd = new THREE.Vector3();
  private readonly fpUp = new THREE.Vector3(0, 1, 0);
  private readonly fpPos = new THREE.Vector3();
  private readonly fpLook = new THREE.Vector3();
  private readonly fpQ = new THREE.Quaternion();
  private readonly fpM = new THREE.Matrix4();

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
    const order: CameraMode[] = ['chase', 'close', 'far', 'fp', 'free'];
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

  /**
   * First person: helmet height, looks along the velocity with a little lag, rolls into carves,
   * bobs with speed, dips on landings. On a lift `onLift` enables mouse free look.
   */
  updateFirstPerson(r: Rider, dt: number, tuck: boolean, onLift: boolean, mouseDx: number, mouseDy: number): void {
    const spd = Math.hypot(r.vx, r.vy);
    // heading to look along: velocity when moving, board heading when slow or airborne
    const hx = Math.sin(r.heading), hy = Math.cos(r.heading);
    let fx = hx, fy = hy;
    if (r.onGround && spd > 3 && !onLift) { const b = Math.min(1, (spd - 3) / 6); fx = hx * (1 - b) + (r.vx / spd) * b; fy = hy * (1 - b) + (r.vy / spd) * b; }
    const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
    const target = this.fpFwd.set(fx, 0, -fy);
    // lag: slower turn of the view than the board
    if (this.fpLook.lengthSq() === 0) this.fpLook.copy(target);
    this.fpLook.lerp(target, 1 - Math.exp(-dt * (onLift ? 3 : 9))).normalize();
    // free look on the lift; recentre when riding
    if (onLift) {
      this.lookYaw = THREE.MathUtils.clamp(this.lookYaw + mouseDx * 0.003, -2.1, 2.1);
      this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - mouseDy * 0.003, -1.0, 1.0);
    } else {
      this.lookYaw *= Math.exp(-dt * 6); this.lookPitch *= Math.exp(-dt * 6);
    }
    // head position: 1.6 m above the board, lowered by tuck and landing shock
    const crouch = (tuck ? 0.45 : 0) + r.landingShock * 0.5 + r.jumpCharge * 0.3;
    this.fpDip += (crouch - this.fpDip) * Math.min(1, dt * 8);
    const bobAmp = r.onGround && !onLift ? Math.min(0.06, spd * 0.003) * (1 - r.surface.groomed * 0.5) : 0;
    this.fpBob += dt * (4 + spd * 0.3);
    const bob = Math.sin(this.fpBob) * bobAmp;
    const eye = 1.6 - this.fpDip * 0.5 + bob + (onLift ? 0.2 : 0);
    // ground normal tilt so the head stays upright-ish relative to the slope, blended toward world up
    const n = this.fpUp.set(r.normal[0] * 0.35, 1, -r.normal[1] * 0.35).normalize();
    this.fpPos.set(r.x, r.z, -r.y).addScaledVector(n, eye).addScaledVector(this.fpLook, 0.15);
    // roll into carves
    const rollT = r.onGround && !onLift ? -r.edgeAngle * 0.22 : 0;
    this.fpRoll += (rollT - this.fpRoll) * Math.min(1, dt * 6);
    // pitch: look slightly down the slope, more when tucking
    const slopePitch = r.onGround ? Math.atan2(-(r.vx * r.normal[0] + r.vy * r.normal[1]), Math.max(0.3, spd)) * 0.5 : 0; // negative = looking downhill
    const pitch = THREE.MathUtils.clamp(slopePitch - (tuck ? 0.12 : 0) + this.lookPitch, -1.2, 1.2);
    const yaw = Math.atan2(this.fpLook.x, -this.fpLook.z) + this.lookYaw;
    // build orientation: yaw about up, then pitch, then roll about the view axis
    // camera forward is -Z; a yaw of `yaw` (clockwise from north) is a rotation of -yaw about +Y
    const e = new THREE.Euler(pitch, -yaw, this.fpRoll, 'YXZ');
    this.fpQ.setFromEuler(e);
    this.camera.position.copy(this.fpPos);
    this.camera.quaternion.copy(this.fpQ);
    // keep the eye out of the snow
    const ground = this.pack.groundHeight(this.fpPos.x, -this.fpPos.z);
    if (this.camera.position.y < ground + 0.6) this.camera.position.y = ground + 0.6;
    const fov = 92 + Math.min(14, r.speed * 0.4) + (tuck ? 3 : 0) - r.landingShock * 6;
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 5);
    this.camera.updateProjectionMatrix();
    void this.fpM;
  }

  update(r: Rider, dt: number, tuck: boolean): void {
    if (this.mode === 'free' || this.mode === 'fp') return;
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
