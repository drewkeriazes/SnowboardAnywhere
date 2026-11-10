// FEAT-156: the page side of tools/treeshot.mjs. Renders the tree kit on its own, on snow, under the
// game's midday light (ACES, exposure 0.75, sun 3.7, sky-blue hemisphere), and exposes window.treeshot
// for the node script: lineup(), lods(species), distance(), stats(). Each returns a PNG data URL.
import * as THREE from 'three';
import { TreeKit, SPECIES, farAttrs, farGeometry, fadeWidth } from '../../src/world/trees';

const W = 1600;
const canvas = document.createElement('canvas');
document.body.style.margin = '0';
document.body.appendChild(canvas);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.75;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const t0 = performance.now();
const kit = new TreeKit({ alphaToCoverage: true });
const tKit = performance.now() - t0;
kit.bake(renderer);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc0e8);
const hemi = new THREE.HemisphereLight(new THREE.Color(0.81, 0.89, 1.0), 0xd9e2ee, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e6, 3.7);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0003;
scene.add(sun, sun.target);
const snow = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xf4f7fb, roughness: 1 }));
snow.receiveShadow = true;
scene.add(snow);
// the rider figure for scale: 1.8 m
const rider = new THREE.Group();
{
  const m = new THREE.MeshStandardMaterial({ color: 0xc2402e, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.1, 4, 8), m); body.position.y = 0.22 + 0.55 + 0.1; body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), m); head.position.y = 1.66;
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 1.55), new THREE.MeshStandardMaterial({ color: 0x222222 })); board.position.y = 0.02;
  rider.add(body, head, board);
}
scene.add(rider);
const gridGround = new THREE.GridHelper(400, 80, 0x8899aa, 0xb8c4d0); gridGround.position.y = 0.02; scene.add(gridGround);
const gridBack = new THREE.GridHelper(400, 80, 0x8899aa, 0xb8c4d0); gridBack.rotation.x = Math.PI / 2; scene.add(gridBack);
const lineMat = gridBack.material as THREE.Material; lineMat.transparent = true; lineMat.opacity = 0.5;

const trees = new THREE.Group();
scene.add(trees);

/** a typical height (m) per species for the lineup */
const HEIGHT = [18, 14, 2.2, 15, 20, 24, 9, 15];

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
function clearTrees(): void { for (const c of [...trees.children]) { trees.remove(c); } }
/** a tree at (x, z) (three.js world) of species s, variant v, height h, with the given LOD forced */
function addTree(s: number, v: number, x: number, z: number, h: number, lod: 0 | 1 | 2 | 3, yaw = 0): void {
  const cr = SPECIES[s].radius * h;
  if (lod <= 1) {
    const mesh = new THREE.InstancedMesh(lod === 0 ? kit.geo.lod0[s][v] : kit.geo.lod1[s][v], lod === 0 ? kit.mat.lod0 : kit.mat.lod1, 1);
    tmpQ.setFromAxisAngle(up, yaw);
    tmpM.compose(new THREE.Vector3(x, 0, z), tmpQ, new THREE.Vector3(cr, h, cr));
    mesh.setMatrixAt(0, tmpM);
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.castShadow = true;
    mesh.customDepthMaterial = lod === 0 ? kit.depth.lod0 : kit.depth.lod1;
    mesh.frustumCulled = false;
    trees.add(mesh);
  } else {
    const a = farAttrs(1);
    a.iPos.setXYZ(0, x, 0, z); a.iScale.setXY(0, cr, h); a.iYaw.setX(0, yaw); a.iColor.setXYZ(0, 1, 1, 1); a.iSpec.setX(0, s);
    const mesh = new THREE.Mesh(farGeometry(lod === 2 ? kit.crossed : kit.billboard, a), lod === 2 ? kit.far!.lod2 : kit.far!.imp);
    mesh.frustumCulled = false;
    trees.add(mesh);
  }
}

/** every LOD visible at any distance (for the lineup and the LOD comparison) or the real bands */
function forceLod(lod: number | null): void {
  const off = (b: { value: THREE.Vector4 }): void => { b.value.set(1e8, 1e8 + 1, 1e8 + 2, 1e8 + 3); };
  const on = (b: { value: THREE.Vector4 }): void => { b.value.set(-2, -1, 1e8, 1e8 + 1); };
  if (lod === null) { kit.setBands(80, 400, 1500, 4500, true); return; }
  [kit.bands.lod0, kit.bands.lod1, kit.bands.lod2, kit.bands.imp].forEach((b, i) => (i === lod ? on(b) : off(b)));
}

