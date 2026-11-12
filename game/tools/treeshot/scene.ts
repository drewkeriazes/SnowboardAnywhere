// FEAT-156: the page side of tools/treeshot.mjs. Renders the tree kit on its own, on snow, under the
// game's midday light (ACES, exposure 0.75, sun 3.7, sky-blue hemisphere), and exposes window.treeshot
// for the node script: lineup(snow), lods(species), snowLods(species), distance(), stats(). Each returns a PNG data URL.
import * as THREE from 'three';
import { TreeKit, SPECIES, farAttrs, farGeometry, fadeWidth, treeMaterial, buildShrubGeometries, SHRUBS, YOUNG_CONIFER } from '../../src/world/trees';
import { treeSnowUniforms } from '../../src/world/trees/snow';
import { buryShrub, SHRUB_MIN_SHOW } from '../../src/world/Shrubs';

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

/** FEAT-157: a snow level: the load (0..1), or 'ghost' (a full load above the snow-ghost line) */
type SnowLevel = number | 'ghost';
const GHOST_Z = treeSnowUniforms.uGhostZ.value.clone();
function snowLevel(l: SnowLevel): void {
  const ghost = l === 'ghost';
  kit.setSnow({ load: ghost ? 1 : l, melt: 0, ghost: ghost ? 1 : 0 });
  // the lineup stands at 0 m, so a ghost moves the ghost line below it
  if (ghost) treeSnowUniforms.uGhostZ.value.set(-200, -100); else treeSnowUniforms.uGhostZ.value.copy(GHOST_Z);
}
const levelName = (l: SnowLevel): string => (l === 'ghost' ? 'snow ghost' : `snow load ${l}`);
snowLevel(0);

/** a typical height (m) per species for the lineup */
const HEIGHT = [18, 14, 2.2, 15, 20, 24, 9, 15, 18, 20];

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

/** 8 strips (4 variants x front and back light): every species, front-lit then back-lit; ortho, so the grid reads in metres */
function lineup(snow: SnowLevel = 0): string {
  snowLevel(snow);
  const stripH = 330, n = SPECIES.length, slot = 116 / (n + 0.3), x0 = -slot * (n - 1) / 2;
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
      for (let s = 0; s < n; s++) addTree(s, v, x0 + s * slot, 0, HEIGHT[s], 0, 0.4 + v * 1.3);
      rider.position.set(x0 - 8.5, 0, 2); rider.rotation.y = 0.6;
      light(kind, new THREE.Vector3(0, 0, 0), 70);
      const img = render(cam, W, stripH);
      ctx.drawImage(img, 0, row * stripH);
      label(ctx, `variant ${v} - ${kind} light${snow === 0 ? '' : ` - ${levelName(snow)}`}`, 10, row * stripH + 22);
      if (row === 0) SPECIES.forEach((sp, s) => label(ctx, `${s} ${sp.name}`, ((x0 + s * slot + 58) / 116) * W - 50, 44));
      row++;
    }
  }
  snowLevel(0);
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

/** FEAT-157: one tile's numbers: the tree's share of the frame, the share of it that reads as snow and its mean brightness */
interface SnowStat { species: string; level: string; lod: string; cover: number; snow: number; luma: number }
const snowStats: SnowStat[] = [];
const MAGENTA = new THREE.Color(1, 0, 1);
/** render the tree again alone on magenta (no ground, no tone-mapped background) and count its pixels */
function measure(cam: THREE.Camera, size: number): { cover: number; snow: number; luma: number } {
  const bg = scene.background;
  scene.background = MAGENTA; snow.visible = false;
  render(cam, size, size);
  scene.background = bg; snow.visible = true;
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const g = c.getContext('2d')!; g.drawImage(canvas, 0, 0);
  const d = g.getImageData(0, 0, size, size).data;
  let n = 0, white = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 245 && d[i + 1] < 10 && d[i + 2] > 245) continue;
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    n++; sum += y;
    if (y > 120) white++; // lit or shaded snow; needles stay well under it
  }
  return { cover: n / (size * size), snow: n ? white / n : 0, luma: n ? sum / n : 0 };
}

/**
 * FEAT-157: LOD0 | LOD1 | LOD2 | impostor of one species at the same framing (front light), one row per
 * snow level: bare, 0.5, 1 and a snow ghost. The near tree and its impostor should match on every row.
 */
