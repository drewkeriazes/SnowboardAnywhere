import * as THREE from 'three';
import { Rider } from '../sim/Rider';
import { landmarkStart } from '../world/Landmarks';
import { isOvercast, parseWeather, type CloudCover } from '../world/Clouds';
import { Controls } from '../sim/Controls';
import { setVegetationBudget, setVegetationDensity, setStandDensity } from '../world/Vegetation';
import { treeFadeUniforms } from '../world/TreeFade';
import { GoggleView } from '../ui/GoggleView';
import { GoggleLens } from '../world/Lens';
import { RunStats } from '../sim/RunStats';
import { RunCard } from '../ui/RunCard';
import { Replay, type ReplaySample } from '../sim/Replay';
import { SpeedLines } from '../ui/SpeedLines';
import { ChaseCamera } from '../world/ChaseCamera';
import { FILL_RATE, setTrackFillRate } from '../world/Tracks';
import { OutrunUI } from '../ui/OutrunUI';
import { ResortMap } from '../ui/ResortMap';
import { LiftRide } from '../sim/LiftRide';
import { Prefetch } from '../sim/Prefetch';
import { MainMenu, type MenuChoice } from '../ui/MainMenu';
import { attractDir, attractShot, shotPose, CONDITION_FIELDS, type AttractManifest, type AttractShot, type ShotConditions } from '../world/AttractShots';
import { AttractGhosts } from '../world/AttractGhosts';
import { LoadingScreen, framesSettled } from '../ui/Loading';
import { PauseMenu, type PauseInfo } from '../ui/PauseMenu';
import { Labels } from '../ui/Labels';
import { TouchControls } from '../ui/TouchControls';
import { saveSettings, FALL_LINE, type Conditions, type Settings } from '../ui/Settings';
import { saveMenuStill } from '../ui/MenuStill';
import { PressMeter } from '../ui/PressMeter';
import { listenHud } from '../ui/HudEvents';
import { connectEventSources } from './eventSources';
import { resetStart, spawnFromUrl, spawnKey } from '../spawn';
import { GameLoop } from '../core/GameLoop';
import { StateMachine } from '../core/StateMachine';
import { FpsMeter } from '../core/FpsMeter';
import { ReplayBar } from '../ui/ReplayBar';
import { KeyLabels } from '../ui/KeyLabels';
import { Toast } from '../ui/Toast';
import { SceneRender } from '../world/SceneRender';
import { SunClock } from '../world/SunClock';
import { warmUp as warmUpWorld } from './warmUp';
import { saveShot as saveShotFile, saveTake as saveTakeFile, saveMenuShot } from './devSaves';
import { askMenuShot } from '../ui/MenuShotForm';
import { buildWorld } from './World';
import { mountLeadTunePanel } from '../ui/LeadTunePanel';
import { RestartRing } from '../ui/RestartRing';
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
import { Modes } from '../modes/Modes';

/** FEAT-105: the New snow setting as a snow cover amount */
const NEW_SNOW: Record<string, number> = { none: 0, dusting: 0.25, '6in': 0.6, powder: 1 };

