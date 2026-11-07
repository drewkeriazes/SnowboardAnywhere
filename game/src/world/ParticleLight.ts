import * as THREE from 'three';

/**
 * BUG-046: the snow spray and puffs are THREE.Points with an unlit PointsMaterial, so they stayed
 * full white at dusk. This works out, once per frame, the colour that flat snow at the rider would
 * have under the scene's lights (same Lambert maths three.js uses for the terrain: albedo / pi times
 * sun + sky irradiance), with the sun term dropped when a ridge between the rider and the sun puts
 * the rider in the shade. Multiply the particle material colour by it.
 */
const SNOW_ALBEDO = 0.9;
const SHADE_EASE = 0.35; // s to blend between sun and shade, so the spray does not pop at a shadow edge

export interface LightSource {
  sun: { color: THREE.Color; intensity: number };
  hemi: { color: THREE.Color; intensity: number };
  sunDir: THREE.Vector3; // three.js axes, unit, towards the sun
}

export class ParticleLight {
  readonly color = new THREE.Color(1, 1, 1);
  /** 1 in the sun, 0 in a ridge's shadow, eased */
  sunlit = 1;
  private readonly tmp = new THREE.Color();

  /**
   * @param ground terrain height in pack metres (x east, y north), for the shade test
   * @param x,y,z the rider in pack metres
   */
  update(dt: number, L: LightSource, ground: (x: number, y: number) => number, x: number, y: number, z: number): THREE.Color {
    const target = this.inSun(L.sunDir, ground, x, y, z) ? 1 : 0;
    const k = Math.min(1, dt / SHADE_EASE);
    this.sunlit += (target - this.sunlit) * k;
    const nDotL = Math.max(0, L.sunDir.y); // flat snow, normal straight up
    const c = this.color.copy(L.hemi.color).multiplyScalar(L.hemi.intensity);
    c.add(this.tmp.copy(L.sun.color).multiplyScalar(L.sun.intensity * nDotL * this.sunlit));
    return c.multiplyScalar(SNOW_ALBEDO / Math.PI);
  }

  /** march toward the sun over the heightfield: any ground above the ray means a ridge shades the rider */
  private inSun(d: THREE.Vector3, ground: (x: number, y: number) => number, x: number, y: number, z: number): boolean {
    if (d.y <= 0) return false;
    const dx = d.x, dy = -d.z, dz = d.y; // three.js -> pack axes
    for (let s = 4; s < 3000; s *= 1.35) {
      const h = ground(x + dx * s, y + dy * s);
      if (h > z + 1 + dz * s) return false;
    }
    return true;
  }
}
