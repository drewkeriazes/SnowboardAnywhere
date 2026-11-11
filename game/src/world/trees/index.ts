import * as THREE from 'three';
import { SPECIES } from './species';
import { buildTreeAtlas, type TreeAtlas } from './textures';
import { buildTreeGeometries, crossedQuads, billboardQuad, type TreeGeometrySet } from './generate';
import { treeMaterial, treeDepthMaterial, farMaterial, bakeMaterial, kitUniforms, farLight, newBand, type Band } from './materials';
import { setTreeSnow, type TreeSnowState } from './snow';

export { SPECIES, SPECIES_COUNT, VARIANTS, speciesFor, variantFor, crownRadius, hash01 } from './species';
export { kitUniforms, treeMaterial, treeDepthMaterial, newBand } from './materials';
export { SHRUBS, SHRUB_KINDS, WILLOW, JUNIPER, SAGE, YOUNG_CONIFER, OAK, buildShrubGeometries, type ShrubKind, type ShrubGeometrySet } from './shrubs';
export { treeSnowState, winterDepth, type TreeSnowState } from './snow';
export { generateStems, type StandGrid } from './stands';

/**
 * FEAT-156: the procedural tree kit. Builds the atlas, every species x variant x LOD geometry and the
 * materials at construction (no renderer needed), and bakes the LOD2 / impostor atlases from LOD0
 * once a renderer is given (`bake`): albedo, normals and (FEAT-157) the snow mask. Vegetation.ts draws with it; tools/treeshot.mjs renders it alone.
 *
 * LOD bands (m from the camera, scaled by the graphics setting through `setBands`):
 *   LOD0 cards 0..b0 (80), LOD1 cones b0..b1 (400), LOD2 crossed quads b1..b2 (1500), impostors b2..b3 (4500),
 *   each edge a dither crossfade `fade(edge)` metres wide.
 */

const ANGLES = 8, TILE = 128, ROWS = 8;
/**
 * FEAT-157: LOD1's cones show their whole upper side, where the cards they stand in for show the tops of
 * only some of their boughs; this share of the snow amount matches the two (treeshot's snow table).
 */
const LOD1_SNOW = 0.6;
/** bake camera elevation (rad) */
const BAKE_EL = 6 * Math.PI / 180;

/** crossfade width at a band edge (m) */
export function fadeWidth(edge: number): number { return Math.max(10, edge * 0.05); }

export interface KitStats {
  /** triangles per species: LOD0 and LOD1 (the largest variant), LOD2 and the impostor */
  triangles: { species: string; lod0: number; lod1: number; lod2: number; impostor: number }[];
  /** texture memory (bytes, mipmaps included): the card atlas, the impostor albedo + normal + snow mask atlases */
  textureBytes: { atlas: number; impostors: number };
  /** build times (ms) */
  ms: { atlas: number; geometry: number; bake: number };
}

export class TreeKit {
  readonly atlas: TreeAtlas;
  readonly geo: TreeGeometrySet;
  readonly bands = { lod0: newBand(), lod1: newBand(), lod2: newBand(), imp: newBand() };
  /** the band edges last set (m) */
  readonly edges = { b0: 80, b1: 400, b2: 1500, b3: 4500, impostors: true };
  private readonly wind0 = { value: 1 };
  private readonly wind1 = { value: 0 };
  readonly mat: { lod0: THREE.MeshStandardMaterial; lod1: THREE.MeshStandardMaterial };
  readonly depth: { lod0: THREE.MeshDepthMaterial; lod1: THREE.MeshDepthMaterial };
  /** after `bake`: the far materials and their atlases */
  far: { lod2: THREE.ShaderMaterial; imp: THREE.ShaderMaterial; albedo: THREE.WebGLRenderTarget; normal: THREE.WebGLRenderTarget; snow: THREE.WebGLRenderTarget } | null = null;
  /** shared instanced templates for the far LODs */
  readonly crossed = crossedQuads();
  readonly billboard = billboardQuad();
  /** impostor frame half-width per species, in crown radii */
  readonly halfW: number[];
  private bakeMs = 0;