function snowLods(s: number): string {
  const tile = 300, h = HEIGHT[s], levels: SnowLevel[] = [0, 0.5, 1, 'ghost'];
  const out = document.createElement('canvas'); out.width = tile * 4; out.height = tile * levels.length;
  const ctx = out.getContext('2d')!;
  gridGround.visible = false; gridBack.visible = false;
  rider.position.set(1e4, 0, 0);
  const half = Math.max(h * 0.56, SPECIES[s].radius * h * 1.4);
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 1, 2000);
  const yc = Math.max(h * 0.48, half - h * 0.06);
  cam.position.set(0, yc + 400 * Math.tan(8 * Math.PI / 180), 400); cam.lookAt(0, yc, 0);
  const names = ['LOD0', 'LOD1', 'LOD2', 'impostor'];
  const rows: SnowStat[] = [];
  levels.forEach((l, r) => {
    snowLevel(l);
    for (let lod = 0; lod < 4; lod++) {
      clearTrees(); forceLod(lod);
      addTree(s, 0, 0, 0, h, lod as 0 | 1 | 2 | 3, 0.5);
      light('front', new THREE.Vector3(0, 0, 0), Math.max(20, h));
      ctx.drawImage(render(cam, tile, tile), lod * tile, r * tile);
      label(ctx, `${names[lod]} - ${levelName(l)}`, lod * tile + 8, r * tile + 20);
      rows.push({ species: SPECIES[s].name, level: levelName(l), lod: names[lod], ...measure(cam, tile) });
    }
  });
  snowStats.push(...rows);
  label(ctx, `${s} ${SPECIES[s].name}, ${h} m`, 8, tile * levels.length - 10);
  snowLevel(0); forceLod(null);
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
  // every LOD at each spot: the real bands pick which one draws
  ds.forEach((d, i) => { const s = [0, 3, 5, 4, 1][i % 5]; for (const lod of [0, 1, 2, 3] as const) addTree(s, i % 4, (i % 2 ? 1 : -1) * (6 + d * 0.1), -d, HEIGHT[s], lod); });
  const cam = new THREE.PerspectiveCamera(40, W / 900, 0.5, 6000);
  cam.position.set(0, 2, 0); cam.lookAt(0, 6, -200);
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

