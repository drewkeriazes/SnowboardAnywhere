import * as THREE from 'three';

export interface Terrain {
  mesh: THREE.Mesh;
  /** World-space height at (x, z), bilinear. Physics samples this. */
  heightAt(x: number, z: number): number;
}

interface Options {
  size: number;      // metres across
  segments: number;  // grid cells per side
  amplitude: number; // vertical range in metres
}

/** Fractal-noise heightfield so the viewer and physics can be built before real data lands. */
export function createPlaceholderTerrain({ size, segments, amplitude }: Options): Terrain {
  const n = segments + 1;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / segments, v = j / segments;
      heights[j * n + i] = fbm(u * 4, v * 4) * amplitude + (1 - v) * amplitude * 1.5; // slopes down toward +z
    }
  }

  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let k = 0; k < pos.count; k++) pos.setY(k, heights[k]);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ color: 0xf2f6fb, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;

  const half = size / 2;
  const cell = size / segments;
  function heightAt(x: number, z: number): number {
    const fx = THREE.MathUtils.clamp((x + half) / cell, 0, segments - 1e-6);
    const fz = THREE.MathUtils.clamp((z + half) / cell, 0, segments - 1e-6);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const h00 = heights[j * n + i], h10 = heights[j * n + i + 1];
    const h01 = heights[(j + 1) * n + i], h11 = heights[(j + 1) * n + i + 1];
    return THREE.MathUtils.lerp(THREE.MathUtils.lerp(h00, h10, tx), THREE.MathUtils.lerp(h01, h11, tx), tz);
  }

  return { mesh, heightAt };
}

// Cheap value-noise fBm; replaced by real heightmap tiles in M1.
function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number): number {
  let sum = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 5; o++) { sum += noise(x * freq, y * freq) * amp; freq *= 2; amp *= 0.5; }
  return sum;
}