  constructor(opts: { alphaToCoverage?: boolean } = {}) {
    this.atlas = buildTreeAtlas();
    this.geo = buildTreeGeometries(this.atlas.cellMean, this.atlas.barkMean);
    const tex = this.atlas.texture;
    this.mat = {
      lod0: treeMaterial(tex, { band: this.bands.lod0, wind: this.wind0, alphaToCoverage: opts.alphaToCoverage ?? true }),
      lod1: treeMaterial(tex, { band: this.bands.lod1, wind: this.wind1, alphaToCoverage: false, snowK: LOD1_SNOW }),
    };
    this.mat.lod0.name = 'trees lod0'; this.mat.lod1.name = 'trees lod1';
    this.depth = { lod0: treeDepthMaterial(tex, { band: this.bands.lod0, wind: this.wind0, alphaToCoverage: false }), lod1: treeDepthMaterial(tex, { band: this.bands.lod1, wind: this.wind1, alphaToCoverage: false }) };
    // the impostor frame covers every variant's widest point (lean, flagged mats)
    this.halfW = SPECIES.map((_, s) => {
      let w = 1;
      for (const g of this.geo.lod0[s]) { const b = g.boundingBox!; w = Math.max(w, -b.min.x, b.max.x, -b.min.z, b.max.z); }
      return w * 1.04;
    });
    this.setBands(80, 400, 1500, 4500, true);
  }

  /** set the LOD band edges (m); without impostors LOD2 runs out to b3; b0 0 drops LOD0 */
  setBands(b0: number, b1: number, b2: number, b3: number, impostors: boolean): void {
    Object.assign(this.edges, { b0, b1, b2, b3, impostors });
    const f0 = fadeWidth(b0) / 2, f1 = fadeWidth(b1) / 2, f2 = fadeWidth(b2) / 2;
    if (b0 > 0) {
      this.bands.lod0.value.set(-2, -1, b0 - f0, b0 + f0);
      this.bands.lod1.value.set(b0 - f0, b0 + f0, b1 - f1, b1 + f1);
    } else { // FEAT-158: no LOD0 (the Low preset): LOD1 from the camera out
      this.bands.lod0.value.set(1e8, 1e8 + 1, 1e8 + 2, 1e8 + 3);
      this.bands.lod1.value.set(-2, -1, b1 - f1, b1 + f1);
    }
    if (impostors) {
      this.bands.lod2.value.set(b1 - f1, b1 + f1, b2 - f2, b2 + f2);
      this.bands.imp.value.set(b2 - f2, b2 + f2, 1e8, 1e8 + 1);
    } else {
      this.bands.lod2.value.set(b1 - f1, b1 + f1, 1e8, 1e8 + 1);
      this.bands.imp.value.set(1e8, 1e8 + 1, 1e8 + 2, 1e8 + 3);
    }
  }

  /** per frame: the camera the bands are measured from, and the clock the LOD0 sway runs on */
  setView(camPos: THREE.Vector3, timeS: number): void {
    kitUniforms.uLodCam.value.copy(camPos);
    kitUniforms.uWindTime.value = timeS;
  }
  /** LOD0 sway strength (0 off, 1 the default) */
  setWind(k: number): void { this.wind0.value = k; }
  /** FEAT-157: the day's snow on the trees (`treeSnowState`); every LOD reads it */
  setSnow(s: TreeSnowState): void { setTreeSnow(s); }

  /** the far LODs' lighting: the sun (direction toward it, colour x intensity) and the hemisphere light */
  setLight(sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number, hemiSky: THREE.Color, hemiGround: THREE.Color, hemiIntensity: number): void {
    farLight.sunDir.value.copy(sunDir).normalize();
    farLight.sunColor.value.copy(sunColor).multiplyScalar(sunIntensity);
    farLight.hemiSky.value.copy(hemiSky).multiplyScalar(hemiIntensity);
    farLight.hemiGround.value.copy(hemiGround).multiplyScalar(hemiIntensity);
  }

