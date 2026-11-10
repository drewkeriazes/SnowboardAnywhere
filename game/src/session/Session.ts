import * as THREE from 'three';
import { MOGUL_CREEP_M_PER_DAY } from '../terrain/Moguls';
import { Rider } from '../sim/Rider';
import { landmarkStart } from '../world/Landmarks';
import { isOvercast, parseWeather, type CloudCover } from '../world/Clouds';
import { Controls } from '../sim/Controls';
import { setVegetationBudget, setVegetationDensity } from '../world/Vegetation';
import { treeFadeUniforms } from '../world/TreeFade';
import { GoggleView } from '../ui/GoggleView';
import { GoggleLens, LENSES, resolveLens, type LensId } from '../world/Lens';
import { AutoQuality } from '../ui/AutoQuality';
import { RunStats } from '../sim/RunStats';
import { RunCard } from '../ui/RunCard';
import { Replay, type ReplaySample } from '../sim/Replay';
import { SpeedLines } from '../ui/SpeedLines';
import { ChaseCamera } from '../world/ChaseCamera';
import { FILL_RATE, setTrackFillRate } from '../world/Tracks';
import { setDeformHold } from '../world/Deform';
import { Outrun } from '../sim/Outrun';
import { OutrunUI } from '../ui/OutrunUI';
import { TimeTrial } from '../sim/TimeTrial';
import { ResortMap } from '../ui/ResortMap';
import { LiftRide } from '../sim/LiftRide';
import { Prefetch } from '../sim/Prefetch';
import { MainMenu, type MenuChoice } from '../ui/MainMenu';
import { attractShot, shotPose, type AttractManifest } from '../world/AttractShots';
import { AttractGhosts } from '../world/AttractGhosts';
import { LoadingScreen } from '../ui/Loading';
import { PauseMenu, type PauseInfo } from '../ui/PauseMenu';
import { Labels } from '../ui/Labels';
import { TouchControls } from '../ui/TouchControls';
import { keysOf, saveSettings, FALL_LINE, type Settings } from '../ui/Settings';
import { PressMeter } from '../ui/PressMeter';
import { listenHud } from '../ui/HudEvents';
import { connectEventSources } from './eventSources';
import { hasCustomStart, resetStart, spawnFromUrl, spawnKey } from '../spawn';
import { GameLoop } from '../core/GameLoop';
import { TrialHud } from '../ui/TrialHud';
import { ReplayBar } from '../ui/ReplayBar';
import { KeyLabels } from '../ui/KeyLabels';
import { keyHints } from '../ui/KeyHints';
import { contextPrompt } from '../ui/ContextPrompt';
import { hudLine } from '../ui/HudLine';
import { Toast } from '../ui/Toast';
import { SceneRender } from '../world/SceneRender';
import { SunClock } from '../world/SunClock';
import { warmUp as warmUpWorld } from './warmUp';
import { saveShot as saveShotFile, saveTake as saveTakeFile } from './devSaves';
import { buildWorld } from './World';
import { mountLeadTunePanel } from '../ui/LeadTunePanel';
import { installSimDebug } from '../core/debugHooks';
import type { GameContext } from '../core/GameContext';
import { PAD } from '../sim/Pad';
import { padFx } from '../sim/PadFeedback';
import { stickGlyph } from '../ui/PadGlyphs';

/** FEAT-105: the New snow setting as a snow cover amount */
const NEW_SNOW: Record<string, number> = { none: 0, dusting: 0.25, '6in': 0.6, powder: 1 };
/** FEAT-077: how skied out the snow gets by late afternoon for each Snow conditions setting */
const SKIED_BASE: Record<string, number> = { fresh: 0.15, mid: 0.9, spring: 0.7 };


/** How a session starts: in the main menu (attract) or riding, with the loading screen when there is no menu over it. */
export interface SessionOpts { menu: MainMenu | null; attract: boolean; loading: LoadingScreen | null; attractFiles: AttractManifest }

/** One resort loaded and playable: its scene, the rider, the menus over it. */
export interface Session {
  /** resolves when the player quits with no main menu to go back to (never, with one: Quit returns to it) */
  readonly quit: Promise<void>;
}

