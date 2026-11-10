import type { Rider } from '../sim/Rider';
import type { Pack } from '../pack/Pack';
import type { ChaseCamera } from '../world/ChaseCamera';
import type { Lifts } from '../world/Lifts';
import type { GameState, GameStates } from './GameState';

export interface LoadingParts {
  pack: Pack; rider: Rider; lifts: Lifts; cam: ChaseCamera;
  /** where the ride starts */
  spawn(): { x: number; y: number; h: number };
  /** the first state once the rider is on the snow: the main menu, or riding (no menu, or an eye link) */
  first: 'attract' | 'riding';
  /** compile and stream the view behind the loading screen or the menu (BUG-063), or null (headless) */
  warmUp: (() => Promise<void>) | null;
  /** false once the session is torn down */
  alive(): boolean;
  /** everything is ready: start the frame loop */
  ready(): void;
}

/**
 * FEAT-162: loading. Waits (8 s at most) for the fine tiles under the start, puts the rider there, moves to
 * the first state (whose camera the warm-up compiles for), warms up, then starts the loop. No frame runs
 * while loading: the loop starts at the end of it.
 */
export class LoadingState implements GameState {
  readonly name = 'loading';

  constructor(private readonly p: LoadingParts, private readonly states: GameStates) {}

  enter(): void { void this.load(); }
  exit(): void { /* nothing held */ }
  update(): void { /* the loop isn't running yet */ }
  render(): void { /* nor drawing */ }

  private async load(): Promise<void> {
    const { pack, rider, lifts, cam } = this.p;
    const t0 = performance.now();
    while (Number.isNaN(pack.fine?.sample(this.p.spawn().x, this.p.spawn().y) ?? 0) && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
    const s = this.p.spawn();
    rider.reset(s.x, s.y, s.h);
    lifts.buildMarkers(pack);
    cam.snapTo(rider);
    this.states.go(this.p.first);
    if (this.p.warmUp && this.p.alive()) await this.p.warmUp();
    if (!this.p.alive()) return;
    this.p.ready();
  }
}