/** the baked impostor atlases: albedo (top), normals and the snow mask (bottom) */
function impostorAtlas(): string {
  const f = kit.far!, w = f.albedo.width, h = f.albedo.height;
  const out = document.createElement('canvas'); out.width = w; out.height = h * 3;
  const ctx = out.getContext('2d')!;
  [f.albedo, f.normal, f.snow].forEach((rt, k) => {
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

// ---------------------------------------------------------------- FEAT-159: the shrubs

const youngTris = Math.max(...[0, 3].flatMap((s) => kit.geo.lod1[s].map((g) => g.index!.count / 3)));
const shrubGeo = buildShrubGeometries(kit.atlas.cellMean, kit.atlas.barkMean, youngTris);
const shrubBand = { value: new THREE.Vector4(-2, -1, 1e8, 1e8 + 1) };
const shrubMat = treeMaterial(kit.atlas.texture, { band: shrubBand, wind: { value: 0 }, alphaToCoverage: true, shrub: true });
const youngMat = treeMaterial(kit.atlas.texture, { band: shrubBand, wind: { value: 0 }, alphaToCoverage: false, snowK: 0.6, shrub: true });

/** a shrub of `kind` (variant v; young conifers: v 0..3 spruce, 4..7 fir) h m tall with crown radius r, under `depth` m of snow, at (x, z) */
function addShrub(kind: number, v: number, x: number, z: number, h: number, r: number, depth: number, yaw: number): boolean {
  const b = buryShrub(kind, h, depth);
  if (b.vis < SHRUB_MIN_SHOW) return false;
  const src = kind === YOUNG_CONIFER ? kit.geo.lod1[v < 4 ? 0 : 3][v % 4] : shrubGeo.geo[kind][v % SHRUBS[kind].variants];
  const g = new THREE.BufferGeometry();
  g.index = src.index;
  for (const n of Object.keys(src.attributes)) g.setAttribute(n, src.getAttribute(n));
  g.setAttribute('aShrub', new THREE.InstancedBufferAttribute(new Float32Array([b.line, b.mound, SHRUBS[kind].drift]), 3));
  const mesh = new THREE.InstancedMesh(g, kind === YOUNG_CONIFER ? youngMat : shrubMat, 1);
  tmpQ.setFromAxisAngle(up, yaw);
  tmpM.compose(new THREE.Vector3(x, b.vis - h, z), tmpQ, new THREE.Vector3(r, h, r));
  mesh.setMatrixAt(0, tmpM);
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  trees.add(mesh);
  return true;
}

/** the lineup's shrubs: kind, variant, height (m), crown radius (m) */
const SHRUB_LINE: [number, number, number, number][] = [
  [0, 0, 1.2, 0.42], [0, 1, 2, 0.7], [0, 2, 3, 1.05],
  [1, 0, 0.35, 0.6], [1, 1, 0.7, 1], [1, 0, 1, 1.4],
  [2, 0, 0.55, 0.35], [2, 1, 0.9, 0.5], [2, 0, 1.2, 0.7],
  [4, 0, 1.4, 1], [4, 1, 2.6, 1.6],
  [3, 0, 1.4, 0.45], [3, 4, 2.4, 0.6], [3, 1, 3.8, 0.95],
];

/**
 * FEAT-159: the shrubs at snow depths 0, 0.5 and 1.5 m: each depth from the side (ortho, the 5 m grid and
 * the 1.8 m rider) and from above at 30 degrees, front lit, a winter snow load on the tops.
 */
function shrubs(): string {
  const depths = [0, 0.5, 1.5], stripH = 300, slot = 3.4, x0 = -slot * (SHRUB_LINE.length - 1) / 2;
  const out = document.createElement('canvas'); out.width = W; out.height = stripH * depths.length * 2;
  const ctx = out.getContext('2d')!;
  kit.setSnow({ load: 0.45, melt: 0, ghost: 0 });
  gridBack.position.set(0, 0, -4); gridGround.visible = true; gridBack.visible = true;
  const halfW = slot * SHRUB_LINE.length / 2 + 1.5, tall = 2 * halfW * stripH / W;
  const side = new THREE.OrthographicCamera(-halfW, halfW, tall - 0.8, -0.8, 1, 1000);
  side.position.set(0, 0, 60); side.lookAt(0, 0, 0);
  const top = new THREE.PerspectiveCamera(14, W / stripH, 0.5, 500);
  top.position.set(0, 16, 32); top.lookAt(0, 0.6, 0);
  let row = 0;
  depths.forEach((dep) => {
    clearTrees();
    const shown = SHRUB_LINE.map(([k, v, h, r], i) => addShrub(k, v, x0 + i * slot, 0, h, r, dep, 0.5 + i * 1.1));
    rider.position.set(x0 - 3, 0, 1.5); rider.rotation.y = 0.6;
    light('front', new THREE.Vector3(0, 0, 0), 40);
    for (const [cam, name] of [[side, 'side'], [top, 'from above']] as const) {
      ctx.drawImage(render(cam, W, stripH), 0, row * stripH);
      label(ctx, `snow depth ${dep} m - ${name}`, 10, row * stripH + 22);
      if (cam === side) SHRUB_LINE.forEach(([k, , h], i) => label(ctx, `${SHRUBS[k].name.replace('young conifer', 'young').replace('gambel oak', 'oak')} ${h}${shown[i] ? '' : ' (buried)'}`, ((x0 + i * slot - side.left) / (side.right - side.left)) * W - 34, row * stripH + stripH - 10));
      row++;
    }
  });
  snowLevel(0);
  clearTrees();
  return out.toDataURL('image/png');
}

function stats(): unknown {
  return { ...kit.stats(), kitMs: tKit, atlasTimes: (globalThis as unknown as { __atlasTimes?: number[] }).__atlasTimes, shrubs: shrubGeo.triangles, shrubMs: shrubGeo.ms };
}

(window as unknown as { treeshot: unknown }).treeshot = { lineup, shrubs, lods, snowLods, snowStats: () => snowStats, distance, atlas, impostorAtlas, stats, ready: true };
