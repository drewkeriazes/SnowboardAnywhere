import * as THREE from 'three';
import { MOGUL_CREEP_M_PER_DAY } from '../terrain/Moguls';
import { LENSES, resolveLens, type GoggleLens, type LensId } from '../world/Lens';
import { setDeformHold } from '../world/Deform';
import type { Settings } from '../ui/Settings';
import { contextPrompt } from '../ui/ContextPrompt';
import { keyHints } from '../ui/KeyHints';
import { hudLine } from '../ui/HudLine';
import { padFx } from '../sim/PadFeedback';
import type { Events } from '../core/Events';
import type { Input, Rider } from '../sim/Rider';
import type { Controls } from '../sim/Controls';
import type { LiftRide } from '../sim/LiftRide';
import type { Prefetch } from '../sim/Prefetch';
import type { RunStats } from '../sim/RunStats';
import type { Replay } from '../sim/Replay';
import type { ChaseCamera } from '../world/ChaseCamera';
import type { SunClock } from '../world/SunClock';
import type { CloudCover } from '../world/Clouds';
import type { GoggleView } from '../ui/GoggleView';
import type { AutoQuality } from '../ui/AutoQuality';
import type { RunCard } from '../ui/RunCard';
import type { SpeedLines } from '../ui/SpeedLines';
import type { ResortMap } from '../ui/ResortMap';
import type { Labels } from '../ui/Labels';
import type { KeyLabels } from '../ui/KeyLabels';
import type { PressMeter } from '../ui/PressMeter';
import type { TouchControls } from '../ui/TouchControls';
import type { GameAudio } from '../audio/Audio';
import type { Pack } from '../pack/Pack';
import type { Params } from '../core/params';
import type { FpsMeter } from '../core/FpsMeter';
import type { World } from '../session/World';
import type { Modes } from '../modes/Modes';
import type { ModeFrame } from '../modes/RideMode';

/** FEAT-077: how skied out the snow gets by late afternoon for each Snow conditions setting */
const SKIED_BASE: Record<string, number> = { fresh: 0.15, mid: 0.9, spring: 0.7 };

/**
 * FEAT-162: who moves the rider this frame. `ride` the physics (riding); `hold` nothing, though a lift carries
 * on (the map is open); `recording` the replay (the replay viewer, the rewind); `menu` nothing, the rider is
 * hidden behind the main menu. While Outrun's monster has caught the rider the eat sequence has it (`eaten`).
 */
export type Drive = 'ride' | 'hold' | 'recording' | 'menu';

/** what each drive lets run: lift, physics step, replay recording, run stats, rider pose, tracks, trial timing, speed lines */
interface Runs { lift: boolean; physics: boolean; record: boolean; stats: boolean; pose: boolean; tracks: boolean; trial: boolean; speedLines: boolean }
const RUNS: Record<Drive | 'eaten', Runs> = {
  ride: { lift: true, physics: true, record: true, stats: true, pose: true, tracks: true, trial: true, speedLines: true },
  hold: { lift: true, physics: false, record: true, stats: true, pose: true, tracks: true, trial: true, speedLines: true },
  recording: { lift: false, physics: false, record: false, stats: false, pose: true, tracks: false, trial: false, speedLines: false },
  menu: { lift: false, physics: false, record: false, stats: true, pose: true, tracks: true, trial: true, speedLines: true },
  eaten: { lift: false, physics: false, record: false, stats: false, pose: false, tracks: true, trial: true, speedLines: true },
};

/** FEAT-043: the replay viewer's camera and photo settings, read by the camera step */
export interface ReplayShot {
  /** H: the HUD hidden for a clean shot */
  clean: boolean;
  /** - / =: the photo zoom added to the field of view (deg) */
  photoFov: number;
  /** the trackside camera, placed by the viewer; null for the follow and free cameras */
  trackside: (() => void) | null;
}

