import * as THREE from 'three';
import { buildSkyView, skyRadiance, toDisplay, transmittance, RAYLEIGH_SEA, RAYLEIGH_H, SKY_W, SKY_H, type Air } from './scattering';

/**
 * Atmosphere shared by the sky, the clouds and everything with `fog: true`.
 *
 * - The sky dome samples a sky-view table from the single-scattering model in scattering.ts,
 *   rebuilt on the CPU whenever the sun elevation changes (replaces the Preetham sky and its grade).
 * - three's fog chunks are replaced with analytic aerial perspective: a Rayleigh air layer
 *   (wavelength-dependent extinction, 8 km scale height) plus exponential height haze that is
 *   dense at the valley floor and thin on the ridges, plus an optional low valley-fog layer.
 *   The in-scattered colour is the horizon colour of the same model in that azimuth, so distant
 *   terrain converges to exactly the sky at the horizon behind it, at any time of day.
 *
 * All parameters live in one shared Float32Array uniform (`uAtmo`). It is added to every built-in
 * ShaderLib entry with fog: three clones uniforms per program, but UniformsUtils.cloneUniforms only
 * copies plain arrays and math objects, so a typed array value stays shared by reference and one
 * write per frame reaches every material. ShaderMaterials that clone UniformsLib.fog get it too.
 *
 * Layout (vec4 each):
 *   0 haze density at ref height (1/m), haze 1/scale height, haze ref height (y), air density scale
 *   1 sun direction (three.js world), -
 *   2..6 horizon colour (display space) at 0, 45, 90, 135, 180 degrees of azimuth from the sun
 *   7 Rayleigh extinction at sea level (rgb, 1/m), 1/scale height
 *   8 valley fog: density at ref, 1/scale height, ref height, -
 *   9 haze light colour (display), how much the haze takes it over the horizon colour
 */
export const ATMO = new Float32Array(40);
const ATMO_UNIFORM = { value: ATMO };

/** GLSL shared by the fog chunk and the sky dome. Needs `uniform vec4 uAtmo[10];` and cameraPosition. */
export const ATMO_GLSL = /* glsl */ `
float atmoLayer(float d0, float k, float ref, float y0, float y1, float t) {
  // optical depth of an exponential layer d0 * exp(-(y - ref) * k) along a straight segment
  float a = clamp(-(y0 - ref) * k, -80.0, 80.0);
  float dy = (y1 - y0) * k;
  if (abs(dy) < 1e-4) return d0 * t * exp(a);
  float b = clamp(-(y1 - ref) * k, -80.0, 80.0);
  return d0 * t * (exp(a) - exp(b)) / dy;
}
vec3 atmoHorizon(vec3 rd) {
  vec2 h = rd.xz, s = uAtmo[1].xz;
  float hl = length(h), sl = length(s);
  float c = (hl > 1e-5 && sl > 1e-5) ? dot(h, s) / (hl * sl) : 0.0;
  float a = acos(clamp(c, -1.0, 1.0)) * (4.0 / 3.14159265);
  int i = int(min(floor(a), 3.0));
  return mix(uAtmo[2 + i].rgb, uAtmo[3 + i].rgb, a - float(i));
}
vec3 atmoApply(vec3 col, vec3 ray) {
  float t = length(ray);
  if (t < 1e-3) return col;
  vec3 rd = ray / t;
  float y0 = cameraPosition.y, y1 = y0 + ray.y;
  vec3 odA = uAtmo[7].rgb * (uAtmo[0].w * atmoLayer(1.0, uAtmo[7].w, 0.0, y0, y1, t));
  float odH = atmoLayer(uAtmo[0].x, uAtmo[0].y, uAtmo[0].z, y0, y1, t) + atmoLayer(uAtmo[8].x, uAtmo[8].y, uAtmo[8].z, y0, y1, t);
  vec3 T = exp(-(odA + vec3(odH)));
  float wH = odH / (odH + dot(odA, vec3(0.3333)) + 1e-6);
  vec3 sky = atmoHorizon(rd);
  vec3 inscat = mix(sky, mix(sky, uAtmo[9].rgb, uAtmo[9].w), wH);
  return col * T + inscat * (1.0 - T);
}
`;

