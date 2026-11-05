import * as THREE from 'three';
import { Pack } from './pack/Pack';
import { Terrain } from './terrain/Terrain';
import { Rider } from './sim/Rider';
import { Collider } from './sim/Collider';
import { Controls } from './sim/Controls';
import { Vegetation, setVegetationBudget } from './world/Vegetation';
import { Rocks } from './world/Rocks';
import { Lifts } from './world/Lifts';
import { RunsOverlay } from './world/RunsOverlay';
import { Environment } from './world/Sky';
import { RiderView } from './world/RiderView';
import { ChaseCamera } from './world/ChaseCamera';

const params = new URLSearchParams(location.search);
const packSlug = params.get('pack') ?? 'synth';
const headless = params.has('headless');
const lowgfx = params.has('lowgfx');

async function main(): Promise<void> {
  const hud = document.getElementById('hud')!;
  const status = document.getElementById('status')!;
  status.textContent = `Loading ${packSlug}...`;
  const pack = await Pack.load(`${import.meta.env.BASE_URL}packs/${packSlug}`);
  document.title = `${pack.meta.name} - snowboard sim`;

  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();

  const env = new Environment(scene, renderer, pack.meta.sun.azimuth, pack.meta.sun.elevation);
  if (lowgfx) { env.sun.shadow.mapSize.set(1024, 1024); renderer.setPixelRatio(1); renderer.shadowMap.enabled = false; setVegetationBudget(250, 600); }
  const terrain = new Terrain(pack);
  scene.add(terrain.group);
  const collider = new Collider();
  const veg = new Vegetation(pack, collider);
  scene.add(veg.group);
  const rocks = new Rocks(pack, collider);
  scene.add(rocks.group);
  const lifts = new Lifts(pack);
  scene.add(lifts.group);
  const runs = new RunsOverlay(pack);
  scene.add(runs.group);
  const riderView = new RiderView();
  scene.add(riderView.group);
  scene.add(riderView.sprayObject);

  const rider = new Rider(pack, collider);
  const start = pack.meta.start;
  const sx = params.has('x') ? Number(params.get('x')) : start.x;
  const sy = params.has('y') ? Number(params.get('y')) : start.y;
  const sh = params.has('h') ? Number(params.get('h')) * Math.PI / 180 : start.heading;
  // pre-request terrain around the start so the first frames have data
  pack.fine?.request(sx - 600, sy - 600, sx + 600, sy + 600);
  pack.mid?.request(sx - 20000, sy - 20000, sx + 20000, sy + 20000);
  pack.far?.request(-1e9, -1e9, 1e9, 1e9);
  pack.mask?.request(sx - 600, sy - 600, sx + 600, sy + 600);
  // wait briefly for the fine tiles under the start point
  const t0 = performance.now();
  while (Number.isNaN(pack.fine?.sample(sx, sy) ?? 0) && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
  rider.reset(sx, sy, sh);

  const cam = new ChaseCamera(pack, window.innerWidth / window.innerHeight);
  cam.snapTo(rider);
  const controls = new Controls(canvas);
  let mouseDx = 0, mouseDy = 0;
  canvas.addEventListener('click', () => { if (cam.mode === 'free') canvas.requestPointerLock(); });
  window.addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { mouseDx += e.movementX; mouseDy += e.movementY; } });
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    cam.camera.aspect = window.innerWidth / window.innerHeight;
    cam.camera.updateProjectionMatrix();
  });

  status.textContent = '';
  let last = performance.now();
  let fpsAcc = 0, fpsN = 0, fps = 0;
  let elapsed = 0;
  const clockStart = performance.now();
  const mph = (ms: number) => (ms * 2.23694).toFixed(0);
  const ft = (m: number) => (m * 3.28084).toFixed(0);

  function frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    elapsed = (now - clockStart) / 1000;
    const input = controls.update();
    if (controls.once('KeyR')) { rider.reset(sx, sy, sh); cam.snapTo(rider); }
    if (controls.once('KeyC')) cam.cycle();
    if (controls.once('KeyM')) runs.toggle();
    if (controls.once('KeyF')) { cam.mode = cam.mode === 'free' ? 'chase' : 'free'; if (cam.mode === 'free') cam.cycle(), cam.cycle(), cam.cycle(), cam.cycle(); }
    if (cam.mode !== 'free') rider.update(dt, input);
    riderView.update(rider, dt, input.tuck);
    if (cam.mode === 'free') { cam.updateFree(dt, controls.keys, mouseDx, mouseDy); mouseDx = mouseDy = 0; }
    else cam.update(rider, dt, input.tuck);
    const cp = cam.camera.position;
    terrain.update(cp.x, -cp.z, cp.y);
    veg.update(rider.x, rider.y);
    rocks.update(rider.x, rider.y);
    lifts.update(elapsed);
    env.update(rider.x, rider.z, -rider.y);
    if (pack.fine) { pack.fine.request(rider.x - 400, rider.y - 400, rider.x + 400, rider.y + 400); if (terrain.stats.builds === 0) pack.fine.evictBeyond(rider.x, rider.y, 3000); }
    pack.mask?.request(rider.x - 400, rider.y - 400, rider.x + 400, rider.y + 400);
    renderer.render(scene, cam.camera);
    controls.endFrame();

    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    hud.innerHTML =
      `<b>${mph(rider.speed)}</b> mph &nbsp; ${ft(rider.z)} ft &nbsp; slope ${rider.slopeDeg.toFixed(0)}&deg;` +
      (rider.onGround ? '' : ` &nbsp; AIR ${rider.airTime.toFixed(1)}s`) + (rider.crashed > 0 ? ' &nbsp; CRASH' : '') +
      `<br><span class="dim">${fps.toFixed(0)} fps &middot; ${terrain.stats.chunks} chunks &middot; ${(terrain.stats.triangles / 1000).toFixed(0)}k tris &middot; trees ${veg.stats.instances} &middot; cam ${cam.mode}` +
      ` &middot; pos ${rider.x.toFixed(0)}, ${rider.y.toFixed(0)}</span>`;
    (window as any).__sim = { rider, terrain, pack, cam, veg, fps };
    if (!headless) requestAnimationFrame(frame);
  }
  if (headless) {
    // deterministic stepping for screenshots: window.__step(n)
    (window as any).__step = (n: number, dtOverride = 1 / 60) => { for (let i = 0; i < n; i++) { last = performance.now() - dtOverride * 1000; frame(); } };
    (window as any).__shot = () => { last = performance.now() - 1000 / 60; frame(); return canvas.toDataURL('image/png'); };
    frame();
  } else {
    requestAnimationFrame(frame);
  }
}

main().catch((e) => {
  console.error(e);
  document.getElementById('status')!.textContent = `Error: ${e.message ?? e}`;
});
