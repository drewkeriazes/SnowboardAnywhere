import type { Controls } from '../sim/Controls';
import type { Rider } from '../sim/Rider';
import type { LiftRide } from '../sim/LiftRide';
import type { Outrun } from '../sim/Outrun';
import type { Replay, ReplaySample } from '../sim/Replay';
import type { Pack } from '../pack/Pack';
import type { TouchControls } from '../ui/TouchControls';
import type { FramePlan, RideFrame } from './RideFrame';
import { backPressed, type GameState, type GameStates } from './GameState';

export interface RewindParts {
  controls: Controls; touch: TouchControls | null; rider: Rider; liftRide: LiftRide; outrun: Outrun; replay: Replay; pack: Pack; frame: RideFrame;
  /** back on the snow at a recorded moment; the recording carries on from there */
  rewindTo(s: ReplaySample): void;
}

/**
 * FEAT-043 / FEAT-162: the practice rewind. While it is held the rider scrubs back along the recording (the sim
 * is frozen); let go and the ride carries on from the last moment on the snow before there (not mid-air, not
 * crashed). Only the rewind key counts while it is held.
 */
export class RewindState implements GameState {
  readonly name = 'rewind';
  /** how far back (s) */
  private t = 0;
  private readonly plan: FramePlan = { drive: 'recording', touch: true, fullMap: false, interact: false, replay: null };

  constructor(private readonly p: RewindParts, private readonly states: GameStates) {}

  /** the rewind key is held, and there is a recording on the board to go back along */
  wanted(): boolean {
    const { controls, outrun, liftRide, replay, rider } = this.p;
    return controls.held('rewind') && !outrun.active && !liftRide.riding && replay.samples.length > 1 && rider.strapState === 'none';
  }

  enter(): void { this.t = 0; }
  exit(): void { this.t = 0; }

  update(dt: number, stepped: boolean): void {
    const { controls, touch, replay, rider, pack, frame } = this.p;
    // Esc lands where the rewind got to, then pauses
    if (backPressed(controls, touch)) { this.land(); this.states.go('paused'); return; }
    if (!this.wanted()) { this.land(); this.states.go('riding'); return; }
    this.t = Math.min(this.t + dt * 2, replay.t - replay.start);
    const s = replay.at(replay.t - this.t);
    if (s) replay.overlay(rider, s, pack);
    frame.update(dt, stepped, this.plan);
  }

  render(): void { this.p.frame.draw(); }

  private land(): void {
    const { replay, rider } = this.p;
    const g = replay.goodGround(replay.t - this.t);
    replay.restore(rider);
    if (g) this.p.rewindTo(g);
    this.t = 0;
  }
}
