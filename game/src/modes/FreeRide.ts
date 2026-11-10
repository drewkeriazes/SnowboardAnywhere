import type { RideMode } from './RideMode';

/** FEAT-164: riding with no mode on top: nothing to start, run or show (the Time trials setting can still put gates out). */
export class FreeRide implements RideMode {
  readonly kind = 'free' as const;
  start(): void { /* nothing to set up */ }
  update(): void { /* nothing to run */ }
  hud(): void { /* nothing to show */ }
  end(): void { /* nothing to undo */ }
  dispose(): void { /* nothing held */ }
}
