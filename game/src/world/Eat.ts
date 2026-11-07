import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Rider } from '../sim/Rider';
import type { MonsterState } from '../sim/Outrun';
import { RiderView } from './RiderView';
import type { MonsterView, EatPose } from './Monster';
import type { Puffs } from './Puffs';

/**
 * The eat sequence (FEAT-100), cartoon and bloodless:
 *   grab (slow motion, camera cut to a fixed side angle) -> lift the rider by the torso ->
 *   rip in half with a pop and a snow-and-confetti puff -> unhinge the jaw -> bite one, bite two ->
 *   spit the board out (it lands upright) -> burp -> fade to the EATEN card.
 * Gentle swallows the rider whole in one bite and skips the rip.
 *
 * The split uses two extra RiderViews posed from the live rider at the catch: one with the leg
 * bones scaled to nothing (the top half), one with the spine scaled to nothing (the legs); each
 * rides in a hand. No mesh cutting. Sound cues go out through `onSound`.
 */
export type EatSound = 'pop' | 'gulp' | 'burp' | 'spit' | 'sting' | 'roar';
type Step = 'grab' | 'lift' | 'rip' | 'jaw' | 'bite1' | 'bite2' | 'spit' | 'burp' | 'fade' | 'done';
const STEPS: [Step, number][] = [['grab', 0.5], ['lift', 1.0], ['rip', 0.5], ['jaw', 0.8], ['bite1', 0.7], ['bite2', 0.8], ['spit', 0.6], ['burp', 1.1], ['fade', 0.7]];
const CONFETTI = [0xff4d6d, 0xffd166, 0x06d6a0, 0x4cc9f0, 0xffffff, 0xf4a261];
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Eat {
  active = false;
  /** the card can show */
  done = false;
  private gentle = false;
  private t = 0;
  private real = 0;
  private monster: MonsterView | null = null;
  private state: MonsterState | null = null;
  private riderView: RiderView | null = null;
  private readonly top: RiderView;
  private readonly legs: RiderView;
  private readonly board: THREE.Mesh;
  private boardV = new THREE.Vector3();
  private boardFlying = false;
  private boardStuck = false;
  private readonly fired = new Set<string>();
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly lHand = new THREE.Vector3();
  private readonly rHand = new THREE.Vector3();
  private readonly carryOff = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly topOff = new THREE.Vector3();
  private readonly legsOff = new THREE.Vector3();
  private heading = 0;
  private sideDir = new THREE.Vector3();
  readonly group = new THREE.Group();
  onSound: ((s: EatSound) => void) | null = null;

  constructor(private readonly pack: Pack, private readonly puffs: Puffs | null) {
    this.group.name = 'eat sequence';
    this.top = new RiderView(); this.legs = new RiderView();
    this.top.group.visible = this.legs.group.visible = false;
    this.group.add(this.top.group, this.legs.group);
    this.board = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.024, 1.56), new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.35, metalness: 0.2 }));
    this.board.castShadow = true; this.board.visible = false; this.board.name = 'spat board';
    this.group.add(this.board);
  }

  /** Materials for the CSM hook. */
  get materials(): THREE.Material[] { return [...Object.values(this.top.mats), ...Object.values(this.legs.mats), this.board.material as THREE.Material]; }

  start(m: MonsterState, mv: MonsterView, rider: Rider, riderView: RiderView, outfit: { jacket: string; pants: string; helmet: string; board: string; gloves: string }, discipline: 'board' | 'ski', gentle: boolean): void {
    this.active = true; this.done = false; this.gentle = gentle;
    this.t = 0; this.real = 0; this.fired.clear();
    this.monster = mv; this.state = m; this.riderView = riderView;
    // the monster stands where it is, facing the rider; the camera sits off to the lower side
    this.heading = Math.atan2(rider.x - m.x, rider.y - m.y);
    const hx = Math.sin(this.heading), hy = Math.cos(this.heading);
    const lx = -hy, ly = hx; // left of the heading (pack)
    const zl = this.pack.groundHeight(m.x + lx * 7, m.y + ly * 7), zr = this.pack.groundHeight(m.x - lx * 7, m.y - ly * 7);
    const s = (Number.isNaN(zl) ? Infinity : zl) <= (Number.isNaN(zr) ? Infinity : zr) ? 1 : -1;
    this.sideDir.set(lx * s, 0, -ly * s);
    // the split clones take the live outfit and pose
    for (const c of [this.top, this.legs]) {
      c.setDiscipline(discipline); c.setOutfit(outfit);
      c.setPack(this.pack); c.update(rider, 1, false);
    }
    this.top.splitPart('top'); this.legs.splitPart('legs');
    this.top.group.visible = this.legs.group.visible = false;
    // where each piece is held: the torso (Spine1) for the top half and the whole rider, the pelvis for the legs
    this.topOff.copy(this.top.boneWorld('Spine1', this.v1)).sub(this.top.group.position);
    this.legsOff.copy(this.legs.boneWorld('Hips', this.v1)).sub(this.legs.group.position);
    this.carryOff.copy(riderView.boneWorld('Spine1', this.v1)).sub(riderView.group.position);
    (this.board.material as THREE.MeshStandardMaterial).color.set(outfit.board);
    this.board.visible = false; this.boardFlying = false; this.boardStuck = false;
    this.onSound?.('roar');
  }

  private at(step: Step): number { let s = 0; for (const [n, d] of STEPS) { if (n === step) return s; s += d; } return s; }
  private stepAt(t: number): { step: Step; u: number } {
    let s = 0;
    for (const [n, d] of STEPS) { if (t < s + d) return { step: n, u: (t - s) / d }; s += d; }
    return { step: 'done', u: 1 };
  }
  private once(key: string, f: () => void): void { if (!this.fired.has(key)) { this.fired.add(key); f(); } }

  /** Per frame; the first half second runs at 0.3x. Returns true while the sequence is running. */
  update(dt: number): boolean {
    if (!this.active || !this.monster || !this.state || !this.riderView) return false;
    this.real += dt;
    const sdt = this.real < 0.5 ? dt * 0.3 : dt;
    this.t += sdt;
    const m = this.state, mv = this.monster, rv = this.riderView;
    const { step, u } = this.stepAt(this.t);
    const gentle = this.gentle;
    // ---- targets for the hands (world, three.js): chest height in front, up to the mouth for a bite
    const chest = mv.belly(this.v1).add(this.v2.set(0, 0.5, 0));
    const front = this.v2.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
    const right = this.right.set(Math.cos(this.heading), 0, Math.sin(this.heading));
    const mouth = mv.mouth(this.v3);
    const hold = (out: THREE.Vector3, side: number, raise: number, toMouth: number) => {
      out.copy(chest).addScaledVector(front, 1.0).addScaledVector(right, side * 0.6 * (1 - toMouth));
      out.y += 0.1 + 0.9 * raise;
      out.lerp(mouth, toMouth);
    };
    let lean = 0, headPitch = 0, jaw = 0.1;
    const spread = step === 'grab' || step === 'lift' ? 0 : 1;
    let lRaise = 0, rRaise = 0, lMouth = 0, rMouth = 0;
    if (step === 'grab') { lean = 1 - u; lRaise = rRaise = 0; }
    else if (step === 'lift') { lRaise = rRaise = smooth(0, 1, u); }
    else if (step === 'rip') { lRaise = rRaise = 1; }
    else if (step === 'jaw') { lRaise = rRaise = 1; headPitch = 0.9 * smooth(0, 1, u); jaw = smooth(0, 1, u); }
    else if (step === 'bite1') { lRaise = rRaise = 1; headPitch = 0.9; jaw = u < 0.6 ? 1 : 1 - smooth(0.6, 0.85, u) * 0.8; rMouth = smooth(0, 0.5, u); lRaise = 1; }
    else if (step === 'bite2') { lRaise = 1; rRaise = 0.3; headPitch = 0.9; jaw = u < 0.1 ? 0.3 : u < 0.6 ? 0.3 + 0.7 * smooth(0.1, 0.3, u) : 1 - smooth(0.6, 0.85, u) * 0.8; lMouth = smooth(0.1, 0.55, u); rMouth = 1; }
    else if (step === 'spit') { headPitch = -0.3 * Math.sin(u * Math.PI); jaw = 0.5 * Math.sin(u * Math.PI); lRaise = rRaise = 0.3; }
    else if (step === 'burp') { headPitch = 0.5 * smooth(0, 0.3, u) * (1 - smooth(0.7, 1, u)); jaw = 0.4 * smooth(0, 0.3, u) * (1 - smooth(0.6, 1, u)); lRaise = rRaise = 0.1; }
    else { lRaise = rRaise = 0.1; }
    hold(this.lHand, -spread, lRaise, lMouth); hold(this.rHand, spread, rRaise, rMouth);
    // belly pat in the burp
    if (step === 'burp' && u > 0.4) { const pat = 0.08 * Math.abs(Math.sin((u - 0.4) * 12)); mv.belly(this.lHand).addScaledVector(front, 0.3 + pat).addScaledVector(right, -0.3); mv.belly(this.rHand).addScaledVector(front, 0.3 + pat).addScaledVector(right, 0.3); }
    const pose: EatPose = { x: m.x, y: m.y, z: m.z, heading: this.heading, lean, lHand: this.lHand, rHand: this.rHand, headPitch, jaw };
    mv.poseEat(pose, this.pack, sdt);
    // ---- the rider: carried whole until the rip, then two halves in the hands
    const lh = mv.hand('L', this.v1), rh = mv.hand('R', this.v2);
    const ripped = !gentle && this.t >= this.at('rip') + 0.15;
    const eatenTop = this.fired.has('bite1'), eatenLegs = this.fired.has('bite2');
    if (!ripped) {
      const whole = !eatenTop;
      rv.group.visible = whole;
      if (whole) { rv.group.position.copy(lh).lerp(rh, 0.5).sub(this.carryOff); }
      this.top.group.visible = this.legs.group.visible = false;
    } else {
      rv.group.visible = false;
      this.top.group.visible = !eatenTop; this.legs.group.visible = !eatenLegs;
      this.top.group.position.copy(rh).sub(this.topOff);
      this.legs.group.position.copy(lh).sub(this.legsOff);
    }
    // ---- cues
    if (step === 'rip' && u > 0.3) this.once('rip', () => {
      this.onSound?.('pop');
      const seam = this.v3.copy(lh).lerp(rh, 0.5);
      this.puffs?.emit(seam.x, seam.y, seam.z, 60, [0xffffff, 0xeaf2ff], 0.4, 2.5, 2.5, 1.0, 1.2);
      this.puffs?.emit(seam.x, seam.y, seam.z, 80, CONFETTI, 0.3, 4, 3, 1.8, 0.8);
    });
    if (step === 'bite1' && u > 0.75) this.once('bite1', () => { this.onSound?.('gulp'); });
    if (step === 'bite2' && u > 0.75) this.once('bite2', () => { this.onSound?.('gulp'); });
    if (step === 'spit' && u > 0.3) this.once('spit', () => {
      this.onSound?.('spit');
      this.board.visible = true; this.boardFlying = true;
      this.board.position.copy(mouth);
      this.board.quaternion.copy(mv.group.quaternion);
      this.boardV.copy(front).multiplyScalar(5).add(this.v3.set(0, 4.5, 0)).addScaledVector(this.sideDir, 1.5);
    });
    if (step === 'burp' && u > 0.15) this.once('burp', () => {
      this.onSound?.('burp');
      this.puffs?.emit(mouth.x, mouth.y, mouth.z - 0.2, 70, [0xffffff, 0xdfe9f5], 0.4, 2.5, 1.5, 1.6, 1.0);
    });
    if (step === 'fade') this.once('fade', () => { this.onSound?.('sting'); });
    if (step === 'done') { this.done = true; }
    // the spat board: a throw, then it sticks in the snow nose down
    if (this.boardFlying) {
      this.boardV.y -= 9.81 * sdt;
      this.board.position.addScaledVector(this.boardV, sdt);
      this.board.rotateX(sdt * 6);
      const g = this.pack.groundHeight(this.board.position.x, -this.board.position.z);
      if (!Number.isNaN(g) && this.board.position.y < g + 0.3 && this.boardV.y < 0) {
        this.boardFlying = false; this.boardStuck = true;
        this.board.position.y = g + 0.55;
        this.board.rotation.set(Math.PI / 2 - 0.15, Math.random() * Math.PI * 2, 0);
        this.puffs?.emit(this.board.position.x, g + 0.1, this.board.position.z, 20, [0xffffff], 0.4, 2, 1.5, 0.8);
      }
    }
    return true;
  }

  /** Fixed side camera: off the lower side of the slope, looking at the monster's chest. */
  cameraPose(pos: THREE.Vector3, look: THREE.Vector3): void {
    const m = this.state!;
    const cx = m.x + this.sideDir.x * 7.5, cy = m.y - this.sideDir.z * 7.5;
    const g = this.pack.groundHeight(cx, cy);
    this.camPos.set(cx, Math.max(m.z + 2.2, (Number.isNaN(g) ? m.z : g) + 1.6), -cy);
    this.camLook.set(m.x, m.z + 2.0, -m.y);
    pos.copy(this.camPos); look.copy(this.camLook);
  }

  /** Clean up after the card: the real rider becomes visible again when the owner resets it. */
  end(): void {
    this.active = false; this.done = false;
    this.top.group.visible = this.legs.group.visible = false;
    this.board.visible = false; this.boardFlying = false; this.boardStuck = false;
    this.monster = null; this.state = null;
    if (this.riderView) { this.riderView.group.visible = true; this.riderView = null; }
  }

  dispose(): void { this.board.geometry.dispose(); (this.board.material as THREE.Material).dispose(); }
}
