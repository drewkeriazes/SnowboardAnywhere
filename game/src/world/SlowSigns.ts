import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';
import { signClear, slowSignSites, type SlowSignSite } from './slowSignSites';

/**
 * FEAT-306: occasional SLOW signs at the bottom of green and blue runs, where they merge into another
 * run or come into the base area (world/slowSignSites.ts picks the spots from the pack's runs and lifts).
 * Each is a yellow panel with SLOW in black on a grey post, facing riders coming down. All of them are one
 * InstancedMesh with one material (one draw call, plus its shadow passes). The posts are collider
 * trunks like the landmark and building posts. A sign first stands OFFSET m off the run's line and
 * moves to the groomed edge once the mask tile under it has loaded, and re-seats on the finest terrain
 * as it streams in near the rider. `visible` hides them and takes their posts out of the collider (for
 * a Nature mode, FEAT-309).
 */

// sizes (m): a 1.1 x 0.75 panel whose bottom edge stands 1.35 m above the snow, on a 0.1 m post
const PANEL_W = 1.1, PANEL_H = 0.75, PANEL_D = 0.03, PANEL_Y = 1.35;
const POST_W = 0.1, POST_TOP = PANEL_Y + PANEL_H - 0.05, SINK = 1.2;
/** collider radius of the post (a little fat so the board catches it) */
const POST_R = 0.12;
/** the sign stands this far inside the groomed edge, kept within these distances of the run's line (m) */
const EDGE_IN = 1.5, OFFSET_MIN = 5, OFFSET_MAX = 30;
/** a mask value at or under this is off the groomed run, or into trees */
const GROOMED_MIN = 0.35, CANOPY_MAX = 0.5;
/** work on signs within this distance of the rider (m): placing them on the mask, seating them, their posts */
const NEAR = 500, POST_NEAR = 200;

// the texture: the panel face on top (TEX_FACE of the height), a strip of grey for the post and the panel's back and edges below it
const TEX_W = 256, TEX_H = 192, TEX_FACE = 160 / 192;
const YELLOW = '#f4c21a', BLACK = '#141414', GREY = '#8a8d90';

function signTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = TEX_W; c.height = TEX_H;
  const g = c.getContext('2d')!;
  const fh = TEX_H * TEX_FACE;
  g.fillStyle = YELLOW; g.fillRect(0, 0, TEX_W, fh);
  g.strokeStyle = BLACK; g.lineWidth = 10; g.strokeRect(12, 12, TEX_W - 24, fh - 24);
  g.fillStyle = BLACK; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 92px "Arial Black", "Helvetica Neue", Arial, sans-serif';
  const w = g.measureText('SLOW').width;
  g.save(); g.translate(TEX_W / 2, fh / 2 + 4); g.scale(Math.min(1, (TEX_W - 56) / w), 1); g.fillText('SLOW', 0, 0); g.restore();
  g.fillStyle = GREY; g.fillRect(0, fh, TEX_W, TEX_H - fh);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** Point every vertex's UV of a geometry at the grey strip. */
function greyUVs(g: THREE.BufferGeometry): void {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const v = (1 - TEX_FACE) / 2; // middle of the strip (uv v runs up from the bottom of the canvas)
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, v);
}

/** One sign in its own frame: y up, the face toward +z (riders come from +z, travelling -z), ground at y = 0. */
function signGeometry(): THREE.BufferGeometry {
  const post = new THREE.BoxGeometry(POST_W, POST_TOP + SINK, POST_W);
  post.translate(0, (POST_TOP - SINK) / 2, -PANEL_D / 2 - POST_W / 2);
  greyUVs(post);
  const panel = new THREE.BoxGeometry(PANEL_W, PANEL_H, PANEL_D);
  panel.translate(0, PANEL_Y + PANEL_H / 2, 0);
  // BoxGeometry's faces run +x, -x, +y, -y, +z, -z, four vertices each: the +z face shows the panel, the rest are grey
  const uv = panel.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    if (Math.floor(i / 4) === 4) uv.setY(i, (1 - TEX_FACE) + uv.getY(i) * TEX_FACE);
    else uv.setXY(i, 0.5, (1 - TEX_FACE) / 2);
  }
  return mergeGeometries([post, panel])!;
}

interface Sign {
  site: SlowSignSite;
  /** where it stands now (pack metres) and the ground under it */
  x: number; y: number; z: number;
  /** the terrain resolution its ground came from (Infinity before it is seated) */
  res: number;
  /** moved to the groomed edge yet */
  edged: boolean;
  post: Float32Array | null;
}

export class SlowSigns {
  readonly group = new THREE.Group();
  readonly materials: THREE.Material[] = [];
  readonly signs: Sign[] = [];
  private readonly mesh: THREE.InstancedMesh | null = null;
  private readonly clear: (x: number, y: number) => boolean;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly px = [0, 0, 0, 0];
  private shown = true;

