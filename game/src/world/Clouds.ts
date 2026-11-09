import * as THREE from 'three';

/**
 * Volumetric cumulus, after the Unreal / Nubis approach:
 *  - Shape: a tileable 64^3 Perlin-Worley texture (billowy base) and a low-frequency Worley fbm,
 *    eroded by a 32^3 Worley detail texture (wispy at the base, puffy at the top). Both are
 *    generated once at startup. A large-scale weather lookup decides where clouds are; a
 *    cumulus height gradient gives flat bases and rounded tops.
 *  - Lighting: a 6-tap march toward the sun, two-octave multiple-scattering approximation
 *    (extinction, scattering and phase eccentricity halved per octave), dual-lobe
 *    Henyey-Greenstein phase for silver linings, energy-conserving integration, sky ambient on
 *    the tops and a bounce from the sunlit snow on the bases ("ground contribution").
 *  - Cost: ray marched at half resolution into a render target, then composited by a huge
 *    camera-centred dome (behind all terrain, so peaks occlude clouds through the depth buffer).
 * Coverage comes from the Weather setting; step count from the quality preset.
 */
const BASE = 4700; // m above sea level, above every summit in the Colorado packs
const TOP = 6300;
const RADIUS = 250000; // composite dome, < camera far (300 km)

export type CloudCover = 'off' | 'cirrus' | 'few' | 'scattered' | 'broken' | 'overcast' | 'flurries' | 'storm';
/** 'cirrus' (FEAT-084) is thin high cloud drawn by the sky dome, no cumulus */
const COVER: Record<CloudCover, number> = { off: 0, cirrus: 0, few: 0.22, scattered: 0.3, broken: 0.42, overcast: 0, flurries: 0, storm: 0 };
export const CLOUD_COVERS = Object.keys(COVER) as CloudCover[];
/** A ?weather= / spot.json value as a cover ('clear' is an alias for 'off'); null when unknown. */
export function parseWeather(w: string | null | undefined): CloudCover | null {
  if (!w) return null;
  const v = w === 'clear' ? 'off' : w;
  return (CLOUD_COVERS as string[]).includes(v) ? v as CloudCover : null;
}
/** Full overcast: the cloud deck is drawn by the sky dome (Atmosphere.ts), not ray marched. */
export const isOvercast = (c: CloudCover): boolean => c === 'overcast' || c === 'flurries';

// ------------------------------------------------------------------ noise textures (CPU, once)
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
/** Tileable inverted Worley F1 at `cells` cells per side, sampled on an n^3 grid. */
function worley(n: number, cells: number, seed: number): Float32Array {
  const r = rng(seed);
  const pts = new Float32Array(cells * cells * cells * 3);
  for (let i = 0; i < pts.length; i++) pts[i] = r();
  const out = new Float32Array(n * n * n);
  const s = cells / n;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const px = (x + 0.5) * s, py = (y + 0.5) * s, pz = (z + 0.5) * s;
    const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ix = cx + dx, iy = cy + dy, iz = cz + dz;
      const wx = (ix + cells) % cells, wy = (iy + cells) % cells, wz = (iz + cells) % cells;
      const k = ((wz * cells + wy) * cells + wx) * 3;
      const ddx = ix + pts[k] - px, ddy = iy + pts[k + 1] - py, ddz = iz + pts[k + 2] - pz;
      const d = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d < best) best = d;
    }
    out[(z * n + y) * n + x] = 1 - Math.min(1, Math.sqrt(best));
  }
  return out;
}
/** Tileable smooth value-noise fbm (stands in for Perlin). */
function valueFbm(n: number, period: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(n * n * n);
  let amp = 0.5, norm = 0, p = period;
  for (let o = 0; o < octaves; o++) {
    const r = rng(seed + o * 101);
    const lat = new Float32Array(p * p * p); for (let i = 0; i < lat.length; i++) lat[i] = r();
    const s = p / n;
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const fx = x * s, fy = y * s, fz = z * s;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
      let tx = fx - x0, ty = fy - y0, tz = fz - z0;
      tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty); tz = tz * tz * (3 - 2 * tz);
      const L = (a: number, b: number, c: number) => lat[(((c % p) * p + (b % p)) * p) + (a % p)];
      const x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
      const v = (1 - tz) * ((1 - ty) * ((1 - tx) * L(x0, y0, z0) + tx * L(x1, y0, z0)) + ty * ((1 - tx) * L(x0, y1, z0) + tx * L(x1, y1, z0)))
        + tz * ((1 - ty) * ((1 - tx) * L(x0, y0, z1) + tx * L(x1, y0, z1)) + ty * ((1 - tx) * L(x0, y1, z1) + tx * L(x1, y1, z1)));
      out[(z * n + y) * n + x] += v * amp;
    }
    norm += amp; amp *= 0.5; p *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}
