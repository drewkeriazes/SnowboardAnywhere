import * as THREE from 'three';

/**
 * FEAT-044: the soft sag of the snow around tracks and boot prints, near the rider. A square window of
 * DEFAULT_SIZE metres that follows the rider (leading a little along the travel direction) is rendered
 * top-down every frame into a small render target: the board-track lanes (`Tracks.ts`) and the boot
 * prints (`Bootprints.ts`) are drawn with a stamp material that writes, per texel,
 *
 *   R = depression below the snow surface (m / HEIGHT_SCALE, so 0..0.5 m)
 *   G = snow pushed up (lips, the braking ridge; the same units)
 *   B = how packed the snow is (0 fresh, 1 a polished floor)
 *
 * with MAX blending, so overlapping passes take the deepest cut and the highest lip without any
 * ordering. The texture holds no state: the lanes and prints are the persistence and the fill-in.
 *
 * Hybrid (after the first build aliased): the sharp trench stays the ribbon mesh (`Tracks.ts`), which
 * has no resolution limit. The texture only adds a soft, wide sag: `deformSag` reads its mipmap at
 * about SAG_TEXEL metres per texel, so the GPU's own box filter pre-blurs the stamp to the terrain's
 * 1 m vertex spacing and nothing can alias. The terrain, the ribbon and the boot prints all add the
 * same sag at their vertices, so they move together; the terrain also takes its slope as a soft normal.
 *
 * All shaders that read the texture share `deformUniforms` and `DEFORM_GLSL`; `Deform.update`
 * writes the window into them. Texture v runs the other way from three.js z (the capture camera
 * looks down with -z as screen up), which `deformUV` hides.
 */
export const DEFAULT_SIZE = 64; // m
export const DEFAULT_RES = 512; // px
/** the sag fades to zero over this many metres inside the window edge */
const EDGE_FADE = 6;
/** the sag is the stamp averaged over about this many metres (the mip level read), the terrain's near vertex spacing */
const SAG_TEXEL = 1;
/** how much of the averaged depression the snow around a track sinks by */
const SAG_K = 1;
/** units of the R and G channels: metres per 1.0 */
export const HEIGHT_SCALE = 0.5;

export const deformUniforms = {
  uDeform: { value: null as THREE.Texture | null },
  /** window origin x, z (three.js), 1 / size, strength (0 = off) */
  uDeformWin: { value: new THREE.Vector4(0, 0, 1 / DEFAULT_SIZE, 0) },
  /** one texel in uv, one texel in metres, the mip level whose texel is SAG_TEXEL */
  uDeformPx: { value: new THREE.Vector3(1 / DEFAULT_RES, DEFAULT_SIZE / DEFAULT_RES, Math.log2(DEFAULT_RES / DEFAULT_SIZE * SAG_TEXEL)) },
};

export const DEFORM_GLSL = /* glsl */ `
  uniform sampler2D uDeform;
  uniform vec4 uDeformWin;
  uniform vec3 uDeformPx;
  vec2 deformUV(vec2 xz) { return vec2((xz.x - uDeformWin.x) * uDeformWin.z, 1.0 - (xz.y - uDeformWin.y) * uDeformWin.z); }
  // 1 well inside the window, 0 at its edge and outside, times the strength
  float deformFade(vec2 uv) {
    float m = ${EDGE_FADE.toFixed(1)} * uDeformWin.z; // the fade width in uv
    vec2 e = min(uv, 1.0 - uv);
    float d = min(e.x, e.y);
    return smoothstep(0.0, m, d) * uDeformWin.w;
  }
  // the soft sag (m, <= 0): the depression averaged over about SAG_TEXEL metres by the mipmap
  float deformSag(vec2 uv) { return -textureLod(uDeform, uv, uDeformPx.z).r * ${(HEIGHT_SCALE * SAG_K).toFixed(3)}; }
  // its slope (d/dx, d/dz in three.js axes) by central differences SAG_TEXEL apart
  vec2 deformSagSlope(vec2 uv) {
    float o = ${SAG_TEXEL.toFixed(1)} * uDeformWin.z;
    float dx = deformSag(uv + vec2(o, 0.0)) - deformSag(uv - vec2(o, 0.0));
    float dz = deformSag(uv - vec2(0.0, o)) - deformSag(uv + vec2(0.0, o)); // v runs against z
    return vec2(dx, dz) / ${(2 * SAG_TEXEL).toFixed(1)};
  }
`;

const stampFrag = /* glsl */ `
  varying vec3 vS;
  void main() {
    float dep = max(0.0, -vS.x) / ${HEIGHT_SCALE.toFixed(2)};
    float lip = max(0.0, vS.x) / ${HEIGHT_SCALE.toFixed(2)};
    gl_FragColor = vec4(min(1.0, dep), min(1.0, lip), clamp(vS.y, 0.0, 1.0), 1.0);
  }`;