  constructor(private readonly pack: Pack, private readonly collider: Collider | null) {
    this.clear = signClear(pack.features);
    for (const site of slowSignSites(pack.features, pack.meta.slug)) {
      const x = site.cx + site.sx * site.offset, y = site.cy + site.sy * site.offset;
      this.signs.push({ site, x, y, z: site.cz, res: Infinity, edged: false, post: null });
    }
    if (!this.signs.length) return; // nothing to draw: no mesh, no draw call
    const map = signTexture();
    // a little emissive so the yellow still reads in the shade and against the light, as reflective sign paint does
    const mat = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0x3a3a3a, roughness: 0.6, metalness: 0.1 });
    this.materials.push(mat);
    this.mesh = new THREE.InstancedMesh(signGeometry(), mat, this.signs.length);
    this.mesh.name = 'slow signs';
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.group.add(this.mesh);
    for (let i = 0; i < this.signs.length; i++) this.seat(i, true);
    this.mesh.computeBoundingSphere();
  }

  /** Shown, with their posts in the collider (default); false hides every sign and lets the board through. */
  get visible(): boolean { return this.shown; }
  set visible(v: boolean) {
    if (v === this.shown) return;
    this.shown = v;
    this.group.visible = v;
    if (!v) for (const s of this.signs) this.dropPost(s);
  }

  /** Stand sign i on the finest terrain loaded under it; true when it moved. */
  private seat(i: number, force = false): boolean {
    const s = this.signs[i];
    const z = this.pack.terrainHeight(s.x, s.y);
    if (Number.isFinite(z)) s.res = this.pack.finestRes(s.x, s.y);
    if (!force && (!Number.isFinite(z) || Math.abs(z - s.z) < 0.01)) return false;
    if (Number.isFinite(z)) s.z = z;
    this.p.set(s.x, s.z, -s.y);
    this.q.setFromAxisAngle(this.up, -s.site.heading);
    this.mesh!.setMatrixAt(i, this.m.compose(this.p, this.q, this.s));
    this.mesh!.instanceMatrix.needsUpdate = true;
    if (s.post) { s.post[3] = s.z - 1; s.post[4] = s.z + POST_TOP; }
    return true;
  }

  /**
   * Move a sign out to the groomed edge of its run once the mask under it has loaded: walk out from the
   * line until the snow is no longer groomed (or trees start), and stand EDGE_IN m inside that.
   */
  private edge(s: Sign): boolean {
    const mask = this.pack.mask;
    const { cx, cy, sx, sy } = s.site;
    if (!mask) return true;
    if (!mask.has(cx, cy) || !mask.has(cx + sx * OFFSET_MAX, cy + sy * OFFSET_MAX)) return false;
    let d = OFFSET_MIN;
    for (; d <= OFFSET_MAX; d += 1) {
      const v = mask.sampleBilinear(cx + sx * d, cy + sy * d, this.px);
      if (v[2] <= GROOMED_MIN || v[3] >= CANOPY_MAX) break;
    }
    const off = d > OFFSET_MAX ? s.site.offset : Math.max(OFFSET_MIN, d - EDGE_IN);
    const x = cx + sx * off, y = cy + sy * off;
    if (this.clear(x, y)) { s.x = x; s.y = y; }
    return true;
  }

  private dropPost(s: Sign): void {
    if (s.post && this.collider) this.collider.remove(s.post);
    s.post = null;
  }

  // ---- BUG-082 workaround: delete from here to the end marker once #689 (BUG-082) is on main ----
  // A far tree cell dropping clears every cylinder in its square kilometre, this sign's post too, so a post
  // the collider no longer holds is forgotten here and maintain() adds it again. Once #689 lands, tree and rock
  // cells remove only their own cylinders: delete this method, its call in maintain() and the `found` field.
  private readonly found: Float32Array[] = [];
  private bug082Readd(s: Sign): void {
    if (s.post && this.collider && !this.collider.near(s.x, s.y, 0.01, this.found).includes(s.post)) s.post = null;
  }
  // ---- end of BUG-082 workaround ----

  /** Each frame: place, seat and give posts to the signs near the rider (pack metres). */
  maintain(rx: number, ry: number): void {
    if (!this.mesh || !this.shown) return;
    let moved = false;
    for (let i = 0; i < this.signs.length; i++) {
      const s = this.signs[i];
      const d = Math.hypot(rx - s.x, ry - s.y);
      if (d > NEAR) continue;
      if (!s.edged && this.edge(s)) {
        s.edged = true; moved = this.seat(i, true) || moved;
        this.dropPost(s); // re-added where it stands now, below
      } else if (s.res > 1) moved = this.seat(i) || moved;
      if (!this.collider) continue;
      if (d < POST_NEAR) {
        this.bug082Readd(s);
        if (!s.post) s.post = this.collider.add(s.x, s.y, POST_R, s.z - 1, s.z + POST_TOP, 0);
      }
    }
    if (moved) this.mesh.computeBoundingSphere();
  }
}
