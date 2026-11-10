import type { GameContext } from '../core/GameContext';
import type { World } from '../session/World';
import type { Course } from '../sim/Courses';
import type { Settings } from '../ui/Settings';
import { TimeTrial } from '../sim/TimeTrial';
import { TrialHud } from '../ui/TrialHud';
import { padFx } from '../sim/PadFeedback';
import type { RideDeps, RideFrame, RideMode } from './RideMode';

/** A course as the menus list it, with the best time saved for it. */
export interface CourseEntry { id: string; name: string; length: number; best: number | null }

/**
 * FEAT-164: time trials as a mode: the run through the gates (sim/TimeTrial), the gates and route in the
 * world, the HUD, and the course picked in Mode. The gates are out while the Time trials setting is on or a
 * course is picked.
 */
export class TimeTrialMode implements RideMode {
  readonly kind = 'trial' as const;
  readonly trial: TimeTrial;
  private readonly trialHud: TrialHud;
  /** FEAT-128: the course picked in pause > Mode (the gates are on for the session), '' in Free ride */
  course = '';

  constructor(private readonly ctx: GameContext, private readonly world: World, private readonly d: RideDeps) {
    const { pack, settings, audio } = ctx;
    const trial = this.trial = new TimeTrial(pack.meta.slug, world.courses);
    const trialHud = this.trialHud = new TrialHud(settings);
    trial.onEvent = (e) => {
      trialHud.onEvent(e, trial.candidates.length);
      if (e.kind === 'start') { audio.chime(); padFx.trialEvent('start'); }
      else if (e.kind === 'split') padFx.trialEvent('split');
      else if (e.kind === 'finish') { audio.chime(); padFx.trialEvent('finish', e.isBest); }
    };
  }

  /** the gates are out */
  get on(): boolean { return this.ctx.settings.timeTrials || !!this.course; }

  /** Mode: a course (gates on for the session), or '' for none */
  start(id: string): void {
    this.course = id;
    this.world.trialWorld.setEnabled(this.on);
    if (!this.on) this.trial.cancel('Free ride');
    this.refreshCourseFlags();
  }
  end(): void { this.start(''); }
  /** stop the run in progress, if any (the HUD shows why) */
  cancel(why: string): void { this.trial.cancel(why); }

  find(id: string | undefined): Course | undefined { return this.world.courses.find((x) => x.id === id); }
  /** the courses for the main menu and pause > Mode */
  list(): CourseEntry[] { return this.world.courses.map((c) => ({ id: c.id, name: c.name, length: c.length, best: this.trial.loadBest(c)?.time ?? null })); }

  /** a few metres above a course's start gate on its line, facing down it */
  goTo(c: Course): void {
    const { pack } = this.ctx, { liftRide, rider, cam } = this.d;
    const x = c.start[0] - c.dir[0] * 6, y = c.start[1] - c.dir[1] * 6;
    liftRide.cancel(); this.trial.cancel('Moved');
    pack.fine?.request(x - 600, y - 600, x + 600, y + 600); pack.mask?.request(x - 600, y - 600, x + 600, y + 600);
    rider.reset(x, y, Math.atan2(c.dir[0], c.dir[1])); cam.snapTo(rider);
  }
  /** the T key: to the nearest course start */
  toNearest(): void {
    const c = this.trial.nearestStart(this.d.rider.x, this.d.rider.y);
    if (c) this.goTo(c);
  }

  applySettings(s: Settings, what: string): void {
    if (what === 'timeTrials' && !s.timeTrials) this.course = ''; // turning them off ends a course picked in Mode too
    this.world.trialWorld.setEnabled(this.on);
    if (!this.on) this.trial.cancel('Time trials off');
    this.refreshCourseFlags();
  }

  update(f: RideFrame): void {
    const { trial } = this, { trialWorld } = this.world, { rider, map } = this.d;
    if (!this.on) { map.trialRoute = null; return; }
    if (f.onLift) trial.cancel('On a lift'); else if (rider.unstrapped) trial.cancel('Unstrapped'); else if (!f.frozen) trial.update(rider, f.dt, f.tuck);
    trialWorld.updateGates(rider.x, rider.y);
    trialWorld.updateGhost(trial.ghostAt(trial.time), f.dt);
    const active = trial.state !== 'idle' ? trial.course : null;
    const showWalls = trial.state === 'running' || (trial.state === 'armed' && trial.candidates.length === 1);
    trialWorld.updateRoute(showWalls ? active : null, trial.along, trial.nextTarget, f.elapsed, trial.outside > 0);
    map.trialRoute = active ? active.points : null;
  }
  hud(f: RideFrame): void {
    if (this.on) this.trialHud.update(f.dt, this.trial, this.ctx.pack, this.d.cam.camera);
    else this.trialHud.hide();
  }

  dispose(): void { this.trialHud.hide(); }

  private refreshCourseFlags(): void {
    this.d.map.courseStarts = this.on ? this.world.courses.map((c) => ({ x: c.start[0], y: c.start[1], name: c.name, best: this.trial.loadBest(c)?.time ?? null })) : [];
  }
}
