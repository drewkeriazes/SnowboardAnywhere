import * as THREE from 'three';

/** WASD + mouse-drag fly camera for the terrain viewer (M1). Replaced by the chase camera in M2. */
export class FlyCamera {
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = -0.25;
  private dragging = false;
  speed = 300; // m/s, Shift x4

  constructor(private camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    canvas.addEventListener('mousedown', () => (this.dragging = true));
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      this.yaw -= e.movementX * 0.0025;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0025, -1.5, 1.5);
    });
  }

  update(dt: number) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    this.camera.quaternion.copy(q);

    const dir = new THREE.Vector3();
    if (this.keys.has('KeyW')) dir.z -= 1;
    if (this.keys.has('KeyS')) dir.z += 1;
    if (this.keys.has('KeyA')) dir.x -= 1;
    if (this.keys.has('KeyD')) dir.x += 1;
    if (this.keys.has('KeyQ')) dir.y -= 1;
    if (this.keys.has('KeyE')) dir.y += 1;
    if (dir.lengthSq() === 0) return;

    const s = this.speed * (this.keys.has('ShiftLeft') ? 4 : 1) * dt;
    dir.normalize().applyQuaternion(q).multiplyScalar(s);
    this.camera.position.add(dir);
  }
}
