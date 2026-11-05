import * as THREE from 'three';
import type { Rider } from '../sim/Rider';

/** Simple rider: board, legs, body, head. Leans into carves, crouches in a tuck and for jumps. */
export class RiderView {
  readonly group = new THREE.Group();
  private readonly board: THREE.Mesh;
  private readonly body: THREE.Group;
  private readonly torso: THREE.Mesh;
  private readonly legs: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly spray: THREE.Points;
  private readonly sprayPos: Float32Array;
  private readonly sprayVel: Float32Array;
  private readonly sprayLife: Float32Array;
  private readonly tmpN = new THREE.Vector3();
  private readonly tmpF = new THREE.Vector3();
  private readonly tmpR = new THREE.Vector3();
  private readonly rot = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private crouch = 0;

  constructor() {
    const boardMat = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.4, metalness: 0.2 });
    this.board = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.025, 1.56), boardMat);
    this.board.castShadow = true;
    this.group.add(this.board);
    this.body = new THREE.Group();
    this.group.add(this.body);
    const suit = new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.8 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.9 });
    this.legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.5, 4, 8), pants);
    this.legs.position.y = 0.45;
    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.5, 4, 8), suit);
    this.torso.position.y = 1.05;
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 }));
    this.head.position.y = 1.55;
    for (const m of [this.legs, this.torso, this.head]) { m.castShadow = true; this.body.add(m); }

    const n = 400;
    this.sprayPos = new Float32Array(n * 3);
    this.sprayVel = new Float32Array(n * 3);
    this.sprayLife = new Float32Array(n);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.sprayPos, 3));
    this.spray = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.35, transparent: true, opacity: 0.8, depthWrite: false }));
    this.spray.frustumCulled = false;
  }

  get sprayObject(): THREE.Points {
    return this.spray;
  }

  update(r: Rider, dt: number, tuck: boolean): void {
    this.group.position.set(r.x, r.z, -r.y);
    // orientation: board forward along heading, up along the ground normal (blend to world up in the air)
    const n = this.tmpN.set(r.normal[0], r.normal[2], -r.normal[1]);
    if (!r.onGround) n.lerp(new THREE.Vector3(0, 1, 0), 0.7).normalize();
    const f = this.tmpF.set(Math.sin(r.heading), 0, -Math.cos(r.heading));
    // make f orthogonal to n
    f.sub(n.clone().multiplyScalar(f.dot(n))).normalize();
    const right = this.tmpR.crossVectors(f, n).normalize();
    this.rot.makeBasis(right, n, f.clone().negate());
    this.q.setFromRotationMatrix(this.rot);
    this.group.quaternion.slerp(this.q, Math.min(1, dt * 12));
    // lean into the edge; crouch for tuck / charge / landing
    const lean = r.onGround ? -r.edgeAngle * 0.55 : 0;
    const target = Math.max(tuck ? 0.45 : 0, r.jumpCharge * 0.5, r.landingShock * 0.6);
    this.crouch += (target - this.crouch) * Math.min(1, dt * 8);
    this.body.rotation.set(this.crouch * 0.6 + (r.crashed > 0 ? 1.3 : 0), 0, lean);
    this.body.position.y = -this.crouch * 0.35;
    this.body.scale.y = 1 - this.crouch * 0.25;
    this.board.visible = true;

    // snow spray when skidding or braking hard
    const pos = this.sprayPos, vel = this.sprayVel, life = this.sprayLife;
    const emit = r.onGround ? Math.floor((r.skid * 10 + (r.speed > 8 ? 1 : 0)) * 1.0) : 0;
    let emitted = 0;
    const g = this.group.position;
    for (let i = 0; i < life.length; i++) {
      if (life[i] <= 0) {
        if (emitted < emit) {
          emitted++;
          life[i] = 0.5 + Math.random() * 0.4;
          pos[i * 3] = g.x + (Math.random() - 0.5) * 0.6; pos[i * 3 + 1] = g.y + 0.1; pos[i * 3 + 2] = g.z + (Math.random() - 0.5) * 0.6;
          const side = Math.sign(r.edgeAngle || 1) * -1;
          vel[i * 3] = right.x * side * (2 + Math.random() * 3) + (Math.random() - 0.5) * 2;
          vel[i * 3 + 1] = 2 + Math.random() * 3 * r.skid;
          vel[i * 3 + 2] = right.z * side * (2 + Math.random() * 3) + (Math.random() - 0.5) * 2;
        } else {
          pos[i * 3 + 1] = -10000;
        }
        continue;
      }
      life[i] -= dt;
      vel[i * 3 + 1] -= 9.81 * dt;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
    }
    (this.spray.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}
