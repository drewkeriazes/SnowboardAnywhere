import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { Atmosphere } from './Atmosphere';

/** FEAT-092: the most the sun's colour may depart from neutral: (max - min) / max of the RGB */
const SUN_TINT_MAX = 0.32;
/** Lift a colour's weaker channels toward its brightest until its saturation is at most `max` (the brightness, its max, is kept). */
export function capTint(c: THREE.Color, max: number): void {
  const hi = Math.max(c.r, c.g, c.b), lo = Math.min(c.r, c.g, c.b);
  if (hi <= 0) return;
  const sat = (hi - lo) / hi;
  if (sat <= max) return;
  const f = max / sat;
  c.setRGB(hi - (hi - c.r) * f, hi - (hi - c.g) * f, hi - (hi - c.b) * f);
}

/**
 * Sky and atmosphere (Atmosphere.ts: scattering sky, height fog, aerial perspective), sun with cascaded shadow maps (3 cascades over the first 1.2 km so trees shadow
 * pistes at distance and the rider still gets a crisp shadow) and hemisphere fill.
 * `sun` is kept as the colour/intensity reference; the CSM owns the actual lights.
 */
export class Environment {
  readonly atmo: Atmosphere;
  readonly sky: THREE.Mesh;
  readonly sun = new THREE.DirectionalLight(0xfff4e0, 3.2);
  csm: CSM | null = null;
  private readonly scene: THREE.Scene;
  private readonly registered = new Set<THREE.Material>();
  readonly hemi = new THREE.HemisphereLight(0xcfe3ff, 0xd9e2ee, 0.9);
  readonly sunDir = new THREE.Vector3();
  /** only switches three's fog chunks on (USE_FOG); the atmosphere chunk ignores near/far */
  readonly fog: THREE.Fog;

