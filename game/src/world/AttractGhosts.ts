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
  /** FEAT-179: the meshes a mid-distance (NEAR_M..LOD_M) and a far (past LOD_M) ghost doesn't draw, and those hidden now with their visibility before */
  midHide: THREE.Object3D[]; farHide: THREE.Object3D[]; lodHidden: THREE.Object3D[]; lodVis: boolean[];
  /** FEAT-179 (cost): behind terrain from the camera at the last check (not drawn, not posed) */
  hidden: boolean;
  /** far out, posed only every FAR_EVERY frames: where it was posed (pack metres), whether it has been, and the time since */
  px: number; py: number; pz: number; posed: boolean; skipped: number;
  /** its meshes cast shadows now (off while fading, and past LOD_M where no shadow reaches the view) */
  shadow: boolean;
}
/** take seconds between the in-frame tests, the ghost's size for them (m, a sphere round the rider), the fade (s) */
const VIEW_STEP = 0.1, GHOST_R = 3, FADE = 0.5;
/** past LOD_M from the camera a ghost is a few px tall (FEAT-179, draw calls): it draws only the meshes named in FAR_KEEP */
const LOD_M = 250;
/**
 * the meshes a ghost keeps, by name (RiderRig / RiderModel): far out the board or skis, the torso, sleeves and pants
 * (the outfit's colours); at mid distance also the head, hands, feet, the board's stripe and the poles. The
 * bindings, straps, goggles and baskets go first: under a few px they can't be seen.
 */
const FAR_KEEP = ['board base', 'ski base', 'body core jacket', 'body limbs jacket', 'body limbs pants'];
const MID_KEEP = [...FAR_KEEP, 'topsheet', 'body core pants', 'body head helmet', 'body head skin', 'body limbs gloves', 'body limbs boots', 'pole shaft'];
/**
 * how often a ghost is posed (and checked against the terrain), by distance: every frame inside NEAR_M, every
 * 2nd frame out to LOD_M (8 to 25 px tall), every FAR_EVERY beyond; it slides by its change of position in between
 */
const NEAR_M = 80, FAR_EVERY = 4;
const _frustum = new THREE.Frustum(), _m = new THREE.Matrix4(), _sphere = new THREE.Sphere();