/** What a state lets the world do this frame; each state keeps one and changes it in place. */
export interface FramePlan {
  drive: Drive;
  /** the touch buttons over the view */
  touch: boolean;
  /** the full map is up (it redraws instead of the minimap, the prompt knows) */
  fullMap: boolean;
  /** E / the lift button this frame: boards, rides and leaves a lift */
  interact: boolean;
  replay: ReplayShot | null;
}

/** the weather on screen and the new snow it has laid (FEAT-105), set by the settings and grown by the storm here */
export interface SkyState { weather: CloudCover; snowCover: number }

/** Everything the frame reads or drives, handed in by the session. */
export interface RideParts extends World {
  params: Params; settings: Settings; pack: Pack; renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement; audio: GameAudio; events: Events;
  rider: Rider; liftRide: LiftRide; prefetch: Prefetch; cam: ChaseCamera; controls: Controls; touch: TouchControls | null;
  goggles: GoggleView; lens: GoggleLens; runStats: RunStats; runCard: RunCard; speedLines: SpeedLines; replay: Replay;
  /** FEAT-164: Free ride, Time trial, Outrun */
  modes: Modes; map: ResortMap; labels: Labels; sun: SunClock;
  auto: AutoQuality; keyLabels: KeyLabels; pressMeter: PressMeter; fps: FpsMeter; sky: SkyState;
  /** mouse movement to hand to the cameras this frame (px); the right stick and the gyro add to it */
  look: { dx: number; dy: number };
  /** re-apply what the adaptive quality level scales */
  applyAuto(): void;
  /** the main render (with the first-person body pass and the lens) */
  draw(): void;
  showToast(text: string, ms?: number): void;
  saveShot(png: string, jpg: string): void;
}

/**
 * FEAT-162: one frame of the resort under any state that shows it (riding, the map, the replay viewer, the
 * rewind, the main menu), in the update order written down in docs/developer-guide.md. The state reads its
 * own keys first and says, through its FramePlan, who moves the rider; everything else runs the same.
 */
export class RideFrame {
  /** this frame's input (read before the state's update) */
  input!: Input;
  /** P (the eye camera, the replay viewer): save the canvas after this frame's render */
  shotPending = false;
  /** FEAT-124: one-time note above the key hints for players with their own keys */
  boardNote = '';
  private boardNoteT = 25;
  private boardMsg = '';
  private boardMsgT = 0;
  private elapsed = 0;
  private lensWorn: LensId | null = null;
  private promptShown = '';
  private helpShown = '';
  private helpT = 0;
  private dt = 0;
  // this frame, shared by the steps
  private onLift = false;
  private detached = false;
  private fx = 0;
  private fy = 0;
  private liftTop: [number, number, number] | null = null;
  private readonly chairPos = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly pressHead = new THREE.Vector3();
  /** FEAT-164: one reused frame for modes.update (a mutable ModeFrame), so the frame allocates nothing */
  private readonly modeFrame: { -readonly [K in keyof ModeFrame]: ModeFrame[K] } = { dt: 0, tuck: false, onLift: false, frozen: false, elapsed: 0 };
  private readonly hud = document.getElementById('hud')!;
  private readonly prompt = document.getElementById('prompt')!;
  private readonly helpEl = document.getElementById('help');

  constructor(private readonly p: RideParts) {}

  /** Start of every frame, paused or not: the devices, and the right stick and gyro into the mouse look. */
  readInput(dt: number): void {
    const { controls, rider, look } = this.p;
    // FEAT-140: on the snow on the board, W / S and the stick balance a held press instead of tucking and braking
    controls.balancing = rider.pressMode !== 'off' && rider.discipline === 'board' && (rider.onGround || rider.pressing) && !rider.unstrapped && rider.crashed <= 0;
    this.input = controls.update(dt);
    // FEAT-124: the gamepad's right stick looks around like the mouse: a rate (px/s at full deflection),
    // added before the cameras consume the look so it lands this frame, not the next
    if (controls.padLookX || controls.padLookY) { look.dx += controls.padLookX * 840 * dt; look.dy += controls.padLookY * 600 * dt; }
    look.dx += controls.gyroDx; look.dy += controls.gyroDy; // FEAT-137: DualSense gyro look (0 unless on)
  }

