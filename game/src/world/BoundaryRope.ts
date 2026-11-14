import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Boundary } from '../sim/Boundary';

/**
 * FEAT-305: the orange boundary rope along the resort's outer edge (sim/Boundary.ts): a post every 12 m or so and
 * one rope between them, sagging between the posts and lifted over any ground that rises under a span, so it drapes
 * on the terrain. Two instanced meshes (posts, rope pieces): two draw calls, no shadows, nothing past DRAW m.
 * The instances are refilled around the rider when it has moved REFILL m, and every REHEIGHT s while it stands, so
 * the posts settle onto the fine terrain as its tiles load. Not a collider: you can duck it (and roll for the yeti).
 * `visible` hides it and stops its refills (FEAT-309's Nature mode; the out of bounds egg is off with it).
 */
const DRAW = 700; // m
const REFILL = 30; // m
const REHEIGHT = 1.5; // s
const MAX_POSTS = 1400;
const SUB = 4; // rope pieces per span
const POST_H = 1.25, ROPE_H = 1.05, SAG = 0.22, CLEAR = 0.3; // m
const POST_R = 0.035, ROPE_R = 0.03; // m

export class BoundaryRope {
  readonly group = new THREE.Group();
  readonly posts: THREE.InstancedMesh;
  readonly rope: THREE.InstancedMesh;
  readonly materials: THREE.MeshStandardMaterial[];
  private fx = Infinity;
  private fy = Infinity;
  private t = 0;
  private on = true;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();

  constructor(private readonly pack: Pack, readonly boundary: Boundary | null) {
    this.group.name = 'boundary rope';
    // the rope: the bright orange of boundary rope, a touch of its own glow so it still reads in the shade
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, emissive: 0xff5200, emissiveIntensity: 0.35, roughness: 0.7 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0xe8681a, roughness: 0.6 });
    this.materials = [ropeMat, postMat];
    const postGeo = new THREE.CylinderGeometry(POST_R, POST_R * 1.2, 1, 6, 1); postGeo.translate(0, 0.5, 0);
    const ropeGeo = new THREE.CylinderGeometry(ROPE_R, ROPE_R, 1, 5, 1, true); ropeGeo.translate(0, 0.5, 0);
    this.posts = new THREE.InstancedMesh(postGeo, postMat, MAX_POSTS);
    this.rope = new THREE.InstancedMesh(ropeGeo, ropeMat, MAX_POSTS * SUB);
    this.posts.name = 'boundary posts'; this.rope.name = 'boundary rope';
    for (const im of [this.posts, this.rope]) { im.count = 0; im.castShadow = false; im.receiveShadow = true; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.group.add(im); }
  }

  get visible(): boolean { return this.on && !!this.boundary; }
  set visible(v: boolean) { this.on = v; this.group.visible = v; if (v) this.fx = Infinity; }

  /** Per frame from the streaming step: refill around (x, y) when it has moved, or now and then for the heights. */
  update(dt: number, x: number, y: number): void {
    if (!this.on || !this.boundary) return;
    this.t += dt;
    if (Math.hypot(x - this.fx, y - this.fy) < REFILL && this.t < REHEIGHT) return;
    this.fx = x; this.fy = y; this.t = 0;
    this.fill(x, y);
  }

  private ground(x: number, y: number): number { return this.pack.terrainHeight(x, y); }

  /** the posts within DRAW m of (x, y), nearest kept when there are too many, and the rope on the spans between them */
  private fill(x: number, y: number): void {
    const b = this.boundary!, R2 = DRAW * DRAW;
    let np = 0, nr = 0;
    for (let ri = 0; ri < b.rings.length; ri++) {
      const r = b.rings[ri], open = b.open[ri], n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const px = r[2 * i], py = r[2 * i + 1];
        if ((px - x) ** 2 + (py - y) ** 2 > R2) continue;
        const j = (i + 1) % n, qx = r[2 * j], qy = r[2 * j + 1];
        const gp = this.ground(px, py);
        if (Number.isNaN(gp)) continue;
        // a post where either span beside it has rope
        if ((!open[i] || !open[(i + n - 1) % n]) && np < MAX_POSTS) {
          this.m.makeScale(1, POST_H, 1).setPosition(px, gp - 0.05, -py);
          this.posts.setMatrixAt(np++, this.m);
        }
        if (open[i] || nr + SUB > MAX_POSTS * SUB) continue;
        const gq = this.ground(qx, qy);
        if (Number.isNaN(gq)) continue;
        // the span: a sagging line from post top to post top, kept CLEAR m over the snow under it
        let prev = this.a.set(px, gp + ROPE_H, -py);
        for (let k = 1; k <= SUB; k++) {
          const u = k / SUB, sx = px + (qx - px) * u, sy = py + (qy - py) * u;
          let z = gp + (gq - gp) * u + ROPE_H - SAG * 4 * u * (1 - u);
          if (k < SUB) { const g = this.ground(sx, sy); if (!Number.isNaN(g)) z = Math.max(z, g + CLEAR); }
          const next = (k % 2 ? this.b : this.a).set(sx, z, -sy);
          this.piece(prev, next, nr++);
          prev = next;
        }
      }
    }
    this.posts.count = np; this.rope.count = nr;
    this.posts.instanceMatrix.needsUpdate = true; this.rope.instanceMatrix.needsUpdate = true;
    this.posts.computeBoundingSphere(); this.rope.computeBoundingSphere();
  }

  /** a rope piece from p to q (a unit cylinder along +Y, base at the origin) */
  private piece(p: THREE.Vector3, q: THREE.Vector3, i: number): void {
    this.v.subVectors(q, p);
    const L = this.v.length();
    this.q.setFromUnitVectors(this.up, this.v.divideScalar(L || 1));
    this.m.compose(p, this.q, this.s.set(1, L, 1));
    this.rope.setMatrixAt(i, this.m);
  }

  dispose(): void {
    for (const im of [this.posts, this.rope]) { im.geometry.dispose(); im.dispose(); }
    for (const m of this.materials) m.dispose();
  }
}