function light(kind: 'front' | 'back' | 'side', at: THREE.Vector3, span: number): void {
  // sun 40 degrees up; front: behind the camera (+z); back: behind the trees; side: from the left
  const el = 40 * Math.PI / 180, dir = kind === 'front' ? new THREE.Vector3(0.35, 0, 1) : kind === 'back' ? new THREE.Vector3(0.25, 0, -1) : new THREE.Vector3(-1, 0, 0.3);
  dir.normalize().multiplyScalar(Math.cos(el)); dir.y = Math.sin(el);
  sun.position.copy(at).addScaledVector(dir, 300); sun.target.position.copy(at);
  const c = sun.shadow.camera as THREE.OrthographicCamera;
  c.left = -span; c.right = span; c.top = span; c.bottom = -span; c.near = 1; c.far = 800; c.updateProjectionMatrix();
  kit.setLight(dir, sun.color, sun.intensity, hemi.color, hemi.groundColor, hemi.intensity);
}

function render(cam: THREE.Camera, w: number, h: number): HTMLCanvasElement {
  renderer.setSize(w, h, false);
  kit.setView(cam.position, 0);
  renderer.render(scene, cam);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  out.getContext('2d')!.drawImage(canvas, 0, 0);
  return out;
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.font = '600 15px system-ui, sans-serif';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.strokeText(text, x, y);
  ctx.fillStyle = '#1b2430'; ctx.fillText(text, x, y);
}

/** 8 strips: the 4 variants of every species, front-lit then back-lit; ortho, so the grid reads in metres */
function lineup(): string {
  const stripH = 330, slot = 14, x0 = -slot * 3.5;
  const out = document.createElement('canvas'); out.width = W; out.height = stripH * 8;
  const ctx = out.getContext('2d')!;
  forceLod(0);
  gridBack.position.set(0, 0, -12); gridGround.visible = true; gridBack.visible = true;
  const cam = new THREE.OrthographicCamera(-58, 58, 25.5, -2.4, 1, 1000);
  cam.position.set(0, 9, 120); cam.lookAt(0, 9 - 120 * Math.tan(3 * Math.PI / 180), 0);
  let row = 0;
  for (const kind of ['front', 'back'] as const) {
    for (let v = 0; v < 4; v++) {
      clearTrees();
      for (let s = 0; s < 8; s++) addTree(s, v, x0 + s * slot, 0, HEIGHT[s], 0, 0.4 + v * 1.3);
      rider.position.set(x0 - 8.5, 0, 2); rider.rotation.y = 0.6;
      light(kind, new THREE.Vector3(0, 0, 0), 70);
      const img = render(cam, W, stripH);
      ctx.drawImage(img, 0, row * stripH);
      label(ctx, `variant ${v} - ${kind} light`, 10, row * stripH + 22);
      if (row === 0) SPECIES.forEach((sp, s) => label(ctx, `${s} ${sp.name}`, ((x0 + s * slot + 58) / 116) * W - 50, 44));
      row++;
    }
  }
  return out.toDataURL('image/png');
}

/** LOD0 | LOD1 | LOD2 | impostor of one species at the same framing; front light, then side light */
function lods(s: number): string {
  const tile = 360, h = HEIGHT[s];
  const out = document.createElement('canvas'); out.width = tile * 4; out.height = tile * 2;
  const ctx = out.getContext('2d')!;
  gridGround.visible = false; gridBack.visible = false;
  rider.position.set(1e4, 0, 0);
  const half = Math.max(h * 0.56, SPECIES[s].radius * h * 1.4);
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 1, 2000);
  const yc = Math.max(h * 0.48, half - h * 0.06);
  cam.position.set(0, yc + 400 * Math.tan(8 * Math.PI / 180), 400); cam.lookAt(0, yc, 0);
  const names = ['LOD0 cards', 'LOD1 cones', 'LOD2 crossed quads', 'impostor'];
  ['front', 'side'].forEach((kind, r) => {
    for (let lod = 0; lod < 4; lod++) {
      clearTrees(); forceLod(lod);
      addTree(s, 0, 0, 0, h, lod as 0 | 1 | 2 | 3, 0.5);
      light(kind as 'front' | 'side', new THREE.Vector3(0, 0, 0), Math.max(20, h));
      ctx.drawImage(render(cam, tile, tile), lod * tile, r * tile);
      label(ctx, `${names[lod]}${r === 0 ? '' : ' (side light)'}`, lod * tile + 8, r * tile + 20);
    }
  });
  label(ctx, `${s} ${SPECIES[s].name}, ${h} m`, 8, tile * 2 - 10);
  forceLod(null);
  return out.toDataURL('image/png');
}

/**
 * Top: a ground-level view down a row of mixed trees from 20 m to 2 km, the real LOD bands. Below:
 * one tile per distance with the lens narrowed so the tree fills it, at the band edges and either
 * side of them (the tiles at an edge show the dither mix of the two LODs).
 */
