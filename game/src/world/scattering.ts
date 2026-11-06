/**
 * Single-scattering atmosphere on the CPU (Rayleigh + Mie + ozone absorption over a spherical
 * Earth), in the spirit of Bruneton 2008 / Hillaire 2020 but small enough to rebuild in a few ms
 * whenever the sun moves. A transmittance table is built once; the sky-view table (radiance per
 * view direction, azimuth taken relative to the sun) is rebuilt per sun position. Values are
 * radiance per unit sun illuminance; the caller scales them into the renderer's range.
 * No three.js here so it can be checked from node.
 */

export const RG = 6360e3, RT = 6460e3;
const BR = [5.802e-6, 13.558e-6, 33.1e-6], HR = 8000;
const BM_S = 3.996e-6, BM_E = 4.40e-6, HM = 1200;
const BO = [0.650e-6, 1.881e-6, 0.085e-6];

export interface Air {
  /** Mie (aerosol) density multiplier: 1 = clean mountain air */
  mie: number;
  /** Mie phase asymmetry */
  g: number;
  /** cheap isotropic multiple-scattering factor (brightens the horizon and twilight) */
  ms: number;
}
export const CLEAR_AIR: Air = { mie: 1, g: 0.8, ms: 0.18 };

/** Rayleigh extinction per metre at sea level, for the shader's analytic air layer. */
export const RAYLEIGH_SEA = BR;
export const RAYLEIGH_H = HR;

function ozone(h: number): number { return Math.max(0, 1 - Math.abs(h - 25000) / 15000); }

function distToTop(r: number, mu: number): number {
  const d = r * r * (mu * mu - 1) + RT * RT;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(0, d)));
}
function distToGround(r: number, mu: number): number {
  if (mu >= 0) return -1;
  const d = r * r * (mu * mu - 1) + RG * RG;
  return d < 0 ? -1 : -r * mu - Math.sqrt(d);
}

// ---------------------------------------------------------------- transmittance table
const TH = 48, TM = 192;
let trans: Float32Array | null = null;
let transMie = -1;
function hOf(i: number): number { const x = i / (TH - 1); return x * x * (RT - RG); }
function muOf(j: number): number { const s = -0.5 + 1.5 * j / (TM - 1); return Math.sign(s) * s * s; }

function buildTransmittance(air: Air): Float32Array {
  const t = new Float32Array(TH * TM * 3);
  const steps = 40;
  for (let i = 0; i < TH; i++) {
    const r = RG + hOf(i);
    for (let j = 0; j < TM; j++) {
      const mu = muOf(j), o = (i * TM + j) * 3;
      if (distToGround(r, mu) >= 0) continue; // the Earth blocks the sun: zero
      const len = distToTop(r, mu), ds = len / steps;
      let dr = 0, dm = 0, dz = 0;
      for (let k = 0; k < steps; k++) {
        const s = (k + 0.5) * ds;
        const h = Math.sqrt(r * r + s * s + 2 * r * mu * s) - RG;
        dr += Math.exp(-h / HR) * ds; dm += Math.exp(-h / HM) * ds; dz += ozone(h) * ds;
      }
      for (let c = 0; c < 3; c++) t[o + c] = Math.exp(-(BR[c] * dr + BM_E * air.mie * dm + BO[c] * dz));
    }
  }
  return t;
}

/** Transmittance from altitude `h` (m above sea level) toward a direction with cosine `mu` to the zenith, to space. */
export function transmittance(h: number, mu: number, out: number[], air: Air = CLEAR_AIR): number[] {
  if (!trans || transMie !== air.mie) { trans = buildTransmittance(air); transMie = air.mie; }
  const fi = Math.sqrt(Math.min(1, Math.max(0, h / (RT - RG)))) * (TH - 1);
  const s = Math.sign(mu) * Math.sqrt(Math.abs(mu));
  const fj = Math.min(TM - 1, Math.max(0, (s + 0.5) / 1.5 * (TM - 1)));
  const i0 = Math.min(TH - 2, Math.floor(fi)), j0 = Math.min(TM - 2, Math.floor(fj));
  const a = fi - i0, b = fj - j0, t = trans;
  for (let c = 0; c < 3; c++) {
    const v00 = t[(i0 * TM + j0) * 3 + c], v01 = t[(i0 * TM + j0 + 1) * 3 + c];
    const v10 = t[((i0 + 1) * TM + j0) * 3 + c], v11 = t[((i0 + 1) * TM + j0 + 1) * 3 + c];
    out[c] = (v00 * (1 - b) + v01 * b) * (1 - a) + (v10 * (1 - b) + v11 * b) * a;
  }
  return out;
}

// ---------------------------------------------------------------- sky radiance
const tmp = [0, 0, 0];
/**
 * Single-scattered radiance (per unit sun illuminance) seen from altitude `alt` looking at
 * elevation `el` and azimuth `phi` from the sun's azimuth (radians), sun at elevation `sunEl`.
 */
