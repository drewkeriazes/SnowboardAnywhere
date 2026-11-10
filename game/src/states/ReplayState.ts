import * as THREE from 'three';
import { PAD } from '../sim/Pad';
import type { Settings } from '../ui/Settings';
import type { Controls } from '../sim/Controls';
import type { Rider } from '../sim/Rider';
import type { Replay } from '../sim/Replay';
import type { Modes } from '../modes/Modes';
import type { Pack } from '../pack/Pack';
import type { ChaseCamera } from '../world/ChaseCamera';
import type { ReplayBar } from '../ui/ReplayBar';
import type { TouchControls } from '../ui/TouchControls';
import type { GameAudio } from '../audio/Audio';
import type { FramePlan, ReplayShot, RideFrame } from './RideFrame';
import { backPressed, type GameState, type GameStates } from './GameState';

const REPLAY_SPEEDS = [0.25, 0.5, 1, 2];

export interface ReplayParts {
  controls: Controls; touch: TouchControls | null; rider: Rider; replay: Replay; replayBar: ReplayBar; pack: Pack; cam: ChaseCamera;
  settings: Settings; modes: Modes; audio: GameAudio; frame: RideFrame; debugHud: boolean;
  /** the sun for a settings object (the replay viewer's own hour) */
  applySun(s: Settings): void;
  replayBlockedReason(): string | null;
  /** ?debug: save the span marked with I and O as a take for the main menu's ghosts */
  saveTake(takeIn: number | null, takeOut: number | null): void;
}

/**
 * FEAT-043 / FEAT-162: the replay viewer (K). The sim is frozen and the recording plays on the rider; the
 * viewer has the keys (Space play, arrows scrub and speed, C camera, H clean, P photo, - = zoom, , . hour).
 */
export class ReplayState implements GameState {
  readonly name = 'replay';
  private t = 0;
  private play = true;
  private speed = 1;
  private clean = false;
  private photoFov = 0;
  private hour = 12;
  private camMode: 'follow' | 'trackside' | 'free' = 'follow';
  private readonly trackPos = new THREE.Vector3();
  private trackSet = false;
  // the recording tool (?debug): I / O mark a span, L saves it as a take
  private takeIn: number | null = null;
  private takeOut: number | null = null;
  private readonly shot: ReplayShot = { clean: false, photoFov: 0, trackside: null };
  private readonly plan: FramePlan = { drive: 'recording', touch: true, fullMap: false, interact: false, replay: this.shot };

  constructor(private readonly p: ReplayParts, private readonly states: GameStates) {}

  enter(): void {
    const { replay, settings, modes } = this.p;
    this.t = Math.max(replay.start, replay.end - 30); this.play = true; this.speed = 1; this.camMode = 'follow'; this.trackSet = false; this.photoFov = 0;
    this.hour = typeof settings.timeOfDay === 'number' ? settings.timeOfDay : 12;
    modes.interrupt('Replay');
  }

  exit(): void {
    const { replayBar, cam, settings } = this.p;
    this.clean = false; replayBar.hide();
    if (cam.mode === 'free') cam.mode = settings.camera;
    this.p.applySun(settings);
  }

