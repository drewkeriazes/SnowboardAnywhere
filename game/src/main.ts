import * as THREE from 'three';
import { Pack } from './pack/Pack';
import { Terrain } from './terrain/Terrain';
import { Rider } from './sim/Rider';
import { Collider } from './sim/Collider';
import { Controls } from './sim/Controls';
import { Vegetation, setVegetationBudget, setVegetationDensity } from './world/Vegetation';
import { Rocks } from './world/Rocks';
import { Lifts } from './world/Lifts';
import { RunsOverlay } from './world/RunsOverlay';
import { Environment } from './world/Sky';
import { RiderView } from './world/RiderView';
import { ChaseCamera } from './world/ChaseCamera';
import { Buildings } from './world/Buildings';
import { Roads } from './world/Roads';
import { ResortMap } from './ui/ResortMap';
import { LiftRide } from './sim/LiftRide';
import { GameAudio } from './audio/Audio';
import { showMainMenu } from './ui/MainMenu';
import { PauseMenu } from './ui/PauseMenu';
import { loadSettings, type Settings } from './ui/Settings';

const params = new URLSearchParams(location.search);
const packSlug = params.get('pack') ?? 'synth';
const headless = params.has('headless');

async function main(): Promise<void> {
  const status = document.getElementById('status')!;
  status.textContent = `Loading ${packSlug}...`;
  const pack = await Pack.load(`${import.meta.env.BASE_URL}packs/${packSlug}`);
  document.title = `${pack.meta.name} - snowboard sim`;
  const audio = new GameAudio();
  const settings = loadSettings();
  if (params.has('lowgfx')) { settings.quality = 'low'; settings.shadows = false; settings.treeDensity = 0.3; settings.pixelRatio = 1; }
  status.textContent = '';

  // one renderer for the whole page; sessions build and tear down their scene
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // menu -> session -> (quit) -> menu ...
  for (;;) {
    let openMapAtStart = false;
    if (!headless) {
      const choice = await showMainMenu(pack.meta.name, audio, settings, () => undefined);
      openMapAtStart = choice.action === 'map';
    }
    status.textContent = `Loading ${packSlug}...`;
    await runSession(pack, renderer, canvas, audio, settings, openMapAtStart);
    if (headless) break;
  }
}