export function createSession(ctx: GameContext, opts: SessionOpts): Session {
  const { params, canvas, renderer, scene, pack, settings, audio, events } = ctx;
  const { headless, hosted, debugHud } = params;
  const { menu, loading } = opts;
  const quit = new Promise<void>((resolveQuit) => {
    const hud = document.getElementById('hud')!;
    const status = document.getElementById('status')!;
    const world = buildWorld(ctx);
    const { zr, env, clouds, snow, terrain, collider, veg, treeFade, rocks, lifts, liftLines, resortTop, runs, roads, landmarks, bridges,
      tracks, bootprints, riderChair, puffs, particleLight, bigprints, deform, monsters, eat, courses, trialWorld, riderView } = world;
    // Outrun (FEAT-097 to FEAT-101): the chase sim and the HUD (the monsters and the eat sequence are in the world)
    const outrun = new Outrun(pack, lifts);
    const outrunUI = new OutrunUI();
    let chase = audio.chase();
    const eatPosing = new Set<number>();
    const eatLook = new THREE.Vector3();
    let countLast = -1;
    const chairPos = new THREE.Vector3();
    /** FEAT-128: the course picked in pause > Mode (the gates are on for the session), '' in Free ride */
    let trialMode = '';
    const trialsOn = () => settings.timeTrials || !!trialMode;
    const trial = new TimeTrial(pack.meta.slug, courses);
    const trialHud = new TrialHud(settings);
    const refreshCourseFlags = () => { map.courseStarts = trialsOn() ? courses.map((c) => ({ x: c.start[0], y: c.start[1], name: c.name, best: trial.loadBest(c)?.time ?? null })) : []; };
    const labels = new Labels(pack);
    if (debugHud) mountLeadTunePanel(riderView);

    const rider = new Rider(pack, collider);
    riderView.setPack(pack, collider); // FEAT-046: the crash ragdoll hits trunks, rocks and walls
    let boardMsg = '', boardMsgT = 0;
    let boardMsgNote = '', boardNoteT = 25; // FEAT-124: one-time note for players with their own keys
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
    let lensWorn: LensId | null = null;
    // FEAT-055: run stats, the after-run card and today's totals
    const runStats = new RunStats(pack), runCard = new RunCard();
    const speedLines = new SpeedLines(document.body); // FEAT-045
    // the short message at the top (now playing, tricks, saves)
    const showToast = new Toast().show;

    // ---------------------------------------------------------------- FEAT-163: the news, on the bus
    // The systems' hooks emit; the HUD, the audio and the rumble subscribe themselves, in that order (a trial
    // event reaches the panel, then the chime, then the pad, as before); the world's reactions are below.
    const disconnectSources = connectEventSources(events, { rider, riderView, trial, runStats, audio, eat, monsters });
    listenHud(events, { toast: showToast, trialHud, runCard, settings, slug: pack.meta.slug, headless });
    audio.listen(events);
    padFx.listen(events);
    events.on('footPlant', (e) => bootprints.add(e.plant, e.sink));
    events.on('outrun', ({ event: e }) => {
      // a monster's foot near the rider kicks the camera; caught, the eat sequence starts (after the audio's record scratch)
      if (e.kind === 'footfall' && e.m) { if (e.m.dist < 30) cam.kick = Math.max(cam.kick, 0.7 * (1 - e.m.dist / 30)); }
      else if (e.kind === 'caught' && e.m) {
        const view = monsters.view(e.m.id);
        if (view) eat.start(e.m, view, rider, riderView, settings.outfit, settings.discipline, outrun.cfg.gentle);
      }
    });
    // ---- FEAT-043: the session recording, the replay viewer (K) and the practice rewind (hold Backspace)
    const replay = new Replay();
    // FEAT-137: with a controller in use, its button glyphs (an action with no button keeps its key)
    const keyLabels = new KeyLabels(controls, settings);
    const replayBar = new ReplayBar(keyLabels);
    const REPLAY_SPEEDS = [0.25, 0.5, 1, 2];
    let replayOpen = false, replayT = 0, replayPlay = true, replaySpeed = 1, replayClean = false, photoFov = 0, replayHour = 12;
    let replayCam: 'follow' | 'trackside' | 'free' = 'follow';
    const trackPos = new THREE.Vector3(); let trackSet = false;
    let rewinding = false, rewindT = 0;
    /** samples (at 20 Hz) recorded before the replay viewer opens: about a second of riding */
    const MIN_REPLAY_SAMPLES = 20;
    /** Why the replay viewer can't open now, or null when it can (the K key and the pause menu's Replay both ask). */
    const replayBlockedReason = (): string | null =>
      outrun.active ? 'not during Outrun' : liftRide.riding ? 'not on a lift' : rider.unstrapped ? 'strap in first' : replay.samples.length <= MIN_REPLAY_SAMPLES ? 'ride a little first' : null;
    const openReplay = () => {
      replayOpen = true; replayT = Math.max(replay.start, replay.end - 30); replayPlay = true; replaySpeed = 1; replayCam = 'follow'; trackSet = false; photoFov = 0;
      replayHour = typeof settings.timeOfDay === 'number' ? settings.timeOfDay : 12;
      trial.cancel('Replay');
    };
    const closeReplay = () => {
      replayOpen = false; replayClean = false; replayBar.hide();
      if (cam.mode === 'free') cam.mode = settings.camera;
      applySun(settings);
    };
    /** back on the snow at a recorded moment; the recording carries on from there */
    const rewindTo = (s: ReplaySample) => {
      rider.x = s.x; rider.y = s.y; rider.z = pack.groundHeight(s.x, s.y, s.z); rider.vx = s.vx; rider.vy = s.vy; rider.vz = 0;
      rider.heading = s.hd; rider.boardYaw = s.h; rider.switch = !!(s.f & 8); rider.onGround = true; rider.onFoot = !!s.on; rider.crashed = 0;
      rider.flip = 0; rider.flipRate = 0; rider.spin = 0; rider.airTime = 0; rider.jumpCharge = 0; rider.landingShock = 0; rider.washout = 0; rider.crashSide = 0;
      replay.truncate(s.t); trial.cancel('Rewound');
    };
    // first person redraws the body with a close near plane so knees, gloves and the board are not clipped
    const sceneRender = new SceneRender(renderer, scene, env, lens);
    const eye = new THREE.Vector3();

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
    let weatherNow: CloudCover = 'scattered';
    /** FEAT-105: new snow, 0..1, shared by the terrain rock and the boulder caps (FEAT-106): a storm adds
     *  1 per 10 min, flurries a fifth of that, it never melts in a session; the New snow setting sets it */
    let snowCover = 0;
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
      clouds.configure(weatherNow, autoClouds(s.quality));
      renderer.setPixelRatio(Math.min(s.pixelRatio, window.devicePixelRatio || 1, 2) * q.res);
      if (s.quality !== 'low') setVegetationDensity(s.treeDensity * q.trees);
      const flakes = s.quality === 'high' ? 16000 : s.quality === 'medium' ? 9000 : 4500;
      snow.setCount(Math.round((weatherNow === 'storm' ? flakes : flakes / 6) * q.snow));
    };
    const applySettings = (s: Settings, what: string): void => {
      applySun(s);
      if (what === 'clouds') weatherOverride = null;
      rider.pressMode = s.pressBalance ?? 'on'; // FEAT-140
      const weather = weatherOverride ?? s.clouds ?? 'scattered';
      weatherNow = weather;
      if (what === 'newSnow' || what === 'init' || what === 'reset') snowCover = NEW_SNOW[s.newSnow ?? 'none'] ?? 0; // FEAT-105: pick a look without waiting
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

    const pause = new PauseMenu(settings, applySettings, { fps: () => fps, credits: () => audio.credits });
    let paused = false;
    const setPaused = (p: boolean) => {
      paused = p;
      controls.guardLeave = !p; // FEAT-111: no leave prompt from the pause menu
      if (p) pause.show(pauseInfo()); else { pause.hide(); controls.padMute(); }
      audio.setDuck(p ? 0.3 : 1);
    };
    // ---------------------------------------------------------------- Outrun
    /** Start a run from where the rider is: trials off, no map teleport, no lift skip. */
    const startOutrun = () => {
      trial.cancel('Outrun');
      eat.end(); monsters.clear(); outrunUI.hideCard();
      riderView.group.visible = true;
      outrun.start(settings.outrun, rider);
      map.onPick = null; map.baseMarker = outrun.base;
      chase = audio.chase();
      countLast = -1;
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
    pause.onAction = (a, arg) => {
      if (a === 'resume') setPaused(false);
      else if (a === 'replay') { setPaused(false); openReplay(); }
      else if (a === 'freeride') { setPaused(false); if (outrun.active) stopOutrun(); setTrialMode(''); }
      else if (a === 'trial') {
        const c = courses.find((x) => x.id === arg);
        setPaused(false);
        if (!c) return;
        if (outrun.active) stopOutrun();
        setTrialMode(c.id);
        goToCourse(c);
      }
      else if (a === 'restart') { setPaused(false); if (outrun.active) stopOutrun(); liftRide.cancel(); trial.cancel('Restarted'); runStats.end(); rider.reset(sx, sy, sh); cam.snapTo(rider); }
      else if (a === 'map') { setPaused(false); map.open(); }
      else if (a === 'outrunStart') { setPaused(false); setTrialMode(''); startOutrun(); }
      else if (a === 'outrunStop') { setPaused(false); stopOutrun(); }
      else if (a === 'quit') { setPaused(false); if (menu) backToMenu(); else { dispose(); resolveQuit(); } }
    };

    // ---------------------------------------------------------------- FEAT-128: the main menu inside the session (attract)
    // The eye camera sits on the resort's backdrop shot and drifts; ghosts ride a line; the rider is hidden and
    // still, the HUD hidden, and the riding keys and buttons do nothing (the menu has them).
    const shot = attractShot(pack, start);
    const ghosts = new AttractGhosts(pack, { x: shot.x, y: shot.y, r: 60 }); // stacked as they pass 60 m out from the camera
    ghosts.group.name = 'attract ghosts'; scene.add(ghosts.group);
    ghosts.setVisible(false);
    void ghosts.load(import.meta.env.BASE_URL, opts.attractFiles[pack.meta.slug]?.ghosts ?? []);
    let attract = false, attractT = 0;
    /** Outrun picked with "or drop in from the map": the chase starts when the map closes */
    let outrunAfterMap = false;
    const startLabel = () => { const lm = landmarkStart(pack.meta.slug); return lm ? lm.label : pack.meta.start.run ? `Starts on ${pack.meta.start.run}` : 'Starts at the resort start'; };
    const menuCourses = () => courses.map((c) => ({ id: c.id, name: c.name, length: c.length, best: trial.loadBest(c)?.time ?? null }));
    const enterAttract = () => {
      if (!menu) return;
      attract = true; attractT = 0;
      if (map.fullOpen) map.close();
      const p = shotPose(shot, 0);
      cam.setEye(p.x, p.y, p.h, p.pitch, p.fov, p.eye);
      pack.fine?.request(shot.x - 600, shot.y - 600, shot.x + 600, shot.y + 600); pack.mask?.request(shot.x - 600, shot.y - 600, shot.x + 600, shot.y + 600);
      ghosts.setVisible(true);
      runCard.hide(); // the run that just ended is behind us
      document.body.classList.add('attract');
      controls.guardLeave = false; // nothing to lose in the menu
      menu.setStart(startLabel(), hasCustomStart(pack.meta.slug));
      menu.setCourses(menuCourses(), settings.units === 'metric');
      menu.show();
    };
    const leaveAttract = (c: MenuChoice) => {
      attract = false;
      ghosts.setVisible(false);
      document.body.classList.remove('attract');
      controls.guardLeave = true;
      controls.padMute(); // the Cross that pressed RIDE is not a jump
      cam.mode = settings.camera;
      cam.snapTo(rider);
      // the mode RIDE starts: a course puts the rider above its start gate for this ride (BUG-037's start otherwise)
      const course = c.mode.kind === 'trial' ? courses.find((x) => x.id === (c.mode as { course: string }).course) : undefined;
      setTrialMode(course ? course.id : '');
      if (course) goToCourse(course);
      if (c.action === 'map') { map.open(); outrunAfterMap = c.mode.kind === 'outrun'; } // Outrun starts once the map has dropped you in (or closed)
      else if (c.mode.kind === 'outrun') startOutrun();
    };
    /** Quit to main menu: ends an Outrun or time trial and this run's stats; RIDE then starts at the saved start. */
    const backToMenu = () => {
      if (rewinding) { replay.restore(rider); rewinding = false; rewindT = 0; } // else the next frame carries the rewind on from the reset
      outrunAfterMap = false;
      if (replayOpen) closeReplay();
      if (outrun.active) stopOutrun();
      trial.cancel('Quit'); setTrialMode('');
      liftRide.cancel(); runStats.end();
      rider.reset(sx, sy, sh);
      enterAttract();
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

    // the recording tool (?debug, replay viewer): I / O mark a span, L saves it as a take
    let takeIn: number | null = null, takeOut: number | null = null;
    const saveTake = () => saveTakeFile({ takeIn, takeOut, samples: replay.samples, slug: pack.meta.slug, settings, ghosts, hosted, toast: (t) => showToast(t) });

    // ---------------------------------------------------------------- scene setup
    applySettings(settings, 'init');
    cam.mode = params.cam === 'fp' ? 'fp' : settings.camera;
    // ?cam=eye&pitch=&fov=&eye=&spot= (DATA-008): a still camera at eye height over x, y for
    // real vs game photo pairs; HUD hidden, rider frozen, P saves the shot (see docs/compare/README.md)
    if (params.cam === 'eye') cam.setEye(sx, sy, sh * 180 / Math.PI, params.pitch ?? 0, params.fov ?? 75, params.eye ?? 1.7);
    const spotName = params.spot;
    let shotPending = false;
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
    // FEAT-140: the press balance meter above the head (the toast when a press ends is in ui/HudEvents.ts)
    const pressMeter = new PressMeter();
    const pressHead = new THREE.Vector3();
    if (params.cam === 'eye' && !headless) showToast('Eye camera: click, then mouse to look · WASD move · Q/E height · [ ] zoom · P save shot · ` free fly', 10000);
    // the menu may already have started a song before the session listened (BUG-033): announce it now
    if (audio.nowPlaying && !headless && params.cam !== 'eye') showToast(`\u266B ${audio.nowPlaying}`);
    const prompt = document.getElementById('prompt')!;
    let promptShown = '';
    // FEAT-124: restart hold and its ring, and the contextual key hints in the corner
    const RESTART_HOLD = 0.6;
    let restartHold = 0, restartDone = false;
    const restartRing = document.createElement('div');
    restartRing.style.cssText = 'position:fixed;left:50%;top:50%;width:46px;height:46px;margin:-23px;border-radius:50%;display:none;pointer-events:none;z-index:7;-webkit-mask:radial-gradient(circle,transparent 15px,#000 16px);mask:radial-gradient(circle,transparent 15px,#000 16px)';
    document.body.appendChild(restartRing);
    const helpEl = document.getElementById('help');
    let helpShown = '', helpT = 0;
    const { padKey, pg } = keyLabels;
    if (settings.keysNote) { boardMsgNote = 'New default key layout available: Settings > Controls > Reset keys'; settings.keysNote = false; saveSettings(settings); }
    const showPrompt = (html: string) => { if (html !== promptShown) { promptShown = html; prompt.innerHTML = html; prompt.classList.toggle('show', html !== ''); } };

    let mouseDx = 0, mouseDy = 0;
    const onClick = () => { if (!paused && (cam.mode === 'free' || cam.firstPerson || cam.mode === 'eye')) canvas.requestPointerLock(); };
    const onMove = (e: MouseEvent) => { if (document.pointerLockElement === canvas || (controls.looking && !paused)) { mouseDx += e.movementX; mouseDy += e.movementY; } };
    const onResize = () => { renderer.setSize(window.innerWidth, window.innerHeight); cam.camera.aspect = window.innerWidth / window.innerHeight; cam.camera.updateProjectionMatrix(); env.onCameraChanged(); };
    canvas.addEventListener('click', onClick);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('resize', onResize);

    let alive = true;
    const loop = new GameLoop(headless, { everyFrame, tick: frame, targetFps: () => settings.targetFps });
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
      disconnectSources(); events.clear(); // FEAT-163
      showPrompt('');
      hud.innerHTML = '';
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

    let fpsAcc = 0, fpsN = 0, fps = 0;
    let elapsed = 0;

    const render = (): void => sceneRender.render(cam.camera, cam.firstPerson);

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
    /** one drawn frame (the update order is written down in docs/developer-guide.md) */
    function frame(dt: number, stepped: boolean): void {
      // FEAT-062: feed the frame time; a level change re-applies the scaled settings
      if (!headless && !stepped && !paused && auto.frame(dt, settings.autoQuality ? (settings.targetFps || 60) : 0)) applyAuto();
      // FEAT-140: on the snow on the board, W / S and the stick balance a held press instead of tucking and braking
      controls.balancing = rider.pressMode !== 'off' && rider.discipline === 'board' && (rider.onGround || rider.pressing) && !rider.unstrapped && rider.crashed <= 0;
      const input = controls.update(dt);
      if (attract) {
        controls.suspendFrame(); // the menu has the keys and buttons: nothing reaches the riding actions
        mouseDx = mouseDy = 0;
        attractT += dt;
        const p = shotPose(shot, settings.reduceMotion ? 0 : attractT); // Reduce motion: the backdrop holds still
        cam.setEye(p.x, p.y, p.h, p.pitch, p.fov, p.eye);
        ghosts.update(dt);
      }
      // FEAT-124: the gamepad's right stick looks around like the mouse: a rate (px/s at full deflection),
      // added before the cameras consume mouseDx / mouseDy so it lands this frame, not the next
      if (controls.padLookX || controls.padLookY) { mouseDx += controls.padLookX * 840 * dt; mouseDy += controls.padLookY * 600 * dt; }
      mouseDx += controls.gyroDx; mouseDy += controls.gyroDy; // FEAT-137: DualSense gyro look (0 unless on)
      // pause has priority; Esc closes the map first if it is open
      if (controls.once('Escape') || touch?.once('pause')) { if (replayOpen) closeReplay(); else if (map.fullOpen) map.close(); else setPaused(!paused); }
      if (paused) {
        padFx.idle(controls.pad); controls.endFrame(); touch?.pressed.clear(); render();
        fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; } // FEAT-128: Settings shows the live frame rate over the paused game
        return;
      }
      touch?.setVisible(!map.fullOpen && !attract);
      if (outrunAfterMap && !map.fullOpen) { outrunAfterMap = false; startOutrun(); }
      elapsed += dt;
      // FEAT-124: restart needs a 0.6 s hold (a fill ring), so a stray tap next to E or W doesn't reset the run
      if (!replayOpen && controls.held('restart') && !paused) {
        restartHold += dt;
        if (restartHold >= RESTART_HOLD && !restartDone) { restartDone = true; if (outrun.active) stopOutrun(); liftRide.cancel(); trial.cancel('Restarted'); runStats.end(); rider.reset(sx, sy, sh); cam.snapTo(rider); }
      } else { restartHold = 0; restartDone = false; }
      controls.action('restart'); // the press itself does nothing
      restartRing.style.display = restartHold > 0.05 && !restartDone ? 'block' : 'none';
      if (restartHold > 0.05) restartRing.style.background = `conic-gradient(#ffd166 ${Math.min(1, restartHold / RESTART_HOLD) * 360}deg, rgba(255,255,255,.18) 0)`;
      if (!replayOpen && controls.action('trial') && trialsOn() && !outrun.active) {
        const c = trial.nearestStart(rider.x, rider.y);
        if (c) goToCourse(c);
      }
      // ---- FEAT-043: replay viewer (the sim is frozen and the recording plays on the rider). While it is open,
      // restart / trial / map / piste / fly / board are ignored so the viewer acts like a modal (P is the photo key here)
      if (controls.action('replay') && !replayBlockedReason()) { if (replayOpen) closeReplay(); else openReplay(); }
      if (replayOpen) {
        const k = controls.keys;
        // FEAT-137 on a controller: Cross play, D-pad left / right scrub, R1 / L1 speed, Triangle camera, Square hide, Circle close
        const po = (b: number) => controls.padOnce(b);
        if (controls.once('Space') || po(PAD.A)) { if (replayT >= replay.end - 0.01) replayT = replay.start; replayPlay = !replayPlay; }
        const si = REPLAY_SPEEDS.indexOf(replaySpeed);
        if (controls.once('ArrowUp') || po(PAD.RB)) replaySpeed = REPLAY_SPEEDS[Math.min(REPLAY_SPEEDS.length - 1, si + 1)];
        if (controls.once('ArrowDown') || po(PAD.LB)) replaySpeed = REPLAY_SPEEDS[Math.max(0, si - 1)];
        const scrub = (k.has('ArrowRight') || controls.padHeld(PAD.RIGHT) ? 1 : 0) - (k.has('ArrowLeft') || controls.padHeld(PAD.LEFT) ? 1 : 0);
        if (scrub) replayT += scrub * 5 * dt; else if (replayPlay) replayT += dt * replaySpeed;
        if (replayT >= replay.end) { replayT = replay.end; replayPlay = false; }
        if (replayT < replay.start) replayT = replay.start;
        if (controls.once('KeyC') || po(PAD.Y)) {
          replayCam = replayCam === 'follow' ? 'trackside' : replayCam === 'trackside' ? 'free' : 'follow'; trackSet = false;
          if (replayCam === 'free') cam.enterFree(); else cam.mode = settings.camera;
        }
        if (controls.once('KeyH') || po(PAD.X)) replayClean = !replayClean;
        if (controls.once('KeyP')) shotPending = true;
        if (controls.once('Minus')) photoFov = Math.max(-35, photoFov - 5);
        if (controls.once('Equal')) photoFov = Math.min(35, photoFov + 5);
        if (controls.once('Comma') || controls.once('Period')) {
          replayHour = Math.max(6, Math.min(20, replayHour + (controls.keys.has('Period') ? 0.5 : -0.5)));
          applySun({ ...settings, timeOfDay: replayHour });
        }
        // FEAT-128 (?debug): mark a span with I and O and save it with L as a take for the main menu's ghosts
        if (debugHud) {
          if (controls.once('KeyI')) takeIn = replayT;
          if (controls.once('KeyO')) takeOut = replayT;
          if (controls.once('KeyL')) saveTake();
        }
        const s = replay.at(replayT);
        if (s) replay.overlay(rider, s, pack);
        const span = Math.max(0.01, replay.end - replay.start);
        replayBar.draw({
          playing: replayPlay, speed: replaySpeed, at: replayT - replay.start, span, cam: replayCam, hour: replayHour, usingPad: controls.usingPad,
          take: debugHud ? { in: takeIn === null ? null : takeIn - replay.start, out: takeOut === null ? null : takeOut - replay.start } : null,
        }, replayClean);
        if (controls.padOnce(PAD.B)) closeReplay();
      }
      // ---- FEAT-043: rewind (hold): scrub back along the recording, let go to carry on from the
      // last moment on the snow before there (not mid-air, not crashed)
      const rewindHeld = !replayOpen && controls.held('rewind') && !outrun.active && !liftRide.riding && replay.samples.length > 1 && rider.strapState === 'none';
      if (rewindHeld) {
        rewinding = true;
        rewindT = Math.min(rewindT + dt * 2, replay.t - replay.start);
        const s = replay.at(replay.t - rewindT);
        if (s) replay.overlay(rider, s, pack);
      } else if (rewinding) {
        rewinding = false;
        const g = replay.goodGround(replay.t - rewindT);
        replay.restore(rider);
        if (g) rewindTo(g);
        rewindT = 0;
      }
      const frozen = replayOpen || rewinding;
      if (!replayOpen && (controls.action('camera') || touch?.once('camera'))) {
        cam.cycle();
        // FEAT-128: the camera you cycle to is the one you come back to (and the pause menu's Camera row shows it)
        if (cam.mode !== 'free' && cam.mode !== 'eye' && cam.mode !== settings.camera) { settings.camera = cam.mode; saveSettings(settings); }
      }
      if (!replayOpen && (controls.action('map') || touch?.once('map'))) { map.toggle(); if (!map.fullOpen) controls.padMute(); }
      // FEAT-137: the full map on a controller: the stick pans under a crosshair, R2 / L2 zoom, Cross drops in, Circle closes
      if (map.fullOpen && controls.pad) {
        const p = controls.pad, dz = (v: number) => (Math.abs(v) > settings.padDead ? v : 0);
        const zoom = (p.buttons[PAD.RT]?.value ?? 0) - (p.buttons[PAD.LT]?.value ?? 0);
        const sx = dz(p.axes[0] ?? 0), sy = dz(p.axes[1] ?? 0), z = Math.abs(zoom) > 0.1 ? zoom : 0;
        if (controls.padOnce(PAD.B)) { map.close(); controls.padMute(); }
        else {
          const help = `${stickGlyph('L')} move &middot; ${pg(PAD.RT)} ${pg(PAD.LT)} zoom (${map.zoom.toFixed(1)}x) &middot; ${pg(PAD.A)} drop in &middot; ${pg(PAD.B)} close`;
          if (map.padDrive(dt, sx, sy, z, controls.padOnce(PAD.A), help)) map.drawFull();
        }
      }
      // the rider stands still while the camera is detached (free fly, eye)
      const detached = cam.mode === 'free' || cam.mode === 'eye';
      const eyeMode = cam.mode === 'eye';
      document.body.classList.toggle('eye-mode', eyeMode || (replayOpen && replayClean));
      if (!eat.active) riderView.group.visible = !eyeMode;
      riderView.sprayObject.visible = !eyeMode;
      // lift markers and piste lines are game UI, not in a photo
      lifts.markers.visible = !eyeMode; if (eyeMode) runs.group.visible = false;
      if (!replayOpen && controls.action('piste')) { if (eyeMode) shotPending = true; else runs.toggle(); }
      if (controls.action('track')) audio.nextTrack();
      if (!replayOpen && controls.action('fly')) { cam.mode = cam.mode === 'free' ? settings.camera : 'free'; if (cam.mode === 'free') cam.enterFree(); }
      // board on / off: unstrap when nearly stopped, strap in standing still. FEAT-124: E (interact)
      // straps in or out when there is no lift near; the separate strap key is optional
      const interact = controls.action('lift') || !!touch?.once('lift');
      const strapAsk = controls.action('board') || !!touch?.once('board') || (interact && !liftRide.riding && !liftRide.nearby);
      if (!replayOpen && strapAsk && !detached && !liftRide.riding && !map.fullOpen) {
        const why = rider.toggleBoard();
        if (why === '' && rider.strapState === 'off') trial.cancel('Unstrapped');
        boardMsg = why === 'fast' ? 'slow down to unstrap' : why === 'moving' ? 'stand still to strap in' : why === 'air' ? 'land first' : '';
        boardMsgT = boardMsg ? 1.5 : 0;
      }
      boardMsgT -= dt;
      // Outrun: no lift skip while it runs (the monster is on the towers behind you), the boost key
      const boardPressed = interact && !detached && !(outrun.running && liftRide.riding);
      if (controls.action('boost') && outrun.active && outrun.boost()) chase?.boostWhoosh(); // FEAT-124: F, Outrun only
      rider.boost = outrun.boosting;
      const eating = outrun.phase === 'caught';
      const onLift = !detached && !eating && !frozen && liftRide.update(rider, dt, boardPressed, input.tuck);
      if (!detached && !onLift && !map.fullOpen && !eating && !frozen) rider.update(dt, input);
      if (!frozen && !onLift && !eating && !attract) replay.record(dt, rider, input.tuck); // FEAT-043 (not the still rider behind the menu)
      if (!frozen && !eating && !outrun.active) runStats.update(dt, rider, onLift); // FEAT-055
      runCard.update(dt);
      // FEAT-137: rumble (landings, crashes, rock, moguls), the DualSense lightbar and adaptive triggers
      padFx.update(dt, controls.pad, { rider, riding: !detached && !onLift && !eating && !frozen && !map.fullOpen && !rider.unstrapped, monsterDist: outrun.running ? outrun.dist : Infinity, lens: riderView.mats.goggles.color.getHex() });
      // visuals draw the pose interpolated between the last two 120 Hz physics steps; gameplay
      // (trials, lifts, audio) keeps reading the sim pose
      riderView.setFirstPerson(cam.firstPerson);
      rider.applyRenderPose();
      if (!eating) riderView.update(rider, dt, input.tuck, input.grab, onLift && liftRide.airborneRide);
      if (!frozen) tracks.update(rider, dt, onLift && liftRide.airborneRide);
      bootprints.update(dt); bigprints.update(dt); puffs.update(dt);
      rider.restoreSimPose();
      // ---- Outrun: sim, its events on the bus (sound, rumble, camera kick, toast, the eat start), the eat sequence, the monsters
      if (outrun.active) {
        outrun.update(dt, rider, onLift ? liftRide : null);
        for (const event of outrun.events) events.emit({ type: 'outrun', event });
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
      outrunUI.update(outrun, settings.units === 'metric', padKey('boost') || keysOf(settings, 'boost'));
      if (trialsOn()) {
        if (onLift) trial.cancel('On a lift'); else if (rider.unstrapped) trial.cancel('Unstrapped'); else if (!frozen) trial.update(rider, dt, input.tuck);
        trialWorld.updateGates(rider.x, rider.y);
        trialWorld.updateGhost(trial.ghostAt(trial.time), dt);
        const active = trial.state !== 'idle' ? trial.course : null;
        const showWalls = trial.state === 'running' || (trial.state === 'armed' && trial.candidates.length === 1);
        trialWorld.updateRoute(showWalls ? active : null, trial.along, trial.nextTarget, elapsed, trial.outside > 0);
        map.trialRoute = active ? active.points : null;
        trialHud.update(dt, trial, pack, cam.camera);
      } else { trialHud.hide(); map.trialRoute = null; }
      audio.update(rider, input.tuck, onLift, dt, liftRide.passedTower);
      rider.lastHit = '';
      rider.applyRenderPose();
      if (cam.mode === 'free') { cam.updateFree(dt, controls.keys, mouseDx, mouseDy); mouseDx = mouseDy = 0; }
      else if (eyeMode) { cam.updateEye(dt, controls.keys, mouseDx, mouseDy); mouseDx = mouseDy = 0; }
      else if (cam.firstPerson) { cam.updateFirstPerson(rider, dt, input.tuck, onLift || controls.looking, mouseDx, mouseDy, riderView.eye(eye)); mouseDx = mouseDy = 0; }
      else if (replayOpen && replayCam === 'trackside') {
        // FEAT-043: a fixed camera beside the line, moved on ahead once the rider is past it
        const sp = Math.hypot(rider.vx, rider.vy) || 1, ux = rider.vx / sp, uy = rider.vy / sp;
        if (!trackSet || Math.hypot(trackPos.x - rider.x, -trackPos.z - rider.y) > 45) {
          const tx = rider.x + ux * 25 - uy * 10, ty = rider.y + uy * 25 + ux * 10;
          trackPos.set(tx, pack.groundHeight(tx, ty) + 1.6, -ty); trackSet = true;
        }
        cam.camera.position.copy(trackPos); cam.camera.lookAt(rider.x, rider.z + 1, -rider.y);
        cam.camera.fov = Math.max(15, settings.fov - 25 + photoFov); cam.camera.updateProjectionMatrix();
      }
      else { cam.freeLook(controls.looking, dt, mouseDx, mouseDy, controls.glancing); mouseDx = mouseDy = 0; cam.baseFov = settings.fov + (outrun.boosting ? 12 : 0) + (replayOpen ? photoFov : 0); cam.update(rider, dt, input.tuck, onLift && liftRide.airborneRide); } // FEAT-124: look behind (G) in every mode
      // the eat sequence owns the camera: high in front of the monster, looking down at it (FEAT-104)
      if (eat.active) { eat.cameraPose(cam.camera.position, eatLook); cam.camera.lookAt(eatLook); if (cam.camera.fov !== 60) { cam.camera.fov = 60; cam.camera.updateProjectionMatrix(); } }
      chase?.setListener(cam.camera);
      goggles.strength = settings.goggleStrength;
      {
        // FEAT-130: the lens follows the setting (Auto: the weather and the sun); the rider and the frame wear it
        const worn = resolveLens(settings.goggleLens, weatherNow, env.sunDir.y);
        if (worn !== lensWorn) { lensWorn = worn; riderView.setLens(worn); goggles.setLens(worn === 'off' ? null : LENSES[worn].swatch); }
        lens.lens = cam.mode === 'fp' && !eat.active ? worn : 'off';
        lens.strength = settings.lensStrength ?? 1;
      }
      cam.fpShake = settings.reduceMotion ? 0 : settings.fpShake ?? 0.3; // BUG-051
      goggles.update(rider, dt, cam.mode === 'fp', cam.mode === 'fp' && settings.fpVignette, onLift);
      // FEAT-045 speed feel toggles, and the speed lines (not on a lift, in free fly or the eat)
      cam.speedFov = settings.speedFov; cam.camShake = settings.camShake && !settings.reduceMotion; speedLines.enabled = settings.speedLines && !settings.reduceMotion; // FEAT-128: Reduce motion turns them off together
      speedLines.update(rider.speed, dt, !detached && !onLift && !eat.active && !paused && !rider.onFoot && !frozen);
      rider.restoreSimPose();
      cam.camera.updateMatrixWorld();
      // FEAT-140: the press meter just above the head (low in the middle of the view in first person)
      {
        const on = rider.pressing && !replayOpen && !detached && !eat.active;
        let px = -999, py = -999;
        if (on && cam.firstPerson) { px = window.innerWidth * 0.5; py = window.innerHeight * 0.78; }
        else if (on || pressMeter.root.style.opacity !== '0') {
          riderView.eye(pressHead); pressHead.y += 0.4; pressHead.project(cam.camera);
          if (pressHead.z < 1) { px = (pressHead.x + 1) / 2 * window.innerWidth; py = (1 - pressHead.y) / 2 * window.innerHeight; }
        }
        pressMeter.update(on && px > -999, rider.pressBalance, rider.pressDir, px, py);
      }
      env.updateCSM();
      clouds.render(renderer, cam.camera, dt, env.sunDir, env.sun.color, env.sun.intensity, env.hemi.color, env.hemi.intensity, env.atmo.hazeLinear);
      env.followCamera(cam.camera.position);
      snow.update(dt, cam.camera, renderer.domElement.height, 0.45 + 0.6 * env.hemi.intensity / 1.4);
      // BUG-046: spray and puffs are unlit points; give them the light flat snow gets at the rider (dark at dusk, darker in a ridge's shade)
      const pl = particleLight.update(dt, env, (x, y) => pack.terrainHeight(x, y), rider.x, rider.y, rider.z);
      riderView.spray.setLight(pl); riderView.spray.setViewHeight(renderer.domElement.height); riderView.spray.wind.set(snow.wind.x * 0.3, snow.wind.y * 0.3);
      (puffs.points.material as THREE.PointsMaterial).color.copy(pl);
      veg.setSun(env.sun.color, env.sun.intensity);
      // FEAT-155: trees in the way of the view downhill go see-through (third-person cameras only)
      treeFade.update(cam.camera, rider, (x, y) => pack.groundHeight(x, y), dt, settings.seeThroughTrees !== false && !detached && !cam.firstPerson && !eat.active);
      terrain.setSun(env.sunDir); // BUG-062: the mogul colouring's sun term
      const cp = cam.camera.position;
      // FEAT-044: stamp the tracks and prints near the rider into the deformation texture (the soft sag around them)
      { const h = riderView.powderHold; setDeformHold(h.x, h.z, h.fx, h.fz, riderView.group.visible && !eat.active ? h.k : 0); } // FEAT-152: the snow wall ahead of a board buried in powder
      deform.update(renderer, rider.x, rider.z, -rider.y, rider.vx, -rider.vy);
      terrain.update(cp.x, -cp.z, cp.y);
      const fx = detached ? cp.x : rider.x, fy = detached ? -cp.z : rider.y;
      // terrain, mask and instance tiles stream ahead along the direction of travel
      const liftTop = onLift && liftRide.lift ? liftRide.lift.top : null;
      prefetch.update(pack, fx, fy, dt, liftTop);
      veg.update(fx, fy, prefetch.ax, prefetch.ay);
      rocks.update(fx, fy, prefetch.ax, prefetch.ay);
      if (weatherNow === 'storm') snowCover = Math.min(1, snowCover + dt / 600);
      else if (weatherNow === 'flurries') snowCover = Math.min(1, snowCover + dt / 3000);
      terrain.setSnowCover(snowCover, snow.wind.x, snow.wind.y);
      // FEAT-077: groomers get skied out through the day (fresh corduroy first thing, tracked out by
      // mid-afternoon); new snow covers the tracks again
      {
        const hour = typeof settings.timeOfDay === 'number' ? settings.timeOfDay : settings.timeOfDay === 'now' ? ((new Date().getUTCHours() + new Date().getUTCMinutes() / 60 + sun.utcOff) % 24 + 24) % 24 : 13;
        const day = Math.max(0, Math.min(1, (hour - 8.5) / 6.5));
        const base = SKIED_BASE[settings.snowDay ?? 'mid'];
        terrain.setSkied(base * (0.15 + 0.85 * day * day * (3 - 2 * day)) * (1 - snowCover), settings.snowDay === 'spring' ? 1 : 0);
        // FEAT-053: the same day drives the snow under the board (powder keeps in the shade and after
        // a storm, open off-piste gets tracked out, the afternoon sun makes slush, spring mornings ice)
        const sw = rider.snowWorld;
        sw.hour = hour; sw.storm = weatherNow === 'storm' ? 1 : weatherNow === 'flurries' ? 0.3 : 0; sw.newSnow = snowCover; sw.day = settings.snowDay ?? 'mid';
        // "high up" is judged against the resort's own top (the highest lift top), not the pack's far terrain
        sw.zLow = zr[0]; sw.zHigh = resortTop;
        // FEAT-059: mogul fields creep uphill about 8 cm a day from mid-November; new snow softens them
        const live = sun.live(settings);
        const d = live ? new Date() : new Date(Date.UTC(new Date().getFullYear(), settings.month - 1, 15));
        const seasonStart = Date.UTC(d.getUTCMonth() >= 10 ? d.getUTCFullYear() : d.getUTCFullYear() - 1, 10, 15);
        const seasonDays = Math.max(0, Math.min(150, (d.getTime() - seasonStart) / 86400000));
        pack.setMoguls(params.nomoguls ? 0 : 1 - 0.6 * snowCover, MOGUL_CREEP_M_PER_DAY * seasonDays);
        terrain.setMoguls(pack.mogulScale, pack.mogulCreep);
      }
      rocks.setSnow(Math.min(1, snowCover * 3), snow.wind.x, snow.wind.y); // boulder tops fill three times faster than the slopes
      roads.update(fx, fy);
      const carried = onLift && liftRide.airborneRide ? liftRide.lift : null;
      riderChair.update(carried, rider.x, rider.y, rider.z, rider.heading, liftRide.cableY);
      lifts.update(elapsed, carried ? chairPos.set(rider.x, rider.z, -rider.y) : null);
      lifts.maintain(dt, rider.x, rider.y);
      bridges.maintain(dt, rider.x, rider.y);
      liftLines.maintain(rider.x, rider.y);
      const passed = landmarks.maintain(rider.x, rider.y);
      if (passed) events.emit({ type: 'landmark', name: passed.name });
      sun.update(dt, settings);
      lifts.updateMarkers(elapsed, rider.x, rider.y, liftRide.canBoard ? liftRide.nearby : null);
      map.liftMarker = liftRide.nearby ? [liftRide.nearby.bottom[0], liftRide.nearby.bottom[1]] : null;
      showPrompt(contextPrompt(keyLabels, {
        onLift, liftRide, lifts, mapOpen: map.fullOpen, detached, rider, boardMsg: boardMsgT > 0 ? boardMsg : '', usingPad: controls.usingPad, metric: settings.units === 'metric',
      }));
      // FEAT-124: only the keys that matter right now (the full list is in Settings > Controls)
      helpT -= dt;
      if (boardMsgNote && (boardNoteT -= dt) <= 0) boardMsgNote = '';
      cam.glance = controls.glancing;
      if (helpEl && helpT <= 0) {
        helpT = 0.25;
        let h = keyHints(keyLabels, controls.usingPad, { onLift: liftRide.riding, outrunRunning: outrun.running, onFoot: rider.onFoot, onGround: rider.onGround, liftNearby: !!liftRide.nearby });
        if (boardMsgNote) h = `<b>${boardMsgNote}</b><br>` + h;
        if (h !== helpShown) { helpShown = h; helpEl.innerHTML = h; }
      }
      env.update(fx, detached ? cp.y : rider.z, -fy);
      if (pack.fine && terrain.stats.builds === 0) pack.fine.evictBeyond(fx, fy, 3000, liftTop);
      map.riderPos = [rider.x, rider.y, rider.z];
      if (map.fullOpen) { if (fpsN % 10 === 0) map.drawFull(); }
      else if (fpsN % 3 === 0) map.drawMini(rider.x, rider.y, rider.heading);
      labels.update(cam.camera, settings.units === 'metric');
      render();
      // the drawing buffer is only readable in the same task as the render
      if (shotPending) { shotPending = false; saveShot(canvas.toDataURL('image/png'), canvas.toDataURL('image/jpeg', 0.9)); }
      controls.endFrame();
      replay.restore(rider); // FEAT-043: the sim state back under the replayed pose

      fpsAcc += dt; fpsN++;
      if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
      hud.innerHTML = hudLine({
        rider, runStats, metric: settings.units === 'metric', fps, chunks: terrain.stats.chunks, triangles: terrain.stats.triangles, trees: veg.stats.instances,
        camMode: cam.mode, auto: auto.level ? auto.describe() : '', debug: debugHud,
      });
    }

    const warmUp = (ls: { set(f: number, label: string): void }) => warmUpWorld(ls, world, pack, rider, renderer, scene, cam.camera);

    // wait briefly for the fine tiles under the start point, then warm up and go
    (async () => {
      const t0 = performance.now();
      while (Number.isNaN(pack.fine?.sample(sx, sy) ?? 0) && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
      rider.reset(sx, sy, sh);
      lifts.buildMarkers(pack);
      cam.snapTo(rider);
      if (opts.attract) enterAttract();
      if (loading && alive) { await warmUp(loading); hideLoading = loading; if (menu) menuReadyIn = HIDE_AFTER_FRAMES; } // ?cam=eye: the menu (shown on Quit) is ready too
      else if (opts.attract && menu && alive) { await warmUp({ set: (f, l) => menu.setProgress(f, l) }); menuReadyIn = HIDE_AFTER_FRAMES; }
      if (!alive) return;
      status.textContent = '';
      installSimDebug({ events, ghosts, menu, shot, rider, riderView, controls, padFx, trialWorld, terrain, pack, cam, veg, map, liftRide, lifts, setSpawn, settings, bootprints, tracks, deform, renderer, eyeAt, outrun, monsters, startOutrun, stopOutrun, treeFadeUniforms,
        /** shoot_spots.mjs: a spot's weather, or null for the page's own (?weather= else the setting) */
        setWeather: (w: string | null) => { weatherOverride = parseWeather(w) ?? initialWeather; applySettings(settings, 'weather'); },
        /** snowcheck.mjs: apply a settings field changed in place (for example 'newSnow') as the settings panel would */
        applySettings: (what: string) => applySettings(settings, what) }, { attract: () => attract, fps: () => fps });
      loop.start(canvas);
    })();
  });
  return { quit };
}
