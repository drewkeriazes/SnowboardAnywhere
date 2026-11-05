import * as THREE from 'three';
import { createPlaceholderTerrain } from './terrain/placeholder';
import { FlyCamera } from './camera/fly';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc3ea);
scene.fog = new THREE.Fog(0x9fc3ea, 1500, 6000);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 20000);
camera.position.set(0, 400, 900);

const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
sun.position.set(-1200, 1800, 600);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -2000;
sun.shadow.camera.right = sun.shadow.camera.top = 2000;
sun.shadow.camera.far = 6000;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x4a5a6a, 0.6));

// Placeholder until the Vail resort pack (M0) exists. Same interface the real
// streamed terrain will expose: a mesh plus heightAt(x, z) for physics.
const terrain = createPlaceholderTerrain({ size: 4000, segments: 256, amplitude: 350 });
scene.add(terrain.mesh);

const fly = new FlyCamera(camera, canvas);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  fly.update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