  /** a short message in the prompt (strap in or out refused) */
  say(msg: string): void { this.boardMsg = msg; this.boardMsgT = msg ? 1.5 : 0; }

  /** Everything but the render, in order. */
  update(dt: number, stepped: boolean, plan: FramePlan): void {
    const { params, settings, auto, touch, cam } = this.p;
    this.dt = dt;
    // 1. FEAT-062: feed the frame time; a level change re-applies the scaled settings
    if (!params.headless && !stepped && auto.frame(dt, settings.autoQuality ? (settings.targetFps || 60) : 0)) this.p.applyAuto();
    touch?.setVisible(plan.touch);
    this.elapsed += dt;
    this.boardMsgT -= dt;
    // the rider stands still while the camera is detached (free fly, eye)
    this.detached = cam.mode === 'free' || cam.mode === 'eye';
    const eyeMode = cam.mode === 'eye';
    this.photoMode(eyeMode, plan);
    const runs = this.simulate(dt, plan);
    this.syncView(dt, runs);
    // 7. FEAT-164: the modes (Outrun's chase and eat, the trial gates) and their HUDs
    const mf = this.modeFrame;
    mf.dt = dt; mf.tuck = this.input.tuck; mf.onLift = this.onLift; mf.frozen = !runs.trial; mf.elapsed = this.elapsed;
    this.p.modes.update(mf);
    this.p.audio.update(this.p.rider, this.input.tuck, this.onLift, dt, this.p.liftRide.passedTower);
    this.p.rider.lastHit = '';
    this.cameras(dt, eyeMode, plan, runs);
    this.skyAndEffects(dt);
    this.streaming(dt);
    this.hudAndMap(dt, plan);
  }

  /** The render, then the frame closed: the P-key shot, the input frame, the replayed pose undone, the frame rate, the HUD line. */
  draw(): void {
    const { canvas, controls, replay, rider, fps, settings, runStats, terrain, veg, cam, auto, params } = this.p;
    this.p.draw();
    // the drawing buffer is only readable in the same task as the render
    if (this.shotPending) { this.shotPending = false; this.p.saveShot(canvas.toDataURL('image/png'), canvas.toDataURL('image/jpeg', 0.9)); }
    controls.endFrame();
    replay.restore(rider); // FEAT-043: the sim state back under the replayed pose
    fps.tick(this.dt);
    this.hud.innerHTML = hudLine({
      rider, runStats, metric: settings.units === 'metric', fps: fps.fps, chunks: terrain.stats.chunks, triangles: terrain.stats.triangles, trees: veg.stats.instances,
      camMode: cam.mode, auto: auto.level ? auto.describe() : '', debug: params.debugHud,
    });
  }

  /** the session is over: the prompt and the HUD line cleared */
  clear(): void { this.showPrompt(''); this.hud.innerHTML = ''; }

  private showPrompt(html: string): void { if (html !== this.promptShown) { this.promptShown = html; this.prompt.innerHTML = html; this.prompt.classList.toggle('show', html !== ''); } }

  /** the eye camera is for photos: no rider, spray, lift markers or piste lines (and no HUD, nor in a clean replay shot) */
  private photoMode(eyeMode: boolean, plan: FramePlan): void {
    const { riderView, eat, lifts, runs } = this.p;
    document.body.classList.toggle('eye-mode', eyeMode || !!plan.replay?.clean);
    if (!eat.active) riderView.group.visible = !eyeMode;
    riderView.sprayObject.visible = !eyeMode;
    // lift markers and piste lines are game UI, not in a photo
    lifts.markers.visible = !eyeMode; if (eyeMode) runs.group.visible = false;
  }

