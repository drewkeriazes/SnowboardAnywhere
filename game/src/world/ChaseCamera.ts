import * as THREE from 'three';
import type { Rider } from '../sim/Rider';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';

/** BUG-032: clearance kept from a trunk, and the closest the chase camera gets to the rider's head when pulled in */
const CAM_PAD = 1.0;
const CAM_MIN = 1.5;

/** first-person roll (BUG-031): radians of roll per unit edge angle, the cap, and the speed (m/s) at which it is fully applied */
const FP_ROLL_K = 0.16;
const FP_ROLL_MAX = 10 * Math.PI / 180;
const FP_ROLL_FULL_SPEED = 8;

export type CameraMode = 'chase' | 'close' | 'far' | 'cine' | 'fp' | 'helmet' | 'free' | 'eye';

/**
 * FEAT-122: how each third-person camera frames the rider (metres). dist / height place the camera
 * behind and above the board, and clear is the least it keeps above the snow under itself (on a steep
 * slope that, not height, sets how high it sits). It looks at a point lookAhead in front of the rider
 * along the travel direction, lookUp above the board, or with aimGround lookUp above the snow there,
 * so it looks over the rider's head at what is coming. tuckDrop lowers it in a tuck, side swings it
 * off to one side, lead (0..1) is how much of the follow lag is cancelled so the distance holds at speed.
 */
interface Framing { dist: number; height: number; clear: number; lookAhead: number; lookUp: number; aimGround: boolean; tuckDrop: number; side: number; lead: number }
const FRAMING: Record<'chase' | 'close' | 'far' | 'cine', Framing> = {
  // default: above and behind, looking over the head at the snow ahead; the rider in the lower third
  chase: { dist: 4.5, height: 4.0, clear: 3.6, lookAhead: 10, lookUp: 1.0, aimGround: true, tuckDrop: 0.3, side: 0, lead: 1 },
  // tight and low behind the back: the rider big in frame, for the feel of speed
  close: { dist: 2.6, height: 1.3, clear: 1.0, lookAhead: 4, lookUp: 1.5, aimGround: false, tuckDrop: 0.25, side: 0, lead: 1 },
  // broadcast view: high and further back, looking down at the rider about 25 deg, the line ahead in view
  far: { dist: 11, height: 6.5, clear: 1.2, lookAhead: 3, lookUp: 0.6, aimGround: false, tuckDrop: 0.4, side: 0, lead: 1 },
  // FEAT-045 cinematic: low, off to one side and trailing on a long lens, slow to follow (lag kept)
  cine: { dist: 11, height: 1.3, clear: 1.2, lookAhead: 0, lookUp: 1.0, aimGround: false, tuckDrop: 0.6, side: 5, lead: 0 },
};
/** FEAT-122: the default camera stopped or slow relaxes back to this, so you can see around you */
const CHASE_SLOW = { dist: 5.5, height: 4.2 };
/** aimGround: the aim point never drops faster than this (rise / run) below the rider, nor rises above it more than AIM_RISE, so a cliff, a jump or an uphill does not yank the view */
const AIM_DROP = 0.6, AIM_RISE = 0.15;
/** speeds (m/s) between which the default blends from CHASE_SLOW to its at-speed framing */
const CHASE_BLEND_LO = 3, CHASE_BLEND_HI = 12;
/**
 * BUG-057 look behind: first person tips up this much (rad, about 5 deg) so the horizon and the run
 * above are in frame. The chase cameras swing round to the downhill side, ease their orbit pitch to
 * GLANCE_PITCH and come down to at most GLANCE_HEIGHT (m) above the board, and aim GLANCE_AIM m back
 * up the travel line, GLANCE_AIM_UP above the snow there, keeping the rider between GLANCE_LOW and
 * GLANCE_HIGH of the half FOV below the centre of the frame.
 */
const FP_GLANCE_UP = 0.09;
const GLANCE_PITCH = -0.05, GLANCE_HEIGHT = 2.0, GLANCE_AIM = 25, GLANCE_AIM_UP = 2;
const GLANCE_LOW = 0.2, GLANCE_HIGH = 0.65;

