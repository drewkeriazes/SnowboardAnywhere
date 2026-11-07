/**
 * BUG-043: CPU copy of the terrain shader's near-field rock and scree coverage (TerrainMaterial.ts,
 * `rockCov` / `screeCov`), so the snow track, the rider's grip and the boot prints treat as rock
 * exactly the patches the player sees as rock. Same value noise (rockShader.ts NOISE_GLSL), same
 * thresholds, near-field values (the fine octave on, the narrowest edge). The ledge term uses the
 * terrain normal instead of the rock texture's detail normal, a close approximation.
 *
 * Positions are three.js world metres (x east, y up, z = -north), as in the shader.
 */
const fract = (v: number): number => v - Math.floor(v);

const f32 = Math.fround;
/** the shader's hash in 32-bit float steps: its last fract() keeps only a few bits, so doubles would drift */
function hash3(x: number, y: number, z: number): number {
  let px = f32(fract(f32(f32(x * f32(0.3183099)) + f32(0.1)))), py = f32(fract(f32(f32(y * f32(0.3183099)) + f32(0.2)))), pz = f32(fract(f32(f32(z * f32(0.3183099)) + f32(0.3))));
  px = f32(px * 17); py = f32(py * 17); pz = f32(pz * 17);
  return f32(fract(f32(f32(f32(px * py) * pz) * f32(f32(px + py) + pz))));
}

export function vnoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
  return mix(
    mix(mix(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), fx), mix(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), fx), fy),
    mix(mix(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), fx), mix(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), fx), fy),
    fz,
  );
}

const smoothstep = (a: number, b: number, v: number): number => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const EDGE = 0.025; // the shader's edge width up close

export interface Cover { rock: number; scree: number }

/**
 * @param wRock, wScree mask weights at the point (0..1)
 * @param x, y, z three.js world position
 * @param ny up component of the ground normal (1 = flat)
 */
export function rockCover(wRock: number, wScree: number, x: number, y: number, z: number, ny: number, out: Cover = { rock: 0, scree: 0 }): Cover {
  let rock = 0;
  if (wRock > 0.15) { // under this the noise (+/- 0.3) can never lift it past 0.5
    const bn = vnoise(x * 0.09, y * 0.09, z * 0.09) * 0.5 + vnoise(x * 0.31 + 3.1, y * 0.31 + 3.1, z * 0.31 + 3.1) * 0.3 + vnoise(x * 1.1 + 7.7, y * 1.1 + 7.7, z * 1.1 + 7.7) * 0.2;
    rock = smoothstep(0.5 - EDGE, 0.5 + EDGE, wRock + (bn - 0.5) * 0.6);
    const ledge = smoothstep(0.8, 0.93, ny + (vnoise(x * 0.6, y * 0.6, z * 0.6) - 0.5) * 0.12);
    rock *= 1 - 0.9 * ledge;
  }
  let scree = 0;
  if (wScree > 0.05) {
    const bn2 = vnoise(x * 0.17 + 11, y * 0.17 + 11, z * 0.17 + 11) * 0.6 + vnoise(x * 0.8 + 5, y * 0.8 + 5, z * 0.8 + 5) * 0.4;
    scree = smoothstep(0.5 - EDGE, 0.5 + EDGE, wScree * 0.65 + (bn2 - 0.5) * 0.7) * (1 - rock);
  }
  out.rock = rock; out.scree = scree;
  return out;
}