  update(dt: number, stepped: boolean): void {
    const { controls, touch, rider, replay, replayBar, pack, cam, settings, audio, frame, debugHud } = this.p;
    if (backPressed(controls, touch) || (controls.action('replay') && !this.p.replayBlockedReason()) || controls.padOnce(PAD.B)) { this.states.go('riding'); return; }
    const k = controls.keys;
    // FEAT-137 on a controller: Cross play, D-pad left / right scrub, R1 / L1 speed, Triangle camera, Square hide, Circle close
    const po = (b: number) => controls.padOnce(b);
    if (controls.once('Space') || po(PAD.A)) { if (this.t >= replay.end - 0.01) this.t = replay.start; this.play = !this.play; }
    const si = REPLAY_SPEEDS.indexOf(this.speed);
    if (controls.once('ArrowUp') || po(PAD.RB)) this.speed = REPLAY_SPEEDS[Math.min(REPLAY_SPEEDS.length - 1, si + 1)];
    if (controls.once('ArrowDown') || po(PAD.LB)) this.speed = REPLAY_SPEEDS[Math.max(0, si - 1)];
    const scrub = (k.has('ArrowRight') || controls.padHeld(PAD.RIGHT) ? 1 : 0) - (k.has('ArrowLeft') || controls.padHeld(PAD.LEFT) ? 1 : 0);
    if (scrub) this.t += scrub * 5 * dt; else if (this.play) this.t += dt * this.speed;
    if (this.t >= replay.end) { this.t = replay.end; this.play = false; }
    if (this.t < replay.start) this.t = replay.start;
    if (controls.once('KeyC') || po(PAD.Y)) {
      this.camMode = this.camMode === 'follow' ? 'trackside' : this.camMode === 'trackside' ? 'free' : 'follow'; this.trackSet = false;
      if (this.camMode === 'free') cam.enterFree(); else cam.mode = settings.camera;
    }
    if (controls.once('KeyH') || po(PAD.X)) this.clean = !this.clean;
    if (controls.once('KeyP')) frame.shotPending = true;
    if (controls.once('Minus')) this.photoFov = Math.max(-35, this.photoFov - 5);
    if (controls.once('Equal')) this.photoFov = Math.min(35, this.photoFov + 5);
    if (controls.once('Comma') || controls.once('Period')) {
      this.hour = Math.max(6, Math.min(20, this.hour + (controls.keys.has('Period') ? 0.5 : -0.5)));
      this.p.applySun({ ...settings, timeOfDay: this.hour });
    }
    // FEAT-128 (?debug): mark a span with I and O and save it with L as a take for the main menu's ghosts
    if (debugHud) {
      if (controls.once('KeyI')) this.takeIn = this.t;
      if (controls.once('KeyO')) this.takeOut = this.t;
      if (controls.once('KeyL')) this.p.saveTake(this.takeIn, this.takeOut);
    }
    const s = replay.at(this.t);
    if (s) replay.overlay(rider, s, pack);
    const span = Math.max(0.01, replay.end - replay.start);
    replayBar.draw({
      playing: this.play, speed: this.speed, at: this.t - replay.start, span, cam: this.camMode, hour: this.hour, usingPad: controls.usingPad,
      take: debugHud ? { in: this.takeIn === null ? null : this.takeIn - replay.start, out: this.takeOut === null ? null : this.takeOut - replay.start } : null,
    }, this.clean);
    if (controls.action('track')) audio.nextTrack();
    this.shot.clean = this.clean; this.shot.photoFov = this.photoFov; this.shot.trackside = this.camMode === 'trackside' ? this.trackside : null;
    frame.update(dt, stepped, this.plan);
  }

  render(): void { this.p.frame.draw(); }

  /** FEAT-043: a fixed camera beside the line, moved on ahead once the rider is past it (on the render pose) */
  private readonly trackside = (): void => {
    const { rider, pack, cam, settings } = this.p;
    const sp = Math.hypot(rider.vx, rider.vy) || 1, ux = rider.vx / sp, uy = rider.vy / sp;
    if (!this.trackSet || Math.hypot(this.trackPos.x - rider.x, -this.trackPos.z - rider.y) > 45) {
      const tx = rider.x + ux * 25 - uy * 10, ty = rider.y + uy * 25 + ux * 10;
      this.trackPos.set(tx, pack.groundHeight(tx, ty) + 1.6, -ty); this.trackSet = true;
    }
    cam.camera.position.copy(this.trackPos); cam.camera.lookAt(rider.x, rider.z + 1, -rider.y);
    cam.camera.fov = Math.max(15, settings.fov - 25 + this.photoFov); cam.camera.updateProjectionMatrix();
  };
}