  /** 5. Simulation on the sim pose: lift ride, the rider (its own 1/120 s fixed steps), replay recording, run stats, rumble. */
  private simulate(dt: number, plan: FramePlan): Runs {
    const { rider, modes, liftRide, replay, runStats, runCard, controls, riderView } = this.p;
    const input = this.input, detached = this.detached;
    rider.boost = modes.boosting;
    const runs = RUNS[modes.holdsRider ? 'eaten' : plan.drive];
    const onLift = this.onLift = !detached && runs.lift && liftRide.update(rider, dt, plan.interact, input.tuck);
    if (!detached && !onLift && runs.physics) rider.update(dt, input);
    if (!onLift && runs.record) replay.record(dt, rider, input.tuck); // FEAT-043 (not the still rider behind the menu)
    if (runs.stats && modes.countsRunStats) runStats.update(dt, rider, onLift); // FEAT-055
    runCard.update(dt);
    // FEAT-137: rumble (landings, crashes, rock, moguls), the DualSense lightbar and adaptive triggers
    padFx.update(dt, controls.pad, { rider, riding: runs.physics && !detached && !onLift && !rider.unstrapped, monsterDist: modes.monsterDist, lens: riderView.mats.goggles.color.getHex() });
    return runs;
  }

  /** 6. View sync on the render pose: rider view, tracks, prints, puffs. Then the sim pose comes back. */
  private syncView(dt: number, runs: Runs): void {
    const { rider, riderView, cam, tracks, bootprints, bigprints, puffs, liftRide } = this.p;
    const input = this.input, onLift = this.onLift;
    // visuals draw the pose interpolated between the last two 120 Hz physics steps; gameplay
    // (trials, lifts, audio) keeps reading the sim pose
    riderView.setFirstPerson(cam.firstPerson);
    rider.applyRenderPose();
    if (runs.pose) riderView.update(rider, dt, input.tuck, input.grab, onLift && liftRide.airborneRide);
    if (runs.tracks) tracks.update(rider, dt, onLift && liftRide.airborneRide);
    bootprints.update(dt); bigprints.update(dt); puffs.update(dt);
    rider.restoreSimPose();
  }

  /** 9. Cameras on the render pose, then lens, goggles, speed lines and the press meter through the final camera */
  private cameras(dt: number, eyeMode: boolean, plan: FramePlan, runs: Runs): void {
    const { rider, cam, controls, look, riderView, modes, settings, eat, goggles, lens, env, speedLines, pressMeter, liftRide } = this.p;
    const input = this.input, onLift = this.onLift, detached = this.detached;
    rider.applyRenderPose();
    if (cam.mode === 'free') { cam.updateFree(dt, controls.keys, look.dx, look.dy); look.dx = look.dy = 0; }
    else if (eyeMode) { cam.updateEye(dt, controls.keys, look.dx, look.dy); look.dx = look.dy = 0; }
    else if (cam.firstPerson) { cam.updateFirstPerson(rider, dt, input.tuck, onLift || controls.looking, look.dx, look.dy, riderView.eye(this.eye)); look.dx = look.dy = 0; }
    else if (plan.replay?.trackside) plan.replay.trackside();
    else { cam.freeLook(controls.looking, dt, look.dx, look.dy, controls.glancing); look.dx = look.dy = 0; cam.baseFov = settings.fov + modes.fovBoost + (plan.replay?.photoFov ?? 0); cam.update(rider, dt, input.tuck, onLift && liftRide.airborneRide); } // FEAT-124: look behind (G) in every mode
    modes.afterCamera(cam.camera); // the eat sequence owns the camera (FEAT-104); the chase sounds hear from it
    goggles.strength = settings.goggleStrength;
    {
      // FEAT-130: the lens follows the setting (Auto: the weather and the sun); the rider and the frame wear it
      const worn = resolveLens(settings.goggleLens, this.p.sky.weather, env.sunDir.y);
      if (worn !== this.lensWorn) { this.lensWorn = worn; riderView.setLens(worn); goggles.setLens(worn === 'off' ? null : LENSES[worn].swatch); }
      lens.lens = cam.mode === 'fp' && !eat.active ? worn : 'off';
      lens.strength = settings.lensStrength ?? 1;
    }
    cam.fpShake = settings.reduceMotion ? 0 : settings.fpShake ?? 0.3; // BUG-051
    goggles.update(rider, dt, cam.mode === 'fp', cam.mode === 'fp' && settings.fpVignette, onLift);
    // FEAT-045 speed feel toggles, and the speed lines (not on a lift, in free fly or the eat)
    cam.speedFov = settings.speedFov; cam.camShake = settings.camShake && !settings.reduceMotion; speedLines.enabled = settings.speedLines && !settings.reduceMotion; // FEAT-128: Reduce motion turns them off together
    speedLines.update(rider.speed, dt, runs.speedLines && !detached && !onLift && !eat.active && !rider.onFoot);
    rider.restoreSimPose();
    cam.camera.updateMatrixWorld();
    // FEAT-140: the press meter just above the head (low in the middle of the view in first person)
    {
      const on = rider.pressing && !plan.replay && !detached && !eat.active;
      let px = -999, py = -999;
      if (on && cam.firstPerson) { px = window.innerWidth * 0.5; py = window.innerHeight * 0.78; }
      else if (on || pressMeter.root.style.opacity !== '0') {
        riderView.eye(this.pressHead); this.pressHead.y += 0.4; this.pressHead.project(cam.camera);
        if (this.pressHead.z < 1) { px = (this.pressHead.x + 1) / 2 * window.innerWidth; py = (1 - this.pressHead.y) / 2 * window.innerHeight; }
      }
      pressMeter.update(on && px > -999, rider.pressBalance, rider.pressDir, px, py);
    }
  }

