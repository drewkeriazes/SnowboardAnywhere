import type * as THREE from 'three';
import type { GameContext } from '../core/GameContext';
import type { World } from '../session/World';
import { Outrun } from '../sim/Outrun';
import { OutOfBounds, ODDS, type Crossed } from '../sim/OutOfBounds';
import type { RideDeps, ModeFrame } from './RideMode';

/** the toast on a hit, word for word from the card */
export const OOB_TOAST = "Bad boy, that's out of bounds.";
const BEHIND = 45; // m behind the rider it wakes
const CHASE_TIME = 35; // s before it gives up
const LOST = 220; // m: left this far behind, it gives up

/**
 * FEAT-305: the out of bounds easter egg. Ducking the boundary rope rolls 1 in 30 (sim/OutOfBounds.ts); on a hit the
 * toast says so and the Outrun yeti (FEAT-099 / FEAT-104: the same sim and rig, world.monsters) wakes BEHIND m back
 * and chases on the Chill rubber band. It gives up after CHASE_TIME s, when left LOST m behind, when it catches you
 * (no eat: it vanishes in a cloud of snow), on a lift, and the moment a real Outrun starts: it vanishes in a puff.
 * Never during an Outrun run, the replay or a detached camera. Its own sim keeps no best score and puts nothing on
 * the bus, so the Outrun HUD, music, map and eat sequence never see it; the chase sounds play its roars and steps.
 */
export class YetiEgg {
  readonly sim: Outrun;
  readonly dice: OutOfBounds | null;
  /** what the last frame's move did (the checks read it) */
  last: Crossed = 'none';
  /** times the yeti woke this session (the checks read it) */
  wakes = 0;
  private chase: ReturnType<GameContext['audio']['chase']> = null;

  constructor(private readonly ctx: GameContext, private readonly world: World, private readonly d: RideDeps) {
    this.sim = new Outrun(ctx.pack, world.lifts);
    const odds = ctx.params.yetiodds;
    this.dice = world.boundary ? new OutOfBounds(world.boundary, odds ?? ODDS) : null;
  }

  /** the yeti is out */
  get on(): boolean { return this.sim.active; }

  /** `outrun`: a real Outrun run is on (no rolls, and an egg chase ends) */
  update(f: ModeFrame, outrun: boolean, detached: boolean): void {
    const { rider } = this.d;
    const live = !outrun && !f.frozen && !f.onLift && !detached && this.world.boundaryRope.visible;
    this.last = this.dice ? this.dice.update(rider.x, rider.y, f.dt, live) : 'none';
    if (this.last === 'hit') this.wake();
    if (!this.sim.active) return;
    if (outrun || f.frozen || f.onLift) { this.end(); return; }
    const { monsters } = this.world;
    this.sim.update(f.dt, rider, null);
    for (const e of this.sim.events) if (e.kind === 'footfall' && e.m) this.chase?.footfall(e.m.dist);
    monsters.update(this.sim, f.dt, NO_POSE);
    const n = this.sim.nearest;
    if (n) this.chase?.setMonster(n.x, n.z + 1.5, -n.y);
    if (this.sim.phase === 'caught') { this.end(); return; }
    if (this.sim.time > CHASE_TIME || this.sim.dist > LOST) { this.chase?.roar('giveup'); this.end(); }
  }

  /** the chase sounds hear from the camera */
  afterCamera(camera: THREE.PerspectiveCamera): void { if (this.sim.active) this.chase?.setListener(camera); }

  private wake(): void {
    const { rider, toast } = this.d;
    toast(OOB_TOAST, 3500);
    this.world.monsters.clear();
    this.sim.startChase({ difficulty: 'chill', escape: 'endless', gentle: false }, rider, BEHIND);
    this.wakes++;
    this.chase = this.ctx.audio.chase();
    this.chase?.roar('wake');
  }

  /** gone in a cloud of snow (Outrun starting, Restart, Quit, a map pick, or it is done) */
  end(): void {
    if (!this.sim.active) return;
    const { puffs, monsters } = this.world;
    for (const m of this.sim.monsters) puffs.emit(m.x, m.z + 1.6, -m.y, 60, [0xffffff, 0xe8eef7, 0xd0dcea], 1.4, 3, 2, 1.4, 1.5);
    this.sim.stop();
    monsters.clear();
  }

  /** a teleport (the map, a respawn): no crossing from the old spot, and the yeti is left behind */
  moved(): void { this.dice?.reset(); this.end(); }
}

const NO_POSE = new Set<number>();
