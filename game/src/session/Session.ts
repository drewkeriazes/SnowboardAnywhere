import * as THREE from 'three';
import { Rider } from '../sim/Rider';
import { landmarkStart } from '../world/Landmarks';
import { isOvercast, parseWeather, type CloudCover } from '../world/Clouds';
import { Controls } from '../sim/Controls';
import { setVegetationBudget, setVegetationDensity } from '../world/Vegetation';
import { treeFadeUniforms } from '../world/TreeFade';
import { GoggleView } from '../ui/GoggleView';
import { GoggleLens } from '../world/Lens';
import { AutoQuality } from '../ui/AutoQuality';
import { RunStats } from '../sim/RunStats';
import { RunCard } from '../ui/RunCard';
import { fmtDistance } from '../ui/Units';
import { Replay, type ReplaySample } from '../sim/Replay';
import { SpeedLines } from '../ui/SpeedLines';
import { ChaseCamera } from '../world/ChaseCamera';
import { FILL_RATE, setTrackFillRate } from '../world/Tracks';
import { Outrun } from '../sim/Outrun';
import { OutrunUI } from '../ui/OutrunUI';
import { TimeTrial } from '../sim/TimeTrial';
import { ResortMap } from '../ui/ResortMap';
import { LiftRide } from '../sim/LiftRide';
import { Prefetch } from '../sim/Prefetch';
import { MainMenu, type MenuChoice } from '../ui/MainMenu';
import { attractShot, type AttractManifest } from '../world/AttractShots';
import { AttractGhosts } from '../world/AttractGhosts';
import { LoadingScreen } from '../ui/Loading';
import { PauseMenu, type PauseInfo } from '../ui/PauseMenu';
import { Labels } from '../ui/Labels';
import { TouchControls } from '../ui/TouchControls';
import { saveSettings, FALL_LINE, type Settings } from '../ui/Settings';
import { switchName, type PressEnd } from '../sim/Rider';
import { PressMeter } from '../ui/PressMeter';
import { resetStart, spawnFromUrl, spawnKey } from '../spawn';
import { GameLoop } from '../core/GameLoop';
import { StateMachine } from '../core/StateMachine';
import { FpsMeter } from '../core/FpsMeter';
import { TrialHud } from '../ui/TrialHud';
import { ReplayBar } from '../ui/ReplayBar';
import { KeyLabels } from '../ui/KeyLabels';
import { Toast } from '../ui/Toast';
import { SceneRender } from '../world/SceneRender';
import { SunClock } from '../world/SunClock';
import { warmUp as warmUpWorld } from './warmUp';
import { saveShot as saveShotFile, saveTake as saveTakeFile } from './devSaves';
import { buildWorld } from './World';
import { mountLeadTunePanel } from '../ui/LeadTunePanel';
import { installSimDebug } from '../core/debugHooks';
import type { GameContext } from '../core/GameContext';
import { padFx } from '../sim/PadFeedback';
import type { GameStateName } from '../states/GameState';
import { RideFrame, type SkyState } from '../states/RideFrame';
import { LoadingState } from '../states/LoadingState';
import { AttractState } from '../states/AttractState';
import { RidingState } from '../states/RidingState';
import { RewindState } from '../states/RewindState';
import { PausedState } from '../states/PausedState';
import { ReplayState } from '../states/ReplayState';
import { MapState } from '../states/MapState';

/** FEAT-105: the New snow setting as a snow cover amount */
const NEW_SNOW: Record<string, number> = { none: 0, dusting: 0.25, '6in': 0.6, powder: 1 };


/** How a session starts: in the main menu (attract) or riding, with the loading screen when there is no menu over it. */
export interface SessionOpts { menu: MainMenu | null; attract: boolean; loading: LoadingScreen | null; attractFiles: AttractManifest }

/** One resort loaded and playable: its scene, the rider, the menus over it. */
export interface Session {
  /** resolves when the player quits with no main menu to go back to (never, with one: Quit returns to it) */
  readonly quit: Promise<void>;
}