export function skyRadiance(alt: number, el: number, phi: number, sunEl: number, out: number[], air: Air = CLEAR_AIR, steps = 32): number[] {
  const r0 = RG + alt;
  const dx = Math.cos(el) * Math.cos(phi), dy = Math.sin(el), dz = Math.cos(el) * Math.sin(phi);
  const sx = Math.cos(sunEl), sy = Math.sin(sunEl);
  const nu = dx * sx + dy * sy; // cos of the scattering angle
  const phR = 3 / (16 * Math.PI) * (1 + nu * nu);
  const g = air.g, g2 = g * g;
  const phM = 3 / (8 * Math.PI) * (1 - g2) * (1 + nu * nu) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * nu, 1.5));
  const ground = distToGround(r0, dy);
  const len = ground >= 0 ? ground : distToTop(r0, dy);
  out[0] = out[1] = out[2] = 0;
  const T = [1, 1, 1];
  // steps bunched near the viewer, where the air is densest
  let prev = 0;
  for (let k = 0; k < steps; k++) {
    const u = (k + 1) / steps, s1 = len * u * u, ds = s1 - prev, s = prev + ds * 0.5;
    prev = s1;
    const px = dx * s, py = r0 + dy * s, pz = dz * s;
    const r = Math.sqrt(px * px + py * py + pz * pz), h = r - RG;
    const muS = (px * sx + py * sy) / r;
    const rhoR = Math.exp(-h / HR), rhoM = Math.exp(-h / HM) * air.mie, rhoO = ozone(h);
    transmittance(h, muS, tmp, air);
    // isotropic multiple-scattering stand-in, fading softly across the Earth's shadow line
    const msLit = Math.min(1, Math.max(0, (muS + 0.25) / 0.3));
    for (let c = 0; c < 3; c++) {
      const sR = BR[c] * rhoR, sM = BM_S * rhoM;
      const ext = BR[c] * rhoR + BM_E * rhoM + BO[c] * rhoO;
      const S = tmp[c] * (sR * phR + sM * phM) + (sR + sM) * air.ms * msLit * (0.25 + 0.75 * tmp[c]) / (4 * Math.PI);
      const tr = Math.exp(-ext * ds);
      out[c] += T[c] * S * (1 - tr) / Math.max(ext, 1e-12);
      T[c] *= tr;
    }
  }
  return out;
}

/** Sky-view table layout: x = azimuth from the sun 0..pi, y = elevation, squeezed toward the horizon. */
export const SKY_W = 32, SKY_H = 64;
export function skyV(el: number): number { const e = el / (Math.PI / 2); return 0.5 + 0.5 * Math.sign(e) * Math.sqrt(Math.min(1, Math.abs(e))); }
function elOfV(v: number): number { const s = (v - 0.5) * 2; return Math.sign(s) * s * s * Math.PI / 2; }

/** RGBA float sky-view table for a sun elevation, radiance scaled by `scale`. */
export function buildSkyView(alt: number, sunEl: number, scale: number, air: Air = CLEAR_AIR, out = new Float32Array(SKY_W * SKY_H * 4)): Float32Array {
  const L = [0, 0, 0];
  for (let y = 0; y < SKY_H; y++) {
    const el = elOfV((y + 0.5) / SKY_H);
    for (let x = 0; x < SKY_W; x++) {
      const phi = (x + 0.5) / SKY_W * Math.PI;
      skyRadiance(alt, el, phi, sunEl, L, air);
      const o = (y * SKY_W + x) * 4;
      out[o] = L[0] * scale; out[o + 1] = L[1] * scale; out[o + 2] = L[2] * scale; out[o + 3] = 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------- display transform (matches three's ACESFilmic + sRGB)
function rrt(v: number): number { return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081); }
function srgb(c: number): number { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
/** Linear radiance -> display value exactly as a three.js material outputs it (ACES filmic, exposure, sRGB). */
export function toDisplay(rgb: number[], exposure: number, out: number[]): number[] {
  const k = exposure / 0.6;
  const r = rgb[0] * k, g = rgb[1] * k, b = rgb[2] * k;
  const a0 = rrt(0.59719 * r + 0.35458 * g + 0.04823 * b);
  const a1 = rrt(0.07600 * r + 0.90834 * g + 0.01566 * b);
  const a2 = rrt(0.02840 * r + 0.13383 * g + 0.83777 * b);
  const o0 = 1.60475 * a0 - 0.53108 * a1 - 0.07367 * a2;
  const o1 = -0.10208 * a0 + 1.10813 * a1 - 0.00605 * a2;
  const o2 = -0.00327 * a0 - 0.07276 * a1 + 1.07602 * a2;
  out[0] = srgb(Math.min(1, Math.max(0, o0))); out[1] = srgb(Math.min(1, Math.max(0, o1))); out[2] = srgb(Math.min(1, Math.max(0, o2)));
  return out;
}
