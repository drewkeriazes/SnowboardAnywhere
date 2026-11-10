import { shotPose, type AttractShot } from '../world/AttractShots';
import { hasCustomStart } from '../spawn';
import type { Settings } from '../ui/Settings';
import type { Controls } from '../sim/Controls';
import type { Rider } from '../sim/Rider';
import type { Pack } from '../pack/Pack';
import type { ChaseCamera } from '../world/ChaseCamera';
import type { AttractGhosts } from '../world/AttractGhosts';
import type { MainMenu } from '../ui/MainMenu';
import type { PauseCourse } from '../ui/PauseMenu';
import type { RunCard } from '../ui/RunCard';
import type { ResortMap } from '../ui/ResortMap';
import type { FramePlan, RideFrame } from './RideFrame';
import type { GameState } from './GameState';

export interface AttractParts {
  menu: MainMenu; shot: AttractShot; ghosts: AttractGhosts; cam: ChaseCamera; pack: Pack; settings: Settings; controls: Controls;
  rider: Rider; runCard: RunCard; map: ResortMap; look: { dx: number; dy: number }; frame: RideFrame;
  /** the start the menu names (a landmark, the start run, else the resort start) */
  startLabel(): string;
  menuCourses(): PauseCourse[];
  /** FEAT-177: draw the shot's own conditions (on, entering) or the player's (off, leaving) */
  holdShotConditions(on: boolean): void;
  /** FEAT-177: put what the shot shows over time back to its start (the clouds) */
  shotFromStart(): void;
}

/**
 * FEAT-128 / FEAT-162: the main menu over the live resort ("attract"). The eye camera sits on the resort's
 * backdrop shot and drifts; ghosts ride a line; the rider is hidden and still, the HUD hidden, and the riding
 * keys and buttons do nothing (the menu has them). RIDE leaves it (the session's menu.onChoice).
 */
export class AttractState implements GameState {
  readonly name = 'attract';
  private t = 0;
  /** FEAT-177: restart the ghosts once this frame has put the camera on the shot's start pose */
  private ghostsFromStart = false;
  private readonly plan: FramePlan = { drive: 'menu', touch: false, fullMap: false, interact: false, replay: null };

  constructor(private readonly p: AttractParts) {}

  enter(): void {
    const { menu, shot, cam, pack, ghosts, runCard, controls, settings, map } = this.p;
    this.t = 0;
    if (map.fullOpen) map.close();
    this.p.holdShotConditions(true);
    this.p.shotFromStart();
    const p = shotPose(shot, 0);
    cam.setEye(p.x, p.y, p.h, p.pitch, p.fov, p.eye);
    pack.fine?.request(shot.x - 600, shot.y - 600, shot.x + 600, shot.y + 600); pack.mask?.request(shot.x - 600, shot.y - 600, shot.x + 600, shot.y + 600);
    ghosts.setVisible(true);
    runCard.hide(); // the run that just ended is behind us
    document.body.classList.add('attract');
    controls.guardLeave = false; // nothing to lose in the menu
    menu.setStart(this.p.startLabel(), hasCustomStart(pack.meta.slug));
    menu.setCourses(this.p.menuCourses(), settings.units === 'metric');
    menu.show();
  }

  exit(): void {
    const { ghosts, controls, cam, settings, rider } = this.p;
    ghosts.setVisible(false);
    this.p.holdShotConditions(false);
    document.body.classList.remove('attract');
    controls.guardLeave = true;
    controls.padMute(); // the Cross that pressed RIDE is not a jump
    cam.mode = settings.camera;
    cam.snapTo(rider);
  }

  update(dt: number, stepped: boolean): void {
    const { controls, look, shot, settings, cam, ghosts, frame } = this.p;
    controls.suspendFrame(); // the menu has the keys and buttons: nothing reaches the riding actions
    look.dx = look.dy = 0;
    this.t += dt;
    const p = shotPose(shot, settings.reduceMotion ? 0 : this.t); // Reduce motion: the backdrop holds still
    cam.setEye(p.x, p.y, p.h, p.pitch, p.fov, p.eye);
    ghosts.update(dt);
    frame.update(dt, stepped, this.plan);
    if (this.ghostsFromStart) { this.ghostsFromStart = false; ghosts.restartOutOfView(cam.camera); }
  }

  render(): void { this.p.frame.draw(); }

  /**
   * FEAT-177: the shot from its start, as the still shows it: the pose at t = 0, the clouds, and the ghosts at a
   * moment when none is in frame (they ride in). The session calls it on the frame the menu crossfades to live.
   */
  restart(): void {
    this.t = 0; // update() adds this frame's dt: the shot's start, give or take a frame (as the still: shoot_attract.mjs draws one frame)
    this.p.shotFromStart();
    this.ghostsFromStart = true;
  }
}
