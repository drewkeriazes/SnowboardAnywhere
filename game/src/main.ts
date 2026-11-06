import * as THREE from 'three';
import { Pack } from './pack/Pack';
import { Terrain } from './terrain/Terrain';
import { Rider } from './sim/Rider';
import { Collider } from './sim/Collider';
import { Bridges } from './world/Bridges';
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
import { Tracks } from './world/Tracks';
import { RiderChair } from './world/RiderChair';
import { buildCourses } from './sim/Courses';
import { TimeTrial } from './sim/TimeTrial';
import { TrialWorld } from './world/TrialWorld';
import { ResortMap } from './ui/ResortMap';
import { LiftRide } from './sim/LiftRide';
import { GameAudio } from './audio/Audio';
import { showMainMenu } from './ui/MainMenu';
import { PauseMenu } from './ui/PauseMenu';
import { Labels } from './ui/Labels';
import { TouchControls } from './ui/TouchControls';
import { sunPosition, guessUtcOffset } from './world/Sun';
import { loadSettings, type Settings } from './ui/Settings';
import { availableResorts } from './resorts';

const params = new URLSearchParams(location.search);
let packSlug = params.get('pack') ?? '';
const headless = params.has('headless');

async function main(): Promise<void> {
  const status = document.getElementById('status')!;
  // no ?pack: last resort played if it is built, else the first built real resort, else the synthetic mountain
  const resorts = await availableResorts(import.meta.env.BASE_URL);
  if (!packSlug) {
    let last = ''; try { last = localStorage.getItem('lastPack') ?? ''; } catch { /* ignore */ }
    packSlug = resorts.find((r) => r.slug === last)?.slug ?? resorts.find((r) => r.slug !== 'synth')?.slug ?? 'synth';
  }
  try { localStorage.setItem('lastPack', packSlug); } catch { /* ignore */ }
  status.textContent = `Loading ${packSlug}...`;
  const pack = await Pack.load(`${import.meta.env.BASE_URL}packs/${packSlug}`);
  document.title = `${pack.meta.name} - snowboard sim`;
  const audio = new GameAudio();
  const settings = loadSettings();
  const rp = params.get('rider'); if (rp === 'ski' || rp === 'board') settings.discipline = rp;
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
      const choice = await showMainMenu(pack.meta.name, audio, settings, () => undefined, resorts, packSlug);
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
    const buildings = new Buildings(pack, collider);
    scene.add(buildings.group);
    const roads = new Roads(pack);
    scene.add(roads.group);
    const bridges = new Bridges(pack, collider);
    scene.add(bridges.group);
    const tracks = new Tracks(pack);
    scene.add(tracks.group);
    const riderChair = new RiderChair(lifts.material);
    scene.add(riderChair.group);
    const chairPos = new THREE.Vector3();
    // time trials (off unless enabled in Settings > Game)
    const courses = buildCourses(pack);
    const trial = new TimeTrial(pack.meta.slug, courses);
    const trialWorld = new TrialWorld(pack, courses);
    scene.add(trialWorld.group);
    const trialEl = document.getElementById('trial')!;
    const finishArrow = document.getElementById('finish-arrow')!;
    const distStr = (m: number) => settings.units === 'metric' ? (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`) : (m >= 1609 ? `${(m / 1609.34).toFixed(2)} mi` : `${(m * 3.28084).toFixed(0)} ft`);
    let splitMsg = '', splitTimer = 0;
    const fmt = (t: number) => { const m = Math.floor(t / 60), sec = t - m * 60; return m > 0 ? `${m}:${sec.toFixed(2).padStart(5, '0')}` : `${sec.toFixed(2)}`; };
    trial.onEvent = (e) => {
      if (e.kind === 'armed') {
        const n = trial.candidates.length;
        splitMsg = n > 1 ? `<span class="dim">${n} courses start here: follow the one you want</span>` : `<span class="dim">Ride through the gate to start</span>`;
        splitTimer = 99;
      }
      else if (e.kind === 'start') { splitMsg = e.best ? `Ghost: ${fmt(e.best.time)}` : 'No ghost yet: set the time'; splitTimer = 3; audio.chime(); }
      else if (e.kind === 'split') { splitMsg = e.delta === null ? `Split ${e.index + 1}: ${fmt(e.time)}` : `<span class="${e.delta <= 0 ? 'ahead' : 'behind'}">${e.delta <= 0 ? '' : '+'}${e.delta.toFixed(2)}</span>`; splitTimer = 3; }
      else if (e.kind === 'finish') { splitMsg = e.isBest ? `<span class="ahead">New best ${fmt(e.time)}</span>` : `Finished ${fmt(e.time)} <span class="dim">(best ${fmt(e.best!.time)})</span>`; splitTimer = 6; audio.chime(); }
      else if (e.kind === 'cancel') { splitMsg = `<span class="behind">${e.reason}</span>`; splitTimer = 3; }
    };
    const refreshCourseFlags = () => { map.courseStarts = settings.timeTrials ? courses.map((c) => ({ x: c.start[0], y: c.start[1], name: c.name, best: trial.loadBest(c)?.time ?? null })) : []; };
    const labels = new Labels(pack);
    const riderView = new RiderView();
    scene.add(riderView.group);
    scene.add(riderView.sprayObject);

    const rider = new Rider(pack, collider);
    const liftRide = new LiftRide(pack, lifts);
    const cam = new ChaseCamera(pack, window.innerWidth / window.innerHeight);
    const controls = new Controls(canvas);
    const touch = TouchControls.wanted() ? new TouchControls(controls) : null;
    // cascaded shadows: every lit material gets the CSM hook
    env.registerMaterial(terrain.material);
    for (const m of Object.values(veg.mat)) env.registerMaterial(m);
    env.registerMaterial(rocks.material); env.registerMaterial(buildings.material); env.registerMaterial(roads.material); env.registerMaterial(lifts.material);
    for (const m of Object.values(riderView.mats)) env.registerMaterial(m);
    let csmSize = 0;
    if (!params.has('noimpostors')) veg.enableImpostors(renderer, true);
    const vignette = document.getElementById('vignette')!;

    // ---------------------------------------------------------------- sun / time of day
    const [lon, lat] = pack.meta.lonlat;
    const utcOff = guessUtcOffset(lon);
    const timeParam = params.get('time'); // ?time=now or ?time=16.5
    const applySun = (s: Settings) => {
      const mode: 'pack' | 'now' | number = timeParam === 'now' ? 'now' : timeParam && !Number.isNaN(Number(timeParam)) ? Number(timeParam) : s.timeOfDay;
      if (mode === 'pack') { env.setSun(pack.meta.sun.azimuth, pack.meta.sun.elevation); return; }
      let date: Date, hour: number;
      if (mode === 'now') { const now = new Date(); date = now; hour = now.getUTCHours() + now.getUTCMinutes() / 60 + utcOff; }
      else { const y = new Date().getFullYear(); date = new Date(Date.UTC(y, s.month - 1, 15)); hour = mode; }
      const p = sunPosition(lon, lat, date, hour, utcOff);
      env.setSun(p.azimuth, Math.max(-5, p.elevation));
    };
    let sunClock = 0;

    // ---------------------------------------------------------------- settings application
    const applySettings = (s: Settings, what: string): void => {
      applySun(s);
      audio.setVolumes(s.mute ? 0 : s.sfx, s.mute ? 0 : s.music);
      audio.setSource(s.musicSource);
      renderer.setPixelRatio(Math.min(s.pixelRatio, window.devicePixelRatio || 1, 2));
      if (renderer.shadowMap.enabled !== s.shadows) { renderer.shadowMap.enabled = s.shadows; renderer.shadowMap.needsUpdate = true; scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.needsUpdate = true; }); }
      const wantSize = (s.csmExperimental || params.has('csm')) && !params.has('nocsm') ? (s.quality === 'high' ? 2048 : 1024) : 0;
      if (csmSize !== wantSize) { csmSize = wantSize; if (wantSize) env.enableCSM(cam.camera, wantSize, 3); else env.disableCSM(); }
      env.sun.visible = wantSize === 0;
      env.sun.shadow.mapSize.set(s.quality === 'high' ? 4096 : 2048, s.quality === 'high' ? 4096 : 2048);
      env.setShadows(s.shadows);
      if (s.quality === 'low') setVegetationBudget(250, 600); else setVegetationDensity(s.treeDensity);
      cam.baseFov = s.fov;
      controls.keymap = { ...s.keys };
      controls.invertSteer = s.invertSteer;
      lifts.markers.visible = s.showMarkers;
      riderView.setOutfit(s.outfit);
      riderView.setDiscipline(s.discipline);
      tracks.setDiscipline(s.discipline);
      trialWorld.setEnabled(s.timeTrials);
      if (!s.timeTrials) trial.cancel('Time trials off');
      refreshCourseFlags();
      rider.discipline = s.discipline;
      labels.visible = s.showLabels;
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
      trial.cancel('Moved');
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
    // now-playing toast
    const toast = document.getElementById('toast')!;
    let toastTimer = 0;
    audio.onTrack = (name) => { toast.textContent = `\u266B ${name}`; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.classList.remove('show'), 4000); };
    const prompt = document.getElementById('prompt')!;
    let promptShown = '';
    const showPrompt = (html: string) => { if (html !== promptShown) { promptShown = html; prompt.innerHTML = html; prompt.classList.toggle('show', html !== ''); } };

    let mouseDx = 0, mouseDy = 0;
    const onClick = () => { if (!paused && (cam.mode === 'free' || cam.mode === 'fp')) canvas.requestPointerLock(); };
    const onMove = (e: MouseEvent) => { if (document.pointerLockElement === canvas || (controls.looking && !paused)) { mouseDx += e.movementX; mouseDy += e.movementY; } };
    const onResize = () => { renderer.setSize(window.innerWidth, window.innerHeight); cam.camera.aspect = window.innerWidth / window.innerHeight; cam.camera.updateProjectionMatrix(); env.onCameraChanged(); };
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
      touch?.destroy();
      map.destroy();
      pause.destroy();
      labels.destroy();
      tracks.dispose();
      trialWorld.dispose();
      trialEl.classList.remove('show');
      finishArrow.style.display = 'none';
      audio.onTrack = null;
      showPrompt('');
      hud.innerHTML = '';
      vignette.classList.remove('show');
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
      });
      env.disableCSM();
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
      if (controls.once('Escape') || touch?.once('pause')) { if (map.fullOpen) map.close(); else setPaused(!paused); }
      if (paused) { controls.endFrame(); touch?.pressed.clear(); renderer.render(scene, cam.camera); if (!headless) requestAnimationFrame(frame); return; }
      touch?.setVisible(!map.fullOpen);
      elapsed += dt;
      if (controls.action('restart')) { liftRide.cancel(); trial.cancel('Restarted'); rider.reset(sx, sy, sh); cam.snapTo(rider); }
      if (controls.action('trial') && settings.timeTrials) {
        const c = trial.nearestStart(rider.x, rider.y);
        if (c) {
          // a few metres above the start gate on the course line, facing down it
          const x = c.start[0] - c.dir[0] * 6, y = c.start[1] - c.dir[1] * 6;
          liftRide.cancel(); trial.cancel('Moved');
          pack.fine?.request(x - 600, y - 600, x + 600, y + 600); pack.mask?.request(x - 600, y - 600, x + 600, y + 600);
          rider.reset(x, y, Math.atan2(c.dir[0], c.dir[1])); cam.snapTo(rider);
        }
      }
      if (controls.action('camera') || touch?.once('camera')) cam.cycle();
      if (controls.action('map') || touch?.once('map')) map.toggle();
      if (controls.action('piste')) runs.toggle();
      if (controls.action('track')) audio.nextTrack();
      if (controls.action('fly')) { cam.mode = cam.mode === 'free' ? settings.camera : 'free'; if (cam.mode === 'free') cam.enterFree(); }
      const boardPressed = (controls.action('lift') || !!touch?.once('lift')) && cam.mode !== 'free';
      const onLift = cam.mode !== 'free' && liftRide.update(rider, dt, boardPressed, input.tuck);
      if (cam.mode !== 'free' && !onLift && !map.fullOpen) rider.update(dt, input);
      riderView.setFirstPerson(cam.mode === 'fp');
      riderView.update(rider, dt, input.tuck, input.grab, onLift && liftRide.airborneRide);
      tracks.update(rider, dt, onLift && liftRide.airborneRide);
      if (settings.timeTrials) {
        if (onLift) trial.cancel('On a lift'); else trial.update(rider, dt, input.tuck);
        trialWorld.updateGates(rider.x, rider.y);
        trialWorld.updateGhost(trial.ghostAt(trial.time), dt);
        const active = trial.state !== 'idle' ? trial.course : null;
        const showWalls = trial.state === 'running' || (trial.state === 'armed' && trial.candidates.length === 1);
        trialWorld.updateRoute(showWalls ? active : null, trial.along, trial.nextTarget, elapsed, trial.outside > 0);
        map.trialRoute = active ? active.points : null;
        // edge arrow toward the finish when it is off-screen or behind
        if (active) {
          const f = active.finish;
          const v = new THREE.Vector3(f[0], pack.groundHeight(f[0], f[1]) + 6, -f[1]).project(cam.camera);
          const behind = v.z > 1;
          const onScreen = !behind && Math.abs(v.x) < 0.92 && Math.abs(v.y) < 0.9;
          const distTo = Math.max(0, active.length - trial.along);
          if (!onScreen) {
            let ax = behind ? -v.x : v.x, ay = behind ? -v.y : v.y;
            const m = Math.max(Math.abs(ax), Math.abs(ay)) || 1; ax /= m; ay /= m;
            const sx = (ax * 0.88 + 1) / 2 * window.innerWidth, sy = (1 - (ay * 0.85)) / 2 * window.innerHeight;
            finishArrow.style.display = 'block';
            finishArrow.style.left = `${sx}px`; finishArrow.style.top = `${sy}px`;
            (finishArrow.firstElementChild as HTMLElement).style.transform = `rotate(${Math.atan2(ax, ay)}rad)`;
            finishArrow.lastElementChild!.textContent = `${distStr(distTo)}`;
          } else finishArrow.style.display = 'none';
        } else finishArrow.style.display = 'none';
        splitTimer -= dt;
        if (trial.state === 'running' || trial.state === 'armed' || splitTimer > 0) {
          const head = trial.course ? `<div class="name">${trial.course.name}</div>` : '';
          const clock = trial.state === 'running' ? `<div class="clock">${fmt(trial.time)}</div>` : '';
          const best = trial.course && trial.best ? `<div class="dim">Best ${fmt(trial.best.time)}</div>` : '';
          const prog = trial.state === 'running' && trial.course
            ? `<div class="togo">${distStr(Math.max(0, trial.course.length - trial.along))} to the finish</div><div class="bar"><div style="width:${Math.min(100, trial.along / trial.course.length * 100).toFixed(1)}%"></div></div>`
            : '';
          const oob = trial.state === 'running' && trial.outside > 0 ? `<div class="split behind">Out of bounds: back in ${trial.graceLeft.toFixed(1)} s</div>` : '';
          const headArmed = trial.state === 'armed' && trial.candidates.length > 1 ? `<div class="name">${trial.candidates.map((e) => e.c.name).slice(0, 4).join(' &middot; ')}</div>` : head;
          trialEl.innerHTML = headArmed + clock + prog + oob + best + (splitTimer > 0 ? `<div class="split">${splitMsg}</div>` : '');
          trialEl.classList.add('show');
        } else trialEl.classList.remove('show');
      } else { trialEl.classList.remove('show'); finishArrow.style.display = 'none'; map.trialRoute = null; }
      audio.update(rider, input.tuck, onLift, dt, liftRide.passedTower);
      rider.lastHit = '';
      if (cam.mode === 'free') { cam.updateFree(dt, controls.keys, mouseDx, mouseDy); mouseDx = mouseDy = 0; }
      else if (cam.mode === 'fp') { cam.updateFirstPerson(rider, dt, input.tuck, onLift || controls.looking, mouseDx, mouseDy); mouseDx = mouseDy = 0; }
      else { cam.freeLook(controls.looking, dt, mouseDx, mouseDy); mouseDx = mouseDy = 0; cam.update(rider, dt, input.tuck, onLift && liftRide.airborneRide); }
      vignette.classList.toggle('show', cam.mode === 'fp' && settings.fpVignette);
      cam.camera.updateMatrixWorld();
      env.updateCSM();
      veg.setSun(env.sun.color, env.sun.intensity);
      const cp = cam.camera.position;
      terrain.update(cp.x, -cp.z, cp.y);
      const fx = cam.mode === 'free' ? cp.x : rider.x, fy = cam.mode === 'free' ? -cp.z : rider.y;
      veg.update(fx, fy);
      rocks.update(fx, fy);
      roads.update(fx, fy);
      const carried = onLift && liftRide.airborneRide ? liftRide.lift : null;
      riderChair.update(carried, rider.x, rider.y, rider.z, rider.heading, liftRide.cableY);
      lifts.update(elapsed, carried ? chairPos.set(rider.x, rider.z, -rider.y) : null);
      lifts.maintain(dt, rider.x, rider.y);
      bridges.maintain(dt, rider.x, rider.y);
      if (settings.timeOfDay === 'now' || timeParam === 'now') { sunClock += dt; if (sunClock > 60) { sunClock = 0; applySun(settings); } }
      lifts.updateMarkers(elapsed, rider.x, rider.y, liftRide.canBoard ? liftRide.nearby : null);
      map.liftMarker = liftRide.nearby ? [liftRide.nearby.bottom[0], liftRide.nearby.bottom[1]] : null;
      if (onLift) {
        const pct = ((liftRide.up / (liftRide.lift ? lifts.rideLength(liftRide.lift) : 1)) * 100).toFixed(0);
        showPrompt(`<div class="name">${liftRide.lift?.feature.name ?? 'Lift'}</div><div class="row"><kbd>E</kbd> skip to the ${liftRide.lift?.kind === 'carpet' ? 'end' : 'top'} <span class="dim">${pct}%</span></div><div class="row"><kbd>W</kbd> hold for ${liftRide.fast ? '<b>3x speed</b>' : '3x speed'} &nbsp; <kbd>Alt</kbd> look around</div>`);
      } else if (liftRide.nearby && !map.fullOpen && cam.mode !== 'free') {
        const name = liftRide.nearby.feature.name ?? 'Lift';
        const dist = settings.units === 'metric' ? `${liftRide.nearbyDist.toFixed(0)} m` : `${(liftRide.nearbyDist * 3.28084).toFixed(0)} ft`;
        if (liftRide.canBoard) showPrompt(`<div class="name">${name}</div><div class="row"><kbd>E</kbd> ${liftRide.nearby.kind === 'gondola' ? 'board the gondola' : liftRide.nearby.kind === 'surface' ? 'grab the lift' : liftRide.nearby.kind === 'carpet' ? 'step on' : 'ride up'}</div>`);
        else if (liftRide.blocker === 'fast') showPrompt(`<div class="name">${name}</div><div class="row">slow down to board <kbd>&darr;</kbd> brake</div>`);
        else showPrompt(`<div class="name">${name}</div><div class="row">ride to the lift <span class="dim">${dist}</span> then <kbd>E</kbd></div>`);
      } else showPrompt('');
      env.update(fx, cam.mode === 'free' ? cp.y : rider.z, -fy);
      if (pack.fine) { pack.fine.request(fx - 400, fy - 400, fx + 400, fy + 400); if (terrain.stats.builds === 0) pack.fine.evictBeyond(fx, fy, 3000); }
      pack.mask?.request(fx - 400, fy - 400, fx + 400, fy + 400);
      map.riderPos = [rider.x, rider.y, rider.z];
      if (map.fullOpen) { if (fpsN % 10 === 0) map.drawFull(); }
      else if (fpsN % 3 === 0) map.drawMini(rider.x, rider.y, rider.heading);
      labels.update(cam.camera, settings.units === 'metric');
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
  const st = document.getElementById('status')!;
  st.style.maxWidth = '720px'; st.style.textAlign = 'center';
  st.textContent = `Error: ${e.message ?? e}`;
});
