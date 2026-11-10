import * as THREE from 'three';
import type { GameContext } from '../core/GameContext';
import type { Events } from '../core/Events';
import type { World } from '../session/World';
import { Outrun } from '../sim/Outrun';
import type { OutrunUI } from '../ui/OutrunUI';
import { keysOf } from '../ui/Settings';
import type { RideDeps, ModeFrame, RideMode } from './RideMode';

/**
 * FEAT-164: Outrun (FEAT-097 to FEAT-101) as a mode: the chase sim (sim/Outrun), the monsters and the eat
 * sequence in the world, the HUD and the end card. Its news goes on the bus (FEAT-163): the audio, the rumble
 * and the HUD's toast listen there, and so does `listen` below (the camera kick, the eat start).
 */
export class OutrunMode implements RideMode {
  readonly kind = 'outrun' as const;
  readonly sim: Outrun;
  private chase: ReturnType<GameContext['audio']['chase']>;
  private readonly eatPosing = new Set<number>();
  private readonly eatLook = new THREE.Vector3();
  private countLast = -1;
  /** Outrun picked with "or drop in from the map": the chase starts when the map closes */
  afterMap = false;
  /** called first in start() (Modes cancels a time trial run there) */
  onStart: (() => void) | null = null;

  /** `ui`: the HUD and end card (the session builds it early so it stacks under the peak labels) */
  constructor(private readonly ctx: GameContext, private readonly world: World, private readonly d: RideDeps, private readonly ui: OutrunUI) {
    const { audio } = ctx, { eat, monsters } = world;
    this.sim = new Outrun(ctx.pack, world.lifts);
    this.chase = audio.chase();
    this.ui.onRetry = () => {
      eat.end(); monsters.clear(); this.chase?.stop(); audio.resumeMusic();
      d.toSpawn();
      this.start();
    };
    this.ui.onExit = () => this.end();
  }

  /**
   * FEAT-163: the mode's own reactions to its news: a monster's foot near the rider kicks the camera; caught, the
   * eat sequence starts. The session calls this after the audio listens, so the record scratch comes first.
   */
  listen(events: Events): void {
    const { settings } = this.ctx, { eat, monsters, riderView } = this.world, { rider, cam } = this.d;
    events.on('outrun', ({ event: e }) => {
      if (e.kind === 'footfall' && e.m) { if (e.m.dist < 30) cam.kick = Math.max(cam.kick, 0.7 * (1 - e.m.dist / 30)); }
      else if (e.kind === 'caught' && e.m) {
        const view = monsters.view(e.m.id);
        if (view) eat.start(e.m, view, rider, riderView, settings.outfit, settings.discipline, this.sim.cfg.gentle);
      }
    });
  }

  /** a run is on (from the countdown to the end card) */
  get on(): boolean { return this.sim.active; }
  /** the chase itself (countdown, head start, chase) */
  get running(): boolean { return this.sim.running; }

  /** Start a run from where the rider is: trials off, no map teleport, no lift skip. */
  start(): void {
    const { settings, audio } = this.ctx, { eat, monsters, riderView } = this.world, { map, rider } = this.d;
    this.onStart?.();
    eat.end(); monsters.clear(); this.ui.hideCard();
    riderView.group.visible = true;
    this.sim.start(settings.outrun, rider);
    map.onPick = null; map.baseMarker = this.sim.base;
    this.chase = audio.chase();
    this.countLast = -1;
    this.d.toast(this.sim.baseMissing ? 'Outrun: no base on this pack, so it is endless' : this.sim.cfg.escape === 'base' ? 'Outrun: reach the base' : 'Outrun: survive', 3000);
  }
  end(): void {
    const { audio } = this.ctx, { eat, monsters, riderView } = this.world, { map, rider } = this.d;
    this.sim.stop(); eat.end(); monsters.clear(); this.ui.hideCard();
    map.onPick = this.d.pick; map.baseMarker = null; map.monsters = [];
    this.chase?.stop(); audio.resumeMusic();
    rider.boost = false; riderView.group.visible = true;
  }
  /** the map has dropped the rider in (or closed): a chase picked with it starts now */
  startAfterMap(): void {
    if (this.afterMap) { this.afterMap = false; this.start(); }
  }

  /** the boost key (FEAT-124: F, Outrun only) */
  boostKey(pressed: boolean): void {
    if (pressed && this.sim.active && this.sim.boost()) this.chase?.boostWhoosh();
  }

  /** the sim, its events on the bus, the eat sequence, the monsters */
  update(f: ModeFrame): void {
    const outrun = this.sim;
    if (!outrun.active) return;
    const { events } = this.ctx, { eat, monsters } = this.world, { rider, liftRide, map } = this.d;
    const chase = this.chase, dt = f.dt;
    outrun.update(dt, rider, f.onLift ? liftRide : null);
    for (const event of outrun.events) events.emit({ type: 'outrun', event });
    if (outrun.phase === 'countdown') { const n = Math.ceil(3 - outrun.t); if (n !== this.countLast) { this.countLast = n; chase?.countBeep(false); } }
    else if (outrun.phase === 'headstart' && this.countLast !== 0) { this.countLast = 0; chase?.countBeep(true); }
    this.eatPosing.clear();
    if (eat.active) { eat.update(dt); if (outrun.nearest) this.eatPosing.add(outrun.nearest.id); }
    monsters.update(outrun, dt, this.eatPosing);
    if (eat.done && !this.ui.cardOpen) this.ui.showCard(outrun, 'eaten');
    if (outrun.phase === 'escaped' && outrun.t > 2.5 && !this.ui.cardOpen) this.ui.showCard(outrun, 'escaped');
    map.monsters = outrun.monsters.map((m) => [m.x, m.y]);
    if (chase) {
      const n = outrun.nearest;
      if (n) chase.setMonster(n.x, n.z + 1.5, -n.y);
      chase.update(dt, outrun.dist, outrun.phase === 'chase', outrun.boosting);
    }
  }
  hud(): void {
    const { settings } = this.ctx;
    this.ui.update(this.sim, settings.units === 'metric', this.d.keyLabels.padKey('boost') || keysOf(settings, 'boost'));
  }
  /** after the camera: the eat sequence owns it (FEAT-104: high in front of the monster, looking down at it); the chase sounds hear from it */
  afterCamera(camera: THREE.PerspectiveCamera): void {
    const { eat } = this.world;
    if (eat.active) { eat.cameraPose(camera.position, this.eatLook); camera.lookAt(this.eatLook); if (camera.fov !== 60) { camera.fov = 60; camera.updateProjectionMatrix(); } }
    this.chase?.setListener(camera);
  }

  dispose(): void {
    if (this.sim.active) this.end();
    this.ui.destroy();
  }
}