  /**
   * @param valleyY valley floor height (m), where the haze sits
   * @param viewerAlt altitude the sky is computed from (m), roughly mid-mountain
   */
  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, azimuthDeg: number, elevationDeg: number, valleyY = 0, viewerAlt = 3000) {
    this.scene = scene;
    this.atmo = new Atmosphere(valleyY, viewerAlt);
    this.sky = this.atmo.sky;
    this.sky.name = 'sky';
    this.sun.name = 'sun';
    this.sun.target.name = 'sun target';
    this.hemi.name = 'hemisphere light';
    this.stormDome.name = 'storm dome';
    scene.add(this.sky);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const cam = this.sun.shadow.camera;
    cam.near = 1; cam.far = 2500;
    cam.left = -260; cam.right = 260; cam.top = 260; cam.bottom = -260;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.add(this.hemi);
    this.stormDome.visible = false;
    this.stormDome.frustumCulled = false;
    this.stormDome.renderOrder = -2;
    scene.add(this.stormDome);
    this.sun.visible = false; // the CSM lights replace it once enableCSM runs

    this.fog = new THREE.Fog(0xc9d8ee, 2000, 50000);
    scene.fog = this.fog;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.75;
    this.renderer = renderer;
    this.setSun(azimuthDeg, elevationDeg);
  }

  /** Create the cascades for a camera. Call once per session after the camera exists; call again to change map size. */
  enableCSM(camera: THREE.PerspectiveCamera, mapSize: number, cascades = 3): void {
    this.disableCSM();
    this.csm = new CSM({ camera, parent: this.scene, cascades, maxFar: 1200, mode: 'practical', shadowMapSize: mapSize, shadowBias: -0.00015, lightDirection: this.sunDir.clone().negate(), lightIntensity: this.sun.intensity, lightMargin: 300, lightNear: 1, lightFar: 3000 });
    this.csm.fade = true;
    for (const l of this.csm.lights) { l.shadow.normalBias = 0.5; l.shadow.intensity = this.sun.shadow.intensity; l.color.copy(this.sun.color); }
    for (const m of this.registered) this.setupCSM(m);
    this.csm.updateFrustums();
  }
  disableCSM(): void {
    if (!this.csm) return;
    this.csm.remove(); this.csm.dispose(); this.csm = null;
    for (const m of this.registered) { if ((m as any).userData.baseHook) (m as any).onBeforeCompile = (m as any).userData.baseHook; else delete (m as any).onBeforeCompile; delete (m as any).customProgramCacheKey; m.needsUpdate = true; }
  }
  /** Register a material so it receives cascaded shadows (also applies a material's own onBeforeCompile first). */
  registerMaterial(m: THREE.Material): void {
    if (this.registered.has(m)) return;
    this.registered.add(m);
    if (!(m as any).userData.baseHook && (m as any).onBeforeCompile) (m as any).userData.baseHook = (m as any).onBeforeCompile;
    if (this.csm) this.setupCSM(m);
  }
  private setupCSM(m: THREE.Material): void {
    const base = (m as any).userData.baseHook as ((shader: any, renderer: any) => void) | undefined;
    this.csm!.setupMaterial(m);
    const csmHook = (m as any).onBeforeCompile as (shader: any, renderer: any) => void;
    (m as any).onBeforeCompile = (shader: any, renderer: any) => { base?.(shader, renderer); csmHook(shader, renderer); };
    // three.js caches programs by onBeforeCompile.toString(); the wrapper above has the same source
    // for every material, so key on the material's own hook or the terrain reuses another
    // material's shader (BUG-009: black terrain, white rocks)
    const key = 'csm|' + (base ? base.toString() : '');
    m.customProgramCacheKey = () => key;
    m.needsUpdate = true;
  }
  setShadows(on: boolean): void { if (this.csm) for (const l of this.csm.lights) l.castShadow = on; this.sun.castShadow = on; }
  /** Per frame after the camera moved. */
  updateCSM(): void { this.csm?.update(); }
  onCameraChanged(): void { this.csm?.updateFrustums(); }

  private renderer: THREE.WebGLRenderer | null = null;
  /** bluebird day: crisp, deep blue sky (low haze) when there are no clouds */
  bluebird = false;
  private lastSun: [number, number] = [160, 30];
  setBluebird(on: boolean): void { this.bluebird = on; this.setSun(this.lastSun[0], this.lastSun[1]); }
  /** snowstorm: no sky, grey overcast dome, thick fog (render distance ~400 m), flat light */
  storm = false;
  readonly stormDome = new THREE.Mesh(new THREE.SphereGeometry(1000, 24, 12), new THREE.MeshBasicMaterial({ side: THREE.BackSide, fog: true, depthWrite: false }));
  setStorm(on: boolean): void { this.storm = on; this.setSun(this.lastSun[0], this.lastSun[1]); }
  /** overcast (FEAT-078): grey cloud deck, no sun disc, soft shadowless light, flat snow, more haze; the sky still reaches the horizon */
  overcast = false;
  setOvercast(on: boolean): void { this.overcast = on; this.setSun(this.lastSun[0], this.lastSun[1]); }
  private readonly deckColor = new THREE.Color();
  /** morning valley fog layer (burns off as the sun climbs) */
  valleyFog = false;
  setValleyFog(on: boolean): void { this.valleyFog = on; this.setSun(this.lastSun[0], this.lastSun[1]); }
  private readonly stormColor = new THREE.Color();
  setSun(azimuthDeg: number, elevationDeg: number): void {
    this.lastSun = [azimuthDeg, elevationDeg];
    // azimuth measured clockwise from north; three.js: north = -z, east = +x
    const az = THREE.MathUtils.degToRad(azimuthDeg), el = THREE.MathUtils.degToRad(Math.max(-6, elevationDeg));
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    // intensity by elevation (the colour comes from the atmosphere's transmittance below)
    const warm = THREE.MathUtils.clamp(elevationDeg / 40, 0, 1);
    const up = THREE.MathUtils.clamp((elevationDeg + 2) / 8, 0, 1); // 0 below the horizon
    this.sun.intensity = (1.4 + 2.3 * warm) * up;
    const exposure = 0.75 * (0.55 + 0.45 * up);
    if (this.renderer) this.renderer.toneMappingExposure = exposure;
    const g = 0.35 + 0.55 * up;
    this.stormColor.setRGB(0.8 * g, 0.82 * g, 0.86 * g);
    const gd = 0.3 + 0.7 * up;
    this.deckColor.setRGB(0.72 * gd, 0.74 * gd, 0.78 * gd); // the Mid-Vail photo's sky, about sRGB (182, 187, 197)
    this.atmo.update({ sunDir: this.sunDir, sunElevationDeg: elevationDeg, exposure, bluebird: this.bluebird, storm: this.storm, stormColor: this.stormColor, valleyFog: this.valleyFog, overcast: this.overcast && !this.storm, deckColor: this.deckColor });
    this.sun.color.copy(this.atmo.sunColor);
    // FEAT-092: cap the golden-hour tint: a low sun stays warm, but snow should not go orange
    capTint(this.sun.color, SUN_TINT_MAX);
    if (this.csm) {
      this.csm.lightDirection.copy(this.sunDir).negate();
      for (const l of this.csm.lights) { l.color.copy(this.sun.color); l.intensity = this.sun.intensity; }
    }
    // ambient: sky blue over snow, fades toward dusk blue
    const amb = 0.35 + 0.55 * up;
    this.hemi.intensity = amb;
    this.hemi.color.setRGB(0.81 * (0.7 + 0.3 * up), 0.89 * (0.75 + 0.25 * up), 1.0);
    this.fog.color.copy(this.storm ? this.stormColor : this.atmo.hazeDisplay);
    this.sky.visible = !this.storm;
    this.stormDome.visible = this.storm;
    if (this.storm) {
      // overcast: the sun is a dim diffuse glow, the sky fill does most of the lighting
      this.sun.intensity *= 0.18;
      if (this.csm) for (const l of this.csm.lights) l.intensity = this.sun.intensity;
      this.hemi.intensity = 0.5 + 0.9 * up;
      this.hemi.color.setRGB(0.86, 0.88, 0.92);
      (this.stormDome.material as THREE.MeshBasicMaterial).color.copy(this.stormColor);
    } else if (this.overcast) {
      // the deck diffuses the sun: a weak directional term keeps some form, the grey sky does the rest
      this.sun.intensity *= 0.2;
      if (this.csm) for (const l of this.csm.lights) l.intensity = this.sun.intensity;
      this.hemi.intensity = 0.6 + 1.8 * up; // snow a shade brighter than the deck, as in the photos
      this.hemi.color.setRGB(0.88, 0.9, 0.94);
    }
    // overcast is shadowless; shadow.intensity avoids the shader recompiles a castShadow toggle causes
    const shadow = this.overcast && !this.storm ? 0 : 1;
    this.sun.shadow.intensity = shadow;
    if (this.csm) for (const l of this.csm.lights) l.shadow.intensity = shadow;
  }

  /** Per frame: keep the sky box and storm dome around the camera. */
  followCamera(p: THREE.Vector3): void { this.sky.position.copy(p); this.stormDome.position.copy(p); }

  /** Keep the shadow frustum centred on the rider. */
  update(x: number, y: number, z: number): void {
    this.sun.target.position.set(x, y, z);
    this.sun.position.copy(this.sunDir).multiplyScalar(1200).add(this.sun.target.position);
    this.sun.target.updateMatrixWorld();
  }
}