  /** 10. Sky and effects from the camera: shadows, clouds, snowfall, particle light, tree fade, the deformation stamp */
  private skyAndEffects(dt: number): void {
    const { env, clouds, renderer, cam, snow, particleLight, pack, rider, riderView, puffs, veg, treeFade, settings, eat, terrain, deform } = this.p;
    env.updateCSM();
    clouds.render(renderer, cam.camera, dt, env.sunDir, env.sun.color, env.sun.intensity, env.hemi.color, env.hemi.intensity, env.atmo.hazeLinear);
    env.followCamera(cam.camera.position);
    snow.update(dt, cam.camera, renderer.domElement.height, 0.45 + 0.6 * env.hemi.intensity / 1.4);
    // BUG-046: spray and puffs are unlit points; give them the light flat snow gets at the rider (dark at dusk, darker in a ridge's shade)
    const pl = particleLight.update(dt, env, (x, y) => pack.terrainHeight(x, y), rider.x, rider.y, rider.z);
    riderView.spray.setLight(pl); riderView.spray.setViewHeight(renderer.domElement.height); riderView.spray.wind.set(snow.wind.x * 0.3, snow.wind.y * 0.3);
    (puffs.points.material as THREE.PointsMaterial).color.copy(pl);
    veg.setLight(env.sunDir, env.sun.color, env.sun.intensity, env.hemi.color, env.hemi.groundColor, env.hemi.intensity);
    // FEAT-155: trees in the way of the view downhill go see-through (third-person cameras only)
    treeFade.update(cam.camera, rider, (x, y) => pack.groundHeight(x, y), dt, settings.seeThroughTrees !== false && !this.detached && !cam.firstPerson && !eat.active);
    terrain.setSun(env.sunDir); // BUG-062: the mogul colouring's sun term
    // FEAT-044: stamp the tracks and prints near the rider into the deformation texture (the soft sag around them)
    { const h = riderView.powderHold; setDeformHold(h.x, h.z, h.fx, h.fz, riderView.group.visible && !eat.active ? h.k : 0); } // FEAT-152: the snow wall ahead of a board buried in powder
    deform.update(renderer, rider.x, rider.z, -rider.y, rider.vx, -rider.vy);
  }

