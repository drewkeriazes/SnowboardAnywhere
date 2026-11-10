/** FEAT-165: the rider's input and state types (split from sim/Rider.ts, which re-exports them) */

export interface Input {
  steer: number; // -1 left .. +1 right
  tuck: boolean;
  brake: boolean;
  jumpHeld: boolean;
  jumpReleased: boolean;
  grab: boolean;
  /** Left Ctrl held: deep squat (FEAT-111) */
  squat?: boolean;
  /** hold to skate on the flat with the back foot out (FEAT-085) */
  skate?: boolean;
  /** FEAT-112: -1 lean back (nose up, ollie) .. +1 lean forward (tail up, nollie) */
  lean?: number;
  /** FEAT-140: weight forward (+1, W or the stick up) or back (-1) to balance a press; Controls sends W / S here instead of tuck / brake while a press key is held on the snow */
  balance?: number;
}

export interface SurfaceInfo {
  rock: number;
  scree: number;
  groomed: number;
  canopy: number;
  /** FEAT-059: mogul amplitude under the rider, metres (0 off the bump fields) */
  moguls: number;
  /** FEAT-159: 0..1 brush the board is riding through (willow, juniper, sagebrush, oak, small conifers above the snow) */
  shrub: number;
}

export type Discipline = 'board' | 'ski';

/** FEAT-140: how a held press ends: let go (or left the snow), dropped flat (under-pressed), slammed or stalled (over-pressed) */
export type PressEnd = 'clean' | 'flat' | 'slam' | 'stall';
/** FEAT-140: Settings > Game > Press balance */
export type PressMode = 'on' | 'easy' | 'hard' | 'off';