/**
 * FEAT-122: for a target followed by `p += (target - p) * kf` each frame of `dt`, the time (s) to lead
 * it by along its velocity so that, moving steadily, the follower lands on the target instead of
 * trailing it by about speed / rate.
 */
function lagTime(dt: number, kf: number): number {
  return kf > 1e-6 ? dt * (1 - kf) / kf : 0;
}

/** Third-person chase camera with lag, speed-dependent FOV and terrain avoidance. */
/** BUG-051: first-person head steadying time (s) and the slope pitch easing (s) */
const FP_STEADY = 0.12, FP_PITCH_TAU = 0.4;
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  /** base FOV for the chase cameras (settings) */
  baseFov = 68;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly pack: Pack;
  // free-fly state
  yaw = 0; pitch = -0.2;
  private readonly freePos = new THREE.Vector3();
  // first-person state
  /** free look while riding a lift (radians, relative to the heading) */
  lookYaw = 0; lookPitch = 0;
  private fpRoll = 0;
  /** BUG-051: first-person shake 0..1 (Graphics setting, default 0.3); 0 is fully smooth */
  fpShake = 0.3;
  /** BUG-051: the stabilised rider height (alpha-beta filter: follows the run down with no lag,
   *  drops the fast ripples of the 1 m terrain) and its rate; and the smoothed slope pitch */
  private fpZ = NaN; private fpZv = 0; private fpPitch = 0;
  /** FEAT-124: look behind held (first person turns the head round; the chase cams orbit in freeLook) */
  glance = false;
  private fpBob = 0;
  private fpDip = 0;
  private readonly fpFwd = new THREE.Vector3();
  private readonly fpUp = new THREE.Vector3(0, 1, 0);
  private readonly fpPos = new THREE.Vector3();
  private readonly fpLook = new THREE.Vector3();
  private readonly fpQ = new THREE.Quaternion();
  private readonly fpM = new THREE.Matrix4();

  /** trunks, rocks and building walls, for keeping the chase camera out of them (BUG-032); set by main */
  collider: Collider | null = null;

  /** Move `want` (three.js) toward the rider's head until the line to it is clear. True when it moved. */
  private pullIn(r: Rider, want: THREE.Vector3): boolean {
    if (!this.collider) return false;
    const hx = r.x, hy = r.y, hz = r.z + 1.2; // pack metres, the rider's head
    const t = this.collider.segmentHit(hx, hy, hz, want.x, -want.z, want.y, CAM_PAD);
    if (t >= 1) return false;
    const len = Math.hypot(want.x - hx, -want.z - hy, want.y - hz) || 1;
    const f = Math.max(CAM_MIN / len, t); // t is where the line enters the padded trunk: stop there, never closer than CAM_MIN
    want.set(hx + (want.x - hx) * f, hz + (want.y - hz) * f, -(hy + (-want.z - hy) * f));
    return true;
  }

  constructor(pack: Pack, aspect: number) {
    this.pack = pack;
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.5, 300000);
  }

  snapTo(r: Rider): void {
    this.fwd.set(Math.sin(r.heading), 0, -Math.cos(r.heading));
    this.pos.set(r.x, r.z, -r.y).addScaledVector(this.fwd, -CHASE_SLOW.dist).add(new THREE.Vector3(0, CHASE_SLOW.height, 0));
    this.look.set(r.x, r.z + 1.2, -r.y);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  cycle(): void {
    const order: CameraMode[] = ['chase', 'close', 'far', 'cine', 'fp', 'helmet', 'free'];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
    if (this.mode === 'free') this.enterFree();
  }

  /** Start free fly from the current camera pose. */
  enterFree(): void {
    this.mode = 'free';
    this.freePos.copy(this.camera.position);
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    this.yaw = Math.atan2(d.x, -d.z);
    this.pitch = Math.asin(d.y);
  }

  updateFree(dt: number, keys: Set<string>, mouseDx: number, mouseDy: number): void {
    this.yaw += mouseDx * 0.003; this.pitch = THREE.MathUtils.clamp(this.pitch - mouseDy * 0.003, -1.5, 1.5);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const speed = (keys.has('ShiftLeft') ? 400 : 60) * dt;
    if (keys.has('KeyW') || keys.has('ArrowUp')) this.freePos.addScaledVector(dir, speed);
    if (keys.has('KeyS') || keys.has('ArrowDown')) this.freePos.addScaledVector(dir, -speed);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) this.freePos.addScaledVector(right, -speed);
    if (keys.has('KeyD') || keys.has('ArrowRight')) this.freePos.addScaledVector(right, speed);
    if (keys.has('KeyQ')) this.freePos.y -= speed;
    if (keys.has('KeyE')) this.freePos.y += speed;
    const ground = this.pack.groundHeight(this.freePos.x, -this.freePos.z) + 1.5;
    if (this.freePos.y < ground) this.freePos.y = ground;
    this.camera.position.copy(this.freePos);
    this.camera.lookAt(this.freePos.clone().add(dir));
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
  }

  // eye camera (DATA-008): a still view at eye height above a ground spot, for real vs game photo pairs
  /** pack metres of the spot, eye height above the ground (m), vertical FOV (deg) */
  eyeX = 0; eyeY = 0; eyeHeight = 1.7; eyeFov = 75;

  /** Place the eye camera. heading is clockwise from pack north, pitch positive up, both in degrees. */
  setEye(x: number, y: number, headingDeg: number, pitchDeg: number, fovDeg: number, height = 1.7): void {
    this.mode = 'eye';
    this.eyeX = x; this.eyeY = y; this.eyeHeight = height; this.eyeFov = fovDeg;
    this.yaw = headingDeg * Math.PI / 180; this.pitch = pitchDeg * Math.PI / 180;
  }

  /** The current eye pose in the units of the URL params (degrees, pack metres). */
  eyePose(): { x: number; y: number; h: number; pitch: number; fov: number; eye: number } {
    const h = ((this.yaw * 180 / Math.PI) % 360 + 360) % 360;
    return { x: this.eyeX, y: this.eyeY, h, pitch: this.pitch * 180 / Math.PI, fov: this.eyeFov, eye: this.eyeHeight };
  }

  /**
   * Eye camera: stays put unless nudged, so a shot can be matched to a photo. Mouse (pointer lock)
   * or arrow keys look, WASD walk (Shift faster), Q / E lower / raise the eye, [ / ] change the FOV.
   */
  updateEye(dt: number, keys: Set<string>, mouseDx: number, mouseDy: number): void {
    const turn = dt * (keys.has('ShiftLeft') ? 0.5 : 0.12);
    this.yaw += mouseDx * 0.002 + ((keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0)) * turn;
    this.pitch = THREE.MathUtils.clamp(this.pitch - mouseDy * 0.002 + ((keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0)) * turn, -1.5, 1.5);
    const step = dt * (keys.has('ShiftLeft') ? 15 : 2);
    const fx = Math.sin(this.yaw), fy = Math.cos(this.yaw);
    const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0), side = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    this.eyeX += (fx * fwd + fy * side) * step; this.eyeY += (fy * fwd - fx * side) * step;
    this.eyeHeight = THREE.MathUtils.clamp(this.eyeHeight + ((keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0)) * dt * 2, 0.3, 200);
    this.eyeFov = THREE.MathUtils.clamp(this.eyeFov + ((keys.has('BracketRight') ? 1 : 0) - (keys.has('BracketLeft') ? 1 : 0)) * dt * 20, 10, 120);
    const g = this.pack.groundHeight(this.eyeX, this.eyeY);
    this.camera.position.set(this.eyeX, (Number.isFinite(g) ? g : 0) + this.eyeHeight, -this.eyeY);
    // same convention as first person: yaw clockwise from north is a rotation of -yaw about +Y
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, -this.yaw, 0, 'YXZ'));
    if (this.camera.fov !== this.eyeFov) { this.camera.fov = this.eyeFov; this.camera.updateProjectionMatrix(); }
  }

  /** hard-landing shake, 0..1, decays */
  private shake = 0;
  private lastShock = 0;
  /** FEAT-045 toggles (Graphics settings): FOV widening with speed, and terrain and landing shake */
  speedFov = true; camShake = true;
  /** FEAT-045: phase of the terrain rumble (s) */
  private rumbleT = 0;
  /** first person or the helmet cam (both ride on the posed head) */
  get firstPerson(): boolean { return this.mode === 'fp' || this.mode === 'helmet'; }

  /**
   * FEAT-045: camera rumble from the snow under the board: none on corduroy, more off-piste, most on
   * rock and scree, growing with speed; plus the landing shake. Smooth (sums of sines), not per-frame
   * noise. Returns a small offset (m) in camera space x, y and a roll (rad).
   */
  private rumble(r: Rider, dt: number, scale: number, landScale = scale): [number, number, number] {
    if (r.landingShock > this.lastShock + 0.2 && r.landingShock > 0.4) this.shake = Math.min(1, r.landingShock);
    this.lastShock = r.landingShock;
    this.shake *= Math.exp(-dt * 7);
    if (!this.camShake) return [0, 0, 0];
    const s = r.surface, spd = Math.hypot(r.vx, r.vy);
    const rough = r.onGround && !r.onFoot ? (1 - 0.8 * s.groomed) * (1 + 1.5 * Math.min(1, s.rock + s.scree)) * Math.min(1, spd / 25) : 0;
    this.rumbleT += dt * (6 + spd * 0.6);
    const t = this.rumbleT, a = rough * 0.03 * scale, sk = this.shake * this.shake * 0.12 * landScale;
    return [
      a * (Math.sin(t * 1.7) + 0.5 * Math.sin(t * 4.3)) + sk * Math.sin(t * 23),
      a * (Math.sin(t * 2.3 + 1) + 0.5 * Math.sin(t * 5.1)) + sk * Math.sin(t * 29 + 2),
      a * 0.4 * Math.sin(t * 1.3 + 2) + sk * 0.3 * Math.sin(t * 17),
    ];
  }

  /**
   * First person: the eye sits at the posed rider's head (`eye`, from RiderView) a little in front
   * of it, so tucks, carves and landings move the view with the body. Looks along the velocity with
   * a little lag, rolls into carves, bobs with speed, shakes on hard landings. On a lift `onLift`
   * enables mouse free look. Without `eye` it falls back to a fixed helmet height.
   */
  updateFirstPerson(r: Rider, dt: number, tuck: boolean, onLift: boolean, mouseDx: number, mouseDy: number, eye: THREE.Vector3 | null = null): void {
    const spd = Math.hypot(r.vx, r.vy);
    // heading to look along: velocity when moving, board heading when slow or airborne
    const hx = Math.sin(r.heading), hy = Math.cos(r.heading);
    let fx = hx, fy = hy;
    if (r.onGround && spd > 3 && !onLift) { const b = Math.min(1, (spd - 3) / 6); fx = hx * (1 - b) + (r.vx / spd) * b; fy = hy * (1 - b) + (r.vy / spd) * b; }
    const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
    const target = this.fpFwd.set(fx, 0, -fy);
    // lag: slower turn of the view than the board
    if (this.fpLook.lengthSq() === 0) this.fpLook.copy(target);
    this.fpLook.lerp(target, 1 - Math.exp(-dt * (onLift ? 3 : 9))).normalize();
    // free look on the lift; recentre when riding
    if (onLift) {
      this.lookYaw = THREE.MathUtils.clamp(this.lookYaw + mouseDx * 0.003, -2.1, 2.1);
      this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - mouseDy * 0.003, -1.0, 1.0);
    } else if (this.glance) {
      // FEAT-124: look back over the shoulder, a little up so the run above is in frame (BUG-057)
      const k = Math.min(1, dt * 10);
      this.lookYaw += (Math.PI * 0.95 - this.lookYaw) * k; this.lookPitch += (FP_GLANCE_UP - this.lookPitch) * k;
    } else {
      this.lookYaw *= Math.exp(-dt * 6); this.lookPitch *= Math.exp(-dt * 6);
    }
    // head position: 1.6 m above the board, lowered by tuck and landing shock
    const crouch = (tuck ? 0.45 : 0) + r.landingShock * 0.5 + r.jumpCharge * 0.3;
    this.fpDip += (crouch - this.fpDip) * Math.min(1, dt * 8);
    // BUG-051: no stride bob on the board (there is no stride); a small one walking
    const bobAmp = r.onGround && !onLift && r.onFoot ? Math.min(0.03, spd * 0.01) : 0;
    // BUG-051: stabilise the head height. The legs soak up the terrain: an alpha-beta filter on the
    // rider's height follows a steady descent with no lag but not the 1 m ripples. Snaps on a big jump
    // (reset, lift, teleport). The posed head's own motion (tuck, squat, landing dip) rides on top.
    if (!Number.isFinite(this.fpZ) || Math.abs(r.z - this.fpZ) > 3 || onLift) { this.fpZ = r.z; this.fpZv = r.vz; }
    else {
      const pz = this.fpZ + this.fpZv * dt, res = r.z - pz;
      const al = 1 - Math.exp(-dt / FP_STEADY), be = (al * al) / (2 - al);
      this.fpZ = pz + al * res; this.fpZv += (be * res) / Math.max(dt, 1e-4);
    }
    const steady = this.fpZ - r.z;
    this.fpBob += dt * (4 + spd * 0.3);
    const bob = Math.sin(this.fpBob) * bobAmp;
    // ground normal tilt so the head stays upright-ish relative to the slope, blended toward world up
    const n = this.fpUp.set(r.normal[0] * 0.35, 1, -r.normal[1] * 0.35).normalize();
    if (eye) {
      // the posed head already crouches, tucks and compresses; 0.12 m forward keeps the helmet behind the eye
      this.fpPos.copy(eye).addScaledVector(n, bob).addScaledVector(this.fpLook, 0.12);
      this.fpPos.y += steady;
    } else {
      const h = 1.6 - this.fpDip * 0.5 + bob + (onLift ? 0.2 : 0);
      this.fpPos.set(r.x, this.fpZ, -r.y).addScaledVector(n, h).addScaledVector(this.fpLook, 0.15);
    }
    // FEAT-045 helmet cam: a GoPro on top of the helmet, a little back, wide and level
    const helmet = this.mode === 'helmet';
    if (helmet) this.fpPos.addScaledVector(n, 0.2).addScaledVector(this.fpLook, -0.2);
    // hard landing and terrain rumble (a darken pulse on landing is drawn by the goggle overlay).
    // First person gets the surface rumble too, on top of the slower stride bob above: rx sways the
    // eye sideways (along the view's right, -look.z, look.x), ry lifts it, rr rolls it.
    // BUG-051: a few mm on groomers up to about 1 cm on rough snow at the default 30 %, double for the
    // helmet cam; the landing shake stays short and sharp. None of it pitches the view.
    const sh = this.fpShake * (helmet ? 2 : 1);
    const [rx, ry, rr] = this.rumble(r, dt, sh * 1.1, Math.min(1, this.fpShake * 3));
    const jx = rr * 0.5;
    this.fpPos.x -= this.fpLook.z * rx; this.fpPos.z += this.fpLook.x * rx;
    this.fpPos.y += ry;
    // roll into carves (BUG-031): a body lean, not the horizon tipping over. Grows with speed and
    // stays within FP_ROLL_MAX however hard the edge, so a carving traverse tilts at most ~10 deg.
    const rollT = r.onGround && !onLift
      ? THREE.MathUtils.clamp(-r.edgeAngle * FP_ROLL_K * Math.min(1, spd / FP_ROLL_FULL_SPEED), -FP_ROLL_MAX, FP_ROLL_MAX)
      : 0;
    this.fpRoll += (rollT - this.fpRoll) * Math.min(1, dt * 6);
    // pitch: look slightly down the slope, more when tucking
    const slopePitch = r.onGround ? Math.atan2(-(r.vx * r.normal[0] + r.vy * r.normal[1]), Math.max(0.3, spd)) * 0.25 : 0; // negative = looking downhill (a quarter of the slope)
    // BUG-051: the eyes hold the line: the slope pitch eases over about 0.4 s instead of nodding over every roller
    this.fpPitch += (slopePitch - this.fpPitch) * (1 - Math.exp(-dt / FP_PITCH_TAU));
    // BUG-057: that tilt is down the slope ahead; turned round (look behind, free look) it flips, so
    // looking back you look up the run above instead of into the snow rising behind you
    const pitch = THREE.MathUtils.clamp((this.fpPitch - (tuck ? 0.06 : 0)) * Math.cos(this.lookYaw) + this.lookPitch, -1.2, 1.2);
    const yaw = Math.atan2(this.fpLook.x, -this.fpLook.z) + this.lookYaw;
    // build orientation: yaw about up, then pitch, then roll about the view axis
    // camera forward is -Z; a yaw of `yaw` (clockwise from north) is a rotation of -yaw about +Y
    const e = new THREE.Euler(pitch, -yaw, this.fpRoll + jx, 'YXZ');
    this.fpQ.setFromEuler(e);
    this.camera.position.copy(this.fpPos);
    this.camera.quaternion.copy(this.fpQ);
    // keep the eye out of the snow
    const ground = this.pack.groundHeight(this.fpPos.x, -this.fpPos.z);
    if (this.camera.position.y < ground + 0.6) this.camera.position.y = ground + 0.6;
    // the helmet cam is a fixed wide lens (a GoPro does not zoom); first person opens with speed
    const fov = helmet ? this.baseFov + 40 : this.baseFov + 30 + (this.speedFov ? Math.min(14, r.speed * 0.4) + (tuck ? 3 : 0) : 0) - r.landingShock * 6;
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 5);
    this.camera.updateProjectionMatrix();
    void this.fpM;
  }

  /** Chase-camera orbit while free look is held (radians); eases back to centre on release. */
  orbitYaw = 0; orbitPitch = 0;
  /** Outrun (FEAT-101): footfall kick 0..1 on the chase cameras, decays on its own */
  kick = 0;
  /** BUG-057: how far into look behind the chase cameras are, 0..1 (lowers the camera, aims up the hill) */
  private glanceW = 0;
  /** `glance` (FEAT-101): snap the orbit round to look back over the shoulder while held. */
  freeLook(held: boolean, dt: number, mouseDx: number, mouseDy: number, glance = false): void {
    this.glanceW = glance ? this.glanceW + (1 - this.glanceW) * (1 - Math.exp(-dt * 10)) : this.glanceW * Math.exp(-dt * 5);
    if (glance) {
      const k = 1 - Math.exp(-dt * 10);
      const target = this.orbitYaw < 0 ? -Math.PI : Math.PI;
      // BUG-057: low on the downhill side (it rose over the rider and looked down into the snow)
      this.orbitYaw += (target - this.orbitYaw) * k; this.orbitPitch += (GLANCE_PITCH - this.orbitPitch) * k;
    } else if (held) {
      this.orbitYaw += mouseDx * 0.004;
      this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + mouseDy * 0.003, -0.35, 1.2);
    } else {
      const k = Math.exp(-dt * 5);
      this.orbitYaw = Math.atan2(Math.sin(this.orbitYaw), Math.cos(this.orbitYaw)) * k; this.orbitPitch *= k;
    }
  }

  update(r: Rider, dt: number, tuck: boolean, onLift = false): void {
    if (this.mode === 'free' || this.firstPerson || this.mode === 'eye') return;
    if (onLift) {
      // chair: sit behind and a little above the seat, look up the line. No slope clamp, the
      // seat is already well above the snow.
      const spd = Math.hypot(r.vx, r.vy) || 1;
      this.fwd.set(r.vx / spd, 0, -r.vy / spd);
      const seat = new THREE.Vector3(r.x, r.z, -r.y);
      // free look orbits the chair the same way it orbits the rider on the snow
      const back = this.fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.orbitYaw);
      const cp = Math.cos(this.orbitPitch), sp = Math.sin(this.orbitPitch);
      const orbiting = Math.abs(this.orbitYaw) > 0.02 || Math.abs(this.orbitPitch) > 0.02;
      this.desired.copy(seat).addScaledVector(back, -6.5 * cp).add(new THREE.Vector3(0, 2.2 + 6.5 * sp, 0));
      const ground = this.pack.groundHeight(this.desired.x, -this.desired.z);
      if (this.desired.y < ground + 1.5) this.desired.y = ground + 1.5;
      this.pos.lerp(this.desired, 1 - Math.exp(-dt * (orbiting ? 12 : 4)));
      this.look.lerp(seat.clone().addScaledVector(back, orbiting ? 0 : 6).add(new THREE.Vector3(0, 0.5, 0)), 1 - Math.exp(-dt * (orbiting ? 12 : 6)));
      this.camera.position.copy(this.pos);
      this.camera.lookAt(this.look);
      this.camera.fov += (this.baseFov - this.camera.fov) * Math.min(1, dt * 4);
      this.camera.updateProjectionMatrix();
      return;
    }
    const cine = this.mode === 'cine';
    const m = this.mode;
    const f = FRAMING[m === 'close' || m === 'far' || m === 'cine' ? m : 'chase'];
    // follow the velocity direction when moving, the heading when slow
    const spd = Math.hypot(r.vx, r.vy);
    let dist = f.dist, height = f.height;
    if (this.mode === 'chase') {
      // FEAT-122: relaxes back a little when slow or stopped, closes in to the at-speed framing
      const b = THREE.MathUtils.smoothstep(spd, CHASE_BLEND_LO, CHASE_BLEND_HI);
      dist = CHASE_SLOW.dist + (f.dist - CHASE_SLOW.dist) * b;
      height = CHASE_SLOW.height + (f.height - CHASE_SLOW.height) * b;
    }
    // BUG-057: looking behind, come down near the rider's height so the run above fills the frame
    const g = this.glanceW;
    height += (Math.min(height, GLANCE_HEIGHT) - height) * g;
    // on foot it stays behind where you face (walking backwards or slipping must not swing it round)
    if (spd > 2.5 && !r.onFoot) this.fwd.set(r.vx / spd, 0, -r.vy / spd);
    else this.fwd.lerp(new THREE.Vector3(Math.sin(r.heading), 0, -Math.cos(r.heading)), Math.min(1, dt * 2)).normalize();
    const riderPos = new THREE.Vector3(r.x, r.z, -r.y);
    // free look: swing the camera around the rider (yaw) and up over them (pitch)
    const back = this.fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.orbitYaw);
    const cp = Math.cos(this.orbitPitch), sp = Math.sin(this.orbitPitch);
    this.desired.copy(riderPos).addScaledVector(back, -dist * cp).add(new THREE.Vector3(0, height - (tuck ? f.tuckDrop : 0) + dist * sp, 0));
    if (f.side) this.desired.add(new THREE.Vector3(-back.z, 0, back.x).multiplyScalar(f.side));
    // keep the camera above the snow
    const ground = this.pack.groundHeight(this.desired.x, -this.desired.z);
    if (this.desired.y < ground + f.clear) this.desired.y = ground + f.clear;
    // BUG-032: a trunk, rock or wall between the rider and the camera pulls the camera in front of it,
    // quickly (no lag through the tree); the normal lag eases it back out once the line is clear
    const blocked = this.pullIn(r, this.desired);
    const orbiting = Math.abs(this.orbitYaw) > 0.02 || Math.abs(this.orbitPitch) > 0.02;
    const k = 1 - Math.exp(-dt * (blocked ? 20 : orbiting ? 12 : cine ? 1.6 : r.onGround ? 5 : 3));
    // FEAT-122: lead the target by the steady-state lag (about speed / rate, 3 m at 15 m/s) so the
    // camera holds its distance at speed instead of drifting back; the ease still smooths turns and
    // swings. In the air only the horizontal lag is cancelled, so the camera still floats over jumps.
    const vz = r.onGround ? r.vz : 0;
    const lead = f.lead * lagTime(dt, k);
    this.pos.lerp(this.desired.set(this.desired.x + r.vx * lead, this.desired.y + vz * lead, this.desired.z - r.vy * lead), k);
    // a transient (crest, a lead that just changed) must not dip the lens into the snow
    const under = this.pack.groundHeight(this.pos.x, -this.pos.z) + 0.8;
    if (this.pos.y < under) this.pos.y = under;
    // while orbiting look at the rider, not ahead of them
    const ahead = orbiting ? 0 : f.lookAhead;
    const lookTarget = riderPos.clone().addScaledVector(back, ahead);
    if (f.aimGround && !orbiting) {
      // over the head at the snow ahead: follows the slope down, within AIM_DROP / AIM_RISE of the rider
      const ga = this.pack.groundHeight(lookTarget.x, -lookTarget.z);
      lookTarget.y = THREE.MathUtils.clamp(Number.isFinite(ga) ? ga : r.z, r.z - ahead * AIM_DROP, r.z + ahead * AIM_RISE) + f.lookUp;
    } else lookTarget.y += orbiting ? 1.0 : f.lookUp;
    if (g > 0.001) lookTarget.lerp(this.glanceAim(r, back), g);
    const kl = 1 - Math.exp(-dt * 8), ll = f.lead * lagTime(dt, kl);
    lookTarget.x += r.vx * ll; lookTarget.y += vz * ll; lookTarget.z -= r.vy * ll;
    this.look.lerp(lookTarget, kl);
    this.camera.position.copy(this.pos);
    if (this.kick > 0.001) {
      const s = this.kick * 0.25;
      this.camera.position.x += (Math.random() - 0.5) * s; this.camera.position.y += (Math.random() - 0.5) * s; this.camera.position.z += (Math.random() - 0.5) * s;
      this.kick *= Math.exp(-dt * 9);
    }
    this.camera.lookAt(this.look);
    // FEAT-045: rumble from the snow and landings, in the camera's own frame
    const [rx, ry, rr] = this.rumble(r, dt, cine ? 0.5 : 1);
    this.camera.translateX(rx); this.camera.translateY(ry); this.camera.rotateZ(rr * 0.5);
    // FOV opens with speed (about +15 deg at 25 m/s, 56 mph), and a little more in a tuck
    const fov = (cine ? this.baseFov - 22 : this.baseFov) + (this.speedFov ? Math.min(22, r.speed * 0.6) + (tuck ? 4 : 0) : 0);
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 4);
    this.camera.updateProjectionMatrix();
  }

  /**
   * BUG-057: where the chase cameras look while looking behind: GLANCE_AIM m back up the travel line
   * (`back` is swung round to point there), GLANCE_AIM_UP above the snow, so the run above and anything
   * coming down it are in view. The aim's pitch is held so the rider stays in the lower part of the frame.
   */
  private glanceAim(r: Rider, back: THREE.Vector3): THREE.Vector3 {
    const p = this.pos;
    const ax = r.x + back.x * GLANCE_AIM, az = -r.y + back.z * GLANCE_AIM;
    const ga = this.pack.groundHeight(ax, -az);
    const ay = (Number.isFinite(ga) ? ga : r.z) + GLANCE_AIM_UP;
    const hd = Math.hypot(ax - p.x, az - p.z) || 1;
    const rd = Math.hypot(r.x - p.x, -r.y - p.z) || 1;
    const toRider = Math.atan2(r.z + 1 - p.y, rd), half = this.camera.fov * Math.PI / 360;
    const pitch = THREE.MathUtils.clamp(Math.atan2(ay - p.y, hd), toRider + GLANCE_LOW * half, toRider + GLANCE_HIGH * half);
    return new THREE.Vector3(ax, p.y + Math.tan(pitch) * hd, az);
  }
}
