import * as THREE from 'three';
import type { Rider } from '../sim/Rider';

/**
 * FEAT-044: powder spray on the GPU. The CPU only writes a spawn record per particle (where it left
 * the snow, its velocity, when, its size, which kind) into a ring buffer; the vertex shader moves
 * every live particle analytically from `uTime`, so the cost per frame is a few hundred attribute
 * writes while the board is throwing snow and nothing when it is not. Two kinds:
 *
 * - wisps (groomers, ice, chop): small, fast, short-lived (0.3 to 0.6 s), high drag; a thin sheet off
 *   the engaged edge at speed, more in a skid, a sheet thrown ahead of the board in a hockey stop.
 * - clouds (powder, slush): big, slow, long-lived (1.5 to 3 s), low drag, so they hang in the air,
 *   grow and drift on the wind: the Steep look. A landing throws a burst of them.
 *
 * Emission per second scales with speed, the sine of the edge angle, the loose snow depth
 * (`rider.snow.depth`), the skid and the scrape (`Rider.ts`); the kind mix follows the snow's
 * powder / slush / chop weights. Snow leaves the engaged edge (the rig's `right` times the edge sign)
 * tilted up by about the edge angle, carrying part of the board's velocity. The particles are unlit:
 * `setLight` gives them the snow's light at the rider (BUG-046, `ParticleLight.ts`).
 */
const MAX = 8192;
/** most particles spawned in one frame (a burst or a hard stop) */
const PER_FRAME_CAP = 48;

const vert = /* glsl */ `
attribute vec3 aP0;
attribute vec3 aV0;
attribute vec4 aT;   // spawn time, life, size (m), kind (0 wisp, 1 cloud)
attribute float aSeed;
uniform float uTime;
uniform vec2 uWind;
uniform float uViewH;
varying float vAlpha;
varying float vKind;
void main() {
  float t = uTime - aT.x, life = aT.y;
  if (life <= 0.0 || t < 0.0 || t > life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; vKind = 0.0; return; }
  float kind = aT.w, u = t / life;
  float k = mix(3.0, 1.8, kind);     // air drag (1/s)
  float vt = mix(3.5, 0.7, kind);    // settling speed (m/s): snow dust falls slowly
  float e = (1.0 - exp(-k * t)) / k;
  vec3 p = aP0 + aV0 * e - vec3(0.0, vt * (t - e), 0.0) + vec3(uWind.x, 0.0, uWind.y) * (t - e) * kind;
  // a cloud billows and drifts a little on its own
  p.xz += kind * 0.25 * t * vec2(sin(aSeed * 6.28 + t * 1.3), cos(aSeed * 9.4 + t * 1.1));
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(0.1, -mv.z);
  float size = aT.z * (1.0 + mix(1.2, 2.5, kind) * u); // grows over its life, a cloud most
  gl_PointSize = clamp(size * uViewH * 0.5 * projectionMatrix[1][1] / d, 1.0, 256.0);
  // fade in fast, out over the second half; a cloud thins as it grows
  vAlpha = smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(mix(0.5, 0.3, kind), 1.0, u)) * mix(0.7, 0.35, kind) / (1.0 + 2.0 * kind * u);
  vAlpha *= smoothstep(0.3, 1.5, d); // no giant blobs across the lens
  vKind = kind;
}`;

