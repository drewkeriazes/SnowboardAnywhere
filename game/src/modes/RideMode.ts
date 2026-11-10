import type { PauseMode } from '../ui/PauseMenu';
import type { Rider } from '../sim/Rider';
import type { LiftRide } from '../sim/LiftRide';
import type { ChaseCamera } from '../world/ChaseCamera';
import type { ResortMap } from '../ui/ResortMap';
import type { KeyLabels } from '../ui/KeyLabels';

/**
 * FEAT-164: a mode on top of riding (FEAT-160 standard 4): Free ride, Time trial, Outrun.
 * The riding loop calls `update` then `hud` on each mode once a frame, in the order `Modes` lists them.
 */
export interface RideMode {
  readonly kind: PauseMode['kind'];
  start(arg?: string): void;
  /** the mode's sim and world (gates, monsters, the eat), after the rider view is synced */
  update(f: RideFrame): void;
  /** the mode's HUD, right after its update */
  hud(f: RideFrame): void;
  end(): void;
  dispose(): void;
}

/** What a mode reads from the riding frame. */
export interface RideFrame {
  readonly dt: number;
  readonly tuck: boolean;
  readonly onLift: boolean;
  /** the replay viewer is open or the rider is rewinding: the sim is held */
  readonly frozen: boolean;
  /** riding seconds this session (the trial route's pulse runs on it) */
  readonly elapsed: number;
}

/** The session's riding pieces the modes use. */
export interface RideDeps {
  readonly rider: Rider;
  readonly liftRide: LiftRide;
  readonly cam: ChaseCamera;
  readonly map: ResortMap;
  readonly keyLabels: KeyLabels;
  readonly toast: (text: string, ms?: number) => void;
  /** the map's drop-in handler (off while Outrun runs) */
  readonly pick: (x: number, y: number) => void;
  /** off any lift and back at the spawn point, the camera snapped (Outrun's Retry) */
  readonly toSpawn: () => void;
}
