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
 * start a couple of seconds apart and loop together.
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
}

/** seconds between the ghosts' drops, and the pause before the group goes again */
const STAGGER = 1.6, GAP = 2.5;

interface Ghost { replay: Replay; rider: Rider; view: RiderView; offset: number; dur: number }

export class AttractGhosts {
  readonly group = new THREE.Group();
  private ghosts: Ghost[] = [];
  private t = 0;

  constructor(private readonly pack: Pack) { this.group.name = 'attract ghosts'; }

  /** Load the resort's takes, `files` from the attract manifest (none is fine: the backdrop rides empty). */
  async load(base: string, ghosts: string[]): Promise<number> {
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
    this.ghosts.push({ replay, rider, view, offset: this.ghosts.length * STAGGER, dur: replay.end });
  }

  get count(): number { return this.ghosts.length; }
  /** one loop: the last ghost's take after its stagger, then the gap */
  private get cycle(): number { return Math.max(0, ...this.ghosts.map((g) => g.offset + g.dur)) + GAP; }

  /** Step the ghosts (only while the menu backdrop shows). */
  update(dt: number): void {
    if (!this.ghosts.length) return;
    this.t = (this.t + dt) % this.cycle;
    for (const g of this.ghosts) {
      const lt = this.t - g.offset;
      const on = lt >= 0 && lt <= g.dur;
      g.view.group.visible = on; g.view.sprayObject.visible = on;
      if (!on) continue;
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
