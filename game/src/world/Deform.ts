import * as THREE from 'three';

/**
 * FEAT-044: snow deformation around the rider. A square window of DEFAULT_SIZE metres that follows the
 * rider (leading a little along the travel direction) is rendered top-down every frame into a small
 * render target: the board-track lanes (`Tracks.ts`) and the boot prints (`Bootprints.ts`) are drawn
 * with a stamp material that writes, per texel,
 *
 *   R = depression below the snow surface (m / HEIGHT_SCALE, so 0..0.5 m)
 *   G = snow pushed up (lips, the braking ridge; the same units)
 *   B = how packed the snow is (0 fresh, 1 a polished floor)
 *
 * with MAX blending, so overlapping passes take the deepest cut and the highest lip without any
 * ordering. The terrain (`TerrainMaterial.ts`) displaces its vertices by lip - depression inside the
 * window and takes a detail normal from the texture, so a trench is real geometry with walls; the
 * ribbon tracks hide themselves inside the window where the stamp is deep and show again beyond it,
 * so the far trail stays the ribbon. The texture holds no state: the lanes and prints are the
 * persistence and the fill-in, so nothing scrolls or ages here.
 *
 * All shaders that read the texture share `deformUniforms` and `DEFORM_GLSL`; `Deform.update`
 * writes the window into them. Texture v runs the other way from three.js z (the capture camera
 * looks down with -z as screen up), which `deformUV` hides.
 */
export const DEFAULT_SIZE = 64; // m
export const DEFAULT_RES = 512; // px
/** the near terrain is split to this vertex spacing (m) inside the window (Terrain.select) */
export const NEAR_RES = 0.25;
/** the displacement fades to zero over this many metres inside the window edge */
const EDGE_FADE = 3;
/** units of the R and G channels: metres per 1.0 */
export const HEIGHT_SCALE = 0.5;

export const deformUniforms = {
  uDeform: { value: null as THREE.Texture | null },
  /** window origin x, z (three.js), 1 / size, strength (0 = off) */
  uDeformWin: { value: new THREE.Vector4(0, 0, 1 / DEFAULT_SIZE, 0) },
  /** one texel in uv, one texel in metres */
  uDeformPx: { value: new THREE.Vector2(1 / DEFAULT_RES, DEFAULT_SIZE / DEFAULT_RES) },
};

export const DEFORM_GLSL = /* glsl */ `
  uniform sampler2D uDeform;
  uniform vec4 uDeformWin;
  uniform vec2 uDeformPx;
  vec2 deformUV(vec2 xz) { return vec2((xz.x - uDeformWin.x) * uDeformWin.z, 1.0 - (xz.y - uDeformWin.y) * uDeformWin.z); }
  // 1 well inside the window, 0 at its edge and outside, times the strength
  float deformFade(vec2 uv) {
    float m = ${EDGE_FADE.toFixed(1)} * uDeformWin.z; // the fade width in uv
    vec2 e = min(uv, 1.0 - uv);
    float d = min(e.x, e.y);
    return smoothstep(0.0, m, d) * uDeformWin.w;
  }
  // height change of the snow surface (m): lips only where there is no depression (RoTR's reconstruction)
  float deformH(vec4 d) {
    float dep = d.r * ${HEIGHT_SCALE.toFixed(2)}, lip = d.g * ${HEIGHT_SCALE.toFixed(2)};
    return lip * (1.0 - smoothstep(0.0, 0.02, dep)) - dep;
  }
  // the height change smoothed over about two vertex spacings (a 3 x 3 box of bilinear taps 2.5 texels
  // apart, so about 60 cm wide), for the vertex displacement: the 25 cm grid carries only a soft trough
  // (a sharper one scallops along the grid); the fragment normal (unsmoothed) carries the walls and lips
  float deformHSmooth(vec2 uv) {
    float o = 2.5 * uDeformPx.x, sum = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) sum += deformH(texture2D(uDeform, uv + vec2(float(i), float(j)) * o));
    return sum / 9.0;
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

/** stamp material for the track lanes: `aStamp` = (height offset m, packed, hide) per vertex (Lane.shape) */
export function laneStampMaterial(): THREE.ShaderMaterial {
  return stampMaterial(/* glsl */ `
    attribute vec3 aStamp;
    varying vec3 vS;
    void main() {
      vS = aStamp;
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
    if (this.target && this.res === res) { deformUniforms.uDeformPx.value.set(1 / res, size / res); return; }
    this.target?.dispose();
    this.res = res;
    this.target = new THREE.WebGLRenderTarget(res, res, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.target.texture.name = 'snow deformation';
    deformUniforms.uDeform.value = this.target.texture;
    deformUniforms.uDeformPx.value.set(1 / res, size / res);
  }

  get resolution(): number { return this.res; }
  get texture(): THREE.Texture | null { return this.target?.texture ?? null; }

  /** the window's box in pack metres (x east, y north), for the terrain's near split */
  get packBox(): { minX: number; minY: number; size: number } {
    return { minX: this.origin.x, minY: -(this.origin.y + this.size), size: this.size };
  }

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