let installed = false;
/** Swap three's fog chunks for the atmosphere. Call before any material compiles. */
export function installAtmosphereFog(): void {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.fog_pars_vertex = '#ifdef USE_FOG\n\tvarying float vFogDepth;\n\tvarying vec3 vFogRay;\n#endif\n';
  // world-space offset from the camera: the view rotation is orthonormal, so v * mat3(view) undoes it
  C.fog_vertex = '#ifdef USE_FOG\n\tvFogDepth = - mvPosition.z;\n\tvFogRay = mvPosition.xyz * mat3( viewMatrix );\n#endif\n';
  C.fog_pars_fragment = '#ifdef USE_FOG\n\tuniform vec3 fogColor;\n\tvarying float vFogDepth;\n\tvarying vec3 vFogRay;\n\tuniform vec4 uAtmo[10];\n\t#ifdef FOG_EXP2\n\t\tuniform float fogDensity;\n\t#else\n\t\tuniform float fogNear;\n\t\tuniform float fogFar;\n\t#endif\n' + ATMO_GLSL + '#endif\n';
  C.fog_fragment = '#ifdef USE_FOG\n\tgl_FragColor.rgb = atmoApply( gl_FragColor.rgb, vFogRay );\n#endif\n';
  (THREE.UniformsLib.fog as Record<string, unknown>).uAtmo = ATMO_UNIFORM;
  for (const s of Object.values(THREE.ShaderLib) as { uniforms: Record<string, unknown> }[]) if (s.uniforms.fogColor) s.uniforms.uAtmo = ATMO_UNIFORM;
}

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w; // on the far plane, behind everything
}`;
const skyFrag = /* glsl */ `
uniform sampler2D uSkyView;
uniform vec4 uAtmo[10];
uniform vec3 uSunDisc;
uniform vec2 uSunCos;
uniform vec4 uDeck; // overcast: horizon grey (display), w = 1 when on
varying vec3 vDir;
${ATMO_GLSL}
void main() {
  vec3 rd = normalize(vDir);
  vec3 s = uAtmo[1].xyz;
  float e = asin(clamp(rd.y, -1.0, 1.0)) / 1.5707963;
  float v = 0.5 + 0.5 * sign(e) * sqrt(abs(e));
  vec2 h = rd.xz, sh = s.xz;
  float c = (length(h) > 1e-5 && length(sh) > 1e-5) ? dot(normalize(h), normalize(sh)) : 0.0;
  vec3 L = texture2D(uSkyView, vec2(acos(clamp(c, -1.0, 1.0)) / 3.14159265, v)).rgb;
  float disc = smoothstep(uSunCos.x, uSunCos.y, dot(rd, s)) * step(-0.01, rd.y);
  gl_FragColor = vec4(L + uSunDisc * disc, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // at and below the horizon: exactly the colour the terrain fog converges to in this azimuth
  float k = exp(-max(rd.y, 0.0) * 30.0) * (1.0 - disc);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, atmoHorizon(rd), k);
  if (uDeck.w > 0.5) {
    // overcast: a uniform grey deck, a little darker overhead, no sun disc, only a faint brighter
    // patch where the sun is behind the cloud (kept off the horizon so distant ridges still meet it)
    float up = max(rd.y, 0.0);
    vec3 deck = uDeck.rgb * mix(1.0, 0.95, smoothstep(0.0, 0.8, up));
    deck += uDeck.rgb * 0.07 * pow(max(dot(rd, s), 0.0), 4.0) * smoothstep(0.0, 0.25, up);
    gl_FragColor.rgb = deck;
  }
  gl_FragColor.rgb += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
}`;

/** Radiance scale: sun illuminance in renderer units (calibrated so a bluebird zenith at a 30 degree sun is about sRGB (10, 70, 145)). */
const SUN_E = 20;
const AZ = [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, Math.PI];

export interface AtmoState {
  sunDir: THREE.Vector3;
  sunElevationDeg: number;
  exposure: number;
  /** clouds or not: more aerosol and valley haze when it is not a bluebird day */
  bluebird: boolean;
  storm: boolean;
  /** storm fog colour (display) */
  stormColor: THREE.Color;
  /** morning valley fog layer on */
  valleyFog: boolean;
  /** full overcast (FEAT-078): grey deck instead of the sky, greyer and denser haze */
  overcast: boolean;
  /** overcast deck colour at the horizon (display) */
  deckColor: THREE.Color;
}

export class Atmosphere {
  readonly sky: THREE.Mesh;
  /** horizon haze colour across the sun (linear radiance) for the cloud march */
  readonly hazeLinear = new THREE.Color();
  /** horizon colour across the sun (display), for anything that wants one flat fog colour */
  readonly hazeDisplay = new THREE.Color();
  /** sun colour from the transmittance at the viewer (max component 1) */
  readonly sunColor = new THREE.Color(1, 1, 1);
  private readonly lut: THREE.DataTexture;
  private readonly lutData = new Float32Array(SKY_W * SKY_H * 4);
  private readonly half = new Uint16Array(SKY_W * SKY_H * 4);
  private readonly mat: THREE.ShaderMaterial;
  private lastKey = '';

  /**
   * @param valleyY height of the valley floor (m): where the haze is densest
   * @param viewerAlt altitude the sky is computed from (m)
   */
  constructor(private readonly valleyY: number, private readonly viewerAlt: number) {
    installAtmosphereFog();
    this.lut = new THREE.DataTexture(this.half, SKY_W, SKY_H, THREE.RGBAFormat, THREE.HalfFloatType);
    this.lut.magFilter = THREE.LinearFilter; this.lut.minFilter = THREE.LinearFilter;
    this.lut.wrapS = this.lut.wrapT = THREE.ClampToEdgeWrapping;
    this.lut.colorSpace = THREE.NoColorSpace;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: skyVert, fragmentShader: skyFrag,
      uniforms: { uSkyView: { value: this.lut }, uAtmo: ATMO_UNIFORM, uSunDisc: { value: new THREE.Vector3() }, uSunCos: { value: new THREE.Vector2(Math.cos(0.0085), Math.cos(0.0072)) }, uDeck: { value: new THREE.Vector4() } },
      side: THREE.BackSide, depthWrite: false,
    });
    this.sky = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000), this.mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -3;
    // constant parts of the layout
    ATMO[28] = RAYLEIGH_SEA[0]; ATMO[29] = RAYLEIGH_SEA[1]; ATMO[30] = RAYLEIGH_SEA[2]; ATMO[31] = 1 / RAYLEIGH_H;
  }

  /** Recompute for a new sun / weather. Cheap when only the azimuth changed. */
  update(st: AtmoState): void {
    const w = THREE.MathUtils.clamp(st.sunElevationDeg / 40, 0, 1);
    const air: Air = { mie: st.bluebird ? 0.6 : 1.2, g: 0.8, ms: 0.1 };
    const sunEl = THREE.MathUtils.degToRad(st.sunElevationDeg);
    ATMO[4] = st.sunDir.x; ATMO[5] = st.sunDir.y; ATMO[6] = st.sunDir.z;

    // colour grade in linear radiance before tone mapping: ACES desaturates a physical sky to pale
    // grey-blue, so a high sun gets more saturation and a slight cobalt tint (a low sun keeps its colours)
    const sat = 1 + 0.9 * w, tr = 1 - 0.22 * w, tg = 1 - 0.08 * w, tb = 1 + 0.06 * w;
    const grade = (L: number[]): number[] => {
      const l = 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2];
      L[0] = Math.max(0, l + (L[0] - l) * sat) * tr * SUN_E;
      L[1] = Math.max(0, l + (L[1] - l) * sat) * tg * SUN_E;
      L[2] = Math.max(0, l + (L[2] - l) * sat) * tb * SUN_E;
      return L;
    };

    const key = `${st.sunElevationDeg.toFixed(2)}|${air.mie}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      buildSkyView(this.viewerAlt, sunEl, 1, air, this.lutData);
      const L = [0, 0, 0];
      for (let i = 0; i < SKY_W * SKY_H; i++) {
        L[0] = this.lutData[i * 4]; L[1] = this.lutData[i * 4 + 1]; L[2] = this.lutData[i * 4 + 2];
        grade(L);
        this.half[i * 4] = THREE.DataUtils.toHalfFloat(L[0]);
        this.half[i * 4 + 1] = THREE.DataUtils.toHalfFloat(L[1]);
        this.half[i * 4 + 2] = THREE.DataUtils.toHalfFloat(L[2]);
        this.half[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
      }
      this.lut.needsUpdate = true;
      const T = transmittance(this.viewerAlt, Math.sin(sunEl), [0, 0, 0], air);
      const m = Math.max(T[0], T[1], T[2], 1e-6);
      this.sunColor.setRGB(T[0] / m, T[1] / m, T[2] / m);
      // the disc: bright enough to clip to white at noon, reddened through the air near the horizon
      (this.mat.uniforms.uSunDisc.value as THREE.Vector3).set(T[0], T[1], T[2]).multiplyScalar(SUN_E * 40);
    }

    // horizon ring (display space, at the current exposure) for the fog chunk and the horizon blend
    const L = [0, 0, 0], D = [0, 0, 0];
    for (let i = 0; i < 5; i++) {
      grade(skyRadiance(this.viewerAlt, 0, AZ[i], sunEl, L, air));
      if (i === 2) this.hazeLinear.setRGB(L[0], L[1], L[2]);
      toDisplay(L, st.exposure, D);
      if (st.storm) { D[0] = st.stormColor.r; D[1] = st.stormColor.g; D[2] = st.stormColor.b; }
      else if (st.overcast) { D[0] = st.deckColor.r; D[1] = st.deckColor.g; D[2] = st.deckColor.b; }
      ATMO[8 + i * 4] = D[0]; ATMO[9 + i * 4] = D[1]; ATMO[10 + i * 4] = D[2];
      if (i === 2) this.hazeDisplay.setRGB(D[0], D[1], D[2]);
    }
    // haze light: a whiter, brighter version of the horizon (forward-scattering aerosol and water droplets)
    const hl = (0.2126 * this.hazeLinear.r + 0.7152 * this.hazeLinear.g + 0.0722 * this.hazeLinear.b) * 1.15;
    const hz = toDisplay([THREE.MathUtils.lerp(this.hazeLinear.r, hl * this.sunColor.r, 0.6), THREE.MathUtils.lerp(this.hazeLinear.g, hl * (0.5 + 0.5 * this.sunColor.g), 0.6), THREE.MathUtils.lerp(this.hazeLinear.b, hl * (0.4 + 0.6 * this.sunColor.b), 0.6)], st.exposure, [0, 0, 0]);
    ATMO[36] = hz[0]; ATMO[37] = hz[1]; ATMO[38] = hz[2]; ATMO[39] = 0.6;

    (this.mat.uniforms.uDeck.value as THREE.Vector4).set(st.deckColor.r, st.deckColor.g, st.deckColor.b, st.overcast ? 1 : 0);
    if (st.storm) {
      // whiteout: uniform dense fog, visibility about 400 m, no air layer or valley structure
      ATMO[0] = 0.0103; ATMO[1] = 0; ATMO[2] = 0; ATMO[3] = 0;
      ATMO[32] = 0; ATMO[33] = 0; ATMO[34] = 0;
      ATMO[36] = st.stormColor.r; ATMO[37] = st.stormColor.g; ATMO[38] = st.stormColor.b; ATMO[39] = 1;
      return;
    }
    // valley haze: about 35 km visibility scale at the valley floor, a tenth of that density 1 km up
    ATMO[0] = (st.bluebird ? 1 : 2) / 35000; ATMO[1] = 1 / 450; ATMO[2] = this.valleyY; ATMO[3] = 1.6;
    if (st.overcast) {
      // overcast: thicker, deeper haze in the deck's grey, so ridges a few km off go soft and grey
      ATMO[0] = 5 / 35000; ATMO[1] = 1 / 1100;
      ATMO[36] = st.deckColor.r; ATMO[37] = st.deckColor.g; ATMO[38] = st.deckColor.b; ATMO[39] = 1;
    }
    // morning valley fog: a thick layer a hundred metres deep that burns off as the sun climbs
    const fog = st.valleyFog ? 0.15 + 0.85 * (1 - THREE.MathUtils.smoothstep(st.sunElevationDeg, 8, 40)) : 0;
    ATMO[32] = fog / 500; ATMO[33] = 1 / 100; ATMO[34] = this.valleyY + 150;
  }
}
