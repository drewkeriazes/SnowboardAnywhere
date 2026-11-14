/**
 * FEAT-307: the static people's meshes, posed once on the player's own rig (RiderRig: the same skinned
 * body, board, skis and poles the rider and the menu ghosts wear) and baked into one plain geometry with
 * the outfit as vertex colours, so a pair of skiers or a sitting snowboarder is one draw call with one
 * shared material. Nothing is animated: the bake is the whole person.
 *
 * Frames (three.js, metres, Y up): a skier's origin is the snow under the middle of the skis, facing -Z
 * (the skis' tips); a sitter's origin is the snow under the seat, the chest and the board's toe edge
 * facing +X (downhill), the board along Z below the seat. `slope` (radians) tilts the skis or the board
 * to the snow; the bodies stay upright.
 */
import * as THREE from 'three';
import { buildRig, pinFeet, setWorldQuat, twoBone, type RiderRig } from '../RiderRig';
import { defaultMaterials, type Pose, type RiderMaterials } from '../RiderModel';

export interface Outfit { jacket: string; pants: string; helmet: string; board: string; gloves: string }

const d2r = Math.PI / 180;
const E = (x: number, y: number, z: number): [number, number, number] => [x * d2r, y * d2r, z * d2r];

/** standing still on skis, chatting: nearly upright, poles planted beside the boots */
const CHAT: Pose = { hipsY: 1.03, hipsRot: E(2, 0, 0), torso: E(5, 0, 0), head: E(-3, 0, 0), lShoulder: E(18, 0, -12), rShoulder: E(18, 0, 12), lElbow: 40, rElbow: 40, lHip: E(10, 0, -2), rHip: E(10, 0, 2), lKnee: 15, rKnee: 15 };
/** sitting on the snow above the board, facing downhill, forearms on the knees */
const SIT: Pose = { hipsY: 0.16, hipsRot: E(-8, -90, 0), torso: E(22, 0, 0), head: E(-14, 0, 0), lShoulder: E(40, 0, -10), rShoulder: E(40, 0, 10), lElbow: 60, rElbow: 60, lHip: E(80, 0, -8), rHip: E(80, 0, 8), lKnee: 100, rKnee: 100 };

/** FK from a pose table, the way the rider's view does it (world/riderView/Limbs.ts applyFK) */
function applyPose(rig: RiderRig, p: Pose, headYaw = 0): void {
  const B = rig.bones;
  B.Hips.position.set(0, p.hipsY, 0);
  B.Hips.rotation.set(-p.hipsRot[0], p.hipsRot[1], p.hipsRot[2]);
  for (const [b, k] of [[B.Spine, 0.4], [B.Spine1, 0.3], [B.Spine2, 0.3]] as const) b.rotation.set(-p.torso[0] * k, p.torso[1] * k, p.torso[2] * k);
  B.Neck.rotation.set(-p.head[0] * 0.4, (p.head[1] + headYaw) * 0.4, p.head[2] * 0.4);
  B.Head.rotation.set(-p.head[0] * 0.6, (p.head[1] + headYaw) * 0.6, p.head[2] * 0.6);
  B.LeftArm.rotation.set(p.lShoulder[0], p.lShoulder[1], p.lShoulder[2]);
  B.RightArm.rotation.set(p.rShoulder[0], p.rShoulder[1], p.rShoulder[2]);
  B.LeftForeArm.rotation.set(p.lElbow * d2r, 0, 0);
  B.RightForeArm.rotation.set(p.rElbow * d2r, 0, 0);
  B.LeftUpLeg.rotation.set(p.lHip[0], p.lHip[1], p.lHip[2]);
  B.RightUpLeg.rotation.set(p.rHip[0], p.rHip[1], p.rHip[2]);
  B.LeftLeg.rotation.set(-p.lKnee * d2r, 0, 0);
  B.RightLeg.rotation.set(-p.rKnee * d2r, 0, 0);
  B.LeftFoot.rotation.set(0, 0, 0); B.RightFoot.rotation.set(0, 0, 0);
}

/** One rig per discipline, reused for every bake (only its pose and its materials' colours change). */
interface Kit { root: THREE.Group; rig: RiderRig; mats: RiderMaterials }
const kits: Partial<Record<'ski' | 'board', Kit>> = {};
function kit(discipline: 'ski' | 'board'): Kit {
  let k = kits[discipline];
  if (!k) {
    const mats = defaultMaterials();
    const rig = buildRig(mats, discipline);
    const root = new THREE.Group();
    root.add(rig.body, rig.board);
    k = kits[discipline] = { root, rig, mats };
  }
  return k;
}

