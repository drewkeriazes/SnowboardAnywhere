import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import { Replay, type ReplaySample } from '../sim/Replay';
import { Rider } from '../sim/Rider';
import { OUTFIT_PRESETS } from '../ui/Settings';
import { RiderView } from './RiderView';

/**
 * FEAT-128: riders dropping a line behind the main menu. Each ghost replays a take Drew recorded and
 * ships with the game (`game/public/attract/index.json` lists each resort's files, each an `AttractTake`):
 * the samples step a full `RiderView` the way the replay viewer poses the rider (no physics). Every take
 * starts from its beginning when the menu goes live, all at once, and each starts over as soon as it ends
 * (FEAT-179, Drew's call: the riders are on the mountain from the first frame).
 */
export interface AttractTake {
  version: 1;
  pack: string;
  /** a take rides what was recorded, whatever the player's Snowboard / Skis setting */
  discipline: 'board' | 'ski';
  stance: 'regular' | 'goofy';
  /** an OUTFIT_PRESETS name */
  outfit: string;
  /** the replay samples (sim/Replay.ts, 20 Hz), times from 0 */
  samples: ReplaySample[];
  /** FEAT-179: marks a take made for the far slopes (from lines drawn on the shot); timed like every other take */
  backdrop?: boolean;
}

/**
 * FEAT-177: a ghost shows only from the last moment it is out of frame before it rides into the backdrop shot
 * to the first moment it is out again after (`from`..`to`, take seconds), so it rides in and out instead of
 * appearing or vanishing on screen (the whole take when it never enters the shot, or when no view is set).
 * A take that starts (or ends) in frame can't ride in: it fades in (out) over FADE seconds instead (`fadeIn`,
 * `fadeOut`). Record takes that start behind the camera and end out of frame to have them ride in.
 */
interface Ghost {
  replay: Replay; rider: Rider; view: RiderView; dur: number;
  from: number; to: number; fadeIn: boolean; fadeOut: boolean; mats: THREE.Material[]; casters: THREE.Object3D[]; alpha: number;
  /** FEAT-179: the meshes past the LOD_KEEP largest, hidden while the ghost is beyond LOD_M (their visibility before) */
  small: THREE.Object3D[]; smallVis: boolean[]; lod: boolean;
}
/** take seconds between the in-frame tests, the ghost's size for them (m, a sphere round the rider), the fade (s) */
const VIEW_STEP = 0.1, GHOST_R = 3, FADE = 0.5;
/** past LOD_M from the camera a ghost is a few px tall: only its LOD_KEEP largest meshes draw (FEAT-179, draw calls) */
const LOD_M = 250, LOD_KEEP = 4;
const _frustum = new THREE.Frustum(), _m = new THREE.Matrix4(), _sphere = new THREE.Sphere();

export class AttractGhosts {
  readonly group = new THREE.Group();
  private ghosts: Ghost[] = [];
  /** seconds since the menu went live: each take is at this time modulo its length */
  private t = 0;
  /** the backdrop camera the visible windows are fitted to (setView) */
  private view: THREE.Camera | null = null;
  /** a check tool's switch: every mesh at every distance (the far LOD off) */
  lodOff = false;
  /** resolves when the takes have loaded (or failed to) */
  loaded: Promise<number> = Promise.resolve(0);

  constructor(private readonly pack: Pack) { this.group.name = 'attract ghosts'; }

  /** Load the resort's takes, `files` from the attract manifest (none is fine: the backdrop rides empty). */
  load(base: string, ghosts: string[]): Promise<number> { return (this.loaded = this.fetchTakes(base, ghosts)); }
  private async fetchTakes(base: string, ghosts: string[]): Promise<number> {
    try {
      const takes = await Promise.all(ghosts.map(async (f) => { try { const r = await fetch(`${base}attract/${this.pack.meta.slug}/${f}`); return r.ok ? await r.json() as AttractTake : null; } catch { return null; } }));
      for (const t of takes) if (t) this.add(t);
    } catch { /* no takes yet */ }
    return this.ghosts.length;
  }

