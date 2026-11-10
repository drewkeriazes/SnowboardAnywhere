import { padFx } from '../sim/PadFeedback';
import type { Controls } from '../sim/Controls';
import type { PauseMenu, PauseInfo } from '../ui/PauseMenu';
import type { TouchControls } from '../ui/TouchControls';
import type { GameAudio } from '../audio/Audio';
import type { FpsMeter } from '../core/FpsMeter';
import { backPressed, type GameState, type GameStates } from './GameState';

export interface PausedParts {
  controls: Controls; touch: TouchControls | null; pause: PauseMenu; audio: GameAudio; fps: FpsMeter;
  /** what the pause menu shows (read when it opens) */
  pauseInfo(): PauseInfo;
  /** the main render */
  draw(): void;
}

/**
 * FEAT-162: the pause menu over the still world. Nothing ticks; the frame only renders (and counts the frame
 * rate, which Settings shows live over the paused game). Esc resumes; the menu's own actions are the
 * session's pause.onAction.
 */
export class PausedState implements GameState {
  readonly name = 'paused';
  private dt = 0;

  constructor(private readonly p: PausedParts, private readonly states: GameStates) {}

  enter(): void {
    const { controls, pause, audio } = this.p;
    controls.guardLeave = false; // FEAT-111: no leave prompt from the pause menu
    pause.show(this.p.pauseInfo());
    audio.setDuck(0.3);
  }

  exit(): void {
    const { controls, pause, audio } = this.p;
    controls.guardLeave = true;
    pause.hide(); controls.padMute();
    audio.setDuck(1);
  }

  update(dt: number): void {
    this.dt = dt;
    if (backPressed(this.p.controls, this.p.touch)) { this.states.go('riding'); return; }
    padFx.idle(this.p.controls.pad);
  }

  render(): void {
    const { controls, touch, fps } = this.p;
    controls.endFrame(); touch?.pressed.clear();
    this.p.draw();
    fps.tick(this.dt); // FEAT-128: Settings shows the live frame rate over the paused game
  }
}
