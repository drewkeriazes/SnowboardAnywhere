import type * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { World } from './World';

/**
 * BUG-063: build the world around the start behind the loading screen, without drawing: stream terrain,
 * trees and rocks with a large per-frame budget (frames stay short, so the page never locks up), then
 * compile every shader in the background. Ends when nothing near the start is still downloading or
 * building, or after 20 s. The screen then stays up for the first few real frames (HIDE_AFTER_FRAMES in
 * the session), so whatever only the full frame draws (clouds, the body pass, GPU uploads) is paid behind it.
 * The trees and rocks stream round `focus` (the rider, or the camera when it is off the rider: the menu shot, FEAT-177).
 */
export async function warmUp(
  ls: { set(f: number, label: string): void },
  w: Pick<World, 'terrain' | 'veg' | 'rocks'>, pack: Pack, focus: () => { x: number; y: number },
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
): Promise<void> {
  const { terrain, veg, rocks } = w;
  const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  terrain.budgetMs = 12; terrain.maxBuilds = 64; veg.budgetMs = 12;
  const tiles = () => [pack.fine, pack.mid, pack.far, pack.mask, pack.ao, pack.dir, pack.moguls].reduce((n, t) => n + (t?.inFlight ?? 0), 0);
  const t0 = performance.now();
  let peak = 1, settled = 0;
  while (performance.now() - t0 < 20000) {
    camera.updateMatrixWorld();
    const cp = camera.position;
    terrain.update(cp.x, -cp.z, cp.y);
    const f = focus();
    veg.update(f.x, f.y, f.x, f.y, cp);
    rocks.update(f.x, f.y);
    const tl = tiles();
    const left = terrain.pending + tl + veg.pending + rocks.pending;
    peak = Math.max(peak, left);
    ls.set(0.85 * (1 - left / peak), `Terrain ${terrain.pending + tl} · trees ${veg.pending} · rocks ${rocks.pending}`);
    settled = left === 0 ? settled + 1 : 0;
    if (settled >= 3) break; // three quiet frames: late tile arrivals have had a chance to mark rebuilds
    await nextFrame();
  }
  ls.set(0.9, 'Compiling shaders...');
  await renderer.compileAsync(scene, camera).catch((e) => console.warn('compileAsync failed', e));
  ls.set(0.97, 'Almost there...');
  // riding: small budgets so streaming never spikes a frame; built parent chunks cover any gaps
  terrain.budgetMs = 4; terrain.maxBuilds = 10; veg.budgetMs = 3;
}
