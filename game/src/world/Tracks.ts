import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Rider } from '../sim/Rider';
import { rockCover } from '../terrain/rockCover';
import { carveLean } from './carveLean';

/**
 * Tracks in the snow as real 3D grooves. Every STEP metres on the snow a cross-section is laid
 * across the line of travel:
 *
 *   snow ____/‾‾\                    /‾‾\____ snow
 *                \__________________/
 *       berm lip   wall   pressed floor   wall   berm lip
 *
 * The floor is DEPTH below the surface (about 2 in), the walls are steep, and the snow pushed
 * aside forms a low lip each side; the outer edge blends into the terrain with alpha 0. Because
 * the floor is below the terrain surface, the vertex shader pulls the depth value a few cm toward
 * the camera so the terrain does not hide it, while real objects in front still occlude it.
 * Clean narrow groove when carving, wide shallow smear when skidding, deeper in powder.
 * Skis cut two narrow grooves. On edge the trench morphs with the carve (FEAT-109): a light turn
 * is a wedge, deep under the engaged edge and rising to the surface on the base side; a committed
 * carve collapses it to a knife cut about 1 cm wide under the edge itself, a sharp wall on the
 * inside of the turn, a smooth slant where the base pressed the snow on the outside, and a small
 * spray lip there only. Skis leave two such lines. The vertex shader holds every section open to a
 * minimum width that grows with distance, so a thin line stays a stable line instead of flickering.
 * The width is the board's footprint across the travel direction,
 * L |sin(gamma)| + W |cos(gamma)| for slip angle gamma (FEAT-065), so a hockey stop scrapes a band
 * about a board length wide: a shallow, polished floor with a ridge of pushed snow on the downhill
 * side that grows as the rider slows. Ring buffer of MAX sections per lane (about 3 km); old track
 * fills back in (depth and alpha fade) over FADE seconds.
 */
const MAX = 6000;
const STEP = 0.5; // m between sections
/** BUG-019: below this speed (m/s) the track keeps its last direction */
const ACROSS_FREEZE = 1;
/** BUG-019: the band may grow this many m of half width per m ridden */
const HALF_GROW_PER_M = 0.5;
const DEPTH = 0.05; // m, about 2 in on a groomer
export const FADE = 600; // s until the snow has filled the track back in in clear weather (bootprints too)
/**
 * How many times faster tracks and boot prints fill in while it snows (FEAT-107): clear 1, flurries 2,
 * storm 5 (a groove is gone in about 2 minutes). Depth goes first and the edges fade last, because the
 * alpha only drops once fill is under a third, so a filling track softens into a faint dent.
 */
export const FILL_RATE = { clear: 1, flurries: 2, storm: 5 } as const;
let fillRate: number = FILL_RATE.clear;
export function setTrackFillRate(rate: number): void { fillRate = rate; }
export const trackFillRate = (): number => fillRate;
/** BUG-043: rock coverage above which no groove is laid, and where it starts to fade out */
const ROCK_CUT = 0.5, ROCK_FADE = 0.3;
// cross-section profile: [offset across in units of the half width (+ fixed metres), height factor of DEPTH, alpha]
// x = sx * half + dx
const PROFILE: { sx: number; dx: number; h: number; a: number }[] = [
  { sx: -1, dx: -0.09, h: 0.0, a: 0 },   // outer edge, blends into snow
  { sx: -1, dx: -0.04, h: 0.35, a: 0.45 },  // berm lip (feathered, BUG-021)
  { sx: -1, dx: 0.0, h: 0.15, a: 1 },    // wall top
  { sx: -1, dx: 0.025, h: -1.0, a: 1 },  // floor edge
  { sx: 1, dx: -0.025, h: -1.0, a: 1 },  // floor edge
  { sx: 1, dx: 0.0, h: 0.15, a: 1 },
  { sx: 1, dx: 0.04, h: 0.35, a: 0.45 },
  { sx: 1, dx: 0.09, h: 0.0, a: 0 },
];
const P = PROFILE.length;
const UP = [0, 1, 0];
/** BUG-021: the terrain's typical snow albedo: mix(uSnowShade, uSnow, 0.72) times its 0.95 grain tone */
const SNOW_RGB = [0.83, 0.86, 0.94];
/** floats stored per section */
const SEC = 14; // ... + terrain normal (three.js x, y, z) at the centre (BUG-021)
/** the berm and lip spread wider when scraping, so the ridge is a mound rather than a spike */
const lipWidth = (polish: number) => 1 + 2.5 * polish;
/**
 * 0..1 how far the groove has collapsed from a trench into the knife cut of a committed carve:
 * smoothstep over the edge amount, so a light turn is still a wedge and only a hard carve is a line.
 */
