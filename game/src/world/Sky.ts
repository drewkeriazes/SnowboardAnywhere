import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

/** Sky dome, sun light with a rider-following shadow camera, hemisphere fill and fog. */
export class Environment {
  readonly sky: Sky;
  readonly sun = new THREE.DirectionalLight(0xfff4e0, 3.2);
  readonly hemi = new THREE.HemisphereLight(0xcfe3ff, 0xd9e2ee, 0.9);
  readonly sunDir = new THREE.Vector3();
  readonly fog: THREE.Fog;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, azimuthDeg: number, elevationDeg: number) {
    this.sky = new Sky();
    this.sky.scale.setScalar(450000);
    scene.add(this.sky);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 3.5;
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;
    this.setSun(azimuthDeg, elevationDeg);

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

    this.fog = new THREE.Fog(0xc9d8ee, 4000, 90000);
    scene.fog = this.fog;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.75;
  }

  setSun(azimuthDeg: number, elevationDeg: number): void {
    // azimuth measured clockwise from north; three.js: north = -z, east = +x
    const az = THREE.MathUtils.degToRad(azimuthDeg), el = THREE.MathUtils.degToRad(elevationDeg);
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    const warm = THREE.MathUtils.clamp(elevationDeg / 40, 0, 1);
    this.sun.color.setRGB(1.0, 0.86 + 0.1 * warm, 0.72 + 0.2 * warm);
    this.sun.intensity = 2.2 + 1.5 * warm;
  }

  /** Keep the shadow frustum centred on the rider. */
  update(x: number, y: number, z: number): void {
    this.sun.target.position.set(x, y, z);
    this.sun.position.copy(this.sunDir).multiplyScalar(1200).add(this.sun.target.position);
    this.sun.target.updateMatrixWorld();
  }
}