export function createSession(ctx: GameContext, opts: SessionOpts): Session {
  const { params, canvas, renderer, scene, pack, settings, audio } = ctx;
  const { headless, hosted, debugHud } = params;
  const { menu, loading } = opts;
  const quit = new Promise<void>((resolveQuit) => {
    const status = document.getElementById('status')!;
    const world = buildWorld(ctx);
    const { env, clouds, snow, terrain, collider, veg, lifts, liftLines, roads, tracks, bootprints, puffs, bigprints, deform, monsters, eat, courses, trialWorld, riderView } = world;
    // FEAT-162: the session's states; the frame is the active state's update (states/RideFrame.ts has the order)
    const states = new StateMachine<GameStateName>();
    // Outrun (FEAT-097 to FEAT-101): the chase sim and the HUD (the monsters and the eat sequence are in the world)
    const outrun = new Outrun(pack, lifts);
    const outrunUI = new OutrunUI();
    let chase = audio.chase();
    /** FEAT-128: the course picked in pause > Mode (the gates are on for the session), '' in Free ride */
    let trialMode = '';
    const trialsOn = () => settings.timeTrials || !!trialMode;
    const trial = new TimeTrial(pack.meta.slug, courses);
    const trialHud = new TrialHud(settings);
    trial.onEvent = (e) => {
      trialHud.onEvent(e, trial.candidates.length);
      if (e.kind === 'start') { audio.chime(); padFx.trialEvent('start'); }
      else if (e.kind === 'split') padFx.trialEvent('split');
      else if (e.kind === 'finish') { audio.chime(); padFx.trialEvent('finish', e.isBest); }
    };
    const refreshCourseFlags = () => { map.courseStarts = trialsOn() ? courses.map((c) => ({ x: c.start[0], y: c.start[1], name: c.name, best: trial.loadBest(c)?.time ?? null })) : []; };
    const labels = new Labels(pack);
    if (debugHud) mountLeadTunePanel(riderView);

    const rider = new Rider(pack, collider);
    // on foot (FEAT-067): every foot plant of the skeleton leaves a print and a footstep
    riderView.setPack(pack, collider); // FEAT-046: the crash ragdoll hits trunks, rocks and walls
    rider.onSkateStroke = () => audio.footstep(rider.surface, rider.speed, 0, rider.snow); // FEAT-085: a crunch per push
    riderView.onPlant = (p) => { bootprints.add(p, rider.sink); audio.footstep(rider.surface, p.speed, rider.sink, rider.snow); };
    const liftRide = new LiftRide(pack, lifts, collider);
    liftRide.gate = (l, x, y) => liftLines.inGate(l, x, y); // FEAT-073: board from inside the maze
    const prefetch = new Prefetch();
    const cam = new ChaseCamera(pack, window.innerWidth / window.innerHeight);
    cam.collider = collider; // BUG-032: keep the chase camera out of trees
    const controls = new Controls(canvas);
    const touch = TouchControls.wanted(params.touch) ? new TouchControls(controls) : null;
    let csmSize = 0;
    const goggles = new GoggleView();
    const lens = new GoggleLens(); // FEAT-130: the tinted lens pass in first person
    // FEAT-055: run stats, the after-run card and today's totals
    const runStats = new RunStats(pack), runCard = new RunCard();
    runStats.onRunEnd = (s) => { if (!headless) runCard.show(s, settings.units === 'metric'); };
    const speedLines = new SpeedLines(document.body); // FEAT-045
    // ---- FEAT-043: the session recording, the replay viewer (K) and the practice rewind (hold Backspace)
    const replay = new Replay();
    // FEAT-137: with a controller in use, its button glyphs (an action with no button keeps its key)
    const keyLabels = new KeyLabels(controls, settings);
    const replayBar = new ReplayBar(keyLabels);
    /** samples (at 20 Hz) recorded before the replay viewer opens: about a second of riding */
    const MIN_REPLAY_SAMPLES = 20;
    /** Why the replay viewer can't open now, or null when it can (the K key and the pause menu's Replay both ask). */
    const replayBlockedReason = (): string | null =>
      outrun.active ? 'not during Outrun' : liftRide.riding ? 'not on a lift' : rider.unstrapped ? 'strap in first' : replay.samples.length <= MIN_REPLAY_SAMPLES ? 'ride a little first' : null;
    /** back on the snow at a recorded moment; the recording carries on from there */
    const rewindTo = (s: ReplaySample) => {
      rider.x = s.x; rider.y = s.y; rider.z = pack.groundHeight(s.x, s.y, s.z); rider.vx = s.vx; rider.vy = s.vy; rider.vz = 0;
      rider.heading = s.hd; rider.boardYaw = s.h; rider.switch = !!(s.f & 8); rider.onGround = true; rider.onFoot = !!s.on; rider.crashed = 0;
      rider.flip = 0; rider.flipRate = 0; rider.spin = 0; rider.airTime = 0; rider.jumpCharge = 0; rider.landingShock = 0; rider.washout = 0; rider.crashSide = 0;
      replay.truncate(s.t); trial.cancel('Rewound');
    };
    // first person redraws the body with a close near plane so knees, gloves and the board are not clipped
    const sceneRender = new SceneRender(renderer, scene, env, lens);

    // ---------------------------------------------------------------- sun / time of day
    const sun = new SunClock(env, pack, params.time); // ?time=now or ?time=16.5
    const applySun = (s: Settings) => sun.apply(s);
    // ?weather=overcast (FEAT-078) and __sim.setWeather (shoot_spots.mjs, per spot) override the
    // saved Weather setting for this session without saving it; picking a Weather in the menu clears it
    let weatherOverride: CloudCover | null = parseWeather(params.weather);
    const initialWeather = weatherOverride;
    /** the weather on screen right now (FEAT-093: saved with P-key shots) */
    const currentWeather = (): CloudCover => weatherOverride ?? settings.clouds ?? 'scattered';

    // ---------------------------------------------------------------- settings application
    /** the weather drawn, and FEAT-105's new snow, 0..1, shared by the terrain rock and the boulder caps (FEAT-106): a
     *  storm adds 1 per 10 min, flurries a fifth of that (states/RideFrame.ts), it never melts in a session; the New snow setting sets it */
    const sky: SkyState = { weather: 'scattered', snowCover: 0 };
    // FEAT-062: adaptive quality; its level scales resolution, cloud steps, trees and snowfall in applySettings
    const auto = new AutoQuality();
    const autoClouds = (q: 'high' | 'medium' | 'low'): 'high' | 'medium' | 'low' => auto.current.cloudsDown ? (q === 'high' ? 'medium' : 'low') : q;
    /** FEAT-044: the deformation window and the spray budget from the preset, the Snow dents setting, ?nodeform and the auto level */
    const applyDeform = (s: Settings): void => {
      const q = auto.current;
      deform.enabled = s.snowDeform !== false && s.quality !== 'low' && !params.nodeform && q.deform > 0;
      const small = q.deform < 1 || s.quality === 'medium';
      deform.configure(small ? 256 : 512, small ? 48 : 64);
      riderView.spray.setCount((s.quality === 'high' ? 8192 : s.quality === 'medium' ? 4096 : 2048) * q.snow);
    };
    /** apply only what the auto level scales (applySettings also does this, scaled, on any settings change) */
    const applyAuto = (): void => {
      const s = settings, q = auto.current;
      applyDeform(s);
      clouds.configure(sky.weather, autoClouds(s.quality));
      renderer.setPixelRatio(Math.min(s.pixelRatio, window.devicePixelRatio || 1, 2) * q.res);
      if (s.quality !== 'low') setVegetationDensity(s.treeDensity * q.trees);
      const flakes = s.quality === 'high' ? 16000 : s.quality === 'medium' ? 9000 : 4500;
      snow.setCount(Math.round((sky.weather === 'storm' ? flakes : flakes / 6) * q.snow));
    };
    const applySettings = (s: Settings, what: string): void => {
      applySun(s);
      if (what === 'clouds') weatherOverride = null;
      rider.pressMode = s.pressBalance ?? 'on'; // FEAT-140
      const weather = weatherOverride ?? s.clouds ?? 'scattered';
      sky.weather = weather;
      if (what === 'newSnow' || what === 'init' || what === 'reset') sky.snowCover = NEW_SNOW[s.newSnow ?? 'none'] ?? 0; // FEAT-105: pick a look without waiting
      clouds.configure(weather, autoClouds(s.quality));
      const storm = weather === 'storm', overcast = isOvercast(weather);
      env.setBluebird(!storm && !overcast); // deep blue sky behind the clouds too; storm and overcast are grey
      env.setStorm(storm);
      env.setOvercast(overcast);
      env.setCirrus(weather === 'cirrus'); // FEAT-084
      // flat light: the snow surface reads poorly under a storm, a little less under overcast
      terrain.setFlatLight(storm ? 1 : overcast ? 0.85 : 0);
      env.setValleyFog(!!s.valleyFog || params.valleyfog); // ?valleyfog forces it on for render checks
      // falling snow: the storm, or light flurries under overcast (a sixth of the flakes, no visibility cut)
      snow.points.visible = storm || weather === 'flurries';
      const flakes = s.quality === 'high' ? 16000 : s.quality === 'medium' ? 9000 : 4500;
      snow.setCount(Math.round((storm ? flakes : flakes / 6) * auto.current.snow));
      applyDeform(s);
      // old tracks and boot prints fill in faster while it snows (FEAT-107)
      setTrackFillRate(storm ? FILL_RATE.storm : weather === 'flurries' ? FILL_RATE.flurries : FILL_RATE.clear);
      // limited render distance in the storm: nothing past the fog is drawn
      cam.camera.far = storm ? 1200 : 300000; cam.camera.updateProjectionMatrix();
      audio.setVolumes(s.mute ? 0 : s.sfx, s.mute ? 0 : s.music);
      audio.setSource(s.musicSource);
      audio.setPlaylist(s.playlist);
      renderer.setPixelRatio(Math.min(s.pixelRatio, window.devicePixelRatio || 1, 2) * auto.current.res); // FEAT-062: auto quality scales it
      if (renderer.shadowMap.enabled !== s.shadows) { renderer.shadowMap.enabled = s.shadows; renderer.shadowMap.needsUpdate = true; scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.needsUpdate = true; }); }
      const wantSize = (s.csmExperimental || params.csm) && !params.nocsm ? (s.quality === 'high' ? 2048 : 1024) : 0;
      if (csmSize !== wantSize) { csmSize = wantSize; if (wantSize) env.enableCSM(cam.camera, wantSize, 3); else env.disableCSM(); }
      env.sun.visible = wantSize === 0;
      env.sun.shadow.mapSize.set(s.quality === 'high' ? 4096 : 2048, s.quality === 'high' ? 4096 : 2048);
      env.setShadows(s.shadows);
      if (s.quality === 'low') setVegetationBudget(250, 600); else setVegetationDensity(s.treeDensity * auto.current.trees);
      cam.baseFov = s.fov;
      controls.keymap = { ...s.keys };
      controls.invertSteer = s.invertSteer;
      // FEAT-137: controller buttons, stick and trigger dead zones, look speed, the DualSense extras
      controls.padKeys = { ...s.padKeys };
      controls.padCfg = { dead: s.padDead, trigDead: s.padTrigDead, lookSens: s.lookSens, invertY: s.invertLookY, gyro: s.padGyro, gyroSens: s.gyroSens };
      padFx.strength = s.rumble ? s.vibration : 0; padFx.triggers = s.padTriggers; padFx.lightbar = s.padLightbar;
      lifts.markers.visible = s.showMarkers;
      roads.setOnSnow(s.roadsOnSnow);
      liftLines.setEnabled(s.liftLines);
      riderView.setOutfit(s.outfit);
      riderView.setDiscipline(s.discipline);
      tracks.setDiscipline(s.discipline);
      if (what === 'timeTrials' && !s.timeTrials) trialMode = ''; // turning them off ends a course picked in Mode too
      trialWorld.setEnabled(trialsOn());
      if (!trialsOn()) trial.cancel('Time trials off');
      refreshCourseFlags();
      rider.discipline = s.discipline;
      rider.goofy = s.stance === 'goofy'; // FEAT-139 (the rider view follows it)
      rider.fallLine = FALL_LINE[s.fallLine] ?? 1; // FEAT-134
      labels.visible = s.showLabels && !storm; // peaks are hidden in the storm
      map.metric = s.units === 'metric';
      if (what === 'camera' || what === 'reset') cam.mode = s.camera;
    };

    // ---------------------------------------------------------------- spawn point
    const start = landmarkStart(pack.meta.slug) ?? pack.meta.start; // FEAT-132: a landmark marked `start` beats meta.start
    const saveKey = spawnKey(pack.meta.slug);
    let saved: { x: number; y: number; h: number } | null = null;
    try { saved = JSON.parse(localStorage.getItem(saveKey) ?? 'null'); } catch { saved = null; }
    const at = spawnFromUrl(); // re-read: the menu's "Reset to resort start" may have removed x/y/h
    let sx = at.x ?? saved?.x ?? start.x;
    let sy = at.y ?? saved?.y ?? start.y;
    let sh = at.h ?? saved?.h ?? start.heading;
    const setSpawn = (x: number, y: number, h: number) => {
      sx = x; sy = y; sh = h;
      try { localStorage.setItem(saveKey, JSON.stringify({ x, y, h })); } catch { /* private mode */ }
      const u = new URL(location.href);
      u.searchParams.set('x', x.toFixed(1)); u.searchParams.set('y', y.toFixed(1)); u.searchParams.set('h', (h * 180 / Math.PI).toFixed(0));
      history.replaceState(null, '', u.toString());
    };
    const map = new ResortMap(pack);
    map.setDebug(debugHud); // FEAT-059: mogul runs under-stroked on the map
    map.spawnPos = [sx, sy];
    // FEAT-162: the Map state follows the full map, however it opened or closed (M, Esc, a drop-in, the pause menu, a tool)
    map.onOpenChange = (open) => { if (open && states.is('riding')) states.go('map'); else if (!open && states.is('map')) states.go('riding'); };
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
      controls.padMute(); // FEAT-137: the Cross that dropped in is not a jump
    };
    map.onPick = pickHandler;

    const fps = new FpsMeter();
    const pause = new PauseMenu(settings, applySettings, { fps: () => fps.fps, credits: () => audio.credits });
    // ---------------------------------------------------------------- Outrun
    /** Start a run from where the rider is: trials off, no map teleport, no lift skip. */
    const startOutrun = () => {
      trial.cancel('Outrun');
      eat.end(); monsters.clear(); outrunUI.hideCard();
      riderView.group.visible = true;
      outrun.start(settings.outrun, rider);
      map.onPick = null; map.baseMarker = outrun.base;
      chase = audio.chase();
      frame.resetCountdown();
      showToast(outrun.baseMissing ? 'Outrun: no base on this pack, so it is endless' : outrun.cfg.escape === 'base' ? 'Outrun: reach the base' : 'Outrun: survive', 3000);
    };
    const stopOutrun = () => {
      outrun.stop(); eat.end(); monsters.clear(); outrunUI.hideCard();
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

    /** a few metres above a course's start gate on its line, facing down it */
    const goToCourse = (c: (typeof courses)[number]) => {
      const x = c.start[0] - c.dir[0] * 6, y = c.start[1] - c.dir[1] * 6;
      liftRide.cancel(); trial.cancel('Moved');
      pack.fine?.request(x - 600, y - 600, x + 600, y + 600); pack.mask?.request(x - 600, y - 600, x + 600, y + 600);
      rider.reset(x, y, Math.atan2(c.dir[0], c.dir[1])); cam.snapTo(rider);
    };
    /** FEAT-128: what the pause menu shows (read when it opens) */
    const pauseInfo = (): PauseInfo => ({
      resort: pack.meta.name,
      place: runStats.placeAt(rider.x, rider.y),
      run: runStats.active ? { time: runStats.time, distance: runStats.distance, vertical: runStats.vertical, topSpeed: runStats.topSpeed } : null,
      day: { runs: runStats.day.runs, vertical: runStats.day.vertical },
      metric: settings.units === 'metric',
      mode: outrun.active ? { kind: 'outrun' } : trialMode ? { kind: 'trial', course: trialMode } : { kind: 'free' },
      replayBlocked: replayBlockedReason(),
      courses: courses.map((c) => ({ id: c.id, name: c.name, length: c.length, best: trial.loadBest(c)?.time ?? null })),
    });
    /** Mode: back to Free ride, or a time trial course (gates on for the session, the rider at its start) */
    const setTrialMode = (id: string) => {
      trialMode = id;
      trialWorld.setEnabled(trialsOn());
      if (!trialsOn()) trial.cancel('Free ride');
      refreshCourseFlags();
    };
    // the pause menu closes itself before it calls this; each action starts from riding
    pause.onAction = (a, arg) => {
      states.go('riding');
      if (a === 'replay') states.go('replay');
      else if (a === 'freeride') { if (outrun.active) stopOutrun(); setTrialMode(''); }
      else if (a === 'trial') {
        const c = courses.find((x) => x.id === arg);
        if (!c) return;
        if (outrun.active) stopOutrun();
        setTrialMode(c.id);
        goToCourse(c);
      }
      else if (a === 'restart') { if (outrun.active) stopOutrun(); liftRide.cancel(); trial.cancel('Restarted'); runStats.end(); rider.reset(sx, sy, sh); cam.snapTo(rider); }
      else if (a === 'map') map.open();
      else if (a === 'outrunStart') { setTrialMode(''); startOutrun(); }
      else if (a === 'outrunStop') stopOutrun();
      else if (a === 'quit') { if (menu) backToMenu(); else { dispose(); resolveQuit(); } }
    };

    // ---------------------------------------------------------------- FEAT-128: the main menu inside the session (attract)
    const shot = attractShot(pack, start);
    const ghosts = new AttractGhosts(pack, { x: shot.x, y: shot.y, r: 60 }); // stacked as they pass 60 m out from the camera
    ghosts.group.name = 'attract ghosts'; scene.add(ghosts.group);
    ghosts.setVisible(false);
    void ghosts.load(import.meta.env.BASE_URL, opts.attractFiles[pack.meta.slug]?.ghosts ?? []);
    /** Outrun picked with "or drop in from the map": the chase starts when the map closes */
    let outrunAfterMap = false;
    const startLabel = () => { const lm = landmarkStart(pack.meta.slug); return lm ? lm.label : pack.meta.start.run ? `Starts on ${pack.meta.start.run}` : 'Starts at the resort start'; };
    const menuCourses = () => courses.map((c) => ({ id: c.id, name: c.name, length: c.length, best: trial.loadBest(c)?.time ?? null }));
    /** RIDE: the mode it starts; a course puts the rider above its start gate for this ride (BUG-037's start otherwise) */
    const leaveAttract = (c: MenuChoice) => {
      states.go('riding');
      const course = c.mode.kind === 'trial' ? courses.find((x) => x.id === (c.mode as { course: string }).course) : undefined;
      setTrialMode(course ? course.id : '');
      if (course) goToCourse(course);
      if (c.action === 'map') { map.open(); outrunAfterMap = c.mode.kind === 'outrun'; } // Outrun starts once the map has dropped you in (or closed)
      else if (c.mode.kind === 'outrun') startOutrun();
    };
    /** Quit to main menu: ends an Outrun or time trial and this run's stats; RIDE then starts at the saved start. */
    const backToMenu = () => {
      outrunAfterMap = false;
      if (outrun.active) stopOutrun();
      trial.cancel('Quit'); setTrialMode('');
      liftRide.cancel(); runStats.end();
      rider.reset(sx, sy, sh);
      states.go('attract');
    };
    if (menu) {
      menu.onChoice = leaveAttract;
      menu.onSettingsChange = (s, what) => applySettings(s, what);
      menu.onResetStart = () => {
        resetStart(pack.meta.slug);
        sx = start.x; sy = start.y; sh = start.heading; map.spawnPos = [sx, sy];
        rider.reset(sx, sy, sh);
        menu.setStart(startLabel(), false);
      };
    }

    const saveTake = (takeIn: number | null, takeOut: number | null) => saveTakeFile({ takeIn, takeOut, samples: replay.samples, slug: pack.meta.slug, settings, ghosts, hosted, toast: (t) => showToast(t) });

    // ---------------------------------------------------------------- scene setup
    applySettings(settings, 'init');
    cam.mode = params.cam === 'fp' ? 'fp' : settings.camera;
    // ?cam=eye&pitch=&fov=&eye=&spot= (DATA-008): a still camera at eye height over x, y for
    // real vs game photo pairs; HUD hidden, rider frozen, P saves the shot (see docs/compare/README.md)
    if (params.cam === 'eye') cam.setEye(sx, sy, sh * 180 / Math.PI, params.pitch ?? 0, params.fov ?? 75, params.eye ?? 1.7);
    const spotName = params.spot;
    /** Scripted shots (game/tools/shoot_spots.mjs): jump the eye camera and stream the tiles around it. */
    const eyeAt = (x: number, y: number, h: number, pitch: number, fov: number, height = 1.7) => {
      cam.setEye(x, y, h, pitch, fov, height);
      pack.fine?.request(x - 600, y - 600, x + 600, y + 600);
      pack.mask?.request(x - 600, y - 600, x + 600, y + 600);
    };
    /** Save the canvas: into docs/compare through the dev server when ?spot= is set, else a browser download. */
    const saveShot = (dataUrl: string, jpgUrl: string) =>
      saveShotFile({ dataUrl, jpgUrl, eye: cam.eyePose(), spot: spotName, slug: pack.meta.slug, weather: currentWeather(), hosted, toast: (t) => showToast(t) });
    pack.fine?.request(sx - 600, sy - 600, sx + 600, sy + 600);
    pack.mid?.request(sx - 20000, sy - 20000, sx + 20000, sy + 20000);
    pack.far?.request(-1e9, -1e9, 1e9, 1e9);
    pack.mask?.request(sx - 600, sy - 600, sx + 600, sy + 600);
    // now-playing toast
    const showToast = new Toast().show;
    rider.onTrick = (name) => showToast(name, 1800); // FEAT-110: flips; FEAT-139: spins and switch tricks
    rider.onWashout = (side) => showToast(side > 0 ? 'Washed out onto the hip' : 'Washed out onto the butt', 1800); // FEAT-148: a hard carve the edge could not hold
    // FEAT-140: the press balance meter above the head, and a toast with the time and distance when a press ends (best per resort)
    const pressMeter = new PressMeter();
    const pressBestKey = `pressBest:${pack.meta.slug}`;
    const PRESS_HOW: Record<PressEnd, string> = { clean: '', flat: ' · dropped flat', slam: ' · slammed', stall: ' · stalled' };
    rider.onPress = (how, dir, t, dist, sw, from) => {
      let best = 0; try { best = Number(localStorage.getItem(pressBestKey)) || 0; } catch { /* private mode */ }
      const isBest = t > best;
      if (isBest) try { localStorage.setItem(pressBestKey, t.toFixed(2)); } catch { /* private mode */ }
      const press = switchName(dir > 0 ? 'Nose press' : 'Tail press', sw);
      const name = from ? `${from} to ${press[0].toLowerCase()}${press.slice(1)}` : press; // landed into it from a trick
      const tail = isBest ? (best > 0 ? ' · new best!' : '') : ` · best ${best.toFixed(1)} s`;
      showToast(`${name} ${t.toFixed(1)} s, ${fmtDistance(dist, settings.units === 'metric')}${PRESS_HOW[how]}${tail}`, 2600);
    };
    if (params.cam === 'eye' && !headless) showToast('Eye camera: click, then mouse to look · WASD move · Q/E height · [ ] zoom · P save shot · ` free fly', 10000);
    audio.onTrack = (name) => showToast(`♫ ${name}`);
    // the menu may already have started a song before onTrack was set (BUG-033): announce it now
    if (audio.nowPlaying && !headless && params.cam !== 'eye') showToast(`♫ ${audio.nowPlaying}`);

    /** mouse movement for the cameras this frame (px); the frame adds the right stick and the gyro */
    const look = { dx: 0, dy: 0 };
    const onClick = () => { if (!states.is('paused') && (cam.mode === 'free' || cam.firstPerson || cam.mode === 'eye')) canvas.requestPointerLock(); };
    const onMove = (e: MouseEvent) => { if (document.pointerLockElement === canvas || (controls.looking && !states.is('paused'))) { look.dx += e.movementX; look.dy += e.movementY; } };
    const onResize = () => { renderer.setSize(window.innerWidth, window.innerHeight); cam.camera.aspect = window.innerWidth / window.innerHeight; cam.camera.updateProjectionMatrix(); env.onCameraChanged(); };
    canvas.addEventListener('click', onClick);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('resize', onResize);

    // ---------------------------------------------------------------- FEAT-162: the frame and the states
    const draw = (): void => sceneRender.render(cam.camera, cam.firstPerson);
    const frame = new RideFrame({
      ...world, params, settings, pack, renderer, canvas, audio, rider, liftRide, prefetch, cam, controls, touch, goggles, lens, runStats, runCard, speedLines, replay,
      outrun, outrunUI, trial, trialHud, map, labels, sun, auto, keyLabels, pressMeter, fps, sky, look,
      chase: () => chase, trialsOn, applyAuto, draw, showToast, saveShot,
    });
    if (settings.keysNote) { frame.boardNote = 'New default key layout available: Settings > Controls > Reset keys'; settings.keysNote = false; saveSettings(settings); }
    const rewind = new RewindState({ controls, touch, rider, liftRide, outrun, replay, pack, frame, rewindTo }, states);
    states
      .add(new RidingState({
        controls, touch, cam, settings, rider, liftRide, outrun, trial, runs: world.runs, audio, map, frame, chase: () => chase, trialsOn, goToCourse, replayBlockedReason,
        rewindWanted: () => rewind.wanted(),
        restartRun: () => { if (outrun.active) stopOutrun(); liftRide.cancel(); trial.cancel('Restarted'); runStats.end(); rider.reset(sx, sy, sh); cam.snapTo(rider); },
      }, states))
      .add(rewind)
      .add(new PausedState({ controls, touch, pause, audio, fps, pauseInfo, draw }, states))
      .add(new ReplayState({ controls, touch, rider, replay, replayBar, pack, cam, settings, trial, audio, frame, debugHud, applySun, replayBlockedReason, saveTake }, states))
      .add(new MapState({ controls, touch, map, settings, keyLabels, audio, frame, onClosed: () => { if (outrunAfterMap) { outrunAfterMap = false; startOutrun(); } } }, states));
    if (menu) states.add(new AttractState({ menu, shot, ghosts, cam, pack, settings, controls, rider, runCard, map, look, frame, startLabel, menuCourses }));

    let alive = true;
    const loop = new GameLoop(headless, { everyFrame, tick: tickFrame, targetFps: () => settings.targetFps });
    const dispose = () => {
      alive = false;
      loop.stop();
      canvas.removeEventListener('click', onClick);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      touch?.destroy();
      map.destroy();
      pause.destroy();
      labels.destroy();
      tracks.dispose(); deform.dispose();
      trialWorld.dispose();
      if (outrun.active) stopOutrun();
      padFx.stop();
      outrunUI.destroy(); runCard.dispose(); speedLines.dispose(); pressMeter.dispose(); eat.dispose(); puffs.dispose(); bigprints.dispose();
      trialHud.hide();
      audio.onTrack = null;
      frame.clear();
      goggles.destroy();
      lens.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
      });
      env.disableCSM();
      renderer.clear();
    };

    /** BUG-063: the loading screen, hidden once the first real frames have run behind it */
    let hideLoading: LoadingScreen | null = null, loadFrames = 0;
    const HIDE_AFTER_FRAMES = 3;
    /** FEAT-128: frames until the menu's still crossfades into the live view (0: not waiting) */
    let menuReadyIn = 0;
    /** every display frame, drawn or skipped by the 30 fps cap */
    function everyFrame(): void {
      if (hideLoading && ++loadFrames >= HIDE_AFTER_FRAMES) { hideLoading.hide(); hideLoading = null; }
      if (menuReadyIn > 0 && --menuReadyIn === 0) menu?.setReady();
    }
    /** one drawn frame: the devices, then the active state (docs/developer-guide.md has the update order) */
    function tickFrame(dt: number, stepped: boolean): void {
      frame.readInput(dt);
      states.update(dt, stepped);
      states.render();
    }

    const warmUp = (ls: { set(f: number, label: string): void }) => warmUpWorld(ls, world, pack, rider, renderer, scene, cam.camera);
    states.add(new LoadingState({
      pack, rider, lifts, cam, spawn: () => ({ x: sx, y: sy, h: sh }), first: opts.attract ? 'attract' : 'riding', alive: () => alive,
      // ?cam=eye: the menu (shown on Quit) is ready too
      warmUp: loading ? async () => { await warmUp(loading); hideLoading = loading; if (menu) menuReadyIn = HIDE_AFTER_FRAMES; }
        : opts.attract && menu ? async () => { await warmUp({ set: (f, l) => menu.setProgress(f, l) }); menuReadyIn = HIDE_AFTER_FRAMES; }
        : null,
      ready: () => {
        status.textContent = '';
        installSimDebug({ ghosts, menu, shot, rider, riderView, controls, padFx, trialWorld, terrain, pack, cam, veg, map, liftRide, lifts, setSpawn, settings, bootprints, tracks, deform, renderer, eyeAt, outrun, monsters, startOutrun, stopOutrun, treeFadeUniforms,
          /** shoot_spots.mjs: a spot's weather, or null for the page's own (?weather= else the setting) */
          setWeather: (w: string | null) => { weatherOverride = parseWeather(w) ?? initialWeather; applySettings(settings, 'weather'); },
          /** snowcheck.mjs: apply a settings field changed in place (for example 'newSnow') as the settings panel would */
          applySettings: (what: string) => applySettings(settings, what) }, { attract: () => states.is('attract'), state: () => states.current, fps: () => fps.fps });
        loop.start(canvas);
      },
    }, states));
    // wait briefly for the fine tiles under the start point, then warm up and go
    states.go('loading');
  });
  return { quit };
}
