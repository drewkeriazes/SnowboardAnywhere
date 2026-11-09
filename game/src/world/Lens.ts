import * as THREE from 'three';

/**
 * FEAT-130 tinted goggle lenses in first person. Real lenses help in flat light by filtering out
 * blue (bluish shadows and dips go darker against the lit snow, so the shape of the slope shows
 * again); mirrors cut the overall light on bright days.
 *
 * The lens is a shader pass at the end of the frame. The scene renders to a half-float target exactly
 * as it would to the screen (tone mapped and sRGB encoded, so the haze, clouds and particles blend as
 * they do without the lens; a linear target blended them in linear light and washed out dark trees
 * behind the storm haze). Then a full-screen pass decodes to display-linear light and applies
 *  - the lens transmission per channel (the lens colour, normalised to unit luminance),
 *  - a two-band local contrast boost on the lens-weighted luminance: detail against a blur about a
 *    fortieth of the screen across (the shading of bumps, rollers and dips), and that blur against
 *    one eight times wider (the mid-tone contrast of the slope). Both are ratios, so they do not
 *    depend on exposure, and both fade out where the ratio is large (a tree against the sky), so
 *    hard edges do not halo,
 *  - the lens's overall brightness as a plain gain (the eye adapting: mirrors dim the view, warm
 *    lenses keep about the light of no lens). A gain keeps the contrast; a lift that held white at
 *    white flattened bright overcast snow and undid the boost. Only the brightest channel rolls off
 *    softly above 0.85, so the warm tints do not clip on white snow.
 * The blurs come from the target's mip chain, built once per frame after the last scene pass.
 * Third person and the helmet cam (a GoPro) skip the pass and render straight to the screen.
 */
export type LensId = 'rose' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'clear' | 'off';
/** the setting: a lens, or Auto (picked from the weather and the sun) */
export type LensSetting = LensId | 'auto';

export interface LensSpec {
  label: string;
  /** one line for the settings panel */
  bestFor: string;
  /** what the lens looks like from outside (swatch, frame tint, the rider's goggles) */
  swatch: string;
  /** a mirror coating (the rider's goggles get a shinier finish) */
  mirror: boolean;
  /** transmission per channel through the lens (linear, normalised to `brightness` below) */
  tint: [number, number, number];
  /** overall light through the lens against no lens (warm high-VLT lenses a touch brighter, mirrors darker) */
  brightness: number;
  /** local contrast exponent (detail against its neighbourhood) */
  local: number;
  /** mid-tone contrast exponent (the neighbourhood against the wider view) */
  mid: number;
}

export const LENSES: Record<LensId, LensSpec> = {
  rose: { label: 'Rose', bestFor: 'flat light, overcast', swatch: '#f0567e', mirror: false, tint: [1.0, 0.68, 0.62], brightness: 1.06, local: 1.1, mid: 0.45 },
  orange: { label: 'Orange / amber', bestFor: 'mixed light, shade', swatch: '#ff8a00', mirror: false, tint: [1.0, 0.72, 0.4], brightness: 1.0, local: 0.9, mid: 0.35 },
  yellow: { label: 'Yellow', bestFor: 'storm, fog, dusk', swatch: '#ffd23f', mirror: false, tint: [1.0, 0.9, 0.42], brightness: 1.12, local: 1.3, mid: 0.5 },
  green: { label: 'Green mirror', bestFor: 'variable, partly sunny', swatch: '#27b46a', mirror: true, tint: [0.96, 1.0, 0.84], brightness: 0.72, local: 0.5, mid: 0.2 },
  blue: { label: 'Blue mirror', bestFor: 'bright sun', swatch: '#2f7bff', mirror: true, tint: [0.84, 0.92, 1.0], brightness: 0.58, local: 0.2, mid: 0.1 },
  purple: { label: 'Purple mirror', bestFor: 'bluebird days', swatch: '#9b5cff', mirror: true, tint: [1.0, 0.84, 0.94], brightness: 0.62, local: 0.45, mid: 0.2 },
  clear: { label: 'Clear', bestFor: 'night', swatch: '#dfe7ea', mirror: false, tint: [1, 1, 1], brightness: 1, local: 0, mid: 0 },
  off: { label: 'Off', bestFor: 'no lens', swatch: '#ff8a00', mirror: true, tint: [1, 1, 1], brightness: 1, local: 0, mid: 0 },
};
export const LENS_ORDER: LensSetting[] = ['auto', 'rose', 'orange', 'yellow', 'green', 'blue', 'purple', 'clear', 'off'];