export const edgeCurve = (edge: number) => { const t = Math.min(1, Math.max(0, (edge - 0.15) / 0.65)); return t * t * (3 - 2 * t); };
/** the base side of a knife cut: the board's base presses a slant from the floor up to the surface over this many metres across */
const SLANT = 0.06;
/** the smallest half width of a section (a knife cut is about 1 cm wide) */
export const MIN_HALF = 0.005;
/** how the profile morphs on one side: + toward the sharp engaged wall, - toward the base slant, scaled by the carve amount */
const sideMorph = (side: number, tilt: number) => side * Math.sign(tilt) * edgeCurve(Math.abs(tilt));
/** across-track offset of profile vertex k: the floor inset shrinks with the width, the base side slides out along the slant */
const profileOff = (k: number, half: number, lw: number, tilt: number) => {
  const pr = PROFILE[k];
  if (pr.h < 0) return pr.sx * Math.max(0, half - Math.min(0.025, 0.45 * half));
  const dis = Math.max(0, -sideMorph(pr.sx, tilt));
  return pr.sx * (half + dis * SLANT) + pr.dx * (Math.abs(pr.dx) > 0.03 ? lw : 1);
};

class Lane {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  private readonly col: Float32Array;
  /** per vertex: unit outward across vector (three.js x, y, z) and the vertex's across offset, for the minimum on-screen width */
  private readonly spr: Float32Array;
  private readonly idx: Uint32Array;
  // per section: the data needed to re-shape it as it fills in
  private readonly secC: Float32Array; // centre x, y, z(surface) in three.js coords, across x, across z, half width, depth, tilt, ridge (m), ridge side, polish
  private readonly age: Float32Array;
  private head = 0;
  private count = 0;
  private lastSlot = -1;
  private readonly geo: THREE.BufferGeometry;

  constructor(material: THREE.Material) {
    this.pos = new Float32Array(MAX * P * 3);
    this.nor = new Float32Array(MAX * P * 3);
    this.col = new Float32Array(MAX * P * 4);
    this.spr = new Float32Array(MAX * P * 4);
    this.idx = new Uint32Array(MAX * (P - 1) * 6);
    this.secC = new Float32Array(MAX * SEC);
    this.age = new Float32Array(MAX).fill(1e9);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSpread', new THREE.BufferAttribute(this.spr, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(this.idx, 1).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.name = 'board tracks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.receiveShadow = true;
  }

  gap(): void { this.lastSlot = -1; }

  /**
   * Add a section. (cx, cy, cz) centre on the snow in three.js coords; (ax, az) unit vector
   * across the track (three.js x/z); half width; depth (m); surface(x, z) returns the snow height.
   * Scraping: ridge height (m) of pushed snow, ridgeSide -1..1 (which lip gets it, + = the right
   * side), polish 0..1 (how much the floor is a flat scraped band rather than a cut groove).
   */
  add(cx: number, cy: number, cz: number, ax: number, az: number, half: number, depth: number, tilt: number, surface: (x: number, z: number) => number, ridge = 0, ridgeSide = 0, polish = 0, fill = 1, gn: ArrayLike<number> = UP): void {
    const s = this.head;
    const o = s * SEC, c = this.secC;
    c[o] = cx; c[o + 1] = cy; c[o + 2] = cz; c[o + 3] = ax; c[o + 4] = az; c[o + 5] = half; c[o + 6] = depth; c[o + 7] = tilt;
    c[o + 8] = ridge; c[o + 9] = ridgeSide; c[o + 10] = polish;
    c[o + 11] = gn[0]; c[o + 12] = gn[1]; c[o + 13] = gn[2];
    this.age[s] = FADE * (1 - fill); // fill < 1 (a rock edge, BUG-043) starts part filled in: shallower and fainter
    // snow heights under each profile vertex (follow the slope across the track)
    const lw = lipWidth(polish);
    for (let k = 0; k < P; k++) {
      const off = profileOff(k, half, lw, tilt);
      this.ground[s * P + k] = surface(cx + ax * off, cz + az * off);
    }
    this.shape(s);
    // quads to the previous section of this stroke
    const q = s * (P - 1) * 6;
    if (this.lastSlot >= 0) {
      const a = this.lastSlot * P, b = s * P;
      for (let k = 0; k < P - 1; k++) this.idx.set([a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k], q + k * 6);
    } else this.idx.fill(0, q, q + (P - 1) * 6);
    // the quads stored at the next slot joined the section we just overwrote: break them
    const nq = ((s + 1) % MAX) * (P - 1) * 6;
    this.idx.fill(0, nq, nq + (P - 1) * 6);
    this.lastSlot = s;
    this.head = (s + 1) % MAX;
    this.count = Math.min(MAX, this.count + 1);
    this.geo.index!.needsUpdate = true;
    this.flag();
  }
  private readonly ground = new Float32Array(MAX * P);

