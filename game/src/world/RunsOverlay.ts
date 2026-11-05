import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Difficulty } from '../pack/types';

const COLORS: Record<string, number> = {
  novice: 0x22c55e,
  easy: 0x22c55e,
  intermediate: 0x3b82f6,
  advanced: 0x111111,
  expert: 0x111111,
  extreme: 0xf97316,
  freeride: 0xf97316,
};

/** Piste centre lines draped just above the snow, coloured by difficulty. Toggle with M. */
export class RunsOverlay {
  readonly group = new THREE.Group();

  constructor(pack: Pack) {
    for (const run of pack.features.runs) {
      if (run.points.length < 2) continue;
      const pts = run.points.map(([x, y, z]) => new THREE.Vector3(x, Math.max(z, pack.groundHeight(x, y)) + 0.6, -y));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color: COLORS[(run.difficulty ?? 'intermediate') as Difficulty] ?? 0x888888, transparent: true, opacity: 0.85 });
      const line = new THREE.Line(geo, mat);
      line.userData.run = run;
      this.group.add(line);
    }
    this.group.visible = false;
  }

  toggle(): void {
    this.group.visible = !this.group.visible;
  }
}
