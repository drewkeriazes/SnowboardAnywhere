import * as THREE from 'three';

/**
 * Falling snow for the snowstorm weather. A fixed set of flakes lives in a BOX-metre cube that
 * wraps around the camera; all motion (fall, wind, flutter) happens in the vertex shader from
 * uTime, so the CPU only updates a few uniforms per frame. Flakes are world-space, so riding fast
 * streams them past the camera like real snow.
 */
const BOX = 60;

const vert = /* glsl */ `
attribute vec4 seed; // xyz: start position in the box (0..1), w: per-flake variation
uniform float uTime;
uniform vec3 uCam;
uniform vec2 uWind;
uniform float uScale;
varying float vAlpha;
void main() {
  float fall = 1.1 + seed.w * 0.9; // m/s
  vec3 p = seed.xyz * ${BOX.toFixed(1)};
  p += vec3(uWind.x, -fall, uWind.y) * uTime;
  p.x += sin(uTime * (0.8 + seed.w) + seed.w * 40.0) * 0.6; // flutter
  p.z += cos(uTime * (0.7 + seed.w) + seed.x * 30.0) * 0.6;
  // wrap into the cube centred on the camera
  vec3 corner = uCam - vec3(${(BOX / 2).toFixed(1)});
  p = corner + mod(p - corner, vec3(${BOX.toFixed(1)}));
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  gl_PointSize = clamp((0.07 + seed.w * 0.05) * uScale / max(d, 0.1), 1.5, 16.0);
  // fade near the camera (no giant blobs) and at the box edge (no popping)
  vAlpha = smoothstep(0.4, 2.0, d) * (1.0 - smoothstep(${(BOX * 0.35).toFixed(1)}, ${(BOX * 0.5).toFixed(1)}, d));
}`;

const frag = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.15, length(c)) * vAlpha * 0.9;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Snow {
  readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;
  private readonly geo = new THREE.BufferGeometry();
  private time = 0;

  constructor(count = 16000) {
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    this.geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    // positions are computed in the shader; three still wants a position attribute for the draw count
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2(2, 1) }, uScale: { value: 600 }, uColor: { value: new THREE.Color(0.95, 0.96, 1.0) } },
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  /** How many flakes to draw (quality). */
  setCount(n: number): void { this.geo.setDrawRange(0, Math.min(n, this.geo.getAttribute('seed').count)); }

  /** the current gusting wind the flakes drift with (three.js x, z; m/s) */
  get wind(): THREE.Vector2 { return this.mat.uniforms.uWind.value as THREE.Vector2; }

  update(dt: number, camera: THREE.PerspectiveCamera, viewportHeight: number, brightness: number): void {
    if (!this.points.visible) return;
    this.time += dt;
    const u = this.mat.uniforms;
    u.uTime.value = this.time;
    u.uCam.value.copy(camera.position);
    // gusty wind, mostly from the west
    u.uWind.value.set(3 + 2.5 * Math.sin(this.time * 0.13), 1.2 * Math.sin(this.time * 0.07 + 1));
    u.uScale.value = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    u.uColor.value.setRGB(0.95, 0.96, 1.0).multiplyScalar(brightness);
  }
}