  /** Write positions, normals and colours of section s from its stored data and age. */
  private shape(s: number): void {
    const o = s * SEC;
    const cx = this.secC[o], cz = this.secC[o + 2], ax = this.secC[o + 3], az = this.secC[o + 4], half = this.secC[o + 5];
    const ridgeSide = this.secC[o + 9], polish = this.secC[o + 10], lw = lipWidth(polish);
    // tilt -1..1: the board on its edge. Positive = the right-hand edge is engaged: that side of the
    // floor is deepest with a near-vertical wall, the other side rises to a shallow shelf, and the
    // displaced snow piles up on the outside of the turn.
    const tilt = this.secC[o + 7];
    const ringAge = ((this.head - s + MAX) % MAX) / MAX;
    const fill = Math.max(0, 1 - this.age[s] / FADE) * (1 - ringAge * ringAge); // 1 fresh .. 0 filled in
    const depth = this.secC[o + 6] * fill;
    const ridge = this.secC[o + 8] * fill;
    // ec 0..1: how far the trench has collapsed into the knife cut of a committed carve (FEAT-109)
    const ec = edgeCurve(Math.abs(tilt));
    const xs: number[] = [], ys: number[] = [];
    for (let k = 0; k < P; k++) {
      const pr = PROFILE[k];
      const off = profileOff(k, half, lw, tilt);
      const side = pr.sx; // -1 left, +1 right
      const e = side * tilt; // + this side is the engaged edge (inside of the turn), - the base side
      const m = sideMorph(side, tilt), eng = Math.max(0, m), dis = Math.max(0, -m);
      let h = pr.h;
      // floor: a wedge, deep at the engaged edge and rising toward the surface at the other, that
      // turns into a deep narrow slot as the carve commits
      if (h < 0) h = e > 0 ? -(1 + 0.85 * e * (1 - 0.5 * ec)) : -(1 + 0.85 * e * (1 - ec));
      // wall top: sharp and low on the engaged side, at the surface at the end of the base slant
      else if (pr.h > 0.1 && pr.h < 0.2) h = pr.h * (1 - dis) * (1 - 0.7 * eng);
      // lip: bigger on the outside of the turn; a knife cut keeps only a small spray lip there
      else if (pr.h > 0.2) h = pr.h * (1 - 0.6 * e) * (1 - 0.8 * eng) * (1 - 0.6 * dis);
      // pushed snow: a ridge on the downhill lip (a little on the other), half height at the wall top
      const rs = 0.25 + 0.75 * Math.max(0, side * ridgeSide);
      const rh = pr.h > 0.2 ? ridge * rs : pr.h > 0.1 ? 0.5 * ridge * rs : 0;
      xs.push(off); ys.push(this.ground[s * P + k] + h * depth + rh);
      const v = (s * P + k) * 3;
      this.pos[v] = cx + ax * off; this.pos[v + 1] = ys[k]; this.pos[v + 2] = cz + az * off;
      const q = (s * P + k) * 4;
      this.spr[q] = ax * side; this.spr[q + 1] = 0; this.spr[q + 2] = az * side; this.spr[q + 3] = Math.abs(off);
    }
    // normals from the profile slope across the track (smoothed between neighbours); the wall
    // vertices of a carve take the wall's own slope so a 1 cm wall still catches the light
    const gx = this.secC[o + 11], gy = this.secC[o + 12], gz = this.secC[o + 13];
    // the across direction made perpendicular to the slope normal
    const ad = ax * gx + az * gz;
    let tax = ax - gx * ad, tay = -gy * ad, taz = az - gz * ad;
    const tl = Math.hypot(tax, tay, taz) || 1; tax /= tl; tay /= tl; taz /= tl;
    for (let k = 0; k < P; k++) {
      const k0 = Math.max(0, k - 1), k1 = Math.min(P - 1, k + 1);
      let dx = xs[k1] - xs[k0], dy = ys[k1] - ys[k0];
      if (ec > 0 && k >= 2 && k <= 5) {
        const w0 = k < 4 ? 2 : 4, w1 = w0 + 1; // the wall segment this vertex belongs to
        const wx = xs[w1] - xs[w0], wy = ys[w1] - ys[w0];
        const cl = Math.hypot(dx, dy) || 1, wl = Math.hypot(wx, wy) || 1;
        dx = dx / cl * (1 - ec) + wx / wl * ec; dy = dy / cl * (1 - ec) + wy / wl * ec;
      }
      const len = Math.hypot(dx, dy) || 1;
      // across-track 2D normal (-dy, dx) mapped back to world: across vector * nx + up * ny
      const nx = -dy / len, ny = dx / len;
      const v = (s * P + k) * 3;
      // BUG-021: tilt the cross-section onto the slope, so the track is lit like the snow it is cut
      // into (it used to face straight up and glowed on shaded slopes): across * nx + slope normal * ny
      this.nor[v] = tax * nx + gx * ny; this.nor[v + 1] = tay * nx + gy * ny; this.nor[v + 2] = taz * nx + gz * ny;
    }
    // colour: pressed floor slightly brighter and smoother, walls pick up their shading from the
    // normals; the slot of a knife cut sits in its own shadow, so it darkens into a thin line that
    // still reads at a distance where the walls are thinner than a pixel
    for (let k = 0; k < P; k++) {
      const c = (s * P + k) * 4;
      const floor = PROFILE[k].h < 0;
      // BUG-021: the terrain's average snow colour (TerrainMaterial uSnow / uSnowShade mix), not white;
      // the floor 1 to 3 % brighter where it was polished, the walls the snow itself
      let tone = floor ? 1.0 + 0.03 * polish : 0.98;
      if (k >= 2 && k <= 5) tone *= 1 - 0.22 * ec;
      this.col[c] = tone * SNOW_RGB[0]; this.col[c + 1] = tone * SNOW_RGB[1]; this.col[c + 2] = tone * SNOW_RGB[2]; this.col[c + 3] = PROFILE[k].a * Math.min(1, fill * 3);
    }
  }