  /** render each species' LOD0 from ANGLES directions into the albedo, normal and snow mask atlases (rows = species) */
  bake(renderer: THREE.WebGLRenderer): void {
    if (this.far) return;
    const t0 = performance.now();
    this.atlas.texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    const mk = (srgb: boolean): THREE.WebGLRenderTarget => {
      const rt = new THREE.WebGLRenderTarget(ANGLES * TILE, ROWS * TILE, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
      rt.texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      return rt;
    };
    const albedo = mk(true), normal = mk(false), snow = mk(false);
    const radius = { value: 1 };
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(this.geo.lod0[0][0], bakeMaterial(this.atlas.texture, radius, 'albedo'));
    scene.add(mesh);
    const prevTarget = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    renderer.autoClear = false;
    const clear = new THREE.Color();
    for (const pass of [albedo, normal, snow]) {
      const isNormal = pass === normal, isSnow = pass === snow;
      mesh.material = bakeMaterial(this.atlas.texture, radius, isNormal ? 'normal' : isSnow ? 'snow' : 'albedo');
      for (let s = 0; s < SPECIES.length && s < ROWS; s++) {
        const sp = SPECIES[s], g = this.geo.lod0[s][0];
        mesh.geometry = g;
        mesh.scale.set(sp.radius, 1, sp.radius);
        radius.value = sp.radius;
        const hw = this.halfW[s] * sp.radius;
        const cam = new THREE.OrthographicCamera(-hw, hw, 0.54, -0.54, 0.1, 40);
        // the clear colour under the cutout: the tree's mean colour (albedo) or straight up (normal), so mips don't fringe
        if (isNormal) clear.setRGB(0.5, 1, 0.5, THREE.LinearSRGBColorSpace);
        else if (isSnow) clear.setRGB(0.3, 0.6, 0.8, THREE.LinearSRGBColorSpace); // about a crown's mean cover
        else { const c = g.getAttribute('color'); let r = 0, gg = 0, b = 0; for (let i = 0; i < c.count; i++) { r += c.getX(i); gg += c.getY(i); b += c.getZ(i); } const k = (this.atlas.cellMean[sp.cells[0]] || 0.5) / c.count; clear.setRGB(r * k, gg * k, b * k, THREE.LinearSRGBColorSpace); }
        for (let i = 0; i < ANGLES; i++) {
          const a = (i / ANGLES) * Math.PI * 2;
          cam.position.set(Math.sin(a) * 12, 0.5 + 12 * Math.tan(BAKE_EL), Math.cos(a) * 12);
          cam.lookAt(0, 0.5, 0);
          cam.updateProjectionMatrix();
          pass.viewport.set(i * TILE, s * TILE, TILE, TILE);
          pass.scissor.set(i * TILE, s * TILE, TILE, TILE);
          pass.scissorTest = true;
          renderer.setRenderTarget(pass);
          renderer.setClearColor(clear, 0);
          renderer.clear(true, true, false);
          renderer.render(scene, cam);
        }
      }
      pass.scissorTest = false;
      pass.viewport.set(0, 0, pass.width, pass.height);
      pass.scissor.set(0, 0, pass.width, pass.height);
      (mesh.material as THREE.Material).dispose();
    }
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    this.far = {
      albedo, normal, snow,
      lod2: farMaterial(albedo.texture, normal.texture, snow.texture, this.halfW, ANGLES, ROWS, this.bands.lod2, false),
      imp: farMaterial(albedo.texture, normal.texture, snow.texture, this.halfW, ANGLES, ROWS, this.bands.imp, true),
    };
    this.far.lod2.name = 'trees lod2'; this.far.imp.name = 'trees impostor';
    this.bakeMs = performance.now() - t0;
  }

  stats(): KitStats {
    const imp = this.far ? 3 * (ANGLES * TILE * ROWS * TILE * 4 * 4 / 3) : 0;
    return {
      triangles: this.geo.triangles.map((t) => ({ ...t, lod2: 4, impostor: 2 })),
      textureBytes: { atlas: this.atlas.bytes, impostors: Math.round(imp) },
      ms: { atlas: this.atlas.ms, geometry: this.geo.ms, bake: this.bakeMs },
    };
  }
}

export type { Band };

/** per-instance attributes of a far LOD mesh (`count` is the capacity) */
export interface FarAttrs {
  iPos: THREE.InstancedBufferAttribute;
  iScale: THREE.InstancedBufferAttribute;
  iYaw: THREE.InstancedBufferAttribute;
  iColor: THREE.InstancedBufferAttribute;
  iSpec: THREE.InstancedBufferAttribute;
  count: number;
}
export function farAttrs(n: number): FarAttrs {
  return {
    iPos: new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3),
    iScale: new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2),
    iYaw: new THREE.InstancedBufferAttribute(new Float32Array(n), 1),
    iColor: new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3),
    iSpec: new THREE.InstancedBufferAttribute(new Float32Array(n), 1),
    count: n,
  };
}
/** a far-LOD geometry: the template (crossed quads or the billboard) with these instances */
export function farGeometry(template: THREE.InstancedBufferGeometry, a: FarAttrs): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.index = template.index;
  for (const name of Object.keys(template.attributes)) g.setAttribute(name, template.getAttribute(name));
  g.setAttribute('iPos', a.iPos); g.setAttribute('iScale', a.iScale); g.setAttribute('iYaw', a.iYaw); g.setAttribute('iColor', a.iColor); g.setAttribute('iSpec', a.iSpec);
  g.instanceCount = a.count;
  return g;
}