function distance(): string {
  const out = document.createElement('canvas'); out.width = W; out.height = 900 + 2 * 220;
  const ctx = out.getContext('2d')!;
  forceLod(null);
  gridGround.visible = false; gridBack.visible = false;
  rider.position.set(1e4, 0, 0);
  clearTrees();
  // a row receding along -z, offset sideways in a zig-zag so each one shows
  const ds: number[] = [];
  for (let d = 20; d <= 2000; d *= 1.12) ds.push(d);
  ds.forEach((d, i) => { const s = [0, 3, 5, 4, 1][i % 5]; addTree(s, i % 4, (i % 2 ? 1 : -1) * (3 + d * 0.06), -d, HEIGHT[s], 0); });
  // real bands: each mesh is drawn by all four LOD materials and the band picks; add the other LODs at the same spots
  const base = [...trees.children];
  ds.forEach((d, i) => { const s = [0, 3, 5, 4, 1][i % 5]; for (const lod of [1, 2, 3] as const) addTree(s, i % 4, (i % 2 ? 1 : -1) * (3 + d * 0.06), -d, HEIGHT[s], lod); });
  void base;
  const cam = new THREE.PerspectiveCamera(50, W / 900, 0.5, 6000);
  cam.position.set(0, 3, 6); cam.lookAt(0, 2, -200);
  light('front', new THREE.Vector3(0, 0, -100), 200);
  ctx.drawImage(render(cam, W, 900), 0, 0);
  label(ctx, 'row from 20 m to 2 km, real LOD bands (0-80 cards, 80-400 cones, 400-1500 crossed quads, then impostors)', 10, 22);
  // the tiles
  const edges = [kit.edges.b0, kit.edges.b1, kit.edges.b2];
  const tilesD: number[] = [40];
  for (const e of edges) { const f = fadeWidth(e); tilesD.push(e - f, e - f / 4, e + f / 4, e + f); }
  tilesD.push(3000);
  const tw = W / 7;
  tilesD.forEach((d, k) => {
    clearTrees();
    const s = 0, h = HEIGHT[s];
    for (const lod of [0, 1, 2, 3] as const) addTree(s, 1, 0, -d, h, lod, 0.7);
    const c2 = new THREE.PerspectiveCamera(2 * Math.atan((h * 0.6) / d) * 180 / Math.PI, 1, Math.max(0.5, d * 0.5), d * 2);
    c2.position.set(0, h * 0.5, 0); c2.lookAt(0, h * 0.5, -d);
    light('front', new THREE.Vector3(0, 0, -d), 40);
    const img = render(c2, Math.round(tw), 220);
    const x = (k % 7) * tw, y = 900 + Math.floor(k / 7) * 220;
    ctx.drawImage(img, x, y);
    label(ctx, `${Math.round(d)} m`, x + 6, y + 18);
  });
  return out.toDataURL('image/png');
}

/** the card atlas (level 0 and the level-3 mip side by side), for checking the sprays */
function atlas(): string {
  const mips = kit.atlas.texture.mipmaps as unknown as { data: Uint8Array; width: number; height: number }[];
  const out = document.createElement('canvas'); out.width = 1024 + 512; out.height = 1024;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#c03080'; ctx.fillRect(0, 0, out.width, out.height);
  const put = (m: { data: Uint8Array; width: number; height: number }, x: number, scale: number): void => {
    const c = document.createElement('canvas'); c.width = m.width; c.height = m.height;
    const id = c.getContext('2d')!.createImageData(m.width, m.height);
    for (let y = 0; y < m.height; y++) id.data.set(m.data.subarray((m.height - 1 - y) * m.width * 4, (m.height - y) * m.width * 4), y * m.width * 4);
    for (let i = 3; i < id.data.length; i += 4) id.data[i] = id.data[i] >= 128 ? 255 : 0; // what the cutoff keeps
    c.getContext('2d')!.putImageData(id, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c, x, 0, m.width * scale, m.height * scale);
  };
  put(mips[0], 0, 1); put(mips[3], 1024, 4);
  return out.toDataURL('image/png');
}

/** the baked impostor atlases: albedo (top) and normals (bottom) */
function impostorAtlas(): string {
  const f = kit.far!, w = f.albedo.width, h = f.albedo.height;
  const out = document.createElement('canvas'); out.width = w; out.height = h * 2;
  const ctx = out.getContext('2d')!;
  [f.albedo, f.normal].forEach((rt, k) => {
    const px = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    const id = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) id.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    for (let i = 3; i < id.data.length; i += 4) id.data[i] = id.data[i] > 0 ? 255 : 0;
    ctx.fillStyle = '#c03080'; ctx.fillRect(0, k * h, w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d')!.putImageData(id, 0, 0);
    ctx.drawImage(c, 0, k * h);
  });
  return out.toDataURL('image/png');
}

function stats(): unknown {
  return { ...kit.stats(), kitMs: tKit, atlasTimes: (globalThis as unknown as { __atlasTimes?: number[] }).__atlasTimes };
}

(window as unknown as { treeshot: unknown }).treeshot = { lineup, lods, distance, atlas, impostorAtlas, stats, ready: true };