function stampMaterial(vertex: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: vertex, fragmentShader: stampFrag,
    blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.MaxEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide, transparent: true,
  });
}

/** stamp material for the track lanes: `aStamp` = (height offset m, packed) per vertex (Lane.shape) */
export function laneStampMaterial(): THREE.ShaderMaterial {
  return stampMaterial(/* glsl */ `
    attribute vec2 aStamp;
    varying vec3 vS;
    void main() {
      vS = vec3(aStamp, 0.0);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`);
}

/** stamp material for the boot prints: the same scaling of the nominal hollow as Bootprints' own shader */
export function printStampMaterial(nominal: number, halfLength: number): THREE.ShaderMaterial {
  return stampMaterial(/* glsl */ `
    attribute float aDepth;
    attribute float aFill;
    attribute float aKick;
    attribute vec2 aSmear;
    attribute float toe;
    varying vec3 vS;
    void main() {
      float off = position.y * aDepth * aFill / ${nominal.toFixed(3)} + toe * aKick * aFill * 0.035;
      vec3 p = vec3(position.x, 0.0, position.z);
      float sl = length(aSmear);
      if (sl > 1e-4) p.xz += aSmear * clamp(dot(position.xz, aSmear / sl) / ${halfLength.toFixed(3)}, 0.0, 1.0);
      // the hollow is packed, the rim is not
      vS = vec3(off, position.y < 0.0 ? 0.6 * min(1.0, aFill * 3.0) : 0.0, 0.0);
      gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    }`);
}

export class Deform {
  readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000);
  private target: THREE.WebGLRenderTarget | null = null;
  private res = DEFAULT_RES;
  /** window size (m); the texel is size / res */
  size = DEFAULT_SIZE;
  /** window origin (three.js x, z) */
  readonly origin = new THREE.Vector2();
  enabled = true;
  private readonly clear = new THREE.Color();

  constructor() {
    this.camera.up.set(0, 0, -1);
    this.configure(DEFAULT_RES, DEFAULT_SIZE);
  }

  /** texture size (px) and window size (m); recreates the target when the resolution changes */
  configure(res: number, size: number): void {
    this.size = size;
    const lod = Math.max(0, Math.log2(res / size * SAG_TEXEL));
    if (this.target && this.res === res) { deformUniforms.uDeformPx.value.set(1 / res, size / res, lod); return; }
    this.target?.dispose();
    this.res = res;
    this.target = new THREE.WebGLRenderTarget(res, res, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    this.target.texture.name = 'snow deformation';
    deformUniforms.uDeform.value = this.target.texture;
    deformUniforms.uDeformPx.value.set(1 / res, size / res, lod);
  }

  get resolution(): number { return this.res; }
  get texture(): THREE.Texture | null { return this.target?.texture ?? null; }

  /**
   * Place the window around the rider ((x, y, z) three.js, (vx, vz) velocity) and render the stamps
   * into it. The centre leads the rider by up to a third of the window along the travel direction.
   */
  update(renderer: THREE.WebGLRenderer, x: number, y: number, z: number, vx: number, vz: number): void {
    const win = deformUniforms.uDeformWin.value;
    if (!this.enabled || !this.target) { win.w = 0; return; }
    const h = this.size / 2, texel = this.size / this.res;
    const sp = Math.hypot(vx, vz);
    const lead = (this.size / 3) * Math.min(1, sp / 10);
    const cx = x + (sp > 0.1 ? vx / sp * lead : 0), cz = z + (sp > 0.1 ? vz / sp * lead : 0);
    // snap the origin to whole texels so the texture does not swim as the rider moves
    const ox = Math.floor((cx - h) / texel) * texel, oz = Math.floor((cz - h) / texel) * texel;
    this.origin.set(ox, oz);
    win.set(ox, oz, 1 / this.size, 1);
    const cam = this.camera;
    cam.left = -h; cam.right = h; cam.top = h; cam.bottom = -h;
    cam.position.set(ox + h, y + 5000, oz + h);
    cam.lookAt(ox + h, y, oz + h);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const prevTarget = renderer.getRenderTarget();
    renderer.getClearColor(this.clear); const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear, prevShadows = renderer.shadowMap.autoUpdate;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true; renderer.shadowMap.autoUpdate = false;
    renderer.render(this.scene, cam);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(this.clear, prevAlpha);
    renderer.autoClear = prevAuto; renderer.shadowMap.autoUpdate = prevShadows;
  }

  /** Read the texture back (slow; for checks): RGBA bytes, row 0 at the window's +z edge (v = 0). */
  read(renderer: THREE.WebGLRenderer): Uint8Array | null {
    if (!this.target) return null;
    const out = new Uint8Array(this.res * this.res * 4);
    renderer.readRenderTargetPixels(this.target, 0, 0, this.res, this.res, out);
    return out;
  }

  dispose(): void { this.target?.dispose(); this.target = null; deformUniforms.uDeform.value = null; deformUniforms.uDeformWin.value.w = 0; }
}
