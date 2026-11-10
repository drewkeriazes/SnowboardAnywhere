import type * as THREE from 'three';
import type { GameContext } from '../core/GameContext';
import type { Events } from '../core/Events';
import type { World } from '../session/World';
import type { Settings } from '../ui/Settings';
import type { PauseMode } from '../ui/PauseMenu';
import type { MenuChoice } from '../ui/MainMenu';
import { FreeRide } from './FreeRide';
import { TimeTrialMode } from './TimeTrialMode';
import { OutrunMode } from './OutrunMode';
import type { OutrunUI } from '../ui/OutrunUI';
import type { RideDeps, ModeFrame, RideMode } from './RideMode';

/**
 * FEAT-164: the modes on top of riding and the picks between them (pause > Mode, the main menu, Restart, Quit).
 * The world frame and the states ask the getters at the bottom instead of checking Outrun or trials themselves.
 * Outrun and the trial gates can be on together (the Time trials setting), so both modes update every frame.
 */
export class Modes {
  readonly free = new FreeRide();
  readonly trials: TimeTrialMode;
  readonly outrun: OutrunMode;
  /** the update order: Outrun's monsters move before the trial reads the gates */
  private readonly order: RideMode[];

  constructor(ctx: GameContext, world: World, private readonly d: RideDeps, outrunUI: OutrunUI) {
    const trials = this.trials = new TimeTrialMode(ctx, world, d);
    const outrun = this.outrun = new OutrunMode(ctx, world, d, outrunUI);
    outrun.onStart = () => trials.cancel('Outrun');
    this.order = [this.free, outrun, trials];
  }

  /** what pause > Mode shows */
  get current(): PauseMode {
    return this.outrun.on ? { kind: 'outrun' } : this.trials.course ? { kind: 'trial', course: this.trials.course } : { kind: 'free' };
  }

  // ---- picks
  /** pause > Mode > Free ride */
  freeRide(): void { if (this.outrun.on) this.outrun.end(); this.trials.end(); }
  /** pause > Mode > a course: gates on for the session, the rider above its start */
  rideCourse(id: string | undefined): void {
    const c = this.trials.find(id);
    if (!c) return;
    if (this.outrun.on) this.outrun.end();
    this.trials.start(c.id);
    this.trials.goTo(c);
  }
  /** pause > Mode > Start the chase */
  startOutrun(): void { this.trials.end(); this.outrun.start(); }
  /** the main menu's RIDE (or the map): a course puts the rider above its start gate for this ride */
  fromMenu(c: MenuChoice): void {
    const mode = c.mode;
    const course = mode.kind === 'trial' ? this.trials.find(mode.course) : undefined;
    this.trials.start(course ? course.id : '');
    if (course) this.trials.goTo(course);
    if (c.action === 'map') { this.d.map.open(); this.outrun.afterMap = mode.kind === 'outrun'; } // Outrun starts once the map has dropped you in (or closed)
    else if (mode.kind === 'outrun') this.outrun.start();
  }
  /** Restart: an Outrun ends, a trial run stops */
  restart(): void { if (this.outrun.on) this.outrun.end(); this.trials.cancel('Restarted'); }
  /** Quit to main menu: ends an Outrun or time trial */
  quit(): void {
    this.outrun.afterMap = false;
    if (this.outrun.on) this.outrun.end();
    this.trials.cancel('Quit'); this.trials.end();
  }
  /** the rider was moved or stopped riding (map pick, replay, rewind, unstrapped): a trial run stops */
  interrupt(why: string): void { this.trials.cancel(why); }
  /** the map has closed: a chase picked with it starts now */
  mapClosed(): void { this.outrun.startAfterMap(); }
  /** FEAT-163: the modes' own reactions to their news on the bus (called after the audio and the rumble listen) */
  listen(events: Events): void { this.outrun.listen(events); }

  // ---- the riding keys (states/RidingState.ts)
  /** the T key: to the nearest course start, while the gates are out and no Outrun runs */
  trialKey(): void { if (this.trials.on && !this.outrun.on) this.trials.toNearest(); }
  boostKey(pressed: boolean): void { this.outrun.boostKey(pressed); }

  // ---- the world frame (states/RideFrame.ts), in order
  /** after the rider view is synced: each mode's update, then its HUD */
  update(f: ModeFrame): void { for (const m of this.order) { m.update(f); m.hud(f); } }
  /** after the camera has moved */
  afterCamera(camera: THREE.PerspectiveCamera): void { this.outrun.afterCamera(camera); }
  applySettings(s: Settings, what: string): void { this.trials.applySettings(s, what); }

  // ---- what the frame and the states ask
  /** why the replay viewer can't open, or null */
  get replayBlocked(): string | null { return this.outrun.on ? 'not during Outrun' : null; }
  get rewindBlocked(): boolean { return this.outrun.on; }
  /** no lift skip while the chase runs (the monster is on the towers behind you) */
  get liftSkipBlocked(): boolean { return this.outrun.running; }
  /** the rider is held still (being eaten) */
  get holdsRider(): boolean { return this.outrun.sim.phase === 'caught'; }
  /** FEAT-055: run stats count outside Outrun only */
  get countsRunStats(): boolean { return !this.outrun.on; }
  /** the boost is on (the rider goes faster) */
  get boosting(): boolean { return this.outrun.sim.boosting; }
  /** degrees added to the field of view (the boost) */
  get fovBoost(): number { return this.outrun.sim.boosting ? 12 : 0; }
  /** metres to the nearest monster while the chase runs (pad rumble), else Infinity */
  get monsterDist(): number { return this.outrun.running ? this.outrun.sim.dist : Infinity; }

  dispose(): void { for (const m of this.order) m.dispose(); }
}
