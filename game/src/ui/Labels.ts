import * as THREE from 'three';
import type { Pack } from '../pack/Pack';

/**
 * Peak and town names projected onto the screen as DOM labels. Peaks are shown when the camera
 * looks toward them and nothing higher blocks the sight line (checked by sampling the far
 * height set along the ray). Nearer and taller peaks win when labels collide. Towns are shown
 * when they are within view and under 60 km. Fades with distance.
 */
interface Item { name: string; kind: 'peak' | 'town'; x: number; y: number; z: number; el: HTMLDivElement; prio: number }

const MAX_PEAKS = 10;
const MAX_TOWNS = 4;
const PEAK_RANGE = 90000;
const TOWN_RANGE = 60000;

export class Labels {
  readonly el: HTMLDivElement;
  private readonly items: Item[] = [];
  private readonly pack: Pack;
  private readonly v = new THREE.Vector3();
  private frame = 0;
  visible = true;

  constructor(pack: Pack) {
    this.pack = pack;
    this.el = document.createElement('div');
    this.el.id = 'labels';
    document.body.appendChild(this.el);
    const b = pack.meta.bounds;
    const inResort = (x: number, y: number) => x > b.minX && x < b.maxX && y > b.minY && y < b.maxY;
    // keep the notable peaks: everything inside the resort, plus the tallest elsewhere
    const peaks = [...pack.features.peaks].filter((p) => p.name).sort((p, q) => q.z - p.z);
    const kept = peaks.filter((p) => inResort(p.x, p.y) || p.z > 3900).slice(0, 120);
    for (const p of kept) this.items.push(this.make(p.name, 'peak', p.x, p.y, p.z, p.z));
    for (const l of pack.features.labels) {
      if (!l.name || (l.kind !== 'town' && l.kind !== 'village' && l.kind !== 'city')) continue;
      const z = l.z > 0 ? l.z : pack.groundHeight(l.x, l.y);
      this.items.push(this.make(l.name, 'town', l.x, l.y, z, l.kind === 'city' ? 3 : l.kind === 'town' ? 2 : 1));
    }
  }

  private make(name: string, kind: 'peak' | 'town', x: number, y: number, z: number, prio: number): Item {
    const el = document.createElement('div');
    el.className = `label ${kind}`;
    el.innerHTML = kind === 'peak' ? `<span class="tick"></span>${name}<span class="alt"></span>` : name;
    el.style.display = 'none';
    this.el.appendChild(el);
    return { name, kind, x, y, z, el, prio };
  }

  destroy(): void { this.el.remove(); }

  /** Sight-line test: true when the ground along the ray stays below the line to the target. */
  private clear(cx: number, cy: number, cz: number, x: number, y: number, z: number): boolean {
    const far = this.pack.far ?? this.pack.mid;
    if (!far) return true;
    const d = Math.hypot(x - cx, y - cy);
    const n = Math.min(40, Math.max(6, Math.floor(d / 1500)));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const px = cx + (x - cx) * t, py = cy + (y - cy) * t;
      const h = far.sample(px, py);
      if (Number.isNaN(h)) continue;
      const line = cz + (z - cz) * t;
      if (h > line + 15) return false;
    }
    return true;
  }

  update(camera: THREE.PerspectiveCamera, metric: boolean): void {
    this.frame++;
    if (!this.visible) { if (this.frame % 30 === 0) for (const it of this.items) it.el.style.display = 'none'; return; }
    if (this.frame % 4 !== 0) return; // 15 Hz is plenty for labels
    const cx = camera.position.x, cy = -camera.position.z, cz = camera.position.y;
    const W = window.innerWidth, H = window.innerHeight;
    const placed: [number, number, number, number][] = [];
    const overlaps = (b: [number, number, number, number]) => placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
    // candidates in range, sorted by priority (peaks: height then nearness; towns: size)
    const cands = this.items
      .map((it) => ({ it, d: Math.hypot(it.x - cx, it.y - cy) }))
      .filter(({ it, d }) => d > 300 && d < (it.kind === 'peak' ? PEAK_RANGE : TOWN_RANGE))
      .sort((a, b) => (b.it.prio - b.d * 0.01) - (a.it.prio - a.d * 0.01));
    let nPeaks = 0, nTowns = 0;
    for (const it of this.items) it.el.style.display = 'none';
    for (const { it, d } of cands) {
      if (it.kind === 'peak' ? nPeaks >= MAX_PEAKS : nTowns >= MAX_TOWNS) continue;
      this.v.set(it.x, it.z + (it.kind === 'peak' ? 0 : 30), -it.y).project(camera);
      if (this.v.z > 1 || this.v.z < -1 || Math.abs(this.v.x) > 1.05 || Math.abs(this.v.y) > 1.05) continue;
      if (!this.clear(cx, cy, cz, it.x, it.y, it.z)) continue;
      const sx = (this.v.x + 1) / 2 * W, sy = (1 - this.v.y) / 2 * H;
      const w = 20 + it.name.length * 7, h = 22;
      const box: [number, number, number, number] = [sx - w / 2, sy - h - 10, sx + w / 2, sy + 4];
      if (overlaps(box)) continue;
      placed.push(box);
      const fade = it.kind === 'peak' ? 1 - Math.max(0, (d - 30000) / (PEAK_RANGE - 30000)) * 0.6 : 1 - Math.max(0, (d - 15000) / (TOWN_RANGE - 15000)) * 0.6;
      it.el.style.display = 'block';
      it.el.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -100%)`;
      it.el.style.opacity = fade.toFixed(2);
      if (it.kind === 'peak') { (it.el.lastElementChild as HTMLElement).textContent = metric ? ` ${it.z.toFixed(0)} m` : ` ${(it.z * 3.28084).toFixed(0)} ft`; nPeaks++; }
      else nTowns++;
    }
  }
}