  /** Add one take (also used by the recording tool to preview a fresh take). */
  add(take: AttractTake): void {
    if (take.samples.length < 2) return;
    const replay = new Replay();
    const t0 = take.samples[0].t;
    for (const s of take.samples) replay.samples.push({ ...s, t: s.t - t0 });
    const rider = new Rider(this.pack, null);
    rider.discipline = take.discipline; rider.goofy = take.stance === 'goofy';
    const view = new RiderView();
    view.setDiscipline(take.discipline);
    view.setOutfit({ ...(OUTFIT_PRESETS[take.outfit] ?? Object.values(OUTFIT_PRESETS)[this.ghosts.length % Object.values(OUTFIT_PRESETS).length]) });
    view.group.visible = false; view.sprayObject.visible = false;
    this.group.add(view.group, view.sprayObject);
    // transparent from the start (opacity 1), so a fade never needs another shader variant mid-menu
    const mats: THREE.Material[] = [], casters: THREE.Object3D[] = [];
    view.group.traverse((o) => {
      if (o.castShadow) casters.push(o);
      const m = (o as THREE.Mesh).material;
      for (const x of Array.isArray(m) ? m : m ? [m] : []) if (!mats.includes(x)) { x.transparent = true; mats.push(x); }
    });
    // the far LOD: every mesh but the largest few (by bounding sphere)
    const meshes: { o: THREE.Object3D; r: number }[] = [];
    view.group.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh || !m.geometry) return; m.geometry.computeBoundingSphere(); const sc = new THREE.Vector3(); m.getWorldScale(sc); meshes.push({ o, r: (m.geometry.boundingSphere?.radius ?? 0) * Math.max(sc.x, sc.y, sc.z) }); });
    const small = meshes.sort((p, q) => q.r - p.r).slice(LOD_KEEP).map((e) => e.o);
    this.ghosts.push({ replay, rider, view, dur: replay.end, from: 0, to: replay.end, fadeIn: false, fadeOut: false, mats, casters, alpha: 1, small, smallVis: small.map(() => true), lod: false });
    if (this.view) this.fitWindows();
  }

  get count(): number { return this.ghosts.length; }

  /** FEAT-177: is the take at `lt` seconds inside the camera's view (the frustum tested against a sphere round the rider)? */
  private seen(g: Ghost, lt: number): boolean {
    const s = g.replay.at(lt);
    if (!s) return false;
    _sphere.center.set(s.x, s.z + 1, -s.y); _sphere.radius = GHOST_R;
    return _frustum.intersectsSphere(_sphere);
  }
  private setFrustum(cam: THREE.Camera): void {
    cam.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  }
  private fitWindows(): void {
    if (!this.view) return;
    this.setFrustum(this.view);
    for (const g of this.ghosts) {
      let first = -1, last = -1;
      for (let lt = 0; lt <= g.dur; lt += VIEW_STEP) if (this.seen(g, lt)) { if (first < 0) first = lt; last = lt; }
      g.from = first < 0 ? 0 : Math.max(0, first - VIEW_STEP);
      g.to = last < 0 ? g.dur : Math.min(g.dur, last + VIEW_STEP);
      g.fadeIn = first >= 0 && this.seen(g, g.from);
      g.fadeOut = last >= 0 && this.seen(g, g.to);
    }
  }
  /** FEAT-177: fit each take's visible window to the backdrop camera (call with the camera on the shot's pose) */
  setView(cam: THREE.Camera): void { this.view = cam; this.fitWindows(); }

  /**
   * FEAT-177 / FEAT-179: every take from its start (the moment the menu goes live; refits the windows to `cam`).
   * A take that starts out of frame rides in; one that starts in frame is at opacity 0 on this frame and fades
   * in, so the frame still matches the still.
   */
  restartOutOfView(cam: THREE.Camera): void {
    this.setView(cam);
    this.t = 0;
    this.update(0);
  }
  /** FEAT-177: is any ghost on screen now (for the camera given)? One faded out (opacity about 0) doesn't count. */
  anyInView(cam: THREE.Camera): boolean {
    this.setFrustum(cam);
    return this.ghosts.some((g) => g.view.group.visible && g.alpha > 0.05 && this.seen(g, this.lt(g)));
  }
  /** a ghost's time in its take now: each starts over as soon as it ends */
  private lt(g: Ghost): number { return g.dur > 0 ? this.t % g.dur : 0; }

  /** Step the ghosts (only while the menu backdrop shows). */
  update(dt: number): void {
    if (!this.ghosts.length) return;
    this.t += dt;
    for (const g of this.ghosts) {
      const lt = this.lt(g);
      const on = lt >= g.from && lt <= g.to;
      g.view.group.visible = on; g.view.sprayObject.visible = on;
      if (!on) continue;
      // a take that starts or ends in frame fades there (its shadow off while it does)
      const a = Math.min(g.fadeIn ? (lt - g.from) / FADE : 1, g.fadeOut ? (g.to - lt) / FADE : 1, 1);
      if (a !== g.alpha) {
        g.alpha = a;
        for (const m of g.mats) m.opacity = a;
        for (const o of g.casters) o.castShadow = a >= 1;
      }
      const s = g.replay.at(lt)!;
      // the far LOD: give the rider view its own mesh visibility back for its update, then hide the small meshes again
      if (g.lod) { g.small.forEach((o, i) => { o.visible = g.smallVis[i]; }); g.lod = false; }
      g.replay.overlay(g.rider, s, this.pack);
      g.view.update(g.rider, dt, !!(s.f & 2), false, false);
      const c = this.view?.position;
      if (c && !this.lodOff && Math.hypot(s.x - c.x, s.z - c.y, -s.y - c.z) > LOD_M) { g.small.forEach((o, i) => { g.smallVis[i] = o.visible; o.visible = false; }); g.lod = true; }
    }
  }

  setVisible(on: boolean): void { this.group.visible = on; }

  dispose(): void {
    for (const g of this.ghosts) g.view.group.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose(); });
    this.ghosts = [];
    this.group.clear();
  }
}

/** The replay span [t0, t1] as a take (the recording tool). */
export function takeFrom(samples: ReplaySample[], t0: number, t1: number, meta: Omit<AttractTake, 'version' | 'samples'>): AttractTake {
  return { version: 1, ...meta, samples: samples.filter((s) => s.t >= t0 && s.t <= t1).map((s) => ({ ...s, t: +(s.t - t0).toFixed(3) })) };
}