const frag = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
varying float vKind;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, mix(0.15, 0.04, vKind), length(c)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Spray {
  readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;
  private readonly geo = new THREE.BufferGeometry();
  private readonly p0 = new Float32Array(MAX * 3);
  private readonly v0 = new Float32Array(MAX * 3);
  private readonly t = new Float32Array(MAX * 4);
  private readonly seed = new Float32Array(MAX);
  private readonly aP0: THREE.BufferAttribute;
  private readonly aV0: THREE.BufferAttribute;
  private readonly aT: THREE.BufferAttribute;
  private readonly aSeed: THREE.BufferAttribute;
  private n = MAX;
  private head = 0;
  private time = 0;
  /** slots written this frame: the first one and how many (the ring may wrap) */
  private start = -1; private written = 0;
  private acc = 0;
  private prevGround = true;
  /** particles spawned in the last update (for checks) */
  spawned = 0;
  /** the wind the clouds drift on (three.js x, z; m/s), set by main from the weather */
  readonly wind: THREE.Vector2;

  constructor() {
    this.aP0 = new THREE.BufferAttribute(this.p0, 3).setUsage(THREE.DynamicDrawUsage);
    this.aV0 = new THREE.BufferAttribute(this.v0, 3).setUsage(THREE.DynamicDrawUsage);
    this.aT = new THREE.BufferAttribute(this.t, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSeed = new THREE.BufferAttribute(this.seed, 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3)); // the draw count; positions come from the shader
    this.geo.setAttribute('aP0', this.aP0); this.geo.setAttribute('aV0', this.aV0); this.geo.setAttribute('aT', this.aT); this.geo.setAttribute('aSeed', this.aSeed);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(0.6, 0.2) }, uViewH: { value: 720 }, uColor: { value: new THREE.Color(1, 1, 1) } },
    });
    this.wind = this.mat.uniforms.uWind.value as THREE.Vector2;
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.name = 'snow spray';
  }

  /** How many particles the ring holds (quality). */
  setCount(n: number): void { this.n = Math.max(64, Math.min(MAX, Math.round(n))); this.geo.setDrawRange(0, this.n); if (this.head >= this.n) this.head = 0; }
  /** the snow's light at the rider (BUG-046) */
  setLight(c: THREE.Color): void { (this.mat.uniforms.uColor.value as THREE.Color).copy(c); }
  /** drawing buffer height (px), for the point size */
  setViewHeight(h: number): void { this.mat.uniforms.uViewH.value = h; }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, kind: number): void {
    const i = this.head;
    this.head = (i + 1) % this.n;
    if (this.start < 0) this.start = i;
    this.written = Math.min(this.n, this.written + 1);
    this.p0[i * 3] = x; this.p0[i * 3 + 1] = y; this.p0[i * 3 + 2] = z;
    this.v0[i * 3] = vx; this.v0[i * 3 + 1] = vy; this.v0[i * 3 + 2] = vz;
    this.t[i * 4] = this.time; this.t[i * 4 + 1] = life; this.t[i * 4 + 2] = size; this.t[i * 4 + 3] = kind;
    this.seed[i] = Math.random();
    this.spawned++;
  }

  /** a wisp or a cloud by the snow's softness; returns [kind, life, size] */
  private pick(soft: number, out: number[]): number[] {
    const cloud = Math.random() < soft;
    out[0] = cloud ? 1 : 0;
    out[1] = cloud ? 1.5 + Math.random() * 1.5 : 0.3 + Math.random() * 0.3;
    out[2] = cloud ? 0.14 + Math.random() * 0.12 : 0.1 + Math.random() * 0.08;
    return out;
  }
  private readonly pk = [0, 0, 0];

  /**
   * Per frame. `g` the board's position (three.js), `f` and `right` the rig's forward and right
   * (unit, three.js), `fl` -1 when the rig is drawn turned round (FEAT-139), `emitting` false only
   * advances the clock (on foot, crashed, in the air).
   */
  update(r: Rider, dt: number, g: THREE.Vector3, f: THREE.Vector3, right: THREE.Vector3, fl: number, emitting: boolean): void {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    this.spawned = 0;
    this.start = -1; this.written = 0;
    const landed = r.onGround && !this.prevGround;
    this.prevGround = r.onGround;
    if (!emitting) { this.acc = 0; return; }
    const sn = r.snow;
    const soft = clamp01(sn.powder + 0.7 * sn.slush + 0.4 * sn.chop);
    const hard = clamp01(sn.ice);
    const depthK = Math.min(1, 0.3 + sn.depth / 0.3); // 0.38 on a groomer .. 1 in deep powder
    const sp = Math.max(1e-3, r.speed);
    const dirX = r.vx / sp, dirZ = -r.vy / sp; // travel direction (three.js)
    let budget = PER_FRAME_CAP;
    // a landing throws a burst of snow out from under the board, a cloud of it in powder
    if (landed && r.landingShock > 0) {
      const n = Math.min(budget, Math.round(r.landingShock * 100 * (0.4 + 1.2 * soft) * (1 - 0.6 * hard)));
      for (let i = 0; i < n; i++) {
        const along = (Math.random() - 0.5) * 1.6, side = (Math.random() - 0.5) * 0.5;
        const ang = Math.random() * Math.PI * 2, out = 1 + Math.random() * 3;
        const [kind, life, size] = this.pick(Math.min(1, soft + 0.3), this.pk);
        this.spawn(g.x + f.x * along + right.x * side, g.y + 0.05, g.z + f.z * along + right.z * side,
          Math.cos(ang) * out + dirX * sp * 0.2, (1 + Math.random() * 2.5) * (kind ? 0.6 : 1), Math.sin(ang) * out + dirZ * sp * 0.2, life * 1.2, size * 1.3, kind);
      }
      budget -= n;
    }
    if (!r.onGround || budget <= 0) { this.acc = 0; this.flush(); return; }
    // the edge: snow leaves the engaged edge on the outside of the turn
    const edgeS = Math.sin(Math.min(1.2, Math.abs(r.edge)));
    const rate = 30 * sp * (0.15 + edgeS) * depthK * (1 + 2 * Math.min(1, r.skid)) * (1 - 0.7 * hard);
    // a hockey stop scrapes a sheet off the whole edge, thrown on ahead of the board
    const sheetRate = r.scrape * 350 * (0.5 + soft) * Math.min(1, sp / 4) * (1 - 0.5 * hard);
    this.acc += (rate + sheetRate) * dt;
    let n = Math.min(budget, Math.floor(this.acc));
    this.acc -= n;
    if (this.acc > PER_FRAME_CAP) this.acc = PER_FRAME_CAP; // never bank a burst
    const sheetShare = sheetRate / Math.max(1e-3, rate + sheetRate);
    const side = Math.sign(fl * r.edgeAngle) || 1; // the engaged edge in the rig's frame (FEAT-139)
    const skid = Math.min(1, r.skid);
    for (; n > 0; n--) {
      const [kind, life, size] = this.pick(soft, this.pk);
      if (Math.random() < sheetShare) {
        // a low sheet: on ahead of the board and out along it, not up
        const along = (Math.random() - 0.5) * 1.5;
        const throwV = sp * (0.9 + 0.5 * Math.random()) + 1, out = (Math.random() - 0.5) * 3;
        this.spawn(g.x + f.x * along + dirX * 0.2, g.y + 0.05, g.z + f.z * along + dirZ * 0.2,
          dirX * throwV + f.x * out, (0.6 + 1.4 * Math.random()) * (0.5 + 0.5 * r.scrape) * (kind ? 0.5 : 1), dirZ * throwV + f.z * out, life, size, kind);
      } else {
        // along the engaged edge (spread along the board when carving, across the band in a skid)
        const along = (Math.random() - 0.5) * (1.3 - 0.6 * skid), off = 0.13 + 0.15 * skid * Math.random();
        const out = (1 + Math.random() * 2.5) * (0.4 + 0.6 * Math.min(1, sp / 10)) * (0.5 + edgeS);
        // a cloud of powder lifts less than a wisp is flung: it billows out low and hangs
        const up = ((1.2 + 2.5 * Math.random()) * (0.5 + edgeS) + 1.5 * skid * Math.random()) * (kind ? 0.45 : 1);
        this.spawn(g.x + f.x * along + right.x * side * off, g.y + 0.05, g.z + f.z * along + right.z * side * off,
          right.x * side * out + dirX * sp * 0.3 + (Math.random() - 0.5) * 1.5, up, right.z * side * out + dirZ * sp * 0.3 + (Math.random() - 0.5) * 1.5, life, size, kind);
      }
    }
    this.flush();
  }

  /** upload only the slots written this frame */
  private flush(): void {
    if (this.start < 0) return;
    const end = this.start + this.written;
    const ranges: [number, number][] = end <= this.n ? [[this.start, this.written]] : [[this.start, this.n - this.start], [0, end - this.n]];
    for (const [a, w] of [[this.aP0, 3], [this.aV0, 3], [this.aT, 4], [this.aSeed, 1]] as [THREE.BufferAttribute, number][]) {
      a.clearUpdateRanges();
      for (const [s, c] of ranges) a.addUpdateRange(s * w, c * w);
      a.needsUpdate = true;
    }
  }

  dispose(): void { this.geo.dispose(); this.mat.dispose(); }
}
