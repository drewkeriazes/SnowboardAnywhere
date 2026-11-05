/**
 * Spatial hash of vertical cylinders (tree trunks, rocks) for rider collisions.
 * Cells are 8 m; lookups check the 3x3 neighbourhood.
 */
const CELL = 8;

export interface Hit {
  x: number;
  y: number;
  nx: number;
  ny: number;
}

export class Collider {
  private readonly cells = new Map<string, Float32Array[]>(); // packed [x, y, radius, zBase, zTop]
  private readonly hit: Hit = { x: 0, y: 0, nx: 0, ny: 0 };

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  add(x: number, y: number, radius: number, zBase: number, zTop: number): void {
    const k = this.key(Math.floor(x / CELL), Math.floor(y / CELL));
    let arr = this.cells.get(k);
    if (!arr) { arr = []; this.cells.set(k, arr); }
    arr.push(new Float32Array([x, y, radius, zBase, zTop]));
  }

  clearCell(cellKey: string): void {
    this.cells.delete(cellKey);
  }

  /** Remove everything inside a rectangle (used when an instance cell unloads). */
  clearRect(minX: number, minY: number, maxX: number, maxY: number): void {
    for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) this.cells.delete(this.key(cx, cy));
    }
  }

  /** Push a circle of radius r at (x, y, z) out of any cylinder it overlaps. Returns the hit or null. */
  resolve(x: number, y: number, z: number, r: number): Hit | null {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    let found: Hit | null = null;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const arr = this.cells.get(this.key(cx + i, cy + j));
        if (!arr) continue;
        for (const c of arr) {
          if (z > c[4] || z + 1.5 < c[3]) continue;
          const dx = x - c[0], dy = y - c[1];
          const d = Math.hypot(dx, dy);
          const min = c[2] + r;
          if (d < min) {
            const nx = d > 1e-4 ? dx / d : 1, ny = d > 1e-4 ? dy / d : 0;
            x = c[0] + nx * min; y = c[1] + ny * min;
            this.hit.x = x; this.hit.y = y; this.hit.nx = nx; this.hit.ny = ny;
            found = this.hit;
          }
        }
      }
    }
    return found;
  }

  get count(): number {
    let n = 0;
    for (const a of this.cells.values()) n += a.length;
    return n;
  }
}
