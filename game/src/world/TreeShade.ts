import * as THREE from 'three';
import { SPECIES } from './trees';

/**
 * FEAT-171: crisp shadows of the drawn trees on the snow past the sun's shadow map (which reaches about
 * 260 m around the rider). Each tree's shadow is drawn as one quad with the outline of a cone's shadow
 * (the crown's base disc joined to the tip's shadow), laid on the ground from the trunk away from the
 * sun, from the tree's own height and crown. The quads are drawn from above into a cached "shade map",
 * three nested squares around the camera (one layer each, `HALF` m half-widths at `size` px), which the
 * terrain shader reads to take the direct sun off the snow. Drawing them on screen instead would not
 * work: tone mapping and the haze are applied inside each material, so a darkening decal could not take
 * only the sun away (the shade would go grey and the haze dark).
 *
 * A layer is redrawn when the camera has moved `RECENTRE` of its half-width from its centre, when the
 * sun has turned `SUN_TURN`, or when a cell of trees arrives or leaves; at most one layer per frame.
 */

/** the layers' half-widths (m), finest first */
export const SHADE_HALF = [512, 1024, 2048];
/** redraw a layer once the camera is this share of its half-width from its centre */
const RECENTRE = 0.2;
/** redraw once the sun has turned this far (rad) */
const SUN_TURN = 0.25 * Math.PI / 180;
/** the longest shadow, in tree heights (the sun about 7 degrees up) */
const COT_MAX = 8;
/** cells reach this far past their square for trees whose shadow falls into a layer (m) */
const REACH = 400;
/** the ground slope under each tree comes from heights on this grid (m) */
const SLOPE_STEP = 20;

/** how much of the direct sun a species' shadow takes (bare aspen, bare hardwood and snags let most of it through) */
const DARK = SPECIES.map((s) => (s.form === 'aspen' ? 0.35 : s.form === 'hardwood' ? 0.4 : s.form === 'snag' ? 0.3 : s.form === 'lodgepole' ? 0.85 : s.form === 'limber' ? 0.8 : 1));

interface ShadeCell { mesh: THREE.Mesh; minX: number; minY: number; maxX: number; maxY: number }
interface Layer { half: number; texel: number; cx: number; cy: number; drawn: boolean; dirty: boolean }

export class TreeShade {
  readonly size: number;
  readonly target: THREE.WebGLArrayRenderTarget;
  /** per layer: centre x, y (pack m), half-width (m), 1 once drawn (0: the terrain ignores it) */
  readonly rects = SHADE_HALF.map(() => new THREE.Vector4(0, 0, 1, 0));
  readonly layers: Layer[];
  readonly stats = { draws: 0, trees: 0, ms: 0 };
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mat: THREE.ShaderMaterial;
  private readonly cells = new Map<string, ShadeCell>();
  private readonly sun = new THREE.Vector3(NaN, 0, 0);
  private readonly quad: THREE.InstancedBufferGeometry;
  private readonly clear = new THREE.Color();