function dress(k: Kit, o: Outfit): void {
  k.mats.jacket.color.set(o.jacket); k.mats.pants.color.set(o.pants); k.mats.helmet.color.set(o.helmet);
  k.mats.board.color.set(o.board); k.mats.gloves.color.set(o.gloves);
}

/** Positions, colours and indices gathered from posed meshes. */
export class Bake {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];
  private readonly v = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();

  /** Add every visible mesh under `root` (world matrices up to date), each vertex through `frame` (root space to the bake's). */
  add(root: THREE.Object3D, frame: THREE.Matrix4): void {
    root.updateMatrixWorld(true);
    root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry, pos = g.getAttribute('position');
      const c = (mesh.material as THREE.MeshStandardMaterial).color;
      const base = this.pos.length / 3;
      this.m.multiplyMatrices(frame, mesh.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        mesh.getVertexPosition(i, this.v); // skinned meshes: through the bones
        this.v.applyMatrix4(this.m);
        this.pos.push(this.v.x, this.v.y, this.v.z);
        this.col.push(c.r, c.g, c.b);
      }
      const ix = g.getIndex();
      if (ix) for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
      else for (let i = 0; i < pos.count; i++) this.idx.push(base + i);
    });
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion();

/**
 * A skier standing across the fall line, posed into `bake` through `frame`. `downhill` is +1 when the
 * slope falls to the skier's right (+X), -1 to the left; the skis roll with the snow, the legs reach them.
 * `headYaw` turns the head a little (radians, + to the left).
 */
export function bakeSkier(bake: Bake, frame: THREE.Matrix4, outfit: Outfit, slope: number, downhill: number, headYaw = 0): void {
  const k = kit('ski'), rig = k.rig;
  dress(k, outfit);
  rig.board.rotation.set(0, 0, -downhill * slope);
  for (const c of rig.carriers) c.rest.decompose(c.obj.position, c.obj.quaternion, c.obj.scale);
  applyPose(rig, CHAT, headYaw);
  // the hips sit a little uphill of the boots, as they do standing on a slope
  rig.bones.Hips.position.x = -downhill * 0.04 * Math.min(1, slope / 0.4);
  k.root.updateMatrixWorld(true);
  pinFeet(rig, _v.set(0, 0, -1), _w.set(0, 0, -1));
  // hands at the hips, a little out and ahead; the poles planted beside the boots
  const B = rig.bones;
  for (const [s, up, lo, end, grip] of [[-1, B.LeftArm, B.LeftForeArm, B.LeftHand, rig.lPole], [1, B.RightArm, B.RightForeArm, B.RightHand, rig.rPole]] as const) {
    const t = _v.set(s * 0.3, 1.05, -0.28);
    twoBone(up, lo, end, t, _w.set(s * 0.7, -0.4, 0.6).normalize());
    if (!grip) continue;
    const g = grip.getWorldPosition(_w);
    const plant = _v.set(s * 0.42, -s * downhill * 0.42 * Math.tan(slope) + 0.02, -0.12);
    setWorldQuat(grip, _q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), plant.sub(g).normalize()));
  }
  bake.add(k.root, frame);
}

/** A snowboarder sitting on the snow facing downhill (+X), posed into `bake` through `frame`. */
export function bakeSitter(bake: Bake, frame: THREE.Matrix4, outfit: Outfit, slope: number): void {
  const k = kit('board'), rig = k.rig;
  dress(k, outfit);
  // the board lies flat on the snow below the seat, toe edge downhill, across the fall line
  const out = 0.62;
  rig.board.position.set(out, -out * Math.tan(slope) + 0.01, 0);
  rig.board.rotation.set(0, 0, -slope);
  for (const c of rig.carriers) c.rest.decompose(c.obj.position, c.obj.quaternion, c.obj.scale);
  applyPose(rig, SIT);
  k.root.updateMatrixWorld(true);
  // knees up and a little out over the board
  pinFeet(rig, _v.set(0.5, 1, 0), _w.set(0.5, 1, 0));
  const B = rig.bones;
  // forearms resting on the knees, hands hanging just past them
  for (const [up, lo, end, knee] of [[B.LeftArm, B.LeftForeArm, B.LeftHand, B.LeftLeg], [B.RightArm, B.RightForeArm, B.RightHand, B.RightLeg]] as const) {
    const kp = knee.getWorldPosition(_v);
    const side = Math.sign(kp.z) || 1;
    twoBone(up, lo, end, _v.set(kp.x + 0.12, kp.y - 0.02, kp.z * 0.6), _w.set(0, -0.6, side).normalize());
  }
  bake.add(k.root, frame);
}
