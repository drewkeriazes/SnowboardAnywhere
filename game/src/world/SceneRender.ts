import * as THREE from 'three';
import { BODY_LAYER } from './RiderView';
import type { Environment } from './Sky';
import type { GoggleLens } from './Lens';
import { treeFadeUniforms } from './TreeFade';

/**
 * The frame's draw: the main render, then in first person the body again over a cleared depth buffer
 * with a close near plane (0.05 m) so knees, gloves and the board are not clipped. FEAT-130: with a lens
 * on, both go into the lens target and the lens pass draws to the screen. BUG-125: tells the tree fade
 * whether this frame's buffer is multisampled (the lens target always is; the canvas when the browser gave it MSAA).
 */
export class SceneRender {
  private readonly bodyCam = new THREE.PerspectiveCamera(70, 1, 0.05, 30);
  private readonly canvasMsaa: boolean;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene, private readonly env: Environment, private readonly lens: GoggleLens) {
    this.bodyCam.layers.set(BODY_LAYER);
    env.sun.layers.enable(BODY_LAYER); env.hemi.layers.enable(BODY_LAYER);
    this.canvasMsaa = renderer.getContext().getContextAttributes()?.antialias === true;
  }

  render(camera: THREE.PerspectiveCamera, firstPerson: boolean): void {
    const { renderer, lens } = this;
    const lensOn = lens.active;
    treeFadeUniforms.uFadeMsaa.value = lensOn || this.canvasMsaa ? 1 : 0;
    if (lensOn) lens.begin(renderer, firstPerson ? 2 : 1);
    renderer.render(this.scene, camera);
    if (firstPerson) this.renderBody(camera, lensOn);
    if (lensOn) lens.end(renderer);
  }

  private renderBody(camera: THREE.PerspectiveCamera, lensOn: boolean): void {
    const { renderer, bodyCam } = this;
    if (lensOn) this.lens.nextPass();
    for (const l of this.env.csm?.lights ?? []) l.layers.enable(BODY_LAYER);
    bodyCam.position.copy(camera.position); bodyCam.quaternion.copy(camera.quaternion);
    if (bodyCam.fov !== camera.fov || bodyCam.aspect !== camera.aspect) { bodyCam.fov = camera.fov; bodyCam.aspect = camera.aspect; bodyCam.updateProjectionMatrix(); }
    const auto = renderer.autoClear, shadows = renderer.shadowMap.autoUpdate;
    renderer.autoClear = false; renderer.shadowMap.autoUpdate = false; // reuse this frame's shadow maps
    renderer.clearDepth();
    renderer.render(this.scene, bodyCam);
    renderer.autoClear = auto; renderer.shadowMap.autoUpdate = shadows;
  }
}
