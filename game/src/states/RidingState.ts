import { saveSettings, type Settings } from '../ui/Settings';
import type { Controls } from '../sim/Controls';
import type { Rider } from '../sim/Rider';
import type { LiftRide } from '../sim/LiftRide';
import type { LiftRuntime } from '../world/Lifts';
import type { ChaseCamera } from '../world/ChaseCamera';
import type { RunsOverlay } from '../world/RunsOverlay';
import type { ResortMap } from '../ui/ResortMap';
import type { TouchControls } from '../ui/TouchControls';
import type { RestartRing } from '../ui/RestartRing';
import type { GameAudio } from '../audio/Audio';
import type { Modes } from '../modes/Modes';
import type { FramePlan, RideFrame } from './RideFrame';
import { backPressed, type GameState, type GameStates } from './GameState';

/** FEAT-124: how long restart is held (s) */
const RESTART_HOLD = 0.6;

export interface RidingParts {
  controls: Controls; touch: TouchControls | null; cam: ChaseCamera; settings: Settings; rider: Rider; liftRide: LiftRide<LiftRuntime>;
  modes: Modes; runs: RunsOverlay; audio: GameAudio; map: ResortMap; frame: RideFrame;
  /** FEAT-124: the restart hold's fill ring (the session owns it and disposes it) */
  ring: RestartRing;
  /** FEAT-181 (?debug): ask for the menu shot's labels and save the eye camera's view as the resort's menu shot */
  menuShot: (() => void) | null;
  /** why the replay viewer can't open now, or null */
  replayBlockedReason(): string | null;
  /** the rewind is held and allowed */
  rewindWanted(): boolean;
  /** back to the spawn point: Outrun and the trial end, the run's stats close */
  restartRun(): void;
}

/** FEAT-162: riding. All the riding keys, then the frame with the physics moving the rider. */
export class RidingState implements GameState {
  readonly name = 'riding';
  private restartHold = 0;
  private restartDone = false;
  private readonly plan: FramePlan = { drive: 'ride', touch: true, fullMap: false, interact: false, replay: null };

  constructor(private readonly p: RidingParts, private readonly states: GameStates) {}

  enter(): void { /* the states that hand back to riding put everything back on their way out */ }

  /** the restart hold counts only while riding */
  exit(): void { this.restartHold = 0; this.restartDone = false; this.p.ring.update(null); }

  update(dt: number, stepped: boolean): void {
    const { controls, touch, cam, settings, rider, liftRide, modes, runs, audio, map, frame } = this.p;
    if (backPressed(controls, touch)) { this.states.go('paused'); return; }
    // FEAT-124: restart needs a 0.6 s hold (a fill ring), so a stray tap next to E or W doesn't reset the run
    if (controls.held('restart')) {
      this.restartHold += dt;
      if (this.restartHold >= RESTART_HOLD && !this.restartDone) { this.restartDone = true; this.p.restartRun(); }
    } else { this.restartHold = 0; this.restartDone = false; }
    controls.action('restart'); // the press itself does nothing
    this.p.ring.update(this.restartHold > 0.05 && !this.restartDone ? Math.min(1, this.restartHold / RESTART_HOLD) : null);
    if (controls.action('trial')) modes.trialKey();
    // FEAT-043: the replay viewer (K) and the practice rewind (hold) freeze the sim; each is its own state
    if (controls.action('replay') && !this.p.replayBlockedReason()) { this.states.go('replay'); return; }
    if (this.p.rewindWanted()) { this.states.go('rewind'); return; }
    if (controls.action('camera') || touch?.once('camera')) {
      cam.cycle();
      // FEAT-128: the camera you cycle to is the one you come back to (and the pause menu's Camera row shows it)
      if (cam.mode !== 'free' && cam.mode !== 'eye' && cam.mode !== settings.camera) { settings.camera = cam.mode; saveSettings(settings); }
    }
    // the map's state follows the map (ResortMap.onOpenChange) and takes the rest of this frame
    if (controls.action('map') || touch?.once('map')) { map.open(); return; }
    if (controls.action('piste')) {
      // the eye camera: P saves a compare shot; Shift+P (FEAT-181, ?debug) makes the view the resort's menu shot
      const shift = controls.keys.has('ShiftLeft') || controls.keys.has('ShiftRight');
      if (cam.mode === 'eye') { if (shift && this.p.menuShot) this.p.menuShot(); else frame.shotPending = true; } else runs.toggle();
    }
    if (controls.action('track')) audio.nextTrack();
    if (controls.action('fly')) { cam.mode = cam.mode === 'free' ? settings.camera : 'free'; if (cam.mode === 'free') cam.enterFree(); }
    // board on / off: unstrap when nearly stopped, strap in standing still. FEAT-124: E (interact)
    // straps in or out when there is no lift near; the separate strap key is optional
    const detached = cam.mode === 'free' || cam.mode === 'eye';
    const interact = controls.action('lift') || !!touch?.once('lift');
    const strapAsk = controls.action('board') || !!touch?.once('board') || (interact && !liftRide.riding && !liftRide.nearby);
    if (strapAsk && !detached && !liftRide.riding) {
      const why = rider.toggleBoard();
      if (why === '' && rider.strapState === 'off') modes.interrupt('Unstrapped');
      frame.say(why === 'fast' ? 'slow down to unstrap' : why === 'moving' ? 'stand still to strap in' : why === 'air' ? 'land first' : '');
    }
    // Outrun: no lift skip while it runs (the monster is on the towers behind you), the boost key
    this.plan.interact = interact && !detached && !(modes.liftSkipBlocked && liftRide.riding);
    modes.boostKey(controls.action('boost')); // FEAT-124: F, Outrun only
    frame.update(dt, stepped, this.plan);
  }

  render(): void { this.p.frame.draw(); }
}
