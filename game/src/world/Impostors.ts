import * as THREE from 'three';

/**
 * Tree impostors: each species' near geometry is rendered once from N yaw angles into an
 * atlas (one row, N columns) and far cells draw camera-facing quads that pick the column
 * matching the view direction. One draw call per species per cell, 2 triangles per tree.
 */
const ANGLES = 8;
const TILE = 128;

export class ImpostorAtlas {
  readonly texture: THREE.Texture;
  /** quad width per metre of tree width, and quad height per metre of tree height, so the tile framing matches */
  readonly widthK: number;
  readonly heightK = 1.16;
  private readonly target: THREE.WebGLRenderTarget;

  constructor(renderer: THREE.WebGLRenderer, geometry: THREE.BufferGeometry, material: THREE.Material, aspect = 1) {
    this.target = new THREE.WebGLRenderTarget(TILE * ANGLES, TILE, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true });
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    this.target.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.target.texture.generateMipmaps = true;
    this.texture = this.target.texture;
    // bake scene: unit tree (height 1, width `aspect`) lit from above-front so the atlas carries shading
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(aspect, 1, aspect);
    scene.add(mesh);
    scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x6b7a5a, 1.1));
    const sun = new THREE.DirectionalLight(0xfff2dc, 2.2); sun.position.set(0.5, 1.2, 0.8); scene.add(sun);
    const half = Math.max(0.55, aspect * 0.6);
    this.widthK = (2 * half) / aspect;
    const cam = new THREE.OrthographicCamera(-half, half, 1.08, -0.08, 0.1, 20);
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const prevScissor = renderer.getScissorTest();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.setScissorTest(true);
    for (let i = 0; i < ANGLES; i++) {
      const a = (i / ANGLES) * Math.PI * 2;
      cam.position.set(Math.sin(a) * 6, 0.5 + 0.9, Math.cos(a) * 6); // ~14 degrees elevation
      cam.lookAt(0, 0.5, 0);
      cam.updateProjectionMatrix();
      renderer.setViewport(i * TILE, 0, TILE, TILE);
      renderer.setScissor(i * TILE, 0, TILE, TILE);
      renderer.render(scene, cam);
    }
    renderer.setScissorTest(prevScissor);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setViewport(0, 0, renderer.domElement.width, renderer.domElement.height);
  }

  dispose(): void { this.target.dispose(); }
}

export function impostorMaterial(atlas: THREE.Texture): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), map: { value: atlas }, angles: { value: ANGLES }, sunColor: { value: new THREE.Color(1, 1, 1) }, sunIntensity: { value: 1 } },
    vertexShader: `
      attribute vec3 iPos; attribute vec2 iScale; attribute float iYaw; attribute vec3 iColor;
      varying vec2 vUv; varying vec3 vColor;
      uniform float angles;
      #include <fog_pars_vertex>
      void main() {
        // billboard around Y toward the camera
        vec3 toCam = cameraPosition - iPos;
        float viewYaw = atan(toCam.x, toCam.z);
        vec3 right = vec3(cos(viewYaw), 0.0, -sin(viewYaw));
        vec3 world = iPos + right * position.x * iScale.x + vec3(0.0, position.y * iScale.y, 0.0);
        // atlas column: angle of the view relative to the tree's own yaw
        float rel = viewYaw - iYaw;
        float col = floor(mod(rel / 6.2831853 * angles + 0.5 + angles, angles));
        vUv = vec2((col + uv.x) / angles, uv.y);
        vColor = iColor;
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform sampler2D map; uniform vec3 sunColor; uniform float sunIntensity;
      varying vec2 vUv; varying vec3 vColor;
      #include <fog_pars_fragment>
      void main() {
        vec4 c = texture2D(map, vUv);
        if (c.a < 0.45) discard;
        // the atlas was lit at intensity ~1; retint by the live sun and the instance colour variation
        vec3 col = c.rgb * vColor * 1.9 * mix(vec3(0.75), sunColor, 0.6) * (0.55 + 0.45 * clamp(sunIntensity / 3.0, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
        #include <colorspace_fragment>
      }`,
    fog: true,
    transparent: false,
    side: THREE.DoubleSide,
  });
  return mat;
}

/** Build an instanced quad geometry for `n` trees; fill the attributes then set needsUpdate. */
export function impostorGeometry(n: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  // unit quad: x in [-0.5, 0.5], y in [0, 1]
  // unit quad matching the bake frame: y from -0.08 to 1.08 of the tree height, pre-divided by heightK
  const y0 = -0.08 / 1.16, y1 = 1.08 / 1.16;
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, y0, 0, 0.5, y0, 0, 0.5, y1, 0, -0.5, y1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('iScale', new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2));
  g.setAttribute('iYaw', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
  g.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
  g.instanceCount = n;
  return g;
}
