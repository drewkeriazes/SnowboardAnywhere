import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

/**
 * Sky dome, sun with cascaded shadow maps (3 cascades over the first 1.2 km so trees shadow
 * pistes at distance and the rider still gets a crisp shadow), hemisphere fill and fog.
 * `sun` is kept as the colour/intensity reference; the CSM owns the actual lights.
 */
export class Environment {
  readonly sky: Sky;
  readonly sun = new THREE.DirectionalLight(0xfff4e0, 3.2);
  csm: CSM | null = null;
  private readonly scene: THREE.Scene;
  private readonly registered = new Set<THREE.Material>();
  readonly hemi = new THREE.HemisphereLight(0xcfe3ff, 0xd9e2ee, 0.9);
  readonly sunDir = new THREE.Vector3();
  readonly fog: THREE.Fog;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, azimuthDeg: number, elevationDeg: number) {
    this.scene = scene;
    this.sky = new Sky();
    this.sky.scale.setScalar(450000);
    scene.add(this.sky);
    const u = this.sky.material.uniforms;
    // colour grade after tone mapping (linear, before sRGB encode): ACES washes the physical sky out to pale grey-blue,
    // so the bluebird preset pushes saturation back up (uSkySat), tints toward cobalt and dims it
    u.uSkySat = { value: 1 }; u.uSkyBright = { value: 1 }; u.uSkyTint = { value: new THREE.Vector3(1, 1, 1) };
    const m = this.sky.material;
    m.fragmentShader = m.fragmentShader
      .replace('void main() {', 'uniform float uSkySat;\nuniform float uSkyBright;\nuniform vec3 uSkyTint;\nvoid main() {')
      .replace('#include <tonemapping_fragment>', '#include <tonemapping_fragment>\n\t\t\tfloat skyL = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );\n\t\t\tfloat skyK = smoothstep( -0.08, 0.16, direction.y ); // full grade overhead, a light one at the horizon\n\t\t\tvec3 skyT = mix( mix( vec3( 1.0 ), vec3( 0.62, 0.76, 1.0 ), step( 1.01, uSkySat ) ), uSkyTint, skyK );\n\t\t\tgl_FragColor.rgb = max( vec3( 0.0 ), mix( vec3( skyL ), gl_FragColor.rgb, mix( min( uSkySat, 2.2 ), uSkySat, skyK ) ) ) * skyT * mix( min( 1.0, uSkyBright * 1.5 ), uSkyBright, skyK );');
    u.turbidity.value = 3.5;
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;

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

    this.fog = new THREE.Fog(0xc9d8ee, 4000, 90000);
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
    for (const l of this.csm.lights) { l.shadow.normalBias = 0.5; l.color.copy(this.sun.color); }
    for (const m of this.registered) this.setupCSM(m);
    this.csm.updateFrustums();
  }
  disableCSM(): void {
    if (!this.csm) return;
    this.csm.remove(); this.csm.dispose(); this.csm = null;
    for (const m of this.registered) { (m as any).onBeforeCompile = (m as any).userData.baseHook ?? undefined; m.needsUpdate = true; }
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
  setSun(azimuthDeg: number, elevationDeg: number): void {
    this.lastSun = [azimuthDeg, elevationDeg];
    // azimuth measured clockwise from north; three.js: north = -z, east = +x
    const az = THREE.MathUtils.degToRad(azimuthDeg), el = THREE.MathUtils.degToRad(Math.max(-6, elevationDeg));
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    // colour and intensity by elevation: warm and dim near the horizon, white and bright at noon,
    // blue twilight below it
    const warm = THREE.MathUtils.clamp(elevationDeg / 40, 0, 1);
    const up = THREE.MathUtils.clamp((elevationDeg + 2) / 8, 0, 1); // 0 below the horizon
    this.sun.color.setRGB(1.0, 0.72 + 0.24 * warm, 0.45 + 0.47 * warm);
    this.sun.intensity = (1.4 + 2.3 * warm) * up;
    if (this.csm) {
      this.csm.lightDirection.copy(this.sunDir).negate();
      for (const l of this.csm.lights) { l.color.copy(this.sun.color); l.intensity = this.sun.intensity; }
    }
    const u = this.sky.material.uniforms;
    u.turbidity.value = 3.5 + (1 - warm) * 4;
    u.rayleigh.value = 1.6 + (1 - warm) * 1.2;
    u.mieCoefficient.value = 0.004 + (1 - warm) * 0.01;
    if (this.bluebird) {
      // crisp, dry Colorado air: very low haze, deep saturated blue (warmer and softer near dusk)
      u.turbidity.value = 1.2 + (1 - warm) * 2;
      u.rayleigh.value = 0.6 + (1 - warm) * 0.6;
      u.mieCoefficient.value = 0.0008 + (1 - warm) * 0.004;
      // matched to a Colorado bluebird photo: zenith about sRGB (15, 70, 145)
      u.uSkySat.value = 1 + 2 * warm;
      u.uSkyBright.value = 1 - 0.68 * warm;
      u.uSkyTint.value.set(1 - 0.65 * warm, 1 - 0.55 * warm, 1 - 0.05 * warm);
    } else {
      u.uSkySat.value = 1; u.uSkyBright.value = 1; u.uSkyTint.value.set(1, 1, 1);
    }
    // ambient: sky blue over snow, fades toward dusk blue
    const amb = 0.35 + 0.55 * up;
    this.hemi.intensity = amb;
    this.hemi.color.setRGB(0.81 * (0.7 + 0.3 * up), 0.89 * (0.75 + 0.25 * up), 1.0);
    this.fog.color.setRGB((0.79 - 0.3 * (1 - up)) + 0.1 * (1 - warm) * up, (0.85 - 0.3 * (1 - up)), 0.93 - 0.2 * (1 - up));
    // bluebird: distant terrain fades into a blue haze that matches the horizon, not a white glow
    if (this.bluebird) this.fog.color.setRGB(0.2 + 0.35 * (1 - warm), 0.32 + 0.3 * (1 - warm), 0.55 + 0.2 * (1 - warm)).multiplyScalar(0.55 + 0.45 * up);
    if (this.renderer) this.renderer.toneMappingExposure = 0.75 * (0.55 + 0.45 * up);
    this.sky.visible = !this.storm;
    this.stormDome.visible = this.storm;
    if (this.storm) {
      // overcast: the sun is a dim diffuse glow, the sky fill does most of the lighting
      this.sun.intensity *= 0.18;
      if (this.csm) for (const l of this.csm.lights) l.intensity = this.sun.intensity;
      this.hemi.intensity = 0.5 + 0.9 * up;
      this.hemi.color.setRGB(0.86, 0.88, 0.92);
      const g = 0.35 + 0.55 * up;
      this.fog.color.setRGB(0.8 * g, 0.82 * g, 0.86 * g);
      this.fog.near = 12; this.fog.far = 380;
      (this.stormDome.material as THREE.MeshBasicMaterial).color.copy(this.fog.color);
    } else {
      this.fog.near = 2000; this.fog.far = 50000; // aerial perspective: far ranges go blue-grey
    }
  }

  /** Keep the shadow frustum centred on the rider. */
  update(x: number, y: number, z: number): void {
    this.sun.target.position.set(x, y, z);
    this.sun.position.copy(this.sunDir).multiplyScalar(1200).add(this.sun.target.position);
    this.sun.target.updateMatrixWorld();
  }
}