/**
 * Auto: the lens a rider would pick for the light. `weather` is the cloud setting, `sunY` the sine of
 * the sun's elevation.
 */
export function autoLens(weather: string, sunY: number): LensId {
  if (sunY < -0.03) return 'clear'; // night
  if (weather === 'storm' || weather === 'flurries') return 'yellow';
  if (weather === 'overcast' || weather === 'broken') return 'rose';
  if (sunY < 0.2) return 'orange'; // low sun: long shade, late afternoon
  if (weather === 'off') return 'blue';
  if (weather === 'cirrus' || weather === 'few') return 'purple';
  return 'green'; // scattered cloud: sun and shade
}

export function resolveLens(setting: LensSetting | undefined, weather: string, sunY: number): LensId {
  if (!setting) return 'rose';
  return setting === 'auto' ? autoLens(weather, sunY) : setting in LENSES ? setting : 'rose';
}

const LUMA = [0.2126, 0.7152, 0.0722];

const FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform vec3 uTint;
uniform vec3 uW;
uniform float uGain;
uniform float uLod1, uLod2, uLocal, uMid;
uniform vec2 uTexel1, uTexel2;
varying vec2 vUv;
// the target holds sRGB-encoded display values
vec3 dec(vec3 c) { c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
// four bilinear taps around the pixel at a mip level (smooths the mip boxes), as lens-weighted luminance
float blurL(float lod, vec2 t) {
  vec3 c = textureLod(tScene, vUv + vec2(-0.5, -0.5) * t, lod).rgb + textureLod(tScene, vUv + vec2(0.5, -0.5) * t, lod).rgb
         + textureLod(tScene, vUv + vec2(-0.5, 0.5) * t, lod).rgb + textureLod(tScene, vUv + vec2(0.5, 0.5) * t, lod).rgb;
  return dot(dec(c * 0.25), uW) + 1e-3;
}
void main() {
  vec3 c = dec(textureLod(tScene, vUv, 0.0).rgb);
  float L = dot(c, uW) + 1e-3;
  float b1 = blurL(uLod1, uTexel1), b2 = blurL(uLod2, uTexel2);
  // log ratios, each boosted only where it is small (the snow's own shading): a hard edge such as a
  // tree against the sky has a large ratio and gets almost nothing, so no halo
  float r1 = log(L / b1), r2 = log(b1 / b2);
  float g = exp(uLocal * r1 * exp(-r1 * r1 * 60.0) + uMid * r2 * exp(-r2 * r2 * 25.0));
  c *= uTint * g * uGain;
  // a plain gain keeps the contrast; only the brightest channel rolls off softly above 0.85 (hue kept)
  float m = max(max(c.r, c.g), c.b);
  if (m > 0.85) c *= (0.85 + 0.15 * (1.0 - exp((0.85 - m) / 0.15))) / m;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  #include <colorspace_fragment>
}`;

export class GoggleLens {
  /** the lens the pass draws this frame ('off' / 'clear' skip it) */
  lens: LensId = 'off';
  /** 0..1: blends the tint and the contrast toward no lens */
  strength = 1;
  private rt: THREE.WebGLRenderTarget | null = null;
  private readonly quad: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  private readonly qScene = new THREE.Scene();
  private readonly qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly size = new THREE.Vector2();
  /** scene passes still to come into the target this frame */
  private pending = 0;
  /** what the uniforms were last computed for */
  private setLens: LensId | null = null;
  private setStrength = -1;
  private setW = 0;
  private setH = 0;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null }, uTint: { value: new THREE.Vector3(1, 1, 1) }, uW: { value: new THREE.Vector3(...LUMA) },
        uGain: { value: 1 }, uLod1: { value: 4 }, uLod2: { value: 7 }, uLocal: { value: 0 }, uMid: { value: 0 },
        uTexel1: { value: new THREE.Vector2() }, uTexel2: { value: new THREE.Vector2() },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: FRAG,
      depthTest: false, depthWrite: false, toneMapped: false, // tone mapped in the scene pass already
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.qScene.add(this.quad);
  }

  /** the pass runs this frame */
  get active(): boolean { return this.lens !== 'off' && this.lens !== 'clear' && this.strength > 0.001; }

  /**
   * Before the scene passes: draw into the lens target. `passes` = how many scene renders follow
   * (first person draws the body in a second pass); the mip chain is built only after the last.
   */
  begin(renderer: THREE.WebGLRenderer, passes: number): void {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x), h = Math.max(1, this.size.y);
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, samples: Math.min(4, renderer.capabilities.maxSamples),
        minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: true,
      });
      // render like the screen: three applies the renderer's tone mapping and encodes to the texture's
      // colour space only for the canvas and WebXR targets (a half-float target stays RGBA16F either way)
      this.rt.texture.colorSpace = THREE.SRGBColorSpace;
      (this.rt as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
      this.mat.uniforms.tScene.value = this.rt.texture;
    } else if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    // allocated (on the first bind after a resize) with the full mip chain, so generateMipmaps must be on here
    this.rt.texture.generateMipmaps = true;
    renderer.setRenderTarget(this.rt);
    this.pending = passes;
    this.rt.texture.generateMipmaps = passes <= 1;
  }

  /** Between scene passes: the next one is the last, so it builds the mips. */
  nextPass(): void {
    if (!this.rt) return;
    this.pending--;
    this.rt.texture.generateMipmaps = this.pending <= 1;
  }

  /** After the scene passes: the lens pass to the screen. */
  end(renderer: THREE.WebGLRenderer): void {
    if (!this.rt) return;
    if (this.lens !== this.setLens || this.strength !== this.setStrength) this.updateLens();
    if (this.rt.width !== this.setW || this.rt.height !== this.setH) this.updateSize(this.rt.width, this.rt.height);
    renderer.setRenderTarget(null);
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.qScene, this.qCam);
    renderer.autoClear = auto;
  }

  /** the lens uniforms, only when the lens or its strength changes (no per-frame work or allocation) */
  private updateLens(): void {
    this.setLens = this.lens; this.setStrength = this.strength;
    const L = LENSES[this.lens], k = this.strength, tint = L.tint;
    // the tint normalised to unit luminance, blended toward clear by strength; then the brightness
    // against no lens as a plain gain
    const y = tint[0] * LUMA[0] + tint[1] * LUMA[1] + tint[2] * LUMA[2];
    const t0 = 1 + (tint[0] / y - 1) * k, t1 = 1 + (tint[1] / y - 1) * k, t2 = 1 + (tint[2] / y - 1) * k;
    const u = this.mat.uniforms;
    u.uTint.value.set(t0, t1, t2);
    u.uW.value.set(t0 * LUMA[0], t1 * LUMA[1], t2 * LUMA[2]);
    u.uGain.value = 1 + (L.brightness - 1) * k;
    u.uLocal.value = L.local * k; u.uMid.value = L.mid * k;
  }

  /** the blur levels and their texel sizes, only when the target size changes */
  private updateSize(w: number, h: number): void {
    this.setW = w; this.setH = h;
    const u = this.mat.uniforms;
    const maxLod = Math.floor(Math.log2(Math.max(w, h)));
    const lod1 = Math.min(maxLod - 3, Math.max(1, Math.log2(h / 40)));
    const lod2 = Math.min(maxLod, lod1 + 3);
    u.uLod1.value = lod1; u.uLod2.value = lod2;
    u.uTexel1.value.set(2 ** lod1 / w, 2 ** lod1 / h); u.uTexel2.value.set(2 ** lod2 / w, 2 ** lod2 / h);
  }

  dispose(): void { this.rt?.dispose(); this.mat.dispose(); this.quad.geometry.dispose(); }
}
