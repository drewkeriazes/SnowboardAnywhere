import * as THREE from 'three';
import { Pack } from './pack/Pack';
import { Terrain } from './terrain/Terrain';
import { Rider } from './sim/Rider';
import { Collider } from './sim/Collider';
import { Bridges } from './world/Bridges';
import { Clouds, isOvercast, parseWeather, type CloudCover } from './world/Clouds';
import { Snow } from './world/Snow';
import { Controls } from './sim/Controls';
import { Vegetation, setVegetationBudget, setVegetationDensity } from './world/Vegetation';
import { Rocks } from './world/Rocks';
import { Lifts } from './world/Lifts';
import { RunsOverlay } from './world/RunsOverlay';
import { Environment } from './world/Sky';
import { RiderView, BODY_LAYER } from './world/RiderView';
import { GoggleView } from './ui/GoggleView';
import { ChaseCamera } from './world/ChaseCamera';
import { Buildings } from './world/Buildings';
import { Roads } from './world/Roads';
import { Tracks } from './world/Tracks';
import { Bootprints } from './world/Bootprints';
import { Outrun } from './sim/Outrun';
import { Monsters } from './world/Monster';
import { Puffs } from './world/Puffs';
import { Eat } from './world/Eat';
import { OutrunUI } from './ui/OutrunUI';
import { RiderChair } from './world/RiderChair';
import { buildCourses } from './sim/Courses';
import { TimeTrial } from './sim/TimeTrial';
import { TrialWorld } from './world/TrialWorld';
import { ResortMap } from './ui/ResortMap';
import { LiftRide } from './sim/LiftRide';
import { Prefetch } from './sim/Prefetch';
import { GameAudio } from './audio/Audio';
import { showMainMenu } from './ui/MainMenu';
import { PauseMenu } from './ui/PauseMenu';
import { Labels } from './ui/Labels';
import { TouchControls } from './ui/TouchControls';
import { sunPosition, guessUtcOffset } from './world/Sun';
import { loadSettings, keyName, type Settings } from './ui/Settings';
import { STAMINA } from './sim/Rider';
import { availableResorts } from './resorts';
import { hasCustomStart, resetStart, spawnKey } from './spawn';

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
  // before the menu, so the first song comes from the saved source and playlist
  audio.source = settings.musicSource;
  audio.playlist = settings.playlist;
  status.textContent = '';

  // one renderer for the whole page; sessions build and tear down their scene
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // menu -> session -> (quit) -> menu ...
  let skipMenu = params.get('cam') === 'eye'; // an eye link opens straight at its view
  for (;;) {
    let openMapAtStart = false;
    if (!headless && !skipMenu) {
      const startInfo = { resortLabel: pack.meta.start.run ? `Starts on ${pack.meta.start.run}` : 'Starts at the resort start', custom: hasCustomStart(packSlug), onReset: () => resetStart(packSlug) };
      const choice = await showMainMenu(pack.meta.name, audio, settings, () => undefined, resorts, packSlug, startInfo);
      openMapAtStart = choice.action === 'map';
    }
    status.textContent = `Loading ${packSlug}...`;
    skipMenu = false;
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
    const zr = pack.meta.zRange ?? [0, 3000];
    const env = new Environment(scene, renderer, pack.meta.sun.azimuth, pack.meta.sun.elevation, zr[0], (zr[0] + zr[1]) / 2);
    // names show up in the Three.js DevTools scene tree and in scene.getObjectByName()
    const add = (name: string, o: THREE.Object3D) => { o.name = name; scene.add(o); };
    const clouds = new Clouds();
    add('clouds', clouds.mesh);
    const snow = new Snow();
    add('snowfall', snow.points);
    const terrain = new Terrain(pack);
    add('terrain', terrain.group);
    const collider = new Collider();
    const veg = new Vegetation(pack, collider);
    add('trees', veg.group);
    const rocks = new Rocks(pack, collider);
    add('rocks', rocks.group);
    const lifts = new Lifts(pack);
    add('lifts', lifts.group);
    add('lift markers', lifts.markers);
    const runs = new RunsOverlay(pack);
    add('run lines', runs.group);
    const buildings = new Buildings(pack, collider);
    add('buildings', buildings.group);
    const roads = new Roads(pack);
    add('roads', roads.group);
    const bridges = new Bridges(pack, collider, params.has('bridgeguess')); // BUG-022: OSM-tagged bridges only by default
    add('bridges', bridges.group);
    const tracks = new Tracks(pack);
    add('tracks', tracks.group);
    const bootprints = new Bootprints(pack);
    add('bootprints', bootprints.mesh);
    const riderChair = new RiderChair(lifts.material);
    add('rider chair', riderChair.group);
    // Outrun (FEAT-097 to FEAT-101): the chase sim, the monsters, their big prints, puffs, the eat sequence, the HUD
    const outrun = new Outrun(pack, lifts);
    const puffs = new Puffs();
    add('puffs', puffs.points);
    const bigprints = new Bootprints(pack, 3.2);
    add('monster prints', bigprints.mesh);
    const monsters = new Monsters(pack, collider, puffs, bigprints);
    add('monsters', monsters.group);
    const eat = new Eat(pack, puffs);
    add('eat sequence', eat.group);
    const outrunUI = new OutrunUI();
    let chase = audio.chase();
    const eatPosing = new Set<number>();
    const eatLook = new THREE.Vector3();
    let countLast = -1;
    const chairPos = new THREE.Vector3();
    // time trials (off unless enabled in Settings > Game)
    const courses = buildCourses(pack);
    const trial = new TimeTrial(pack.meta.slug, courses);
    const trialWorld = new TrialWorld(pack, courses);
    add('time trials', trialWorld.group);
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
    add('rider', riderView.group);
    add('rider spray', riderView.sprayObject);

    const rider = new Rider(pack, collider);
    // on foot (FEAT-067): every foot plant of the skeleton leaves a print and a footstep
    riderView.setPack(pack);
    riderView.onPlant = (p) => { bootprints.add(p, rider.sink); audio.footstep(rider.surface, p.speed, rider.sink); };
    let boardMsg = '', boardMsgT = 0;
    const liftRide = new LiftRide(pack, lifts, collider);
    const prefetch = new Prefetch();
    const cam = new ChaseCamera(pack, window.innerWidth / window.innerHeight);
    const controls = new Controls(canvas);
    const touch = TouchControls.wanted() ? new TouchControls(controls) : null;
    // cascaded shadows: every lit material gets the CSM hook
    env.registerMaterial(terrain.material);
    for (const m of Object.values(veg.mat)) env.registerMaterial(m);
    env.registerMaterial(rocks.material); env.registerMaterial(buildings.material); env.registerMaterial(roads.material); env.registerMaterial(lifts.material);
    for (const m of Object.values(riderView.mats)) env.registerMaterial(m);
    for (const m of Object.values(monsters.materials)) env.registerMaterial(m);
    for (const m of eat.materials) env.registerMaterial(m);
    let csmSize = 0;
    if (!params.has('noimpostors')) veg.enableImpostors(renderer, true);
    const goggles = new GoggleView();
    // first person redraws the body with a close near plane so knees, gloves and the board are not clipped
    const bodyCam = new THREE.PerspectiveCamera(70, 1, 0.05, 30);
    bodyCam.layers.set(BODY_LAYER);
    env.sun.layers.enable(BODY_LAYER); env.hemi.layers.enable(BODY_LAYER);
    const eye = new THREE.Vector3();

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
    // ?weather=overcast (FEAT-078) and __sim.setWeather (shoot_spots.mjs, per spot) override the
    // saved Weather setting for this session without saving it; picking a Weather in the menu clears it
    let weatherOverride: CloudCover | null = parseWeather(params.get('weather'));
    const initialWeather = weatherOverride;

    // ---------------------------------------------------------------- settings application
    const applySettings = (s: Settings, what: string): void => {
      applySun(s);
      if (what === 'clouds') weatherOverride = null;
      const weather = weatherOverride ?? s.clouds ?? 'scattered';
      clouds.configure(weather, s.quality);
      const storm = weather === 'storm', overcast = isOvercast(weather);
      env.setBluebird(!storm && !overcast); // deep blue sky behind the clouds too; storm and overcast are grey
      env.setStorm(storm);
      env.setOvercast(overcast);
      // flat light: the snow surface reads poorly under a storm, a little less under overcast
      terrain.setFlatLight(storm ? 1 : overcast ? 0.85 : 0);
      env.setValleyFog(!!s.valleyFog || params.has('valleyfog')); // ?valleyfog forces it on for render checks
      // falling snow: the storm, or light flurries under overcast (a sixth of the flakes, no visibility cut)
      snow.points.visible = storm || weather === 'flurries';
      const flakes = s.quality === 'high' ? 16000 : s.quality === 'medium' ? 9000 : 4500;
      snow.setCount(storm ? flakes : Math.round(flakes / 6));
      // limited render distance in the storm: nothing past the fog is drawn
      cam.camera.far = storm ? 1200 : 300000; cam.camera.updateProjectionMatrix();
      audio.setVolumes(s.mute ? 0 : s.sfx, s.mute ? 0 : s.music);
      audio.setSource(s.musicSource);
      audio.setPlaylist(s.playlist);
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
      labels.visible = s.showLabels && !storm; // peaks are hidden in the storm
      map.metric = s.units === 'metric';
      if (what === 'camera' || what === 'reset') cam.mode = s.camera;
    };

    // ---------------------------------------------------------------- spawn point
    const start = pack.meta.start;
    const saveKey = spawnKey(pack.meta.slug);
    let saved: { x: number; y: number; h: number } | null = null;
    try { saved = JSON.parse(localStorage.getItem(saveKey) ?? 'null'); } catch { saved = null; }
    const at = new URLSearchParams(location.search); // re-read: the menu's "Reset to resort start" may have removed x/y/h
    let sx = at.has('x') ? Number(at.get('x')) : saved?.x ?? start.x;
    let sy = at.has('y') ? Number(at.get('y')) : saved?.y ?? start.y;
    let sh = at.has('h') ? Number(at.get('h')) * Math.PI / 180 : saved?.h ?? start.heading;
    const setSpawn = (x: number, y: number, h: number) => {
      sx = x; sy = y; sh = h;
      try { localStorage.setItem(saveKey, JSON.stringify({ x, y, h })); } catch { /* private mode */ }
      const u = new URL(location.href);
      u.searchParams.set('x', x.toFixed(1)); u.searchParams.set('y', y.toFixed(1)); u.searchParams.set('h', (h * 180 / Math.PI).toFixed(0));
      history.replaceState(null, '', u.toString());
    };
    const map = new ResortMap(pack);
    map.spawnPos = [sx, sy];
    const pickHandler = (x: number, y: number) => {
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
    map.onPick = pickHandler;

    const pause = new PauseMenu(settings, applySettings);
    let paused = false;
    const setPaused = (p: boolean) => {
      paused = p;
      controls.guardLeave = !p; // FEAT-111: no leave prompt from the pause menu
      if (p) pause.show(); else pause.hide();
      audio.setDuck(p ? 0.3 : 1);
    };
    // ---------------------------------------------------------------- Outrun
    /** Start a run from where the rider is: trials off, no map teleport, no lift skip. */
    const startOutrun = () => {
      trial.cancel('Outrun');
      eat.end(); monsters.clear(); outrunUI.hideCard();
      riderView.group.visible = true;
      outrun.start(settings.outrun, rider);
      pause.setOutrunRunning(true);
      map.onPick = null; map.baseMarker = outrun.base;
      chase = audio.chase();
      countLast = -1;
      showToast(outrun.baseMissing ? 'Outrun: no base on this pack, so it is endless' : outrun.cfg.escape === 'base' ? 'Outrun: reach the base' : 'Outrun: survive', 3000);
    };
    const stopOutrun = () => {
      outrun.stop(); eat.end(); monsters.clear(); outrunUI.hideCard();
      pause.setOutrunRunning(false);
      map.onPick = pickHandler; map.baseMarker = null; map.monsters = [];
      chase?.stop(); audio.resumeMusic();
      rider.boost = false; riderView.group.visible = true;
    };
    outrunUI.onRetry = () => {
      eat.end(); monsters.clear(); chase?.stop(); audio.resumeMusic();
      liftRide.cancel(); rider.reset(sx, sy, sh); cam.snapTo(rider);
      startOutrun();
    };
    outrunUI.onExit = () => stopOutrun();
    eat.onSound = (k) => {
      if (!chase) return;
      if (k === 'roar') chase.roar('angry'); else if (k === 'pop') chase.pop(); else if (k === 'gulp') chase.gulp();
      else if (k === 'burp') chase.burp(); else if (k === 'spit') chase.spit(); else if (k === 'sting') chase.sting();
    };
    monsters.onCrack = () => chase?.crack();

    pause.onAction = (a) => {
      if (a === 'resume') setPaused(false);
      else if (a === 'restart') { setPaused(false); if (outrun.active) stopOutrun(); liftRide.cancel(); rider.reset(sx, sy, sh); cam.snapTo(rider); }
      else if (a === 'map') { setPaused(false); map.open(); }
      else if (a === 'outrunStart') { setPaused(false); startOutrun(); }
      else if (a === 'outrunStop') { setPaused(false); stopOutrun(); }
      else if (a === 'quit') { setPaused(false); dispose(); resolveQuit(); }
    };

    // ---------------------------------------------------------------- scene setup
    applySettings(settings, 'init');
    cam.mode = params.get('cam') === 'fp' ? 'fp' : settings.camera;
    // ?cam=eye&pitch=&fov=&eye=&spot= (DATA-008): a still camera at eye height over x, y for
    // real vs game photo pairs; HUD hidden, rider frozen, P saves the shot (see docs/compare/README.md)
    const num = (k: string, d: number) => { const v = Number(params.get(k)); return params.has(k) && Number.isFinite(v) ? v : d; };
    if (params.get('cam') === 'eye') cam.setEye(sx, sy, sh * 180 / Math.PI, num('pitch', 0), num('fov', 75), num('eye', 1.7));
    const spotName = params.get('spot') ?? '';
    let shotPending = false;
    /** Scripted shots (game/tools/shoot_spots.mjs): jump the eye camera and stream the tiles around it. */
    const eyeAt = (x: number, y: number, h: number, pitch: number, fov: number, height = 1.7) => {
      cam.setEye(x, y, h, pitch, fov, height);
      pack.fine?.request(x - 600, y - 600, x + 600, y + 600);
      pack.mask?.request(x - 600, y - 600, x + 600, y + 600);
    };
    /** Save the canvas: into docs/compare through the dev server when ?spot= is set, else a browser download. */
    const saveShot = (dataUrl: string) => {
      const p = cam.eyePose();
      const pose = { x: +p.x.toFixed(1), y: +p.y.toFixed(1), h: +p.h.toFixed(1), pitch: +p.pitch.toFixed(1), fov: +p.fov.toFixed(1), eye: +p.eye.toFixed(2) };
      const u = new URL(location.href);
      for (const [k, v] of Object.entries(pose)) u.searchParams.set(k, String(v));
      history.replaceState(null, '', u.toString());
      console.log('eye shot', JSON.stringify({ spot: spotName, ...pose, link: u.toString() }));
      const download = () => {
        const a = document.createElement('a');
        a.href = dataUrl; a.download = `${pack.meta.slug}_${pose.x}_${pose.y}_${pose.h.toFixed(0)}.png`; a.click();
        showToast('Saved the shot to Downloads');
      };
      if (!spotName) { download(); return; }
      fetch('/__compare/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pack: pack.meta.slug, spot: spotName, pose, link: u.toString(), png: dataUrl }) })
        .then(async (r) => { if (!r.ok) throw new Error(await r.text()); showToast(`Saved ${await r.text()}`); })
        .catch((e) => { console.warn('compare save failed, downloading instead', e); download(); });
    };
    pack.fine?.request(sx - 600, sy - 600, sx + 600, sy + 600);
    pack.mid?.request(sx - 20000, sy - 20000, sx + 20000, sy + 20000);
    pack.far?.request(-1e9, -1e9, 1e9, 1e9);
    pack.mask?.request(sx - 600, sy - 600, sx + 600, sy + 600);
    // now-playing toast
    const toast = document.getElementById('toast')!;
    let toastTimer = 0;
    const showToast = (text: string, ms = 4000) => { toast.textContent = text; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.classList.remove('show'), ms); };
    rider.onTrick = (name) => showToast(name, 1800); // FEAT-110: flips
    if (params.get('cam') === 'eye' && !headless) showToast('Eye camera: click, then mouse to look · WASD move · Q/E height · [ ] zoom · P save shot · F free fly', 10000);
    audio.onTrack = (name) => showToast(`\u266B ${name}`);
    // the menu may already have started a song before onTrack was set (BUG-033): announce it now
    if (audio.nowPlaying && !headless && params.get('cam') !== 'eye') showToast(`\u266B ${audio.nowPlaying}`);
    const prompt = document.getElementById('prompt')!;
    let promptShown = '';
    const showPrompt = (html: string) => { if (html !== promptShown) { promptShown = html; prompt.innerHTML = html; prompt.classList.toggle('show', html !== ''); } };

    let mouseDx = 0, mouseDy = 0;
    const onClick = () => { if (!paused && (cam.mode === 'free' || cam.mode === 'fp' || cam.mode === 'eye')) canvas.requestPointerLock(); };
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
      if (outrun.active) stopOutrun();
      outrunUI.destroy(); eat.dispose(); puffs.dispose(); bigprints.dispose();
      trialEl.classList.remove('show');
      finishArrow.style.display = 'none';
      audio.onTrack = null;
      showPrompt('');
      hud.innerHTML = '';
      goggles.destroy();
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

    /** Main render, then in first person the body again over a cleared depth buffer (near 0.05 m). */
    function render(): void {
      renderer.render(scene, cam.camera);
      if (cam.mode !== 'fp') return;
      for (const l of env.csm?.lights ?? []) l.layers.enable(BODY_LAYER);
      bodyCam.position.copy(cam.camera.position); bodyCam.quaternion.copy(cam.camera.quaternion);
      if (bodyCam.fov !== cam.camera.fov || bodyCam.aspect !== cam.camera.aspect) { bodyCam.fov = cam.camera.fov; bodyCam.aspect = cam.camera.aspect; bodyCam.updateProjectionMatrix(); }
      const auto = renderer.autoClear, shadows = renderer.shadowMap.autoUpdate;
      renderer.autoClear = false; renderer.shadowMap.autoUpdate = false; // reuse this frame's shadow maps
      renderer.clearDepth();
      renderer.render(scene, bodyCam);
      renderer.autoClear = auto; renderer.shadowMap.autoUpdate = shadows;
    }

    /** headless only: exact frame dt for __step, so scripted runs replay step for step */
    let fixedDt: number | null = null;
    function frame(): void {
      if (!alive) return;
      const now = performance.now();
      const dt = fixedDt ?? Math.min(0.1, (now - last) / 1000);
      last = now;
      const input = controls.update();
      // pause has priority; Esc closes the map first if it is open
      if (controls.once('Escape') || touch?.once('pause')) { if (map.fullOpen) map.close(); else setPaused(!paused); }
      if (paused) { controls.endFrame(); touch?.pressed.clear(); render(); if (!headless) requestAnimationFrame(frame); return; }
      touch?.setVisible(!map.fullOpen);
      elapsed += dt;
      if (controls.action('restart')) { if (outrun.active) stopOutrun(); liftRide.cancel(); trial.cancel('Restarted'); rider.reset(sx, sy, sh); cam.snapTo(rider); }
      if (controls.action('trial') && settings.timeTrials && !outrun.active) {
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
      // the rider stands still while the camera is detached (free fly, eye)
      const detached = cam.mode === 'free' || cam.mode === 'eye';
      const eyeMode = cam.mode === 'eye';
      document.body.classList.toggle('eye-mode', eyeMode);
      if (!eat.active) riderView.group.visible = !eyeMode;
      riderView.sprayObject.visible = !eyeMode;
      // lift markers and piste lines are game UI, not in a photo
      lifts.markers.visible = !eyeMode; if (eyeMode) runs.group.visible = false;
      if (controls.action('piste')) { if (eyeMode) shotPending = true; else runs.toggle(); }
      if (controls.action('track')) audio.nextTrack();
      if (controls.action('fly')) { cam.mode = cam.mode === 'free' ? settings.camera : 'free'; if (cam.mode === 'free') cam.enterFree(); }
      // board on / off: unstrap when nearly stopped, strap in standing still
      if ((controls.action('board') || touch?.once('board')) && !detached && !liftRide.riding && !map.fullOpen) {
        const why = rider.toggleBoard();
        if (why === '' && rider.strapState === 'off') trial.cancel('Unstrapped');
        boardMsg = why === 'fast' ? 'slow down to unstrap' : why === 'moving' ? 'stand still to strap in' : why === 'air' ? 'land first' : '';
        boardMsgT = boardMsg ? 1.5 : 0;
      }
      boardMsgT -= dt;
      // Outrun: no lift skip while it runs (the monster is on the towers behind you), the boost key
      const boardPressed = (controls.action('lift') || !!touch?.once('lift')) && !detached && !(outrun.running && liftRide.riding);
      if (controls.action('boost') && outrun.boost()) chase?.boostWhoosh();
      rider.boost = outrun.boosting;
      const eating = outrun.phase === 'caught';
      const onLift = !detached && !eating && liftRide.update(rider, dt, boardPressed, input.tuck);
      if (!detached && !onLift && !map.fullOpen && !eating) rider.update(dt, input);
      // visuals draw the pose interpolated between the last two 120 Hz physics steps; gameplay
      // (trials, lifts, audio) keeps reading the sim pose
      riderView.setFirstPerson(cam.mode === 'fp');
      rider.applyRenderPose();
      if (!eating) riderView.update(rider, dt, input.tuck, input.grab, onLift && liftRide.airborneRide);
      tracks.update(rider, dt, onLift && liftRide.airborneRide);
      bootprints.update(dt); bigprints.update(dt); puffs.update(dt);
      rider.restoreSimPose();
      // ---- Outrun: sim, events to sound and effects, the eat sequence, the monsters
      if (outrun.active) {
        outrun.update(dt, rider, onLift ? liftRide : null);
        for (const e of outrun.events) {
          if (e.kind === 'wake') chase?.roar('wake');
          else if (e.kind === 'spawn') { if (e.m && e.m.id > 1) chase?.roar('spawn'); }
          else if (e.kind === 'roar') chase?.roar('spawn');
          else if (e.kind === 'sight') chase?.roar('sight');
          else if (e.kind === 'closecall') { chase?.roar('angry'); chase?.closeCall(); }
          else if (e.kind === 'footfall' && e.m) { chase?.footfall(e.m.dist); if (e.m.dist < 30) cam.kick = Math.max(cam.kick, 0.7 * (1 - e.m.dist / 30)); }
          else if (e.kind === 'second') showToast('Another one.', 2500);
          else if (e.kind === 'escaped') { chase?.roar('giveup'); chase?.stop(); audio.resumeMusic(); chase?.fanfare(); }
          else if (e.kind === 'caught' && e.m) {
            const view = monsters.view(e.m.id);
            audio.scratchStop(); chase?.stop();
            if (view) eat.start(e.m, view, rider, riderView, settings.outfit, settings.discipline, outrun.cfg.gentle);
          }
        }
        if (outrun.phase === 'countdown') { const n = Math.ceil(3 - outrun.t); if (n !== countLast) { countLast = n; chase?.countBeep(false); } }
        else if (outrun.phase === 'headstart' && countLast !== 0) { countLast = 0; chase?.countBeep(true); }
        eatPosing.clear();
        if (eat.active) { eat.update(dt); if (outrun.nearest) eatPosing.add(outrun.nearest.id); }
        monsters.update(outrun, dt, eatPosing);
        if (eat.done && !outrunUI.cardOpen) outrunUI.showCard(outrun, 'eaten');
        if (outrun.phase === 'escaped' && outrun.t > 2.5 && !outrunUI.cardOpen) outrunUI.showCard(outrun, 'escaped');
        map.monsters = outrun.monsters.map((m) => [m.x, m.y]);
        if (chase) {
          const n = outrun.nearest;
          if (n) chase.setMonster(n.x, n.z + 1.5, -n.y);
          chase.update(dt, outrun.dist, outrun.phase === 'chase', outrun.boosting);
        }
      }
      outrunUI.update(outrun, settings.units === 'metric', keyName(settings.keys.boost));
      if (settings.timeTrials) {
        if (onLift) trial.cancel('On a lift'); else if (rider.unstrapped) trial.cancel('Unstrapped'); else trial.update(rider, dt, input.tuck);
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
      rider.applyRenderPose();
      if (cam.mode === 'free') { cam.updateFree(dt, controls.keys, mouseDx, mouseDy); mouseDx = mouseDy = 0; }
      else if (eyeMode) { cam.updateEye(dt, controls.keys, mouseDx, mouseDy); mouseDx = mouseDy = 0; }
      else if (cam.mode === 'fp') { cam.updateFirstPerson(rider, dt, input.tuck, onLift || controls.looking, mouseDx, mouseDy, riderView.eye(eye)); mouseDx = mouseDy = 0; }
      else { cam.freeLook(controls.looking, dt, mouseDx, mouseDy, outrun.running && controls.keys.has(controls.keymap.glance)); mouseDx = mouseDy = 0; cam.baseFov = settings.fov + (outrun.boosting ? 12 : 0); cam.update(rider, dt, input.tuck, onLift && liftRide.airborneRide); }
      // the eat sequence owns the camera: high in front of the monster, looking down at it (FEAT-104)
      if (eat.active) { eat.cameraPose(cam.camera.position, eatLook); cam.camera.lookAt(eatLook); if (cam.camera.fov !== 60) { cam.camera.fov = 60; cam.camera.updateProjectionMatrix(); } }
      chase?.setListener(cam.camera);
      goggles.strength = settings.goggleStrength;
      goggles.update(rider, dt, cam.mode === 'fp', cam.mode === 'fp' && settings.fpVignette, onLift);
      rider.restoreSimPose();
      cam.camera.updateMatrixWorld();
      env.updateCSM();
      clouds.render(renderer, cam.camera, dt, env.sunDir, env.sun.color, env.sun.intensity, env.hemi.color, env.hemi.intensity, env.atmo.hazeLinear);
      env.followCamera(cam.camera.position);
      snow.update(dt, cam.camera, renderer.domElement.height, 0.45 + 0.6 * env.hemi.intensity / 1.4);
      veg.setSun(env.sun.color, env.sun.intensity);
      const cp = cam.camera.position;
      terrain.update(cp.x, -cp.z, cp.y);
      const fx = detached ? cp.x : rider.x, fy = detached ? -cp.z : rider.y;
      // terrain, mask and instance tiles stream ahead along the direction of travel
      const liftTop = onLift && liftRide.lift ? liftRide.lift.top : null;
      prefetch.update(pack, fx, fy, dt, liftTop);
      veg.update(fx, fy, prefetch.ax, prefetch.ay);
      rocks.update(fx, fy, prefetch.ax, prefetch.ay);
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
        showPrompt(`<div class="name">${liftRide.lift?.feature.name ?? 'Lift'}</div><div class="row"><kbd>E</kbd> skip to the ${liftRide.lift?.kind === 'carpet' ? 'end' : 'top'} <span class="dim">${pct}%</span></div><div class="row"><kbd>W</kbd> hold for ${liftRide.fast ? '<b>5x speed</b>' : '5x speed'} &nbsp; <kbd>Alt</kbd> look around</div>`);
      } else if (liftRide.nearby && !map.fullOpen && !detached) {
        const name = liftRide.nearby.feature.name ?? 'Lift';
        const dist = settings.units === 'metric' ? `${liftRide.nearbyDist.toFixed(0)} m` : `${(liftRide.nearbyDist * 3.28084).toFixed(0)} ft`;
        if (liftRide.canBoard) showPrompt(`<div class="name">${name}</div><div class="row"><kbd>E</kbd> ${rider.unstrapped ? 'strap in and ' : ''}${liftRide.nearby.kind === 'gondola' ? 'board the gondola' : liftRide.nearby.kind === 'surface' ? 'grab the lift' : liftRide.nearby.kind === 'carpet' ? 'step on' : 'ride up'}</div>`);
        else if (liftRide.blocker === 'fast') showPrompt(`<div class="name">${name}</div><div class="row">slow down to board <kbd>&darr;</kbd> brake</div>`);
        else showPrompt(`<div class="name">${name}</div><div class="row">ride to the lift <span class="dim">${dist}</span> then <kbd>E</kbd></div>`);
      } else if (!map.fullOpen && !detached) {
        // board on / off
        const bk = `<kbd>${keyName(settings.keys.board)}</kbd>`;
        if (boardMsgT > 0) showPrompt(`<div class="row">${boardMsg}</div>`);
        else if (rider.strapState !== 'none') showPrompt('');
        else if (rider.onFoot) showPrompt(`<div class="row">${bk} strap in${rider.speed > 0.3 ? ' <span class="dim">(stand still)</span>' : ''} &nbsp; <kbd>${keyName(settings.keys.grab)}</kbd> sprint</div>`);
        else if (rider.canUnstrap) showPrompt(`<div class="row">${bk} unstrap</div>`);
        else showPrompt('');
      } else showPrompt('');
      env.update(fx, detached ? cp.y : rider.z, -fy);
      if (pack.fine && terrain.stats.builds === 0) pack.fine.evictBeyond(fx, fy, 3000, liftTop);
      map.riderPos = [rider.x, rider.y, rider.z];
      if (map.fullOpen) { if (fpsN % 10 === 0) map.drawFull(); }
      else if (fpsN % 3 === 0) map.drawMini(rider.x, rider.y, rider.heading);
      labels.update(cam.camera, settings.units === 'metric');
      render();
      // the drawing buffer is only readable in the same task as the render
      if (shotPending) { shotPending = false; saveShot(canvas.toDataURL('image/png')); }
      controls.endFrame();

      fpsAcc += dt; fpsN++;
      if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
      hud.innerHTML =
        `<b>${speedStr(rider.speed)} &nbsp; ${altStr(rider.z)} &nbsp; slope ${rider.slopeDeg.toFixed(0)}&deg;` +
        (rider.onFoot ? ` &nbsp; ${rider.crawling ? 'SCRAMBLING' : 'ON FOOT'} &nbsp; <span class="dim">sprint</span> ${'&#9646;'.repeat(Math.ceil(rider.stamina / STAMINA * 5))}${'&#9647;'.repeat(5 - Math.ceil(rider.stamina / STAMINA * 5))}` : '') +
        (rider.onGround || rider.onFoot ? '' : ` &nbsp; AIR ${rider.airTime.toFixed(1)}s`) + (rider.crashed > 0 ? ' &nbsp; CRASH' : '') +
        `<br><span class="dim">${fps.toFixed(0)} fps &middot; ${terrain.stats.chunks} chunks &middot; ${(terrain.stats.triangles / 1000).toFixed(0)}k tris &middot; trees ${veg.stats.instances} &middot; cam ${cam.mode}` +
        ` &middot; pos ${rider.x.toFixed(0)}, ${rider.y.toFixed(0)}</span>`;
      (window as any).__sim = { rider, riderView, terrain, pack, cam, veg, fps, map, liftRide, lifts, setSpawn, settings, bootprints, tracks, eyeAt, outrun, monsters, startOutrun, stopOutrun,
        /** shoot_spots.mjs: a spot's weather, or null for the page's own (?weather= else the setting) */
        setWeather: (w: string | null) => { weatherOverride = parseWeather(w) ?? initialWeather; applySettings(settings, 'weather'); } };
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
        (window as any).__step = (n: number, dtOverride = 1 / 60) => { fixedDt = dtOverride; for (let i = 0; i < n; i++) frame(); fixedDt = null; last = performance.now(); };
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