/** Resolves when the player quits to the main menu. */
function runSession(pack: Pack, renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement, audio: GameAudio, settings: Settings, openMapAtStart: boolean): Promise<void> {
  return new Promise<void>((resolveQuit) => {
    const hud = document.getElementById('hud')!;
    const status = document.getElementById('status')!;
    const scene = new THREE.Scene();
    const env = new Environment(scene, renderer, pack.meta.sun.azimuth, pack.meta.sun.elevation);
    const terrain = new Terrain(pack);
    scene.add(terrain.group);
    const collider = new Collider();
    const veg = new Vegetation(pack, collider);
    scene.add(veg.group);
    const rocks = new Rocks(pack, collider);
    scene.add(rocks.group);
    const lifts = new Lifts(pack);
    scene.add(lifts.group);
    scene.add(lifts.markers);
    const runs = new RunsOverlay(pack);
    scene.add(runs.group);
    const buildings = new Buildings(pack);
    scene.add(buildings.group);
    const roads = new Roads(pack);
    scene.add(roads.group);
    const riderView = new RiderView();
    scene.add(riderView.group);
    scene.add(riderView.sprayObject);

    const rider = new Rider(pack, collider);
    const liftRide = new LiftRide(pack, lifts);
    const cam = new ChaseCamera(pack, window.innerWidth / window.innerHeight);
    const controls = new Controls(canvas);
    const vignette = document.getElementById('vignette')!;

    // ---------------------------------------------------------------- settings application
    const applySettings = (s: Settings, what: string): void => {
      audio.setVolumes(s.mute ? 0 : s.sfx, s.mute ? 0 : s.music);
      renderer.setPixelRatio(Math.min(s.pixelRatio, window.devicePixelRatio || 1, 2));
      if (renderer.shadowMap.enabled !== s.shadows) { renderer.shadowMap.enabled = s.shadows; renderer.shadowMap.needsUpdate = true; scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.needsUpdate = true; }); }
      env.sun.castShadow = s.shadows;
      env.sun.shadow.mapSize.set(s.quality === 'high' ? 4096 : 2048, s.quality === 'high' ? 4096 : 2048);
      if (s.quality === 'low') setVegetationBudget(250, 600); else setVegetationDensity(s.treeDensity);
      cam.baseFov = s.fov;
      controls.keymap = { ...s.keys };
      controls.invertSteer = s.invertSteer;
      lifts.markers.visible = s.showMarkers;
      map.metric = s.units === 'metric';
      if (what === 'camera' || what === 'reset') cam.mode = s.camera;
    };

    // ---------------------------------------------------------------- spawn point
    const start = pack.meta.start;
    const saveKey = `spawn:${pack.meta.slug}`;
    let saved: { x: number; y: number; h: number } | null = null;
    try { saved = JSON.parse(localStorage.getItem(saveKey) ?? 'null'); } catch { saved = null; }
    let sx = params.has('x') ? Number(params.get('x')) : saved?.x ?? start.x;
    let sy = params.has('y') ? Number(params.get('y')) : saved?.y ?? start.y;
    let sh = params.has('h') ? Number(params.get('h')) * Math.PI / 180 : saved?.h ?? start.heading;
    const setSpawn = (x: number, y: number, h: number) => {
      sx = x; sy = y; sh = h;
      try { localStorage.setItem(saveKey, JSON.stringify({ x, y, h })); } catch { /* private mode */ }
      const u = new URL(location.href);
      u.searchParams.set('x', x.toFixed(1)); u.searchParams.set('y', y.toFixed(1)); u.searchParams.set('h', (h * 180 / Math.PI).toFixed(0));
      history.replaceState(null, '', u.toString());
    };
    const map = new ResortMap(pack);
    map.spawnPos = [sx, sy];
    map.onPick = (x, y) => {
      const n = pack.groundNormal(x, y) as number[];
      const h = Math.hypot(n[0], n[1]) > 0.02 ? Math.atan2(n[0], n[1]) : 0;
      setSpawn(x, y, h);
      map.spawnPos = [x, y];
      liftRide.cancel();
      pack.fine?.request(x - 600, y - 600, x + 600, y + 600);
      pack.mask?.request(x - 600, y - 600, x + 600, y + 600);
      rider.reset(x, y, h);
      cam.mode = cam.mode === 'free' ? 'chase' : cam.mode;
      cam.snapTo(rider);
      map.close();
    };

    const pause = new PauseMenu(settings, applySettings);
    let paused = false;
    const setPaused = (p: boolean) => {
      paused = p;
      if (p) pause.show(); else pause.hide();
      audio.setDuck(p ? 0.3 : 1);
    };
    pause.onAction = (a) => {
      if (a === 'resume') setPaused(false);
      else if (a === 'restart') { setPaused(false); liftRide.cancel(); rider.reset(sx, sy, sh); cam.snapTo(rider); }
      else if (a === 'map') { setPaused(false); map.open(); }
      else if (a === 'quit') { setPaused(false); dispose(); resolveQuit(); }
    };

    // ---------------------------------------------------------------- scene setup
    applySettings(settings, 'init');
    cam.mode = params.get('cam') === 'fp' ? 'fp' : settings.camera;
    pack.fine?.request(sx - 600, sy - 600, sx + 600, sy + 600);
    pack.mid?.request(sx - 20000, sy - 20000, sx + 20000, sy + 20000);
    pack.far?.request(-1e9, -1e9, 1e9, 1e9);
    pack.mask?.request(sx - 600, sy - 600, sx + 600, sy + 600);
    const prompt = document.getElementById('prompt')!;
    let promptShown = '';
    const showPrompt = (html: string) => { if (html !== promptShown) { promptShown = html; prompt.innerHTML = html; prompt.classList.toggle('show', html !== ''); } };

    let mouseDx = 0, mouseDy = 0;
    const onClick = () => { if (!paused && (cam.mode === 'free' || cam.mode === 'fp')) canvas.requestPointerLock(); };
    const onMove = (e: MouseEvent) => { if (document.pointerLockElement === canvas) { mouseDx += e.movementX; mouseDy += e.movementY; } };
    const onResize = () => { renderer.setSize(window.innerWidth, window.innerHeight); cam.camera.aspect = window.innerWidth / window.innerHeight; cam.camera.updateProjectionMatrix(); };
    canvas.addEventListener('click', onClick);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('resize', onResize);

    let alive = true;
    const dispose = () => {
      alive = false;
      canvas.removeEventListener('click', onClick);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      map.destroy();
      pause.destroy();
      showPrompt('');
      hud.innerHTML = '';
      vignette.classList.remove('show');
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
      });
      renderer.clear();
    };

    let last = performance.now();
    let fpsAcc = 0, fpsN = 0, fps = 0;
    let elapsed = 0;
    const clockStart = performance.now();
    const speedStr = (ms: number) => settings.units === 'metric' ? `${(ms * 3.6).toFixed(0)}</b> km/h` : `${(ms * 2.23694).toFixed(0)}</b> mph`;
    const altStr = (m: number) => settings.units === 'metric' ? `${m.toFixed(0)} m` : `${(m * 3.28084).toFixed(0)} ft`;

    function frame(): void {
      if (!alive) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const input = controls.update();
      // pause has priority; Esc closes the map first if it is open
      if (controls.once('Escape')) { if (map.fullOpen) map.close(); else setPaused(!paused); }
      if (paused) { controls.endFrame(); renderer.render(scene, cam.camera); if (!headless) requestAnimationFrame(frame); return; }
      elapsed += dt;
      if (controls.action('restart')) { liftRide.cancel(); rider.reset(sx, sy, sh); cam.snapTo(rider); }
      if (controls.action('camera')) cam.cycle();
      if (controls.action('map')) map.toggle();
      if (controls.action('piste')) runs.toggle();
      if (controls.action('track')) audio.nextTrack();
      if (controls.action('fly')) { cam.mode = cam.mode === 'free' ? settings.camera : 'free'; if (cam.mode === 'free') cam.enterFree(); }
      const boardPressed = controls.action('lift') && cam.mode !== 'free';
      const onLift = cam.mode !== 'free' && liftRide.update(rider, dt, boardPressed);
      if (cam.mode !== 'free' && !onLift && !map.fullOpen) rider.update(dt, input);
      riderView.setFirstPerson(cam.mode === 'fp');
      riderView.update(rider, dt, input.tuck);
      audio.update(rider, input.tuck, onLift, dt, liftRide.passedTower);
      rider.lastHit = '';
      if (cam.mode === 'free') { cam.updateFree(dt, controls.keys, mouseDx, mouseDy); mouseDx = mouseDy = 0; }
      else if (cam.mode === 'fp') { cam.updateFirstPerson(rider, dt, input.tuck, onLift, mouseDx, mouseDy); mouseDx = mouseDy = 0; }
      else cam.update(rider, dt, input.tuck);
      vignette.classList.toggle('show', cam.mode === 'fp' && settings.fpVignette);
      const cp = cam.camera.position;
      terrain.update(cp.x, -cp.z, cp.y);
      const fx = cam.mode === 'free' ? cp.x : rider.x, fy = cam.mode === 'free' ? -cp.z : rider.y;
      veg.update(fx, fy);
      rocks.update(fx, fy);
      roads.update(fx, fy);
      lifts.update(elapsed);
      lifts.updateMarkers(elapsed, rider.x, rider.y, liftRide.canBoard ? liftRide.nearby : null);
      map.liftMarker = liftRide.nearby ? [liftRide.nearby.bottom[0], liftRide.nearby.bottom[1]] : null;
      if (onLift) {
        const pct = ((liftRide.up / (liftRide.lift?.length ?? 1)) * 100).toFixed(0);
        showPrompt(`<div class="name">${liftRide.lift?.feature.name ?? 'Lift'}</div><div class="row"><kbd>E</kbd> skip to the top <span class="dim">${pct}%</span></div>`);
      } else if (liftRide.nearby && !map.fullOpen && cam.mode !== 'free') {
        const name = liftRide.nearby.feature.name ?? 'Lift';
        const dist = settings.units === 'metric' ? `${liftRide.nearbyDist.toFixed(0)} m` : `${(liftRide.nearbyDist * 3.28084).toFixed(0)} ft`;
        if (liftRide.canBoard) showPrompt(`<div class="name">${name}</div><div class="row"><kbd>E</kbd> ride up</div>`);
        else if (liftRide.blocker === 'fast') showPrompt(`<div class="name">${name}</div><div class="row">slow down to board <kbd>&darr;</kbd> brake</div>`);
        else showPrompt(`<div class="name">${name}</div><div class="row">ride to the lift <span class="dim">${dist}</span> then <kbd>E</kbd></div>`);
      } else showPrompt('');
      env.update(fx, cam.mode === 'free' ? cp.y : rider.z, -fy);
      if (pack.fine) { pack.fine.request(fx - 400, fy - 400, fx + 400, fy + 400); if (terrain.stats.builds === 0) pack.fine.evictBeyond(fx, fy, 3000); }
      pack.mask?.request(fx - 400, fy - 400, fx + 400, fy + 400);
      map.riderPos = [rider.x, rider.y, rider.z];
      if (map.fullOpen) { if (fpsN % 10 === 0) map.drawFull(); }
      else if (fpsN % 3 === 0) map.drawMini(rider.x, rider.y, rider.heading);
      renderer.render(scene, cam.camera);
      controls.endFrame();

      fpsAcc += dt; fpsN++;
      if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
      hud.innerHTML =
        `<b>${speedStr(rider.speed)} &nbsp; ${altStr(rider.z)} &nbsp; slope ${rider.slopeDeg.toFixed(0)}&deg;` +
        (rider.onGround ? '' : ` &nbsp; AIR ${rider.airTime.toFixed(1)}s`) + (rider.crashed > 0 ? ' &nbsp; CRASH' : '') +
        `<br><span class="dim">${fps.toFixed(0)} fps &middot; ${terrain.stats.chunks} chunks &middot; ${(terrain.stats.triangles / 1000).toFixed(0)}k tris &middot; trees ${veg.stats.instances} &middot; cam ${cam.mode}` +
        ` &middot; pos ${rider.x.toFixed(0)}, ${rider.y.toFixed(0)}</span>`;
      (window as any).__sim = { rider, terrain, pack, cam, veg, fps, map, liftRide, lifts, setSpawn, settings };
      if (!headless) requestAnimationFrame(frame);
    }

    // wait briefly for the fine tiles under the start point, then go
    (async () => {
      const t0 = performance.now();
      while (Number.isNaN(pack.fine?.sample(sx, sy) ?? 0) && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
      rider.reset(sx, sy, sh);
      lifts.buildMarkers(pack);
      cam.snapTo(rider);
      status.textContent = '';
      if (openMapAtStart) map.open();
      last = performance.now();
      if (headless) {
        (window as any).__step = (n: number, dtOverride = 1 / 60) => { for (let i = 0; i < n; i++) { last = performance.now() - dtOverride * 1000; frame(); } };
        (window as any).__shot = () => { last = performance.now() - 1000 / 60; frame(); return canvas.toDataURL('image/png'); };
        frame();
      } else {
        requestAnimationFrame(frame);
      }
    })();
    void clockStart;
  });
}

main().catch((e) => {
  console.error(e);
  document.getElementById('status')!.textContent = `Error: ${e.message ?? e}`;
});