  constructor(size = 2048) {
    this.size = size;
    this.target = new THREE.WebGLArrayRenderTarget(size, size, SHADE_HALF.length, { depthBuffer: false });
    const t = this.target.texture;
    t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType;
    t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace;
    this.layers = SHADE_HALF.map((half) => ({ half, texel: (2 * half) / size, cx: NaN, cy: NaN, drawn: false, dirty: true }));
    // x 0..1 along the shadow (from behind the trunk to past the tip), y -1..1 across it
    this.quad = new THREE.InstancedBufferGeometry();
    this.quad.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    this.quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uLevel: { value: new THREE.Vector4() },
        uBase: { value: SPECIES.map((s) => s.crownBase) },
        uDark: { value: DARK },
      },
      vertexShader: /* glsl */ `
        attribute vec4 iTree;  // x, y (pack m), ground z, height
        attribute vec4 iCrSp;  // crown radius (m), kit species, ground slope (dz/dx, dz/dy)
        uniform vec3 uSunDir;  // toward the sun, three.js world
        uniform vec4 uLevel;   // layer centre x, y, half-width, texel (m)
        uniform float uBase[${SPECIES.length}];
        uniform float uDark[${SPECIES.length}];
        varying vec2 vP;       // m from the trunk: along the shadow, across it
        varying vec3 vShape;   // crown radius, crown-base disc centre and tip along the shadow (m)
        varying float vDark;
        varying float vK;      // the slope's stretch along the shadow
        void main() {
          float sunH = length(uSunDir.xz);
          vec2 away = -vec2(uSunDir.x, -uSunDir.z) / max(sunH, 1e-4);
          vec2 side = vec2(-away.y, away.x);
          float cot = min(sunH / max(uSunDir.y, 1e-3), ${COT_MAX.toFixed(1)});
          int s = int(iCrSp.y + 0.5);
          float h = iTree.w, r = iCrSp.x;
          // on a slope the shadow stretches along its length: by tan(e) / (tan(e) + rise of the ground away
          // from the sun), shorter on a slope facing the sun and longer on one turned away
          float tanE = uSunDir.y / max(sunH, 1e-4);
          float rise = dot(iCrSp.zw, away);
          float k = min(tanE / max(tanE + rise, 1e-3), ${COT_MAX.toFixed(1)} / max(cot, 1e-3));
          float a0 = uBase[s] * h * cot * k, a1 = h * cot * k;
          float pad = uLevel.w;
          float aMin = min(0.0, a0 - r * k) - pad, aMax = max(a1, a0 + r * k) + pad, b = r + pad;
          vec2 q = vec2(mix(aMin, aMax, position.x), position.y * b);
          vec2 xy = iTree.xy + away * q.x + side * q.y;
          // the shape is drawn unstretched: the disc stays round in the frame stretched by k
          vP = vec2(q.x / k, q.y); vShape = vec3(r, a0 / k, a1 / k); vDark = uDark[s]; vK = k;
          gl_Position = vec4((xy - uLevel.xy) / uLevel.z, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec4 uLevel;
        varying vec2 vP;
        varying vec3 vShape;
        varying float vDark;
        varying float vK;
        // signed distance to a cone's shadow: the disc of radius r at a0 joined to the tip at a1 (Quilez's uneven capsule, tip radius 0)
        float sdCone(vec2 p, float r, float a0, float a1) {
          vec2 q = vec2(abs(p.y), p.x - a0);
          float hh = a1 - a0;
          if (hh <= r) return length(q) - r;
          float b = r / hh, a = sqrt(1.0 - b * b);
          float k = dot(q, vec2(-b, a));
          if (k < 0.0) return length(q) - r;
          if (k > a * hh) return length(q - vec2(0.0, hh));
          return dot(q, vec2(a, b)) - r;
        }
        void main() {
          float d = sdCone(vP, vShape.x, vShape.y, vShape.z) * min(vK, 1.0);
          gl_FragColor = vec4(vDark * (1.0 - smoothstep(-0.5, 0.5, d / uLevel.w)), 0.0, 0.0, 1.0);
        }`,
      // overlapping shadows: the darkest wins
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mat.name = 'tree shade';
    this.scene.matrixWorldAutoUpdate = false;
  }

  /**
   * A cell of trees arrived: `data` the pack records (x, y, z, h, crown, species), `cr` / `sp` the kit's
   * crown radius and species per tree, `height` the ground (pack m) for the slope under each tree.
   */
  addCell(key: string, minX: number, minY: number, size: number, data: Float32Array, cr: Float32Array, sp: Uint8Array, height: (x: number, y: number) => number): void {
    if (this.cells.has(key)) return;
    const n = data.length / 6;
    if (n === 0) return;
    const g = new THREE.InstancedBufferGeometry();
    g.index = this.quad.index;
    g.setAttribute('position', this.quad.getAttribute('position'));
    g.setAttribute('iTree', new THREE.InterleavedBufferAttribute(new THREE.InstancedInterleavedBuffer(data, 6), 4, 0));
    // heights on a grid over the cell (one row and column past it), then each tree's slope from its grid square
    const m = Math.ceil(size / SLOPE_STEP) + 3, x0 = minX - SLOPE_STEP, y0 = minY - SLOPE_STEP;
    const hs = new Float32Array(m * m);
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) hs[j * m + i] = height(x0 + i * SLOPE_STEP, y0 + j * SLOPE_STEP);
    const cs = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const fx = Math.min(m - 2.001, Math.max(0, (data[i * 6] - x0) / SLOPE_STEP)), fy = Math.min(m - 2.001, Math.max(0, (data[i * 6 + 1] - y0) / SLOPE_STEP));
      const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, o = iy * m + ix;
      const h00 = hs[o], h10 = hs[o + 1], h01 = hs[o + m], h11 = hs[o + m + 1];
      cs[i * 4] = cr[i]; cs[i * 4 + 1] = sp[i];
      cs[i * 4 + 2] = ((h10 - h00) * (1 - ty) + (h11 - h01) * ty) / SLOPE_STEP;
      cs[i * 4 + 3] = ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) / SLOPE_STEP;
    }
    g.setAttribute('iCrSp', new THREE.InstancedBufferAttribute(cs, 4));
    g.instanceCount = n;
    const mesh = new THREE.Mesh(g, this.mat);
    mesh.name = `tree shade ${key}`;
    mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
    const c = { mesh, minX, minY, maxX: minX + size, maxY: minY + size };
    this.cells.set(key, c);
    this.touch(c);
  }

  removeCell(key: string): void {
    const c = this.cells.get(key);
    if (!c) return;
    this.scene.remove(c.mesh);
    c.mesh.geometry.dispose();
    this.cells.delete(key);
    this.touch(c);
  }

  /** mark the drawn layers this cell's shadows reach as stale */
  private touch(c: ShadeCell): void {
    for (const l of this.layers) {
      if (!l.drawn || l.dirty) continue;
      if (c.maxX + REACH > l.cx - l.half && c.minX - REACH < l.cx + l.half && c.maxY + REACH > l.cy - l.half && c.minY - REACH < l.cy + l.half) l.dirty = true;
    }
  }

  /** Per frame: `x`, `y` the camera (pack m), `sunDir` toward the sun (three.js world). Redraws at most one layer. */
  update(renderer: THREE.WebGLRenderer, x: number, y: number, sunDir: THREE.Vector3): void {
    if (sunDir.y < 0.02) return; // no shadows to draw; the terrain shader skips them too
    const sunLen = sunDir.length();
    if (Number.isNaN(this.sun.x) || this.sun.dot(sunDir) / (this.sun.length() * sunLen) < Math.cos(SUN_TURN)) {
      this.sun.copy(sunDir);
      for (const l of this.layers) l.dirty = true;
    }
    let pick = -1;
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i];
      if (Math.max(Math.abs(x - l.cx), Math.abs(y - l.cy)) > l.half * RECENTRE || Number.isNaN(l.cx)) l.dirty = true;
      if (l.dirty && pick < 0) pick = i;
    }
    if (pick >= 0) this.draw(renderer, pick, x, y);
  }

  private draw(renderer: THREE.WebGLRenderer, i: number, x: number, y: number): void {
    const t0 = performance.now();
    const l = this.layers[i];
    // centre on the texel grid so a redraw lands on the same texels and nothing swims
    l.cx = Math.round(x / l.texel) * l.texel; l.cy = Math.round(y / l.texel) * l.texel;
    const u = this.mat.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(this.sun).normalize();
    (u.uLevel.value as THREE.Vector4).set(l.cx, l.cy, l.half, l.texel);
    let draws = 0, trees = 0;
    for (const c of this.cells.values()) {
      const on = c.maxX + REACH > l.cx - l.half && c.minX - REACH < l.cx + l.half && c.maxY + REACH > l.cy - l.half && c.minY - REACH < l.cy + l.half;
      c.mesh.visible = on;
      if (on) { draws++; trees += (c.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount; }
    }
    const prevTarget = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clear);
    renderer.setRenderTarget(this.target, i);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.autoClear = false;
    renderer.render(this.scene, this.cam);
    renderer.autoClear = prevAuto;
    renderer.setClearColor(this.clear, prevAlpha);
    renderer.setRenderTarget(prevTarget);
    this.rects[i].set(l.cx, l.cy, l.half, 1);
    l.drawn = true; l.dirty = false;
    this.stats.draws = draws; this.stats.trees = trees; this.stats.ms = performance.now() - t0;
  }

  dispose(): void {
    for (const k of [...this.cells.keys()]) this.removeCell(k);
    this.target.dispose(); this.mat.dispose(); this.quad.dispose();
  }
}
