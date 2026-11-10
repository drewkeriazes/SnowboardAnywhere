import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import { Replay, type ReplaySample } from '../sim/Replay';
import { Rider } from '../sim/Rider';
import { OUTFIT_PRESETS } from '../ui/Settings';
import { RiderView } from './RiderView';

/**
 * FEAT-128: riders dropping a line behind the main menu. Each ghost replays a take Drew recorded and
 * ships with the game (`game/public/attract/index.json` lists each resort's files, each an `AttractTake`):
 * the samples step a full `RiderView` the way the replay viewer poses the rider (no physics). The takes
 * are stacked into one group: each is lined up on the moment it rides `anchor.r` metres from the camera,
 * and they pass that point `STAGGER` seconds apart, so they come down the line together and loop together.
 * A backdrop take (`backdrop: true`, or never within `FAR_M` of the camera: a line across the bowl) is not in
 * that queue: each starts when the menu goes live and loops on its own (its length plus BACKDROP_GAP), so the
 * far slope has riders on it at once and a long backdrop take doesn't stretch the close riders' loop (FEAT-179).
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
  /**
   * FEAT-179: a backdrop take (riders far across the bowl, for example made by a tool from lines drawn on the
   * shot): it starts with the menu and loops on its own instead of joining the queue of close takes. Without the
   * flag, a take that never comes within FAR_M of the camera is one too.
   */
  backdrop?: boolean;
}

/** seconds between the ghosts' drops, and the pause before the group goes again */
const STAGGER = 1.6, GAP = 2.5, BACKDROP_GAP = 4;
/** a take that never comes closer than this to the backdrop camera (m) is a backdrop take */
const FAR_M = 300;

/**
 * FEAT-177: a ghost shows only from the last moment it is out of frame before it rides into the backdrop shot
 * to the first moment it is out again after (`from`..`to`, take seconds), so it rides in and out instead of
 * appearing or vanishing on screen (the whole take when it never enters the shot, or when no view is set).
 * A take that starts (or ends) in frame can't ride in: it fades in (out) over FADE seconds instead (`fadeIn`,
 * `fadeOut`). Record takes that start behind the camera and end out of frame to have them ride in.
 */
interface Ghost {
  replay: Replay; rider: Rider; view: RiderView; offset: number; dur: number; anchorT: number;
  /** a backdrop take: never within FAR_M of the camera (starts with the loop, a few px tall) */
  far: boolean;
  from: number; to: number; fadeIn: boolean; fadeOut: boolean; mats: THREE.Material[]; casters: THREE.Object3D[]; alpha: number;
}
/** take seconds between the in-frame tests, the ghost's size for them (m, a sphere round the rider), the fade (s) */
const VIEW_STEP = 0.1, GHOST_R = 3, FADE = 0.5;
const _frustum = new THREE.Frustum(), _m = new THREE.Matrix4(), _sphere = new THREE.Sphere();
/** where the group lines up: a distance from the backdrop camera (pack metres) */
export interface GhostAnchor { x: number; y: number; r: number }

export class AttractGhosts {
  readonly group = new THREE.Group();
  private ghosts: Ghost[] = [];
  private t = 0;
  /** FEAT-179: the backdrop takes' own clock (each loops on its length plus BACKDROP_GAP) */
  private tb = 0;
  /** the backdrop camera the visible windows are fitted to (setView) */
  private view: THREE.Camera | null = null;
  /** resolves when the takes have loaded (or failed to) */
  loaded: Promise<number> = Promise.resolve(0);

  constructor(private readonly pack: Pack, private readonly anchor: GhostAnchor | null = null) { this.group.name = 'attract ghosts'; }

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
    // the take's own moment at the anchor: the first sample that far from the camera (else its start)
    const a = this.anchor;
    const at = a ? replay.samples.find((s) => Math.hypot(s.x - a.x, s.y - a.y) >= a.r) : undefined;
    const far = take.backdrop ?? (!!a && replay.samples.every((s) => Math.hypot(s.x - a.x, s.y - a.y) > FAR_M));
    this.ghosts.push({ replay, rider, view, offset: 0, dur: replay.end, anchorT: at ? at.t : 0, far, from: 0, to: replay.end, fadeIn: false, fadeOut: false, mats, casters, alpha: 1 });
    this.stack();
    if (this.view) this.fitWindows();
  }

  /**
   * Line the takes up on their anchor moments, STAGGER apart in the order they were added, the earliest starting
   * at 0; backdrop takes all start at 0.
   */
  private stack(): void {
    const near = this.ghosts.filter((g) => !g.far);
    const raw = near.map((g, i) => i * STAGGER - g.anchorT);
    const min = Math.min(...raw);
    near.forEach((g, i) => { g.offset = raw[i] - min; });
    for (const g of this.ghosts) if (g.far) g.offset = 0;
    this.t = 0; this.tb = 0;
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

  /** the loop time when no ghost is showing, from `t0` on (the first such moment in one loop; else `t0`) */
  private clearTime(t0: number): number {
    const c = this.cycle;
    for (let dt = 0; dt < c; dt += VIEW_STEP) {
      const t = (t0 + dt) % c;
      // backdrop takes don't count: a few px far off, they fade in where the still has empty snow
      if (this.ghosts.every((g) => { const lt = t - g.offset; return g.far || lt < g.from || lt > g.to; })) return t;
    }
    return t0;
  }
  /**
   * FEAT-177: restart the loop at a moment with every ghost out of frame (the start, unless a take begins
   * in the shot), so at the menu's crossfade they ride in instead of popping in. Refits the windows to `cam`.
   */
  restartOutOfView(cam: THREE.Camera): void {
    this.setView(cam);
    this.t = this.clearTime(0);
    this.tb = 0;
    this.update(0);
  }
  /** FEAT-177: is any ghost on screen now (for the camera given)? Backdrop takes, a few px far off, don't count. */
  anyInView(cam: THREE.Camera): boolean {
    this.setFrustum(cam);
    return this.ghosts.some((g) => !g.far && g.view.group.visible && this.seen(g, this.lt(g)));
  }
  /** one loop: the last ghost's take after its stagger, then the gap */
  private get cycle(): number { return Math.max(0, ...this.ghosts.filter((g) => !g.far).map((g) => g.offset + g.dur)) + GAP; }
  /** a ghost's time in its take now */
  private lt(g: Ghost): number { return g.far ? this.tb % (g.dur + BACKDROP_GAP) : this.t - g.offset; }

  /** Step the ghosts (only while the menu backdrop shows). */
  update(dt: number): void {
    if (!this.ghosts.length) return;
    this.t = (this.t + dt) % this.cycle;
    this.tb += dt;
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
      g.replay.overlay(g.rider, s, this.pack);
      g.view.update(g.rider, dt, !!(s.f & 2), false, false);
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