function worleyFbm(n: number, cells: number, seed: number): Float32Array {
  const a = worley(n, cells, seed), b = worley(n, cells * 2, seed + 7), c = worley(n, cells * 4, seed + 13);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * 0.625 + b[i] * 0.25 + c[i] * 0.125;
  return out;
}
function tex3d(n: number, channels: Float32Array[]): THREE.Data3DTexture {
  const c = channels.length;
  const data = new Uint8Array(n * n * n * c);
  for (let i = 0; i < n * n * n; i++) for (let k = 0; k < c; k++) data[i * c + k] = Math.max(0, Math.min(255, Math.round(channels[k][i] * 255)));
  const t = new THREE.Data3DTexture(data, n, n, n);
  t.format = c === 1 ? THREE.RedFormat : THREE.RGFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}
function makeNoise(): { base: THREE.Data3DTexture; detail: THREE.Data3DTexture } {
  const N = 64;
  const perlin = valueFbm(N, 4, 4, 11);
  const wf = worleyFbm(N, 4, 3);
  const pw = new Float32Array(perlin.length);
  // Perlin-Worley: Perlin remapped so Worley cells carve billows into it
  for (let i = 0; i < pw.length; i++) pw[i] = wf[i] + perlin[i] * (1 - wf[i]); // remap(perlin, 0, 1, worley, 1)
  const low = worleyFbm(N, 2, 5);
  const base = tex3d(N, [pw, low]);
  const detail = tex3d(32, [worleyFbm(32, 2, 9)]);
  return { base, detail };
}

// ------------------------------------------------------------------ shaders
const quadVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const marchFrag = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uBase;
uniform sampler3D uDetail;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCam;
uniform float uTime;
uniform float uCoverage;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uGroundCol;
uniform vec3 uHazeCol;
varying vec2 vUv;

#define BASE ${BASE.toFixed(1)}
#define TOP ${TOP.toFixed(1)}
#define SIGMA 0.09

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
float hg(float c, float g) { float g2 = g * g; return 0.0795775 * (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5); }
float phase(float c, float k) { return mix(hg(c, 0.8 * k), hg(c, -0.3 * k), 0.25); }

vec3 wind() { return vec3(uTime * 7.0, 0.0, uTime * 2.5); }

