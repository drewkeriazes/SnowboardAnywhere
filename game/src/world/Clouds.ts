import * as THREE from 'three';

/**
 * Volumetric cumulus layer. A huge camera-centred dome (inside the far plane, behind all terrain)
 * runs a raymarch per sky pixel through a cloud slab at BASE..TOP metres altitude: 3D value-noise
 * fbm shaped by a height profile and a coverage threshold, lit with a short march toward the sun
 * (Beer-Lambert + powder), a two-lobe Henyey-Greenstein phase for the silver lining, and sky
 * ambient. Wind drifts the field. Sun direction and colour follow the time of day each frame.
 * Coverage comes from Settings > Graphics > Clouds; step count from the quality preset.
 */
const BASE = 4700; // m above sea level (above every summit in the Colorado packs)
const TOP = 6600;
const RADIUS = 250000; // dome radius, < camera far (300 km)

export type CloudCover = 'off' | 'few' | 'scattered' | 'broken' | 'storm';
const COVER: Record<CloudCover, number> = { off: 0, few: 0.32, scattered: 0.48, broken: 0.66, storm: 0 };

const vert = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const frag = /* glsl */ `
uniform float uTime;
uniform float uCoverage;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
varying vec3 vWorld;

#define BASE ${BASE.toFixed(1)}
#define TOP ${TOP.toFixed(1)}

float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p, int oct) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { if (i >= oct) break; s += a * noise(p); p = p * 2.03 + vec3(1.7, 9.2, 4.1); a *= 0.5; }
  return s;
}
float density(vec3 p, int oct) {
  float h = clamp((p.y - BASE) / (TOP - BASE), 0.0, 1.0);
  // cumulus profile: flat base, rounded top
  float prof = smoothstep(0.0, 0.12, h) * smoothstep(1.0, 0.45, h);
  vec3 q = p * vec3(0.00022, 0.00045, 0.00022) + vec3(uTime * 0.0016, 0.0, uTime * 0.0007);
  // big cells decide where clouds are, fbm gives the cauliflower
  float cells = noise(p * 0.00006 + vec3(uTime * 0.0004, 0.0, 0.0));
  float n = fbm(q, oct) * 0.75 + cells * 0.45;
  // threshold tuned so roughly uCoverage of the sky is covered (n has mean ~0.57, sd ~0.12)
  float d = (n * prof - (0.745 - 0.35 * uCoverage)) * 4.0;
  return clamp(d, 0.0, 1.0);
}
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  if (rd.y < 0.005 || ro.y > TOP || uCoverage <= 0.0) discard;
  float t0 = max(0.0, (BASE - ro.y) / rd.y);
  float t1 = (TOP - ro.y) / rd.y;
  if (t0 > 90000.0) discard;
  t1 = min(t1, t0 + 9000.0); // grazing rays: cap the path through the slab
  float dt = (t1 - t0) / float(STEPS);
  float t = t0 + dt * hash(vec3(gl_FragCoord.xy, uTime)); // jitter hides banding
  float T = 1.0;
  vec3 col = vec3(0.0);
  float cosSun = dot(rd, uSunDir);
  float phase = mix(hg(cosSun, 0.6), hg(cosSun, -0.2), 0.3);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = density(p, 4);
    if (d > 0.002) {
      // light march toward the sun
      float ld = 0.0;
      for (int j = 1; j <= LIGHT_STEPS; j++) ld += density(p + uSunDir * (180.0 * float(j)), 2);
      float sunT = exp(-ld * 180.0 * 0.006);
      float powder = 1.0 - exp(-d * 6.0);
      float h = clamp((p.y - BASE) / (TOP - BASE), 0.0, 1.0);
      vec3 lit = uSunColor * sunT * powder * phase * 9.0 + uAmbient * (0.45 + 0.55 * h);
      float a = 1.0 - exp(-d * dt * 0.006);
      col += T * a * lit;
      T *= 1.0 - a;
      if (T < 0.02) break;
    }
    t += dt;
  }
  float alpha = 1.0 - T;
  // aerial perspective: distant clouds fade into the sky and the horizon
  float fade = exp(-t0 / 45000.0) * smoothstep(0.005, 0.09, rd.y);
  gl_FragColor = vec4(col * fade, alpha * fade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Clouds {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private steps = 0;
  private time = Math.random() * 1000;

  constructor() {
    this.mat = this.makeMaterial(28, 3);
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 32, 16), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1; // first among the transparent objects
  }

  private makeMaterial(steps: number, lightSteps: number): THREE.ShaderMaterial {
    this.steps = steps;
    return new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag,
      defines: { STEPS: steps, LIGHT_STEPS: lightSteps },
      uniforms: {
        uTime: { value: 0 }, uCoverage: { value: COVER.scattered },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(1, 1, 1) }, uAmbient: { value: new THREE.Color(0.6, 0.7, 0.85) },
      },
      side: THREE.BackSide, transparent: true, depthWrite: false,
      // premultiplied colour
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
  }

  /** Settings: cover amount and quality (raymarch steps). */
  configure(cover: CloudCover, quality: 'high' | 'medium' | 'low'): void {
    const steps = quality === 'high' ? 28 : quality === 'medium' ? 18 : 10;
    if (steps !== this.steps) {
      const old = this.mat; const u = old.uniforms;
      const m = this.makeMaterial(steps, quality === 'low' ? 2 : 3);
      for (const k of Object.keys(u)) m.uniforms[k].value = u[k].value;
      this.mat = m; this.mesh.material = m; old.dispose();
    }
    this.mat.uniforms.uCoverage.value = COVER[cover] ?? COVER.scattered;
    this.mesh.visible = cover !== 'off' && cover !== 'storm'; // a storm is fog and falling snow instead
  }

  /** Per frame: follow the camera, drift with the wind, light from the current sun. */
  update(dt: number, camPos: THREE.Vector3, sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number, ambient: THREE.Color, ambientIntensity: number): void {
    this.time += dt;
    this.mesh.position.copy(camPos);
    const u = this.mat.uniforms;
    u.uTime.value = this.time;
    u.uSunDir.value.copy(sunDir);
    // dim the sun term near and below the horizon; keep a little so dusk clouds glow
    u.uSunColor.value.copy(sunColor).multiplyScalar(Math.max(0.05, sunIntensity / 3.7));
    u.uAmbient.value.copy(ambient).multiplyScalar(0.55 * ambientIntensity + 0.08);
  }
}