  private flag(): void {
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSpread') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Age and re-shape (called a couple of times a second). */
  tick(dt: number): void {
    const aged = dt * fillRate;
    for (let s = 0; s < this.count; s++) { this.age[s] += aged; this.shape(s); }
    this.flag();
  }

  clear(): void { this.idx.fill(0); this.count = 0; this.head = 0; this.lastSlot = -1; this.geo.index!.needsUpdate = true; }
  dispose(): void { this.geo.dispose(); }
}

export class Tracks {
  readonly group = new THREE.Group();
  private readonly pack: Pack;
  private readonly mat: THREE.MeshStandardMaterial;
  private lanes: Lane[] = [];
  private offsets: number[] = [0];
  /** BUG-044: the two ski lanes are drawn as one band (overlapping in a stop) */
  private merged = false;
  /** BUG-019: travel direction kept from the last section ridden faster than ACROSS_FREEZE, and the last half width */
  private dirX = NaN;
  private dirFromHeading = false;
  private dirY = NaN;
  private lastHalf = NaN;
  private laneHalf: number[] = [NaN, NaN];
  private lastX = NaN;
  private lastY = NaN;
  /** edge tilt smoothed over distance, so the line crosses the board in a soft S between turns (FEAT-109) */
  private tiltS = 0;
  private tickAcc = 0;
  discipline: 'board' | 'ski' = 'board';
  /** on foot: one skid groove per boot when slipping down the snow (FEAT-068) */
  private readonly bootLanes: Lane[];
  private bootX = NaN;
  private bootY = NaN;

