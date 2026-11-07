import * as THREE from 'three';

/**
 * Small coloured particle bursts (Outrun, FEAT-099 to FEAT-101): snow spray off the monster's
 * feet, puffs at snapped trees, the confetti of the eat sequence, the burp cloud. One Points
 * object over a ring buffer; particles fall slowly and fade out.
 */
const MAX = 3000;

function softTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,0.7)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Puffs {
  readonly points: THREE.Points;
  private readonly pos = new Float32Array(MAX * 3);
  private readonly col = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly life = new Float32Array(MAX);
  private readonly life0 = new Float32Array(MAX);
  private readonly drag = new Float32Array(MAX);
  private head = 0;
  private readonly c = new THREE.Color();

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.pos.fill(-10000);
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.45, vertexColors: true, map: softTexture(), transparent: true, opacity: 0.9, depthWrite: false, alphaTest: 0.05 }));
    this.points.frustumCulled = false;
    this.points.name = 'puffs';
  }

  /**
   * Burst `n` particles at (x, y, z) (three.js frame): `spread` m around the point, `speed` m/s
   * outward plus `up` m/s, `colors` picked per particle, `life` s (randomised +/- 40%).
   */
  emit(x: number, y: number, z: number, n: number, colors: (number | string)[], spread = 0.3, speed = 2, up = 2, life = 0.8, drag = 2): void {
    for (let k = 0; k < n; k++) {
      const i = this.head; this.head = (i + 1) % MAX;
      const a = Math.random() * Math.PI * 2, b = (Math.random() - 0.5) * Math.PI;
      const cb = Math.cos(b);
      this.pos[i * 3] = x + (Math.random() - 0.5) * spread; this.pos[i * 3 + 1] = y + (Math.random() - 0.5) * spread; this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * spread;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.vel[i * 3] = Math.cos(a) * cb * s; this.vel[i * 3 + 1] = Math.sin(b) * s + up * (0.5 + Math.random()); this.vel[i * 3 + 2] = Math.sin(a) * cb * s;
      this.c.set(colors[Math.floor(Math.random() * colors.length)]);
      this.col[i * 3] = this.c.r; this.col[i * 3 + 1] = this.c.g; this.col[i * 3 + 2] = this.c.b;
      this.life[i] = this.life0[i] = life * (0.6 + Math.random() * 0.8);
      this.drag[i] = drag;
    }
    (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number): void {
    const p = this.pos, v = this.vel, l = this.life;
    for (let i = 0; i < MAX; i++) {
      if (l[i] <= 0) continue;
      l[i] -= dt;
      if (l[i] <= 0) { p[i * 3 + 1] = -10000; continue; }
      const f = Math.exp(-dt * this.drag[i]);
      v[i * 3] *= f; v[i * 3 + 2] *= f; v[i * 3 + 1] = v[i * 3 + 1] * f - 3 * dt;
      p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt;
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void { this.points.geometry.dispose(); (this.points.material as THREE.Material).dispose(); }
}