export class AttractGhosts {
  readonly group = new THREE.Group();
  private ghosts: Ghost[] = [];
  /** seconds since the menu went live: each take is at this time modulo its length */
  private t = 0;
  /** frames stepped, so the far ghosts take turns at their full update */
  private frame = 0;
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
    // the distance LODs: the meshes not on each keep list (by name)
    const meshes: THREE.Object3D[] = [];
    view.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o); });
    const named = (o: THREE.Object3D, keep: string[]) => keep.some((k) => o.name.startsWith(k));
    const midHide = meshes.filter((o) => !named(o, MID_KEEP)), farHide = meshes.filter((o) => !named(o, FAR_KEEP));
    this.ghosts.push({ replay, rider, view, dur: replay.end, from: 0, to: replay.end, fadeIn: false, fadeOut: false, mats, casters, alpha: 1, midHide, farHide, lodHidden: [], lodVis: [], hidden: false, px: 0, py: 0, pz: 0, posed: false, skipped: 0, shadow: true });
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
    return this.ghosts.some((g) => g.view.group.visible && !g.hidden && g.alpha > 0.05 && this.seen(g, this.lt(g)));
  }
  /** a ghost's time in its take now: each starts over as soon as it ends */
  private lt(g: Ghost): number { return g.dur > 0 ? this.t % g.dur : 0; }

  /**
   * FEAT-179 (cost): is the rider's head behind the terrain from the camera at `c` (three.js space)? A march along
   * the sight line against the pack's heights, one sample per 25 m or so (8 to 40).
   */
  private behindTerrain(c: THREE.Vector3, s: ReplaySample): boolean {
    const hx = s.x, hy = s.z + 1.8, hz = -s.y;
    const n = Math.max(8, Math.min(40, Math.round(Math.hypot(hx - c.x, hy - c.y, hz - c.z) / 25)));
    for (let i = 1; i < n; i++) {
      const k = i / n, x = c.x + (hx - c.x) * k, y = c.y + (hy - c.y) * k, z = c.z + (hz - c.z) * k;
      const g = this.pack.groundHeight(x, -z, y);
      if (Number.isFinite(g) && g > y + 0.3) return true;
    }
    return false;
  }

  /**
   * Step the ghosts (only while the menu backdrop shows). What they cost (FEAT-179, 50 on screen on Drew's GPU):
   * a ghost behind the terrain is neither drawn nor posed; one further out is posed less often (NEAR_M, LOD_M,
   * FAR_EVERY; each on its own beat, sliding by its change of position in between); past LOD_M one draws only its
   * FAR_KEEP meshes (past NEAR_M its MID_KEEP ones), casts no shadow and has no spray.
   */
  update(dt: number): void {
    if (!this.ghosts.length) return;
    this.t += dt;
    this.frame++;
    const c = this.view?.position;
    this.ghosts.forEach((g, i) => {
      const lt = this.lt(g);
      if (!(lt >= g.from && lt <= g.to)) { g.view.group.visible = g.view.sprayObject.visible = false; g.posed = false; g.hidden = false; return; }
      const s = g.replay.at(lt)!;
      const d = c ? Math.hypot(s.x - c.x, s.z - c.y, -s.y - c.z) : 0, far = d > LOD_M;
      const every = d > LOD_M ? FAR_EVERY : d > NEAR_M ? 2 : 1;
      const beat = every === 1 || (this.frame + i) % every === 0;
      // the terrain check on the ghost's beat, also for one not posed yet (just into its window), but not again
      // every frame for one already behind the terrain: hidden ghosts are many, and their view rarely changes
      if (c && (beat || (!g.posed && !g.hidden))) g.hidden = this.behindTerrain(c, s);
      g.view.group.visible = !g.hidden;
      if (g.hidden) { g.view.sprayObject.visible = false; g.posed = false; return; }
      // posed on its beat, and at once when it has no pose (just into its window, or just out from behind the terrain)
      const turn = beat || !g.posed;
      // a take that starts or ends in frame fades there (its shadow off while it does)
      const a = Math.min(g.fadeIn ? (lt - g.from) / FADE : 1, g.fadeOut ? (g.to - lt) / FADE : 1, 1);
      if (a !== g.alpha) { g.alpha = a; for (const m of g.mats) m.opacity = a; }
      const shadow = a >= 1 && !far;
      if (shadow !== g.shadow) { g.shadow = shadow; for (const o of g.casters) o.castShadow = shadow; }
      g.skipped += dt;
      if (!turn) {
        // far out between full updates: slide by the change of position
        g.view.group.position.x += s.x - g.px; g.view.group.position.y += s.z - g.pz; g.view.group.position.z -= s.y - g.py;
        g.px = s.x; g.py = s.y; g.pz = s.z;
        return;
      }
      // the distance LOD: give the rider view its own mesh visibility back for its update, then hide again
      g.lodHidden.forEach((o, j) => { o.visible = g.lodVis[j]; });
      g.lodHidden = [];
      g.replay.overlay(g.rider, s, this.pack);
      g.view.update(g.rider, g.skipped, !!(s.f & 2), false, false);
      g.skipped = 0; g.px = s.x; g.py = s.y; g.pz = s.z; g.posed = true;
      g.view.sprayObject.visible = !far;
      if (!this.lodOff && d > NEAR_M) {
        g.lodHidden = far ? g.farHide : g.midHide;
        g.lodVis = g.lodHidden.map((o) => o.visible);
        for (const o of g.lodHidden) o.visible = false;
      }
    });
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