float density(vec3 p, bool detail) {
  float h = (p.y - BASE) / (TOP - BASE);
  if (h <= 0.0 || h >= 1.0) return 0.0;
  vec3 w = wind();
  // weather: where clouds are (very low frequency), and how tall they get there
  float wx = texture(uBase, vec3((p.xz + w.xz * 0.5) * 0.00007, 0.37).xzy).g;
  float cov = clamp(remap(wx, 1.0 - uCoverage - 0.08, 1.0 - uCoverage + 0.22, 0.0, 1.0), 0.0, 1.0);
  if (cov <= 0.0) return 0.0;
  float topH = 0.45 + 0.55 * cov; // bigger towers where coverage is high
  float grad = smoothstep(0.0, 0.07, h) * (1.0 - smoothstep(topH * 0.55, topH, h));
  vec2 b = texture(uBase, (p + w) * 0.00032).rg;
  float shape = remap(b.r, b.g - 1.0, 1.0, 0.0, 1.0);
  shape *= grad;
  float c = clamp(remap(shape, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0) * cov;
  if (detail && c > 0.0) {
    float dn = texture(uDetail, (p + w * 1.6) * 0.0022).r;
    float m = mix(dn, 1.0 - dn, clamp(h * 4.0, 0.0, 1.0)); // wispy base, billowy top
    c = clamp(remap(c, m * 0.45, 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  return c;
}

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(mat3(uCamWorld) * (v.xyz / v.w));
  vec3 ro = uCam;
  if (rd.y < 0.003 || ro.y > TOP || uCoverage <= 0.0) { gl_FragColor = vec4(0.0); return; }
  float t0 = max(0.0, (BASE - ro.y) / rd.y);
  float t1 = (TOP - ro.y) / rd.y;
  if (t0 > 120000.0) { gl_FragColor = vec4(0.0); return; }
  t1 = min(t1, t0 + 14000.0); // grazing rays: cap the path through the slab
  float dt = (t1 - t0) / float(STEPS);
  float t = t0 + dt * ign(gl_FragCoord.xy);
  float cosS = dot(rd, uSunDir);
  float T = 1.0;
  vec3 L = vec3(0.0);
  float tHit = -1.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = density(p, false);
    if (d > 0.0) {
      d = density(p, true);
      if (d > 0.001) {
        if (tHit < 0.0) tHit = t;
        // optical depth toward the sun
        float od = 0.0, s = 0.0;
        float lens[6] = float[6](70.0, 110.0, 170.0, 260.0, 400.0, 620.0);
        for (int j = 0; j < 6; j++) { s += lens[j]; od += density(p + uSunDir * (s - lens[j] * 0.5), j < 3) * lens[j]; }
        float h = clamp((p.y - BASE) / (TOP - BASE), 0.0, 1.0);
        // two-octave multiple scattering approximation
        vec3 sun = vec3(0.0);
        float a = 1.0, bsc = 1.0, k = 1.0;
        for (int o = 0; o < 2; o++) { sun += bsc * phase(cosS, k) * exp(-od * SIGMA * a); a *= 0.5; bsc *= 0.5; k *= 0.5; }
        float powder = 1.0 - exp(-d * 2.0 * 6.0);
        sun *= uSunCol * mix(1.0, powder, 0.5 + 0.5 * (1.0 - cosS) * 0.5) * 9.0;
        vec3 amb = mix(uGroundCol, uSkyCol, smoothstep(0.0, 0.7, h)) * (0.5 + 0.5 * h);
        float sig = d * SIGMA;
        float tr = exp(-sig * dt);
        vec3 S = (sun + amb);
        L += T * S * (1.0 - tr); // energy-conserving: (S - S*tr) / sig * sig
        T *= tr;
        if (T < 0.015) break;
      }
    }
    t += dt;
  }
  float alpha = 1.0 - T;
  if (tHit > 0.0) {
    // aerial perspective: distant clouds take on the horizon haze
    float haze = 1.0 - exp(-tHit / 38000.0);
    L = mix(L, uHazeCol * alpha, haze);
  }
  float edge = smoothstep(0.003, 0.06, rd.y);
  gl_FragColor = vec4(L * edge, alpha * edge);
}`;

const compVert = /* glsl */ `
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const compFrag = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uRes;
void main() {
  vec4 c = texture2D(uTex, gl_FragCoord.xy / uRes);
  if (c.a < 0.004) discard;
  gl_FragColor = vec4(c.rgb / c.a, c.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Clouds {
  readonly mesh: THREE.Mesh;
  private readonly comp: THREE.ShaderMaterial;
  private march: THREE.ShaderMaterial;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly noise = makeNoise();
  private steps = 0;
  private time = Math.random() * 3000;
  private readonly size = new THREE.Vector2();
  private readonly clear = new THREE.Color();

  constructor() {
    this.march = this.makeMarch(48);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.march);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.comp = new THREE.ShaderMaterial({
      vertexShader: compVert, fragmentShader: compFrag,
      uniforms: { uTex: { value: this.rt.texture }, uRes: { value: new THREE.Vector2(1, 1) } },
      side: THREE.BackSide, transparent: true, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 32, 16), this.comp);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }

  private makeMarch(steps: number): THREE.ShaderMaterial {
    this.steps = steps;
    return new THREE.ShaderMaterial({
      vertexShader: quadVert, fragmentShader: marchFrag, defines: { STEPS: steps },
      uniforms: {
        uBase: { value: this.noise.base }, uDetail: { value: this.noise.detail },
        uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 }, uCoverage: { value: COVER.scattered }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunCol: { value: new THREE.Color() }, uSkyCol: { value: new THREE.Color() }, uGroundCol: { value: new THREE.Color() }, uHazeCol: { value: new THREE.Color() },
      },
      depthTest: false, depthWrite: false,
    });
  }

  /** Settings: cover amount and quality (raymarch steps). */
  configure(cover: CloudCover, quality: 'high' | 'medium' | 'low'): void {
    const steps = quality === 'high' ? 64 : quality === 'medium' ? 44 : 28;
    if (steps !== this.steps) {
      const old = this.march;
      const m = this.makeMarch(steps);
      for (const k of Object.keys(old.uniforms)) m.uniforms[k].value = old.uniforms[k].value;
      this.march = m; this.quad.material = m; old.dispose();
    }
    this.march.uniforms.uCoverage.value = COVER[cover] ?? COVER.scattered;
    this.mesh.visible = COVER[cover] > 0; // a storm is fog and falling snow instead; overcast is the sky dome's grey deck
  }

  /**
   * Per frame, before the main render: ray march the clouds at half resolution.
   * Lighting comes from the current sun and sky so the clouds follow the time of day.
   */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, dt: number, sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number, sky: THREE.Color, skyIntensity: number, haze: THREE.Color): void {
    if (!this.mesh.visible) return;
    this.time += dt;
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x / 2)), h = Math.max(1, Math.floor(this.size.y / 2));
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    this.comp.uniforms.uRes.value.copy(this.size);
    this.mesh.position.copy(camera.position);
    const u = this.march.uniforms;
    camera.updateMatrixWorld();
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uCam.value.copy(camera.position);
    u.uTime.value = this.time;
    u.uSunDir.value.copy(sunDir);
    u.uSunCol.value.copy(sunColor).multiplyScalar(Math.max(0.04, sunIntensity));
    u.uSkyCol.value.copy(sky).multiplyScalar(skyIntensity * 0.9);
    // sunlit snow below bounces light onto the cloud bases
    const snow = 0.8 * (Math.max(0, sunDir.y) * Math.max(0.04, sunIntensity) + skyIntensity) / Math.PI;
    u.uGroundCol.value.copy(sunColor).lerp(sky, 0.4).multiplyScalar(snow);
    u.uHazeCol.value.copy(haze);
    const prev = renderer.getRenderTarget();
    renderer.getClearColor(this.clear); const ca = renderer.getClearAlpha();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0); renderer.clear();
    renderer.render(this.quadScene, this.quadCam);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(this.clear, ca);
  }
}