/** How a session starts: in the main menu (attract) or riding, with the loading screen when there is no menu over it. */
export interface SessionOpts { menu: MainMenu | null; attract: boolean; loading: LoadingScreen | null; attractFiles: AttractManifest; shots: AttractShot[] }

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
    const status = document.getElementById('status')!;
    const world = buildWorld(ctx);
    const { env, clouds, snow, terrain, collider, veg, lifts, liftLines, roads, tracks, bootprints, puffs, bigprints, deform, monsters, eat, trialWorld, riderView } = world;
    // FEAT-162: the session's states; the frame is the active state's update (states/RideFrame.ts has the order)
    const states = new StateMachine<GameStateName>();
    const outrunUI = new OutrunUI(); // FEAT-164: built here, before the labels, so its HUD stacks as it always has
    const labels = new Labels(pack);
    if (debugHud) mountLeadTunePanel(riderView);

    const rider = new Rider(pack, collider);
    riderView.setPack(pack, collider); // FEAT-046: the crash ragdoll hits trunks, rocks and walls
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
    const speedLines = new SpeedLines(document.body); // FEAT-045
    // the short message at the top (now playing, tricks, saves)
    const showToast = new Toast().show;

    // ---- FEAT-043: the session recording, the replay viewer (K) and the practice rewind (hold Backspace)
    const replay = new Replay();
    // FEAT-137: with a controller in use, its button glyphs (an action with no button keeps its key)
    const keyLabels = new KeyLabels(controls, settings);
    const replayBar = new ReplayBar(keyLabels);
    /** samples (at 20 Hz) recorded before the replay viewer opens: about a second of riding */
    const MIN_REPLAY_SAMPLES = 20;
    /** Why the replay viewer can't open now, or null when it can (the K key and the pause menu's Replay both ask). */
    const replayBlockedReason = (): string | null =>
      modes.replayBlocked ?? (liftRide.riding ? 'not on a lift' : rider.unstrapped ? 'strap in first' : replay.samples.length <= MIN_REPLAY_SAMPLES ? 'ride a little first' : null);
    /** back on the snow at a recorded moment; the recording carries on from there */
    const rewindTo = (s: ReplaySample) => {
      rider.x = s.x; rider.y = s.y; rider.z = pack.groundHeight(s.x, s.y, s.z); rider.vx = s.vx; rider.vy = s.vy; rider.vz = 0;
      rider.heading = s.hd; rider.boardYaw = s.h; rider.switch = !!(s.f & 8); rider.onGround = true; rider.onFoot = !!s.on; rider.crashed = 0;
      rider.flip = 0; rider.flipRate = 0; rider.spin = 0; rider.airTime = 0; rider.jumpCharge = 0; rider.landingShock = 0; rider.washout = 0; rider.crashSide = 0;
      replay.truncate(s.t); modes.interrupt('Rewound');
    };
    // first person redraws the body with a close near plane so knees, gloves and the board are not clipped
    const sceneRender = new SceneRender(renderer, scene, env, lens);

    // ---------------------------------------------------------------- sun / time of day
    const sun = new SunClock(env, pack, params.time); // ?time=now or ?time=16.5
    const applySun = (c: Conditions) => sun.apply(c);
    // ?weather=overcast (FEAT-078) and __sim.setWeather (shoot_spots.mjs, per spot) override the
    // saved Weather setting for this session without saving it; picking a Weather in the menu clears it
    let weatherOverride: CloudCover | null = parseWeather(params.weather);
    const initialWeather = weatherOverride;
    // FEAT-177: while the main menu is up it draws its shot's own conditions (AttractShots.ts), so the live view
    // matches the shipped still whatever the player saved; never saved, and a condition picked in the menu ends it
    let shotCond: ShotConditions | null = null, coverBeforeShot = 0;
    /** the conditions drawn now */
    const conditions = (): Conditions => shotCond ?? settings;
    /** the weather on screen right now (FEAT-093: saved with P-key shots) */
    const currentWeather = (): CloudCover => shotCond?.clouds ?? weatherOverride ?? settings.clouds ?? 'scattered';

    // ---------------------------------------------------------------- settings application
    /** the weather drawn, and FEAT-105's new snow, 0..1, shared by the terrain rock and the boulder caps (FEAT-106): a
     *  storm adds 1 per 10 min, flurries a fifth of that (states/RideFrame.ts), it never melts in a session; the New snow setting sets it */
    const sky: SkyState = { weather: 'scattered', snowCover: 0 };
    /** FEAT-044: the deformation window and the spray budget from the preset, the Snow dents setting and ?nodeform */
    const applyDeform = (s: Settings): void => {
      deform.enabled = s.snowDeform !== false && s.quality !== 'low' && !params.nodeform;
      const small = s.quality === 'medium';
      deform.configure(small ? 256 : 512, small ? 48 : 64);
      riderView.spray.setCount(s.quality === 'high' ? 8192 : s.quality === 'medium' ? 4096 : 2048);
    };
    const applySettings = (s: Settings, what: string): void => {
      if (shotCond && (what === 'reset' || (CONDITION_FIELDS as readonly string[]).includes(what))) {
        shotCond = null; // the player picked a condition in the menu: show theirs
        if (what !== 'newSnow') sky.snowCover = coverBeforeShot;
      }
      const c = conditions();
      applySun(c);
      if (what === 'clouds') weatherOverride = null;
      rider.pressMode = s.pressBalance ?? 'on'; // FEAT-140
      const weather = currentWeather();
      sky.weather = weather;
      if (what === 'newSnow' || what === 'init' || what === 'reset') sky.snowCover = NEW_SNOW[c.newSnow ?? 'none'] ?? 0; // FEAT-105: pick a look without waiting
      clouds.configure(weather, s.quality);
      const storm = weather === 'storm', overcast = isOvercast(weather);
      env.setBluebird(!storm && !overcast); // deep blue sky behind the clouds too; storm and overcast are grey
      env.setStorm(storm);
      env.setOvercast(overcast);
      env.setCirrus(weather === 'cirrus'); // FEAT-084
      // flat light: the snow surface reads poorly under a storm, a little less under overcast
      terrain.setFlatLight(storm ? 1 : overcast ? 0.85 : 0);
      env.setValleyFog(!!c.valleyFog || params.valleyfog); // ?valleyfog forces it on for render checks
      // falling snow: the storm, or light flurries under overcast (a sixth of the flakes, no visibility cut)
      snow.points.visible = storm || weather === 'flurries';
      const flakes = s.quality === 'high' ? 16000 : s.quality === 'medium' ? 9000 : 4500;
      snow.setCount(Math.round(storm ? flakes : flakes / 6));
      applyDeform(s);
      // old tracks and boot prints fill in faster while it snows (FEAT-107)
      setTrackFillRate(storm ? FILL_RATE.storm : weather === 'flurries' ? FILL_RATE.flurries : FILL_RATE.clear);
      // limited render distance in the storm: nothing past the fog is drawn
      cam.camera.far = storm ? 1200 : 300000; cam.camera.updateProjectionMatrix();
      audio.setVolumes(s.mute ? 0 : s.sfx, s.mute ? 0 : s.music);
      audio.setSource(s.musicSource);
      audio.setPlaylist(s.playlist);
      renderer.setPixelRatio(Math.min(s.pixelRatio, window.devicePixelRatio || 1, 2));
      if (renderer.shadowMap.enabled !== s.shadows) { renderer.shadowMap.enabled = s.shadows; renderer.shadowMap.needsUpdate = true; scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.needsUpdate = true; }); }
      const wantSize = (s.csmExperimental || params.csm) && !params.nocsm ? (s.quality === 'high' ? 2048 : 1024) : 0;
      if (csmSize !== wantSize) { csmSize = wantSize; if (wantSize) env.enableCSM(cam.camera, wantSize, 3); else env.disableCSM(); }
      env.sun.visible = wantSize === 0;
      env.sun.shadow.mapSize.set(s.quality === 'high' ? 4096 : 2048, s.quality === 'high' ? 4096 : 2048);
      env.setShadows(s.shadows);
      if (s.quality === 'low') setVegetationBudget(250, 600, params.lowgfx ? 0 : 200); else setVegetationDensity(s.treeDensity); // BUG-107: Low's LOD0 cards to 200 m (none on ?lowgfx, the software-GPU runs, FEAT-158)
      setStandDensity(s.forestDensity ?? 1); // FEAT-074: only the generated stems
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
      modes.applySettings(s, what);
      rider.discipline = s.discipline;
      rider.goofy = s.stance === 'goofy'; // FEAT-139 (the rider view follows it)
      rider.fallLine = FALL_LINE[s.fallLine] ?? 1; // FEAT-134
      labels.visible = s.showLabels && !storm; // peaks are hidden in the storm
      map.metric = s.units === 'metric';
      if (what === 'camera' || what === 'reset') cam.mode = s.camera;
    };
    /** FEAT-285: Settings > Graphics > Apply, behind its loading screen: the held options go live, every material
     *  compiles now instead of on the frames after, and the loading screen waits until the frames run clean */
    const applyGraphics = async (s: Settings, progress: (p: number, text: string) => void): Promise<void> => {
      applySettings(s, 'quality');
      progress(0.4, 'Compiling shaders');
      try { await renderer.compileAsync(scene, cam.camera); } catch { /* the first frames compile them instead */ }
      progress(0.75, 'Drawing the first frames');
      await framesSettled();
      progress(1, 'Ready');
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
      modes.interrupt('Moved');
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
    const pause = new PauseMenu(settings, applySettings, { fps: () => fps.fps, credits: () => audio.credits, apply: applyGraphics });
    // ---------------------------------------------------------------- FEAT-164: Free ride, Time trial and Outrun on top of riding
    const toSpawn = () => { liftRide.cancel(); rider.reset(sx, sy, sh); cam.snapTo(rider); };
    const modes = new Modes(ctx, world, { rider, liftRide, cam, map, keyLabels, toast: (t, ms) => showToast(t, ms), pick: pickHandler, toSpawn }, outrunUI);

    // ---------------------------------------------------------------- FEAT-163: the news, on the bus
    // The systems' hooks emit; the HUD, the audio and the rumble subscribe themselves, in that order (a trial
    // event reaches the panel, then the chime, then the pad, as before); the world's and the modes' reactions follow.
    const disconnectSources = connectEventSources(events, { rider, riderView, trial: modes.trials.trial, runStats, audio, eat, monsters });
    listenHud(events, { toast: showToast, trialHud: modes.trials.trialHud, runCard, settings, slug: pack.meta.slug, headless });
    audio.listen(events);
    padFx.listen(events);
    events.on('footPlant', (e) => bootprints.add(e.plant, e.sink));
    modes.listen(events); // Outrun: the camera kick, the eat start (after the audio's record scratch)

    /** FEAT-128: what the pause menu shows (read when it opens) */
    const pauseInfo = (): PauseInfo => ({
      resort: pack.meta.name,
      place: runStats.placeAt(rider.x, rider.y),
      run: runStats.active ? { time: runStats.time, distance: runStats.distance, vertical: runStats.vertical, topSpeed: runStats.topSpeed } : null,
      day: { runs: runStats.day.runs, vertical: runStats.day.vertical },
      metric: settings.units === 'metric',
      mode: modes.current,
      replayBlocked: replayBlockedReason(),
      courses: modes.trials.list(),
    });
    /** back to the spawn point (the pause menu's Restart, the restart hold): Outrun and the trial end, the run's stats close */
    const restartRun = () => { modes.restart(); liftRide.cancel(); runStats.end(); rider.reset(sx, sy, sh); cam.snapTo(rider); };
    // the pause menu closes itself before it calls this; each action starts from riding
    pause.onAction = (a, arg) => {
      states.go('riding');
      if (a === 'replay') states.go('replay');
      else if (a === 'freeride') modes.freeRide();
      else if (a === 'trial') modes.rideCourse(arg);
      else if (a === 'restart') restartRun();
      else if (a === 'map') map.open();
      else if (a === 'outrunStart') modes.startOutrun();
      else if (a === 'outrunStop') modes.outrun.end();
      else if (a === 'quit') { if (menu) backToMenu(); else { dispose(); resolveQuit(); } }
    };

    // ---------------------------------------------------------------- FEAT-128: the main menu inside the session (attract)
    const shot = attractShot(pack, start, opts.shots);
    const ghosts = new AttractGhosts(pack);
    ghosts.group.name = 'attract ghosts'; scene.add(ghosts.group);
    ghosts.setVisible(false);
    void ghosts.load(attractDir(import.meta.env.BASE_URL, pack.meta.slug, opts.attractFiles), opts.attractFiles[pack.meta.slug]?.ghosts ?? []);
    /** FEAT-177: the menu draws its shot's conditions (on), or hands the player's back (off) */
    const holdShotConditions = (on: boolean): void => {
      if (on === !!shotCond) return;
      if (on) { shotCond = shot.conditions; coverBeforeShot = sky.snowCover; sky.snowCover = NEW_SNOW[shotCond.newSnow] ?? 0; }
      else { shotCond = null; sky.snowCover = coverBeforeShot; }
      applySettings(settings, 'conditions');
    };
    /** FEAT-177: the shot from its start (the moment the still shows): the clouds where the still has them */
    const shotFromStart = (): void => { clouds.setTime(shot.conditions.cloudTime); };
    const startLabel = () => { const lm = landmarkStart(pack.meta.slug); return lm ? lm.label : pack.meta.start.label ?? (pack.meta.start.run ? `Starts on ${pack.meta.start.run}` : 'Starts at the resort start'); };
    /** RIDE: the mode it starts (BUG-037's start when it is not a course) */
    const leaveAttract = (c: MenuChoice) => {
      states.go('riding');
      modes.fromMenu(c);
    };
    /** Quit to main menu: ends an Outrun or time trial and this run's stats; RIDE then starts at the saved start. */
    const backToMenu = () => {
      modes.quit();
      liftRide.cancel(); runStats.end();
      rider.reset(sx, sy, sh);
      states.go('attract');
    };
    if (menu) {
      menu.onChoice = leaveAttract;
      menu.onSettingsChange = (s, what) => applySettings(s, what);
      menu.onSettingsApply = applyGraphics;
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
    /** FEAT-181 (?debug): the eye camera's view as the resort's menu shot, in the conditions on screen now */
    const menuShot = params.debug === null ? null : () => askMenuShot({ id: shot.id === 'start' ? '' : shot.id, place: shot.place === pack.meta.name ? '' : shot.place, region: shot.region || pack.meta.name }, (labels, candidate) => {
      const c = conditions();
      const hour = c.timeOfDay === 'now' ? new Date().getHours() + new Date().getMinutes() / 60 : c.timeOfDay;
      saveMenuShot({ slug: pack.meta.slug, eye: cam.eyePose(), labels, hosted, candidate, toast: (t, ms) => showToast(t, ms),
        conditions: { clouds: c.clouds, timeOfDay: hour, month: c.month, newSnow: c.newSnow ?? 'none', snowDay: c.snowDay, valleyFog: c.valleyFog, cloudTime: 0 } });
    });
    const saveShot = (dataUrl: string, jpgUrl: string) =>
      saveShotFile({ dataUrl, jpgUrl, eye: cam.eyePose(), spot: spotName, slug: pack.meta.slug, weather: currentWeather(), hosted, toast: (t) => showToast(t) });
    pack.fine?.request(sx - 600, sy - 600, sx + 600, sy + 600);
    pack.mid?.request(sx - 20000, sy - 20000, sx + 20000, sy + 20000);
    pack.far?.request(-1e9, -1e9, 1e9, 1e9);
    pack.mask?.request(sx - 600, sy - 600, sx + 600, sy + 600);
    // FEAT-140: the press balance meter above the head (the toast when a press ends is in ui/HudEvents.ts)
    const pressMeter = new PressMeter();
    if (params.cam === 'eye' && !headless) showToast('Eye camera: click, then mouse to look · WASD move · Q/E height · [ ] zoom · P save shot · ` free fly', 10000);
    // the menu may already have started a song before the session listened (BUG-033): announce it now
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
    const draw = (): void => { veg.cull(cam.camera, renderer.shadowMap.enabled && env.sun.visible && !env.csm ? env.sun : null); sceneRender.render(cam.camera, cam.firstPerson); }; // FEAT-158: the near trees culled to this view
    const frame = new RideFrame({
      ...world, params, settings, pack, renderer, canvas, audio, events, rider, liftRide, prefetch, cam, controls, touch, goggles, lens, runStats, runCard, speedLines, replay,
      modes, map, labels, sun, keyLabels, pressMeter, fps, sky, look, draw, showToast, saveShot, conditions,
    });
    if (settings.keysNote) { frame.boardNote = 'New default key layout available: Settings > Controls > Reset keys'; settings.keysNote = false; saveSettings(settings); }
    const restartRing = new RestartRing();
    const rewind = new RewindState({ controls, touch, rider, liftRide, modes, replay, pack, frame, rewindTo }, states);
    states
      .add(new RidingState({
        controls, touch, cam, settings, rider, liftRide, modes, runs: world.runs, audio, map, frame, ring: restartRing, replayBlockedReason, menuShot,
        rewindWanted: () => rewind.wanted(), restartRun,
      }, states))
      .add(rewind)
      .add(new PausedState({ controls, touch, pause, audio, fps, pauseInfo, draw }, states))
      .add(new ReplayState({ controls, touch, rider, replay, replayBar, pack, cam, settings, modes, audio, frame, debugHud, applySun, replayBlockedReason, saveTake }, states))
      .add(new MapState({ controls, touch, map, settings, keyLabels, audio, frame, onClosed: () => modes.mapClosed() }, states));
    const attract = menu ? new AttractState({ menu, shot, ghosts, cam, pack, settings, controls, rider, runCard, map, look, frame, startLabel, menuCourses: () => modes.trials.list(), holdShotConditions, shotFromStart }) : null;
    if (attract) states.add(attract);

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
      modes.dispose();
      padFx.stop();
      runCard.dispose(); speedLines.dispose(); pressMeter.dispose(); restartRing.dispose(); eat.dispose(); puffs.dispose(); bigprints.dispose();
      disconnectSources(); events.clear(); // FEAT-163
      frame.clear();
      goggles.destroy();
      lens.dispose();
      veg.shade?.dispose(); veg.shade = null; // FEAT-171: its own scene and render target, outside the main scene
      veg.clumps?.dispose(); veg.clumps = null; // FEAT-292: the stand atlases (a render target and two data textures, 24 MB) are not reached by the traverse below
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
    // FEAT-128 / FEAT-177: the menu's still crossfades into the live view once the view has settled behind it: the
    // ghosts loaded, the terrain, trees (and their impostors) and rocks in the shot built, and HIDE_AFTER_FRAMES
    // quiet frames in a row; or MENU_WAIT_MS after the warm-up, whatever is left, so nothing can hold the menu
    let menuWait: { t0: number; quiet: number } | null = null, ghostsIn = false;
    void ghosts.loaded.then(() => { ghostsIn = true; });
    const MENU_WAIT_MS = 8000;
    /** something in the backdrop shot is still downloading or building */
    const shotBusy = (): boolean => !ghostsIn || terrain.pending > 0 || veg.pending > 0 || world.rocks.pending > 0 || world.shrubs.pending > 0
      || [pack.fine, pack.mid, pack.far, pack.mask, pack.ao, pack.dir].some((t) => (t?.inFlight ?? 0) > 0);
    /** every display frame, drawn or skipped by the 30 fps cap */
    function everyFrame(): void {
      if (hideLoading && ++loadFrames >= HIDE_AFTER_FRAMES) { hideLoading.hide(); hideLoading = null; }
    }
    /** one drawn frame: the devices, then the active state (docs/developer-guide.md has the update order) */
    function tickFrame(dt: number, stepped: boolean): void {
      // the frame the menu goes live on starts the shot over (the pose, the clouds, the ghosts out of frame), as the still has it
      let live = false;
      if (menuWait && menu) {
        menuWait.quiet = shotBusy() ? 0 : menuWait.quiet + 1;
        if (menuWait.quiet >= HIDE_AFTER_FRAMES || performance.now() - menuWait.t0 > MENU_WAIT_MS) {
          live = true;
          performance.measure('menu settle', { start: menuWait.t0 }); // shoot_attract.mjs --compare reports it
          menuWait = null;
        }
      }
      if (live && attract && states.is('attract')) attract.restart();
      frame.readInput(dt);
      states.update(dt, stepped);
      states.render();
      if (!live || !menu) return;
      // FEAT-177: this frame is what the still should have been: keep it for the next visit (ghosts out of frame, the shot's own conditions)
      if (states.is('attract') && shotCond && !ghosts.anyInView(cam.camera)) saveMenuStill(canvas, pack, shot, settings);
      if (params.menuframe) Object.assign(window, { __menuFrame: canvas.toDataURL('image/png'), __menuFrameGhosts: ghosts.anyInView(cam.camera) });
      menu.setReady();
    }

    // FEAT-177: the warm-up streams the trees and rocks where the camera looks when it is off the rider (the menu shot)
    const warmFocus = () => cam.mode === 'eye' || cam.mode === 'free' ? { x: cam.camera.position.x, y: -cam.camera.position.z } : rider;
    const warmUp = (ls: { set(f: number, label: string): void }) => warmUpWorld(ls, world, pack, warmFocus, renderer, scene, cam.camera);
    states.add(new LoadingState({
      pack, rider, lifts, cam, spawn: () => ({ x: sx, y: sy, h: sh }), first: opts.attract ? 'attract' : 'riding', alive: () => alive,
      // ?cam=eye: the menu (shown on Quit) is ready too
      warmUp: loading ? async () => { await warmUp(loading); hideLoading = loading; if (menu) menuWait = { t0: performance.now(), quiet: 0 }; }
        : opts.attract && menu ? async () => { await warmUp({ set: (f, l) => menu.setProgress(f, l) }); menuWait = { t0: performance.now(), quiet: 0 }; }
        : null,
      ready: () => {
        status.textContent = '';
        installSimDebug({ events, ghosts, menu, shot, rider, riderView, controls, padFx, trialWorld, terrain, pack, cam, veg, shrubs: world.shrubs, treeBrush: world.treeBrush, map, liftRide, lifts, setSpawn, settings, bootprints, tracks, deform, renderer, scene, eyeAt, outrun: modes.outrun.sim, monsters, egg: modes.egg, boundary: world.boundary, boundaryRope: world.boundaryRope, startOutrun: () => modes.outrun.start(), stopOutrun: () => modes.outrun.end(), treeFadeUniforms,
          /** shoot_spots.mjs: a spot's weather, or null for the page's own (?weather= else the setting) */
          setWeather: (w: string | null) => { weatherOverride = parseWeather(w) ?? initialWeather; applySettings(settings, 'weather'); },
          /** snowcheck.mjs: apply a settings field changed in place (for example 'newSnow') as the settings panel would */
          applySettings: (what: string) => applySettings(settings, what),
          /** shoot_attract.mjs: draw the menu shot's conditions, from its start (as the live menu does) */
          shotConditions: () => { holdShotConditions(true); shotFromStart(); },
          /** shoot_attract.mjs: the shot's pose at t seconds of its drift (the still is t = 0, where the menu goes live) */
          shotPose: (t: number) => shotPose(shot, t) }, { attract: () => states.is('attract'), state: () => states.current, fps: () => fps.fps });
        loop.start(canvas);
      },
    }, states));
    // wait briefly for the fine tiles under the start point, then warm up and go
    states.go('loading');
  });
  return { quit };
}
