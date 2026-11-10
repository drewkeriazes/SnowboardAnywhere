import type { State, StateMachine } from '../core/StateMachine';
import type { Controls } from '../sim/Controls';
import type { TouchControls } from '../ui/TouchControls';

/**
 * FEAT-162: the session's states. `loading` until the start area has streamed in; `attract` is the main menu
 * over the live resort; `riding`; `rewind` while the rewind is held; `paused` (the pause menu); `replay` (the
 * replay viewer, K); `map` (the full resort map, M).
 */
export type GameStateName = 'loading' | 'attract' | 'riding' | 'rewind' | 'paused' | 'replay' | 'map';
export type GameState = State<GameStateName>;
export type GameStates = StateMachine<GameStateName>;

/** Esc, a controller's pause buttons (Controls turns them into Esc) or the touch pause button, consumed */
export const backPressed = (controls: Controls, touch: TouchControls | null): boolean => controls.once('Escape') || !!touch?.once('pause');