  constructor(pack: Pack) {
    this.pack = pack;
    // BUG-021: the same lighting model and roughness as the terrain's snow (was Lambert, lit brighter)
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, depthWrite: true, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
    // the floor is below the terrain surface: bias the depth a few cm toward the camera so the
    // terrain does not cover it, but nearer geometry (rider, trees, ridges) still does
    this.mat.onBeforeCompile = (shader) => {
      // minimum on-screen width (FEAT-109): a 1 cm carve line is thinner than a pixel at range, so
      // each vertex is held at least 1.5 mm per metre of distance off the centre line; the line
      // widens a little with distance and stays a stable thin line instead of flickering
      shader.vertexShader = 'attribute vec4 aSpread;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float camDist = length((modelViewMatrix * vec4(position, 1.0)).xyz);
          transformed += aSpread.xyz * max(0.0, 0.0015 * camDist - aSpread.w);
        }`);
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        {
          vec3 toCam = normalize(-mvPosition.xyz);
          float bias = 0.09 + 0.0015 * length(mvPosition.xyz); // grows a little with distance for depth precision
          vec4 biased = projectionMatrix * vec4(mvPosition.xyz + toCam * bias, 1.0);
          gl_Position.z = biased.z / biased.w * gl_Position.w;
        }`);
    };
    this.setDiscipline('board');
    this.bootLanes = [new Lane(this.mat), new Lane(this.mat)];
    for (const l of this.bootLanes) { l.mesh.name = 'boot skid tracks'; this.group.add(l.mesh); }
  }

  /** On foot and slipping: each boot drags a narrow, shallow, slightly polished groove down the snow. */
  private bootSkid(r: Rider): void {
    if (!r.slipping) { for (const l of this.bootLanes) l.gap(); this.bootX = NaN; return; }
    const moved = Number.isNaN(this.bootX) ? Infinity : Math.hypot(r.x - this.bootX, r.y - this.bootY);
    if (moved < 0.25) return;
    if (moved > 6) for (const l of this.bootLanes) l.gap();
    this.bootX = r.x; this.bootY = r.y;
    const sp = Math.hypot(r.vx, r.vy);
    const fx = sp > 0.1 ? r.vx / sp : -r.normal[0], fy = sp > 0.1 ? r.vy / sp : -r.normal[1];
    const fl = Math.hypot(fx, fy) || 1;
    const ax = fy / fl, ay = -fx / fl; // across the slide
    const rx = Math.cos(r.heading), ry = -Math.sin(r.heading); // the boots sit either side of the body
    const surface = (x: number, z: number) => this.pack.groundHeight(x, -z);
    const depth = Math.max(0.015, r.sink * 0.7);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const cx = r.x + rx * side * 0.11, cy = r.y + ry * side * 0.11;
      const g = this.pack.groundHeight(cx, cy);
      if (Number.isNaN(g)) continue;
      const pn = this.pack.groundNormal(cx, cy, this.nTmp); // BUG-021: lit like the slope, not flat ground
      this.gnTmp[0] = pn[0]; this.gnTmp[1] = pn[2]; this.gnTmp[2] = -pn[1];
      this.bootLanes[i].add(cx, g, -cy, ax, -ay, 0.07, depth, 0, surface, 0.01, 0, 0.4, 1, this.gnTmp);
    }
  }

  get material(): THREE.Material { return this.mat; }

  setDiscipline(d: 'board' | 'ski'): void {
    if (d === this.discipline && this.lanes.length) return;
    this.discipline = d;
    this.merged = false;
    for (const l of this.lanes) { this.group.remove(l.mesh); l.dispose(); }
    this.offsets = d === 'ski' ? [-0.12, 0.12] : [0];
    this.lanes = this.offsets.map(() => new Lane(this.mat));
    for (const l of this.lanes) this.group.add(l.mesh);
    this.lastX = NaN;
  }

  /** Per frame. `riding` = on a chair or gondola (no track). */
  update(r: Rider, dt: number, riding: boolean): void {
    this.tickAcc += dt;
    if (this.tickAcc > 0.5) { for (const l of this.lanes) l.tick(this.tickAcc); for (const l of this.bootLanes) l.tick(this.tickAcc); this.tickAcc = 0; }
    this.bootSkid(r);
    if (!r.onGround || riding || r.crashed > 0 || r.unstrapped) { for (const l of this.lanes) l.gap(); this.lastX = NaN; return; }
    if (!Number.isNaN(this.lastX) && Math.hypot(r.x - this.lastX, r.y - this.lastY) < STEP) return;
    // a jump in position (teleport, map drop, restart, time-trial start) starts a new track
    // instead of joining the old spot to the new one with a long straight groove
    const moved = Number.isNaN(this.lastX) ? Infinity : Math.hypot(r.x - this.lastX, r.y - this.lastY);
    if (moved > 6) for (const l of this.lanes) l.gap();
    this.lastX = r.x; this.lastY = r.y;
    const sp = Math.hypot(r.vx, r.vy);
    // BUG-019: below ACROSS_FREEZE the velocity direction is noise (the end of a hockey stop, standing
    // across the hill) and the heading is the board's, 84 deg off the travel, so the across vector
    // swung between sections and twisted the quads into arrows and bow-ties. Keep the last good
    // direction instead; a fresh stroke with no history falls back to the heading.
    // a direction guessed from the board heading (standing start) is replaced as soon as there is real travel
    if (sp > ACROSS_FREEZE || moved > 6 || Number.isNaN(this.dirX) || (this.dirFromHeading && sp > 0.3)) {
      this.dirFromHeading = sp <= 0.3;
      this.dirX = sp > 0.3 ? r.vx / sp : Math.sin(r.heading); this.dirY = sp > 0.3 ? r.vy / sp : Math.cos(r.heading);
    }
    const fx = this.dirX, fy = this.dirY;
    const ax = fy, ay = -fx; // right-hand side, pack coords
    const skid = Math.min(1, r.skid);
    const s = r.surface;
    const powder = Math.max(0, 1 - s.groomed - s.rock - s.scree);
    // footprint across the travel direction from the board's slip angle: the board's width when
    // running straight, up to its length when it is across (a hockey stop)
    const ski = this.discipline === 'ski';
    const gs = Math.abs(Math.sin(r.slip)), gc = Math.abs(Math.cos(r.slip));
    const L = ski ? 1.7 : 1.55, W = ski ? 0.1 : 0.26;
    const scrape = Math.max(skid, gs); // 0 a clean cut, 1 a flat scraped band
    // edge angle from the physics (same inclination the rider model leans by): flat base going
    // straight presses the full board width; on edge the board cuts a narrow, deeper, tilted trench
    const phi = carveLean(r.lateralG);                       // + = turning toward the right-hand side
    // lateral G flips edge to edge in a couple of sections; real snow shows the crossover as the
    // board rolls flat and over, so smooth the tilt over two or three metres of travel: the
    // line slides across through the wedge and the flat imprint instead of stepping sideways
    const raw = Math.sign(phi) * Math.min(1, Math.abs(phi) / 0.6) * (1 - scrape);
    this.tiltS = moved > 6 ? raw : this.tiltS + (raw - this.tiltS) * (1 - Math.exp(-moved / 1.2));
    const tilt = this.tiltS;
    const edge = Math.abs(tilt);
    // a committed carve collapses the trench to a knife cut about 1 cm wide (FEAT-109)
    const ec = edgeCurve(edge);
    const halfRaw = Math.max(MIN_HALF, 0.5 * (L * gs + W * gc * (1 - 0.95 * ec)) + (ski ? 0.05 : 0.15) * skid);
    // BUG-019: ease the width so a stop widens the band over a few sections, not in one long wedge
    const half = moved > 6 || Number.isNaN(this.lastHalf) ? halfRaw : Math.min(halfRaw, this.lastHalf + HALF_GROW_PER_M * moved);
    this.lastHalf = half;
    const depth = DEPTH * (1 + 0.6 * powder) * (1 + 0.3 * edge) * (1 - 0.6 * scrape) * (s.rock + s.scree > 0.5 ? 0.3 : 1);
    // the cut sits under the engaged edge, not the middle of the board: slide the section across by
    // up to half the width as the board goes on edge, so the line crosses the board between turns
    const shift = 0.5 * W * gc * ec * Math.sign(tilt);
    // braking pushes snow ahead of the cutting edge: a ridge on the downhill side of the band,
    // highest where the stop ends (it builds as the rider slows), more of it in soft snow
    const ridge = 0.07 * r.scrape * (0.4 + 0.6 * Math.max(0, 1 - sp / 12)) * (0.6 + 0.6 * powder);
    const dn = Math.hypot(r.normal[0], r.normal[1]);
    const ridgeSide = dn > 0.02 ? (ax * r.normal[0] + ay * r.normal[1]) / dn : 0; // + = the right side is downhill
    const surface = (x: number, z: number) => this.pack.groundHeight(x, -z);
    // BUG-044: once the two ski bands overlap (a hockey stop) their lips poke through each other's
    // floor; draw one band centred between the skis instead, and split back when they separate.
    // Hysteresis (merge at overlap, split once the gap is back to 80 %) stops it flickering.
    const spread = this.offsets.length > 1 ? Math.abs(this.offsets[1] - this.offsets[0]) * 0.5 * gc : 0;
    const wasMerged = this.merged;
    this.merged = spread > 0 && (this.merged ? half > spread * 0.8 : half > spread);
    if (this.merged !== wasMerged && this.lanes.length) this.lanes[0].gap(); // lane 0 jumps between the centre and its ski; no skewed joining quad
    this.offsets.forEach((off, i) => {
      if (this.merged && i > 0) { this.lanes[i].gap(); return; } // the first lane carries the one band
      const o = this.merged ? shift : off * gc + shift; // skis turned across the travel direction sweep the same band
      const want = this.merged ? half + spread : half;
      // the merged band is wider than either groove: grow into it at the same rate (BUG-019)
      const prev = this.laneHalf[i];
      const bandHalf = moved > 6 || Number.isNaN(prev) ? want : Math.min(want, prev + HALF_GROW_PER_M * moved);
      this.laneHalf[i] = bandHalf;
      const cx = r.x + ax * o, cy = r.y + ay * o;
      const g = this.pack.groundHeight(cx, cy);
      // BUG-043: no groove in rock the player can see; it fades out over the last bit of snow
      // before the rock edge and starts again on the snow below
      const rock = this.rockAt(cx, cy, g);
      if (rock > ROCK_CUT) { this.lanes[i].gap(); return; }
      const fill = rock > ROCK_FADE ? 1 - (rock - ROCK_FADE) / (ROCK_CUT - ROCK_FADE) : 1;
      const pn = this.pack.groundNormal(cx, cy, this.nTmp);
      this.gnTmp[0] = pn[0]; this.gnTmp[1] = pn[2]; this.gnTmp[2] = -pn[1]; // pack -> three.js axes
      this.lanes[i].add(cx, g, -cy, ax, -ay, bandHalf, depth, tilt, surface, ridge, ridgeSide, gs, fill, this.gnTmp);
    });
  }

  private readonly maskTmp = [0, 0, 0, 0];
  private readonly nTmp = [0, 0, 1];
  private readonly gnTmp = [0, 1, 0];
  private readonly coverTmp = { rock: 0, scree: 0 };
  /** rock + scree coverage the terrain shader shows at (x, y) */
  private rockAt(x: number, y: number, z: number): number {
    const mask = this.pack.mask;
    if (!mask) return 0;
    const m = mask.sampleBilinear(x, y, this.maskTmp);
    if (m[0] < 0.15 && m[1] < 0.05) return 0;
    const n = this.pack.groundNormal(x, y, this.nTmp);
    const c = rockCover(m[0], m[1], x, z, -y, n[2], this.coverTmp);
    return c.rock + c.scree;
  }

  clear(): void { for (const l of [...this.lanes, ...this.bootLanes]) l.clear(); this.lastX = NaN; this.bootX = NaN; }
  dispose(): void { for (const l of [...this.lanes, ...this.bootLanes]) l.dispose(); this.mat.dispose(); }
}