  /** 11. Streaming around the rider (or the camera when detached), the snow on the ground, lifts and landmarks, the live sun */
  private streaming(dt: number): void {
    const { cam, terrain, rider, liftRide, prefetch, pack, veg, rocks, sky, snow, settings, sun, params, zr, resortTop, roads, riderChair, lifts, bridges, liftLines, landmarks, map } = this.p;
    const onLift = this.onLift, detached = this.detached;
    const cp = cam.camera.position;
    terrain.update(cp.x, -cp.z, cp.y);
    const fx = this.fx = detached ? cp.x : rider.x, fy = this.fy = detached ? -cp.z : rider.y;
    // terrain, mask and instance tiles stream ahead along the direction of travel
    const liftTop = this.liftTop = onLift && liftRide.lift ? liftRide.lift.top : null;
    prefetch.update(pack, fx, fy, dt, liftTop);
    veg.update(fx, fy, prefetch.ax, prefetch.ay, cp);
    rocks.update(fx, fy, prefetch.ax, prefetch.ay);
    if (sky.weather === 'storm') sky.snowCover = Math.min(1, sky.snowCover + dt / 600);
    else if (sky.weather === 'flurries') sky.snowCover = Math.min(1, sky.snowCover + dt / 3000);
    const snowCover = sky.snowCover;
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
      sw.hour = hour; sw.storm = sky.weather === 'storm' ? 1 : sky.weather === 'flurries' ? 0.3 : 0; sw.newSnow = snowCover; sw.day = settings.snowDay ?? 'mid';
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
    lifts.update(this.elapsed, carried ? this.chairPos.set(rider.x, rider.z, -rider.y) : null);
    lifts.maintain(dt, rider.x, rider.y);
    bridges.maintain(dt, rider.x, rider.y);
    liftLines.maintain(rider.x, rider.y);
    const passed = landmarks.maintain(rider.x, rider.y);
    if (passed) this.p.events.emit({ type: 'landmark', name: passed.name });
    sun.update(dt, settings);
    lifts.updateMarkers(this.elapsed, rider.x, rider.y, liftRide.canBoard ? liftRide.nearby : null);
    map.liftMarker = liftRide.nearby ? [liftRide.nearby.bottom[0], liftRide.nearby.bottom[1]] : null;
  }

  /** 12. Prompt and key hints, the sky's follow, tile eviction, the map, horizon labels */
  private hudAndMap(dt: number, plan: FramePlan): void {
    const { keyLabels, liftRide, lifts, rider, controls, settings, cam, modes, env, pack, terrain, map, labels, fps } = this.p;
    const onLift = this.onLift, detached = this.detached, fx = this.fx, fy = this.fy;
    this.showPrompt(contextPrompt(keyLabels, {
      onLift, liftRide, lifts, mapOpen: plan.fullMap, detached, rider, boardMsg: this.boardMsgT > 0 ? this.boardMsg : '', usingPad: controls.usingPad, metric: settings.units === 'metric',
    }));
    // FEAT-124: only the keys that matter right now (the full list is in Settings > Controls)
    this.helpT -= dt;
    if (this.boardNote && (this.boardNoteT -= dt) <= 0) this.boardNote = '';
    cam.glance = controls.glancing;
    if (this.helpEl && this.helpT <= 0) {
      this.helpT = 0.25;
      let h = keyHints(keyLabels, controls.usingPad, { onLift: liftRide.riding, outrunRunning: modes.outrun.running, onFoot: rider.onFoot, onGround: rider.onGround, liftNearby: !!liftRide.nearby });
      if (this.boardNote) h = `<b>${this.boardNote}</b><br>` + h;
      if (h !== this.helpShown) { this.helpShown = h; this.helpEl.innerHTML = h; }
    }
    const cp = cam.camera.position;
    env.update(fx, detached ? cp.y : rider.z, -fy);
    if (pack.fine && terrain.stats.builds === 0) pack.fine.evictBeyond(fx, fy, 3000, this.liftTop);
    map.riderPos = [rider.x, rider.y, rider.z];
    if (plan.fullMap) { if (fps.n % 10 === 0) map.drawFull(); }
    else if (fps.n % 3 === 0) map.drawMini(rider.x, rider.y, rider.heading);
    labels.update(cam.camera, settings.units === 'metric');
  }
}
