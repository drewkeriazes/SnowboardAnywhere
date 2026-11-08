import type { Pack } from '../pack/Pack';
import type { Collider } from './Collider';
import { Rng } from './Rng';
import { rockCover } from '../terrain/rockCover';

export interface Input {
  steer: number; // -1 left .. +1 right
  tuck: boolean;
  brake: boolean;
  jumpHeld: boolean;
  jumpReleased: boolean;
  grab: boolean;
  /** Left Ctrl held: deep squat (FEAT-111) */
  squat?: boolean;
  /** hold to skate on the flat with the back foot out (FEAT-085) */
  skate?: boolean;
  /** FEAT-112: -1 lean back (nose up, ollie) .. +1 lean forward (tail up, nollie) */
  lean?: number;
}

export interface SurfaceInfo {
  rock: number;
  scree: number;
  groomed: number;
  canopy: number;
}

const G = 9.81;
const STEP = 1 / 120;
const D2R = Math.PI / 180;
/** board angle to the direction of travel in a full hockey stop */
const STOP_GAMMA = 84 * D2R;
/** FEAT-133: steering while braking opens the swing out to GAMMA_SOFT and lets the edge off to
 *  PSI_SOFT (a skidded turn, steer away from the edge), or squares it up to GAMMA_HARD and tips it
 *  PSI_DIG further than a plain brake's cut (steer into the edge); eased over BRAKE_MOD_IN s */
const GAMMA_SOFT = 40 * D2R, GAMMA_HARD = 90 * D2R, PSI_SOFT = 25 * D2R, PSI_DIG = 12 * D2R, BRAKE_MOD_IN = 0.2;
/** FEAT-133: how fast the steering axis follows the direction of travel while the board is swung (1/s) */
const HEAD_FOLLOW = 10;
/** FEAT-133: the dug-in edge drags along its own length with up to this share of the cut's hold,
 *  settling the slide along the board over BRAKE_TRENCH_T s */
const BRAKE_TRENCH = 0.35, BRAKE_TRENCH_T = 0.12;
/** seconds to swing the board across, and back on release */
const SWING_IN = 0.25, SWING_OUT = 0.3;
/** hard cap on braking deceleration from the snow cut (m/s^2): the paper's 60 degree edge case */
const BRAKE_MAX = 14;
/** below this speed (m/s) a released brake leaves the board across the hill (a standing stop) */
const PARK_SPEED = 1;
/** skis below this speed at brake start snowplough instead of turning across */
const PLOUGH_SPEED = 5;

/** FEAT-067 on foot: seconds to unstrap and to strap back in */
export const UNSTRAP_TIME = 0.8, STRAP_TIME = 1.0;
/** fastest the rider can be going to unstrap (m/s), and to strap in (standing still) */
const UNSTRAP_SPEED = 1.5, STRAP_SPEED = 0.3;
/** BUG-045 on foot: ledges up to STEP_UP are stepped onto by walking into them (eased over STEP_TIME);
 *  up to CLIMB_UP a jump climbs (mantles) onto them over MANTLE_TIME, probing MANTLE_PROBE ahead;
 *  taller stays a wall (m, s) */
const STEP_UP = 0.45, STEP_TIME = 0.25, CLIMB_UP = 1.4, MANTLE_TIME = 0.9, MANTLE_PROBE = 0.7;
/** on-foot speeds on groomed snow (m/s): walk, sprint, a tired sprint (a run), walking backwards */
const WALK = 1.4, SPRINT = 3.8, JOG = 2.4, BACK = 0.6;
/** seconds of sprint, and how much has to come back before sprinting again after running out */
export const STAMINA = 4;
const STAMINA_RESUME = 1.5;
/**
 * Slopes on foot are judged at body scale (FEAT-068): the rise over BODY_L metres, so a short steep
 * face on a small lump does not stop you. Steeper than CLIMB_MAX (degrees) you scramble on all fours
 * at CRAWL m/s; steeper than CRAWL_MAX you cannot get up and slip back, and standing on more than
 * CRAWL_MAX you slip whatever you do.
 */
const CLIMB_MAX = 35, CRAWL_MAX = 45, CRAWL = 0.45, BODY_L = 2.5;

/**
 * How far a boot sinks (m): about 2.5 cm on a groomer, 10 to 16 cm in open powder, up to about
 * 22 cm in deep powder off-piste under trees, almost nothing on rock. Drives the walking speed,
 * the boot height and the print depth.
 */
export function bootSink(s: SurfaceInfo): number {
  const hard = Math.min(1, s.rock + s.scree);
  const groomed = Math.min(1, s.groomed) * (1 - hard);
  const powder = Math.max(0, 1 - groomed - hard);
  const deep = powder * (s.canopy > 0.3 ? 1 : 0.5);
  return 0.025 * groomed + 0.1 * powder + 0.12 * deep + 0.008 * hard;
}

/** wrap an angle to -PI..PI */
function wrap(a: number): number { return Math.atan2(Math.sin(a), Math.cos(a)); }

export type Discipline = 'board' | 'ski';
/**
 * Feel constants per discipline (FEAT-127 carving):
 * - pivot, pivotTuck: yaw rate (rad/s) of a flat pivot turn at a standstill, fading out by pivotFade m/s
 * - sidecut: sidecut radius Rsc (m); a carve on edge angle psi bends the board to R = Rsc cos(psi)
 * - psiMax, psiPowder: highest edge angle (rad) on firm snow, and in powder where the board planes
 * - roll: how fast the edge rolls over (rad/s), so edge to edge takes a moment
 * - angulation: share of the edge angle made up by the knees and hips, not the body's inclination
 * - gripFlat, gripEdge: sideways hold in g on groomed corduroy, flat base and added by a full edge
 * Skis: snappier pivot, a longer sidecut, a lower top edge, quicker rolls, a bit more hold on a
 * flat base (two edges), a snowplough brake, and no fakie flip.
 */
interface Feel {
  pivot: number; pivotTuck: number; pivotFade: number;
  sidecut: number; psiMax: number; psiPowder: number; roll: number; angulation: number;
  gripFlat: number; gripEdge: number;
  brake: number; fakie: boolean; aero: number; aeroTuck: number;
}
const FEEL: Record<Discipline, Feel> = {
  board: { pivot: 1.9, pivotTuck: 0.9, pivotFade: 9, sidecut: 7.8, psiMax: 72 * D2R, psiPowder: 45 * D2R, roll: 400 * D2R, angulation: 0.12, gripFlat: 0.55, gripEdge: 0.9, brake: 0.45, fakie: true, aero: 0.0055, aeroTuck: 0.0025 },
  ski: { pivot: 2.4, pivotTuck: 1.1, pivotFade: 8, sidecut: 13, psiMax: 68 * D2R, psiPowder: 42 * D2R, roll: 460 * D2R, angulation: 0.08, gripFlat: 0.65, gripEdge: 0.75, brake: 0.6, fakie: false, aero: 0.005, aeroTuck: 0.0021 },
};
/** FEAT-127: `edgeAngle` is the edge as a share of this (1 = 60 degrees) for sound, poses and the ghost format */
export const EDGE_FULL = 60 * D2R;
/** edge angle (rad) at which the edge's grip is fully in; the flat base holds little sideways */
const GRIP_EDGE = 40 * D2R;
/** most the body inclines (rad): past it the rider can't lean further whatever the edge */
const PHI_MAX = 68 * D2R;
/** at a crawl the body can't lean against a turn, so only this much edge (rad) comes from angulation alone */
const ANG_SLOW = 25 * D2R;
/** a tuck keeps this share of the top edge; a full squat adds SQUAT_EDGE (rad); a full press loses PRESS_EDGE of it */
const TUCK_EDGE = 0.85, SQUAT_EDGE = 5 * D2R, PRESS_EDGE = 0.4;
/** the edge eases into its target over the last part of the roll (1/s) */
const EDGE_EASE = 30;
/** BUG-053: the roll is this much quicker while the edge crosses to the other side (unweighting
 *  between turns), so a full edge change at speed takes about 0.3 s */
const EDGE_SNAP = 1.5;
/** BUG-053: yaw rate (rad/s) a full steer adds at speed whatever the edge is doing, faded in as the
 *  pivot fades out, so the board starts coming round through the flat crossover instead of hanging
 *  until the new edge bites. A game feel term, not physics. */
const STEER_YAW = 0.25;
/** BUG-053: share of the fall line's pull kept when it fights the turn (climbing out across the
 *  hill); in full when it helps (turning down into it) */
const GIN_FIGHT = 0.5;
/** the board's slip past its line (rad) before the carve lets go: from SLIP_HOLD on, the arc stops
 *  driving the heading, gone by SLIP_HOLD + SLIP_WASH (a skid that settles, not a spin) */
const SLIP_HOLD = 4 * D2R, SLIP_WASH = 30 * D2R;

/**
 * Snowboard rider as a point mass with a board heading. Ground contact is a bilinear
 * heightfield lookup, so terrain collision is exact at the data resolution.
 *
 * Edge model (FEAT-127): steer rolls the board onto a real edge angle. The heading follows the
 * carved arc, R = Rsc cos(edge) from the sidecut, opened out at speed to the radius the rider's
 * lean can balance, plus a pivot at low speed. The snow holds lateral force up to a grip limit
 * that rises with the edge and falls off the groomers. Below the limit the velocity turns with
 * the board (a carve). Above it the board skids: the velocity lags the heading and energy is shed.
 *
 * Brake model (FEAT-065, after Komissarov's snow-cutting model of side-slipping and hockey
 * stops): holding brake swings the board yaw across the direction of travel to the angle of
 * attack gamma (about 84 degrees) while the edge angle Psi ramps up. The snow resists the board's
 * slide across its own edge with up to N tan(Psi), pushing at right angles to the board
 * (FEAT-133): the part of that push against the travel direction brakes, a = g cos(alpha) tan(Psi)
 * sin(gamma), and the part across it turns the rider toward the edge, so a partial swing is a
 * skidded turn. Steering while braking modulates both: into the edge squares the board up and
 * digs it in (a harder stop), away opens the swing and softens the edge (a drift down the fall
 * line). On a steep pitch a soft edge cannot hold the slope's pull across the board and the rider
 * side-slips. `heading` is the steering axis and follows the travel direction while the board is
 * swung; `boardYaw` is the board as drawn and as it marks the snow.
 */
/** FEAT-111 deep squat: ease time (s), extra grip, share of the tuck's drag cut, jump bonus and its window after letting go (s) */
const SQUAT_IN = 0.25;
const SQUAT_GRIP = 0.08;
const SQUAT_AERO = 0.3;
const SQUAT_POP = 1.15;
const SQUAT_SPRING_WINDOW = 0.25;
/** FEAT-110 flips: full-input pitch rate (1.1 rotations a second), how fast it builds and decays (1/s),
 * and the landing windows (rad): within FLIP_CLEAN of upright is clean, up to FLIP_CRASH a wobble, past it a crash */
const FLIP_RATE = 1.1 * Math.PI * 2;
const FLIP_EASE = 6, FLIP_DECAY = 4;
const FLIP_CLEAN = 35 * Math.PI / 180, FLIP_CRASH = 60 * Math.PI / 180;
const COUNT = ['', '', 'Double ', 'Triple ', 'Quad '];
/** "Backflip", "Double front flip", "Rodeo 540" (a backflip with a spin), "Front flip 360" */
export function trickName(flip: number, spin: number, rotations: number): string {
  const n = COUNT[Math.min(rotations, 4)] ?? `${rotations}x `;
  const turns = Math.round(Math.abs(spin) / Math.PI) * 180;
  if (turns >= 360) return flip < 0 ? `${n}Rodeo ${turns}` : `${n}Front flip ${turns}`;
  return `${n}${flip > 0 ? 'front flip' : 'backflip'}`.replace(/^./, (c) => c.toUpperCase());
}

/** FEAT-085 skating: mean push (m/s^2) from a standstill, top skating speed (m/s), steepest slope it works on (deg), stroke period (s) */
const SKATE_ACC = 4.2, SKATE_MAX = 5.5, SKATE_SLOPE = 10, SKATE_PERIOD = 0.6;

/** FEAT-112 lean: ease time (s), grip lost and drag added (per m/s) on a full press, pop multiplier for an
 * ollie / nollie (|lean| > 0.5 at release), and the pitch rate it leaves (rad/s per unit lean) */
const LEAN_IN = 0.2, PRESS_GRIP = 0.35, PRESS_DRAG = 0.05, OLLIE_POP = 1.3, OLLIE_PITCH = 1.2;

export class Rider {
  x = 0; y = 0; z = 0; // position, local metres (z up)
  vx = 0; vy = 0; vz = 0;
  heading = 0; // radians, 0 = north (+y), increasing clockwise (toward +x)
  onGround = true;
  airTime = 0;
  jumpCharge = 0;
  /** 0..1 how far into the deep squat (FEAT-111), eased over about 0.25 s */
  squat = 0;
  /** s since the squat was let go from deep; a jump right then pops higher */
  private squatUp = 9;
  speed = 0;
  /** FEAT-127: the board's edge angle to the snow (rad), + = the right-hand (toe) edge, rolled toward the steer at a limited rate */
  edge = 0;
  /** the edge as a share of EDGE_FULL (sound, poses, replays and ghosts) */
  get edgeAngle(): number { return this.edge / EDGE_FULL; }
  set edgeAngle(v: number) { this.edge = v * EDGE_FULL; }
  /** BUG-056: the edge angle the steer is rolling toward this step (rad, 0 off the snow), for the rider
   *  view's body lead: the rider knows where the turn is going before the board gets there */
  edgeTarget = 0;
  /** BUG-056: the lean the press input is easing toward (-1 .. 1, 0 off the snow), for the body lead */
  leanTarget = 0;
  /** radius of the turn the heading is following (m, Infinity going straight): speed over the heading rate, so it includes the steer yaw and any slip wash-out (BUG-053; was the arc the edge and lean balance), for the debug HUD and tools */
  turnRadius = Infinity;
  /** BUG-053: heading rate this step (rad/s, + clockwise) and the lateral acceleration the edge and lean
   *  balance (m/s^2), for the debug readout and tools */
  turnRate = 0;
  carveAcc = 0;
  /** FEAT-133: eased steer while braking, -1 away from the edge (open swing, soft edge) .. +1 into it (square, dug in) */
  brakeMod = 0;
  /** edge angle of the brake's snow cut (rad, 0 when not braking), for the board's roll on screen */
  brakePsi = 0;
  spin = 0; // extra yaw while airborne
  /** FEAT-110: pitch rotation in the air (rad, + = front flip, nose down) and its rate */
  flip = 0;
  flipRate = 0;
  /** FEAT-085: skating now, the stroke phase (0..1, a push at 0), and a callback on each push for sound */
  /** FEAT-112: the board's lean, eased: -1 nose up (tail loaded) .. +1 tail up (nose loaded) */
  lean = 0;
  skating = false;
  skatePhase = 0;
  onSkateStroke: (() => void) | null = null;
  /** FEAT-110: called on landing a flip ("Backflip", "Double front flip", "Rodeo 540"), clean or sketchy */
  onTrick: ((name: string) => void) | null = null;
  crashed = 0; // seconds remaining in a crash
  surface: SurfaceInfo = { rock: 0, scree: 0, groomed: 0, canopy: 0 };
  normal: [number, number, number] = [0, 0, 1];
  slopeDeg = 0;
  skid = 0; // 0..1 how much the board is sliding sideways (for spray)
  /** board yaw (same convention as heading): the heading, swung across the travel direction while braking */
  boardYaw = 0;
  /** 0..1 progress of the brake swing */
  brakeAmt = 0;
  /** brake stance: -1 heelside, +1 toeside, 0 not braking */
  brakeSide = 0;
  /** braking deceleration from the snow cut this step (m/s^2) */
  brakeAcc = 0;
  /** 0..1 braking power (deceleration times speed), smoothed, for spray, sound and the track */
  scrape = 0;
  /** signed angle from the travel direction to the board (radians, 0 when nearly stopped) */
  slip = 0;
  private travelYaw = 0;
  // ---- on foot (FEAT-067)
  /** off the board, walking (the board is carried) */
  onFoot = false;
  /** binding transition in progress: 'off' unstrapping, 'on' strapping in */
  strapState: 'none' | 'off' | 'on' = 'none';
  /** seconds into the current transition */
  strapT = 0;
  /** seconds of sprint left */
  stamina = STAMINA;
  /** ran out of sprint: a run until stamina comes back to STAMINA_RESUME */
  tired = false;
  /** sprinting this step */
  sprinting = false;
  /** 0..1 how hard the rider is working (sprint, climbing), smoothed, for breathing */
  exertion = 0;
  /** boot sink at the current spot (m) */
  sink = 0;
  /** sliding back down a slope too steep to stand on (m/s, pack x/y) */
  slideVx = 0; slideVy = 0;
  private walkVx = 0; private walkVy = 0;
  private hopHeld = false;
  /** BUG-045: climbing onto a ledge (mantle): progress 0..1 (0 = not climbing) and its start and end */
  mantle = 0;
  private readonly mantleFrom = [0, 0, 0]; private readonly mantleTo = [0, 0, 0];
  /** BUG-045: stepping up onto a low ledge: progress 0..1 (0 = not stepping), from mantleFrom to mantleTo */
  private stepT = 0;
  /** scrambling up on all fours (too steep to walk, not too steep to climb) */
  crawling = false;
  /** body-scale slope along the way you are walking (degrees, + = uphill) */
  walkSlopeDeg = 0;
  /** seconds left of a slip back down a face too steep to climb (no walking until it ends) */
  slipT = 0;
  /** board angle to travel this brake aims for, fixed when the brake starts (0 = ski snowplough) */
  private brakeGamma = STOP_GAMMA;
  /** lateral acceleration in g, positive toward the board's right-hand side (smoothed, for the rider's lean) */
  lateralG = 0;
  landingShock = 0;
  /** last collision this step: 'ramp' | 'graze' | 'wall' | '' (for sound and effects; cleared each frame) */
  lastHit = '';
  /** Outrun boost (FEAT-101): less drag for a few seconds */
  boost = false;
  distance = 0;
  maxSpeed = 0;
  discipline: Discipline = 'board';
  /** sim randomness: seeded on reset so the same inputs replay the same run */
  readonly rng = new Rng(1);
  /** physics steps so far, and how many of them sampled a coarser height set than the point has */
  steps = 0;
  coarseSteps = 0;
  private readonly pack: Pack;
  private readonly collider: Collider | null;
  private accum = 0;
  private readonly maskTmp = [0, 0, 0, 0];
  private readonly coverTmp = { rock: 0, scree: 0 };
  // render interpolation: pose before the last step, pose after it (to spot external moves), and
  // the sim pose stashed while the interpolated one is applied
  private readonly prev = [0, 0, 0, 0, 0];
  private readonly end = [NaN, NaN, NaN, NaN];
  private readonly stash = [0, 0, 0, 0, 0];
  private alpha = 1;
  private posed = false;
  private lastWarn = -Infinity;

  constructor(pack: Pack, collider: Collider | null) {
    this.pack = pack;
    this.collider = collider;
  }

  reset(x: number, y: number, heading: number, seed = 1): void {
    this.x = x; this.y = y; this.z = this.pack.groundHeight(x, y) + 0.5;
    this.vx = this.vy = this.vz = 0;
    this.heading = heading; this.onGround = true; this.airTime = 0; this.jumpCharge = 0;
    this.crashed = 0; this.spin = 0; this.skid = 0; this.distance = 0; this.maxSpeed = 0;
    this.edge = 0; this.edgeTarget = 0; this.leanTarget = 0; this.turnRadius = Infinity; this.turnRate = 0; this.carveAcc = 0; this.lateralG = 0; this.landingShock = 0;
    this.accum = 0; this.alpha = 1; this.steps = 0; this.coarseSteps = 0;
    this.onFoot = false; this.strapState = 'none'; this.strapT = 0; this.stamina = STAMINA; this.tired = false; this.mantle = 0; this.stepT = 0;
    this.sprinting = false; this.crawling = false; this.slipT = 0; this.exertion = 0; this.slideVx = this.slideVy = this.walkVx = this.walkVy = 0;
    this.rng.seed(seed);
    this.squareBoard();
    this.snapPose();
  }

  /**
   * 0 = strapped in and riding, 1 = on foot carrying the board; in between during the unstrap and
   * strap-in transitions (the view runs its crouch, step-off and lift animation off this).
   */
  get footU(): number {
    if (this.strapState === 'off') return Math.min(1, this.strapT / UNSTRAP_TIME);
    if (this.strapState === 'on') return Math.max(0, 1 - this.strapT / STRAP_TIME);
    return this.onFoot ? 1 : 0;
  }
  /** off the board or getting on or off it: no board physics, tracks or spray */
  get unstrapped(): boolean { return this.onFoot || this.strapState !== 'none'; }
  /** nearly stopped on the snow, so E (interact) unstraps */
  get canUnstrap(): boolean { return !this.onFoot && this.strapState === 'none' && this.onGround && this.crashed <= 0 && this.speed < UNSTRAP_SPEED; }
  /** standing still on foot, so B straps in */
  get canStrapIn(): boolean { return this.onFoot && this.strapState === 'none' && this.onGround && this.speed < STRAP_SPEED; }

  /** The board key: unstrap or strap in. Returns '' when it started, else why not ('fast', 'moving', 'air', 'busy'). */
  toggleBoard(): string {
    if (this.strapState !== 'none') return 'busy';
    if (!this.onGround) return 'air';
    if (!this.onFoot) {
      if (!this.canUnstrap) return 'fast';
      this.strapState = 'off'; this.strapT = 0;
      return '';
    }
    if (!this.canStrapIn) return 'moving';
    this.strapState = 'on'; this.strapT = 0;
    this.vx = this.vy = this.walkVx = this.walkVy = this.slideVx = this.slideVy = 0;
    return '';
  }

  /** Back on the board at once (boarding a lift on foot). */
  strapInNow(): void {
    if (!this.unstrapped) return;
    this.onFoot = false; this.strapState = 'none'; this.strapT = 0;
    this.walkVx = this.walkVy = this.slideVx = this.slideVy = 0;
    this.squareBoard();
  }

  /** End any brake swing: the board lines up with the heading again. */
  private squareBoard(): void {
    this.boardYaw = this.travelYaw = this.heading;
    this.brakeAmt = 0; this.brakeSide = 0; this.brakeAcc = 0; this.brakePsi = 0; this.brakeMod = 0; this.scrape = 0; this.slip = 0;
  }

  /**
   * Advance the sim by real time dt in fixed 1/120 s steps. Catch-up is capped at 0.1 s per call
   * (12 steps), so a tab switch or a long hitch drops time instead of fast-forwarding the run.
   */
  update(dt: number, input: Input): void {
    // moved from outside since the last step (lift, reset, teleport): nothing to interpolate from
    if (this.x !== this.end[0] || this.y !== this.end[1] || this.z !== this.end[2] || this.heading !== this.end[3]) { this.squareBoard(); this.snapPose(); }
    this.accum += Math.min(dt, 0.1);
    while (this.accum >= STEP) {
      this.prev[0] = this.x; this.prev[1] = this.y; this.prev[2] = this.z; this.prev[3] = this.heading; this.prev[4] = this.boardYaw;
      const fb = this.pack.coarseFallbacks;
      // FEAT-124: the squat key grabs in the air and sprints on foot, so it only squats riding on the snow
      this.easeSquat(STEP, !!input.squat && this.onGround && !this.onFoot);
      this.leanTarget = this.onGround ? input.lean ?? 0 : 0;
      this.lean += (this.leanTarget - this.lean) * Math.min(1, STEP / LEAN_IN); // snaps back level in the air
      this.step(STEP, input);
      this.steps++;
      if (this.pack.coarseFallbacks !== fb) this.onCoarse();
      this.accum -= STEP;
      input.jumpReleased = false; // consume the release edge
    }
    this.end[0] = this.x; this.end[1] = this.y; this.end[2] = this.z; this.end[3] = this.heading;
    this.alpha = this.accum / STEP;
  }

  /** FEAT-111: blend into or out of the squat, and time how long ago a deep squat was released */
  private easeSquat(dt: number, held: boolean): void {
    const was = this.squat;
    this.squat = held ? Math.min(1, was + dt / SQUAT_IN) : Math.max(0, was - dt / SQUAT_IN);
    if (!held && was >= 0.6 && this.squatUp > 1) this.squatUp = 0; // let go from deep: the spring window opens
    else this.squatUp += dt;
  }

  private snapPose(): void {
    this.prev[0] = this.end[0] = this.x; this.prev[1] = this.end[1] = this.y;
    this.prev[2] = this.end[2] = this.z; this.prev[3] = this.end[3] = this.heading; this.prev[4] = this.boardYaw;
  }

  private onCoarse(): void {
    this.coarseSteps++;
    const now = performance.now();
    if (now - this.lastWarn < 2000) return;
    this.lastWarn = now;
    console.warn(`physics: 1 m terrain not loaded at ${this.x.toFixed(0)}, ${this.y.toFixed(0)}; riding on a coarser set (${this.coarseSteps}/${this.steps} steps so far)`);
  }

  /**
   * Swap in the pose interpolated between the last two physics steps for drawing (call
   * restoreSimPose after). Without it the rider judders when the frame rate does not divide
   * 120 Hz evenly. Big heading jumps (fakie flip, landing snap) are not blended.
   */
  applyRenderPose(): void {
    if (this.posed) return;
    this.posed = true;
    const s = this.stash, p = this.prev, a = this.alpha;
    s[0] = this.x; s[1] = this.y; s[2] = this.z; s[3] = this.heading; s[4] = this.boardYaw;
    if (this.x !== this.end[0] || this.y !== this.end[1] || this.z !== this.end[2] || this.heading !== this.end[3]) return; // moved outside the sim
    this.x = p[0] + (s[0] - p[0]) * a; this.y = p[1] + (s[1] - p[1]) * a; this.z = p[2] + (s[2] - p[2]) * a;
    const dh = s[3] - p[3];
    if (Math.abs(dh) < 1) this.heading = p[3] + dh * a;
    const db = s[4] - p[4];
    if (Math.abs(db) < 1) this.boardYaw = p[4] + db * a;
  }

  restoreSimPose(): void {
    if (!this.posed) return;
    this.posed = false;
    const s = this.stash;
    this.x = s[0]; this.y = s[1]; this.z = s[2]; this.heading = s[3]; this.boardYaw = s[4];
  }

  private step(dt: number, input: Input): void {
    const pack = this.pack;
    const n = pack.groundNormal(this.x, this.y, this.normal, this.z) as [number, number, number];
    const ground = this.groundAt(this.x, this.y, this.z);
    this.slopeDeg = Math.acos(Math.min(1, n[2])) * 57.2958;
    if (pack.mask) {
      const m = pack.mask.sample(this.x, this.y, this.maskTmp);
      // BUG-043: rock and scree as the terrain shader draws them (crisp patches), not the soft mask
      const cov = rockCover(m[0], m[1], this.x, this.z, -this.y, n[2], this.coverTmp);
      this.surface.rock = cov.rock; this.surface.scree = cov.scree; this.surface.groomed = m[2]; this.surface.canopy = m[3];
    }
    if (this.strapState !== 'none') { this.strapStep(dt, ground); return; }
    if (this.onFoot) { this.walkStep(dt, input, n, ground); return; }
    if (this.crashed > 0) {
      this.crashed -= dt;
      // tumble: slide to a stop
      const f = Math.exp(-dt * 2.5);
      this.vx *= f; this.vy *= f;
      this.x += this.vx * dt; this.y += this.vy * dt;
      this.z = this.groundAt(this.x, this.y, this.z);
      this.vz = 0;
      this.speed = Math.hypot(this.vx, this.vy);
      this.squareBoard();
      return;
    }

    // ---------------------------------------------------------------- airborne
    if (!this.onGround) {
      this.lateralG *= Math.exp(-dt * 4);
      // the board squares up quickly once off the snow
      this.brakeAmt = Math.max(0, this.brakeAmt - dt / 0.15);
      this.brakeAcc = 0; this.scrape *= Math.exp(-dt * 10); this.slip = 0;
      this.edge *= Math.exp(-dt * 5); this.edgeTarget = 0; this.brakePsi *= Math.exp(-dt * 8); this.turnRadius = Infinity; this.turnRate = 0; this.carveAcc = 0; // off the snow the board rolls back flat
      if (this.brakeAmt === 0) this.brakeSide = 0;
      this.vz -= G * dt;
      // air control: spin with steer, slight drift
      this.spin += input.steer * 3.5 * dt;
      this.heading += input.steer * 3.5 * dt;
      // FEAT-110: Up/W pitches forward (front flip), Down/S back (backflip); the rate builds while
      // held and carries on a little after letting go, like real momentum
      const want = (input.tuck ? 1 : 0) - (input.brake ? 1 : 0);
      if (want !== 0) this.flipRate += (want * FLIP_RATE - this.flipRate) * Math.min(1, dt * FLIP_EASE);
      else this.flipRate *= Math.exp(-dt * FLIP_DECAY);
      this.flip += this.flipRate * dt;
      this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
      this.travelYaw += input.steer * 3.5 * dt; // spin carries the swung board round with it
      this.poseBoard();
      this.airTime += dt;
      const g2 = this.groundAt(this.x, this.y, this.z);
      if (this.z <= g2) {
        this.land(g2, input);
      }
      this.speed = Math.hypot(this.vx, this.vy, this.vz);
      return;
    }

    // ---------------------------------------------------------------- on snow
    // gravity projected onto the slope plane: a = g * (slope direction component)
    // slope plane tangent of gravity: g_t = g - (g.n) n where g = (0,0,-G)
    const gn = -G * n[2];
    let ax = -gn * n[0], ay = -gn * n[1]; // (0 - gn*nx, 0 - gn*ny) -> downhill acceleration
    // board heading vector (unit) and its lateral
    const hx = Math.sin(this.heading), hy = Math.cos(this.heading);
    const lx = hy, ly = -hx; // right-hand lateral
    const spd = Math.hypot(this.vx, this.vy);
    const F = FEEL[this.discipline];

    // surface properties
    const groomed = this.surface.groomed;
    const rock = this.surface.rock;
    const powder = Math.max(0, 1 - groomed) * (this.surface.canopy > 0.3 ? 1 : 0.6);
    const gripBase = (1.0 + 0.4 * groomed - 0.5 * rock) * (1 + SQUAT_GRIP * this.squat) * (1 - PRESS_GRIP * Math.abs(this.lean)); // low centre of mass bites a little more; on a press you can't carve

    // ---- FEAT-127 edge and carve. Steer sets a target edge angle up to what can be held here; the
    // edge rolls toward it at F.roll, quicker through the flat while it changes sides (BUG-053), so
    // edge to edge takes about 0.3 s. A brake takes the edge over.
    const want = input.steer * this.edgeCap(input, F, powder, spd) * (1 - this.brakeAmt);
    this.edgeTarget = want;
    const roll = F.roll * dt * (want * this.edge < 0 ? EDGE_SNAP : 1);
    this.edge += Math.max(-roll, Math.min(roll, (want - this.edge) * Math.min(1, dt * EDGE_EASE)));
    const psi = Math.abs(this.edge);
    // the board bent on edge carves an arc of R = Rsc cos(psi), and the rider balances it with
    // tan(phi) = v^2 / (g R), phi being the body's inclination (the edge less the angulation). Slow,
    // the sidecut's arc sets the turn; fast, the arc opens out to the radius the lean can hold.
    // Either way more edge is a tighter turn. The lean balances the edge's load, so on a slope the
    // pull of the fall line helps the turn into it (gIn > 0) and fights it climbing across (gIn < 0,
    // kept at GIN_FIGHT so the end of a turn across the hill is not its weakest part).
    const phi = Math.min(PHI_MAX, psi * (1 - F.angulation));
    const gInRaw = (ax * lx + ay * ly) * Math.sign(this.edge);
    const gIn = gInRaw < 0 ? gInRaw * GIN_FIGHT : gInRaw;
    const aLat = Math.min((spd * spd) / (F.sidecut * Math.cos(psi)), Math.max(0, G * n[2] * Math.tan(phi) + gIn));
    this.carveAcc = aLat;
    // more than the snow holds and the tail slides out: once the board slips past its line the
    // arc lets go of the heading, so the skid settles at a slip angle instead of spinning out
    let hold = 1;
    if (spd > 0.5 && psi > 0) {
      const ahead = wrap(this.heading - Math.atan2(this.vx, this.vy)) * Math.sign(this.edge);
      if (ahead > SLIP_HOLD && ahead < Math.PI / 2) hold = Math.max(0, 1 - (ahead - SLIP_HOLD) / SLIP_WASH);
    }
    const carveRate = spd > 0.1 ? Math.sign(this.edge) * (aLat / spd) * hold : 0;
    // slow or flat: a pivot (a skidded turn) straight from the steer, gone by F.pivotFade; from about
    // there on a small steer yaw (STEER_YAW) keeps the board coming round through an edge change.
    // Neither while the board is swung across for a brake: the steer works the brake then (FEAT-133).
    const steerFade = Math.max(0, Math.min(1, spd / F.pivotFade - 0.5));
    const pivotRate = input.steer * ((input.tuck ? F.pivotTuck : F.pivot) * Math.max(0, 1 - spd / F.pivotFade) + STEER_YAW * steerFade) * (1 - this.brakeAmt);
    const turnRate = carveRate + pivotRate;
    this.turnRate = turnRate;
    this.turnRadius = Math.abs(turnRate) > 1e-3 ? spd / Math.abs(turnRate) : Infinity;
    const dHeading = turnRate * dt;
    this.heading += dHeading;

    // brake: swing the board across the direction of travel (a hockey stop). Steer picks the
    // stance (right = toeside, left = heelside); otherwise the edge already engaged, else heelside.
    // Toeside rotates the board clockwise from the travel direction, which leaves the heel edge
    // leading and the toe edge trailing (the uphill edge, cutting the snow); heelside the reverse.
    if (spd > 0.5) this.travelYaw = Math.atan2(this.vx, this.vy);
    else this.travelYaw += dHeading; // stopped: steering turns the board where it stands
    if (input.brake) {
      if (this.brakeSide === 0) {
        this.brakeSide = input.steer > 0.1 ? 1 : input.steer < -0.1 ? -1 : this.edgeAngle > 0.3 ? 1 : -1;
        this.brakeGamma = this.discipline === 'ski' && spd < PLOUGH_SPEED ? 0 : STOP_GAMMA;
        this.brakeMod = 0;
      }
      this.brakeAmt = Math.min(1, this.brakeAmt + dt / SWING_IN);
    } else if (this.brakeAmt > 0) {
      if (spd < PARK_SPEED && this.brakeGamma > 0) {
        // released while (nearly) stopped: stay standing across the hill
        this.heading = this.boardYaw;
        this.squareBoard();
      } else {
        this.brakeAmt = Math.max(0, this.brakeAmt - dt / SWING_OUT);
        if (this.brakeAmt === 0) this.brakeSide = 0;
      }
    }
    // FEAT-133: steer works the brake while it is held: toward the brake side digs the edge in and
    // squares the board up (a harder stop), away lets the edge off and opens the swing (a skidded
    // turn, a drift down the fall line); eased so nothing snaps
    const modWant = input.brake && this.brakeSide !== 0 && this.brakeGamma > 0 ? Math.max(-1, Math.min(1, input.steer * this.brakeSide)) : 0;
    this.brakeMod += (modWant - this.brakeMod) * Math.min(1, dt / BRAKE_MOD_IN);
    const swing = this.poseBoard();
    this.slip = spd > 0.5 ? wrap(this.boardYaw - Math.atan2(this.vx, this.vy)) : 0;
    // while the board is swung the steering axis follows the direction of travel, so the carve grip
    // below does not fight the edge's push and the board rides off on its new line when the brake lets go
    if (swing > 0 && spd > 0.5) this.heading += wrap(this.travelYaw - this.heading) * Math.min(1, dt * HEAD_FOLLOW) * swing;
    // snow cut (FEAT-133): the edge resists the board's slide across itself with up to
    // a = g cos(alpha) tan(Psi), pushing at right angles to the board. Psi ramps with the swing and
    // rises with the slope (riders tip further on steeper pitches) so a brake can hold anywhere up
    // to about 55 degrees, and the steer digs it in or lets it off. The push against the direction
    // of travel is the braking, a = g cos(alpha) tan(Psi) sin(gamma); the push across it turns the
    // rider toward the edge. The dug-in edge also drags along its own length (BRAKE_TRENCH of the
    // cut), so the slide settles instead of running on along the board. On a steep pitch a soft edge
    // cannot hold the slope's pull across the board and the rider side-slips. Skis below PLOUGH_SPEED
    // snowplough with a flat drag instead.
    let brakeAcc = 0, plough = 0;
    this.brakePsi = 0;
    if (swing > 0) {
      if (this.brakeGamma > 0) {
        const cutMax = Math.min(68, Math.max(45, this.slopeDeg + 12)) * D2R;
        let cut = 15 * D2R + (cutMax - 15 * D2R) * swing;
        cut += this.brakeMod > 0 ? (Math.min(68 * D2R, cutMax + PSI_DIG) - cut) * this.brakeMod : (Math.max(cut, PSI_SOFT) - PSI_SOFT) * this.brakeMod;
        const bx = Math.cos(this.boardYaw), by = -Math.sin(this.boardYaw); // the board's right-hand side
        const fx = Math.sin(this.boardYaw), fy = Math.cos(this.boardYaw); // along the board
        const nvx = this.vx + ax * dt, nvy = this.vy + ay * dt; // after this step's gravity, so a dug-in edge holds on a slope
        const aMax = Math.min(BRAKE_MAX, G * n[2] * Math.tan(cut)) * (1 - 0.4 * rock);
        const aB = -Math.max(-aMax, Math.min(aMax, (nvx * bx + nvy * by) / dt));
        const aF = -Math.max(-aMax * BRAKE_TRENCH, Math.min(aMax * BRAKE_TRENCH, (nvx * fx + nvy * fy) / BRAKE_TRENCH_T)) * swing;
        ax += aB * bx + aF * fx; ay += aB * by + aF * fy;
        // the deceleration along the travel direction, for spray, sound, the track and the lean;
        // standing on the brake it reads the cut's full hold so the stance stays dug in
        brakeAcc = spd > 0.5 ? -(aB * (bx * this.vx + by * this.vy) + aF * (fx * this.vx + fy * this.vy)) / spd : aMax * Math.sin(this.brakeGamma) * swing;
        this.brakePsi = cut;
      } else plough = F.brake * G * swing;
    }
    this.brakeAcc = brakeAcc;
    this.scrape += (Math.min(1, (brakeAcc * spd) / 50) - this.scrape) * Math.min(1, dt * 10);

    // decompose velocity along/across the board
    const vAlong = this.vx * hx + this.vy * hy;
    const vLat = this.vx * lx + this.vy * ly;
    // lateral grip: the most sideways force the snow holds (FEAT-127), a little on the flat base and
    // the rest as the edge rolls in; less off the groomers and on rock and scree (icy, scraped).
    // Swung across for a brake the board is not under the heading, so the edge's push above takes
    // over from it (FEAT-133).
    const bite = Math.min(1, psi / GRIP_EDGE);
    const maxLat = G * gripBase * (F.gripFlat + F.gripEdge * bite);
    // wanted: kill lateral velocity (carve) within a short time
    let latAcc = -vLat / Math.max(0.04, 0.12 - 0.08 * bite);
    const skidding = Math.abs(latAcc) > maxLat;
    if (skidding) latAcc = Math.sign(latAcc) * maxLat;
    latAcc *= 1 - swing;
    this.skid += (((skidding ? Math.min(1, Math.abs(vLat) / 6) : 0)) - this.skid) * Math.min(1, dt * 10);
    ax += latAcc * lx; ay += latAcc * ly;
    this.lateralG += ((latAcc / G) - this.lateralG) * Math.min(1, dt * 12);

    // drag: aerodynamic + snow. Tuck lowers aero, powder adds speed-scaled drag, skidding scrubs speed
    const aeroK = input.tuck ? F.aeroTuck : F.aero + (F.aeroTuck - F.aero) * SQUAT_AERO * this.squat; // a squat is part way to a tuck
    const aero = aeroK * spd * spd * (this.boost ? 0.55 : 1) + PRESS_DRAG * Math.abs(this.lean) * spd; // FEAT-112: the loaded end digs in
    const snowDrag = 0.015 * G * (1 - 0.5 * groomed) + powder * 0.004 * spd + 0.35 * this.skid * G;
    const dragAcc = aero + snowDrag + plough;
    if (spd > 0.01) {
      const d = Math.min(dragAcc * dt, spd);
      ax -= (this.vx / spd) * (d / dt); ay -= (this.vy / spd) * (d / dt);
    }
    // push on the flat when tucking below 3 m/s (skating)
    if (input.tuck && spd < 3 && this.slopeDeg < 8) {
      ax += hx * 2.0; ay += hy * 2.0;
    }
    // FEAT-085: skate with the back foot out: a push stroke every SKATE_PERIOD s along the board's
    // heading, strongest from a standstill and gone by SKATE_MAX; works on the flat and slight uphills
    this.skating = !!input.skate && spd < SKATE_MAX && this.slopeDeg < SKATE_SLOPE && this.crashed <= 0;
    if (this.skating) {
      const before = this.skatePhase;
      this.skatePhase = (this.skatePhase + dt / SKATE_PERIOD) % 1;
      if (this.skatePhase < before) this.onSkateStroke?.();
      const stroke = Math.max(0, Math.cos(this.skatePhase * Math.PI * 2)); // the push, then the glide
      const a = SKATE_ACC * 2.2 * stroke * stroke * (1 - spd / SKATE_MAX);
      ax += hx * a; ay += hy * a;
    } else this.skatePhase = 0;
    // standing on the uphill edge: nearly stopped with the board across the fall line (within
    // about 50 degrees of it) the edge holds, so the rider stands still instead of creeping down.
    // Turning the board toward the fall line or tucking lets it run again.
    const fall = Math.hypot(n[0], n[1]);
    if (spd < 0.3 && !input.tuck && fall > 0.03 && this.slopeDeg < 55) {
      const across = Math.abs(Math.sin(this.boardYaw - Math.atan2(n[0], n[1])));
      if (across > 0.75) { this.vx = this.vy = 0; ax = ay = 0; }
    }
    // backwards riding is unstable: if moving against heading fast, flip heading (fakie)
    if (F.fakie && vAlong < -4) { this.heading += Math.PI; this.edge = -this.edge; } // the same edge is now on the other side of the heading
    else if (!F.fakie && vAlong < -1 && spd > 2) { this.vx *= 0.97; this.vy *= 0.97; } // skis sliding backwards scrub speed

    this.vx += ax * dt; this.vy += ay * dt;
    this.x += this.vx * dt; this.y += this.vy * dt;

    // jump: hold to charge, release to pop (impulse along the normal plus the slope direction)
    if (input.jumpHeld) this.jumpCharge = Math.min(1, this.jumpCharge + dt * 1.6);
    if (input.jumpReleased && this.jumpCharge > 0.1) {
      // jumping from a deep squat, or within SQUAT_SPRING_WINDOW of standing up from one: a bigger pop
      const spring = this.squat >= 0.6 || this.squatUp < SQUAT_SPRING_WINDOW ? SQUAT_POP : 1;
      // FEAT-112: popped off a loaded tail (ollie) or nose (nollie): the board's spring
      const flex = Math.abs(this.lean) > 0.5 ? OLLIE_POP : 1;
      const pop = (2.5 + 4.5 * this.jumpCharge) * spring * flex;
      this.vx += n[0] * pop; this.vy += n[1] * pop; this.vz = n[2] * pop + Math.max(0, -(this.vx * n[0] + this.vy * n[1]));
      this.onGround = false; this.airTime = 0; this.spin = 0; this.flip = 0; this.flipRate = 0; this.jumpCharge = 0;
      if (flex > 1) this.flipRate = this.lean * OLLIE_PITCH; // an ollie leaves you rotating back a little, a nollie forward
      this.z = ground + 0.05;
      return;
    }
    if (!input.jumpHeld) this.jumpCharge = Math.max(0, this.jumpCharge - dt * 3);

    // follow the ground; detect leaving it (convex rollovers at speed)
    const g2 = this.groundAt(this.x, this.y, this.z);
    const n2 = pack.groundNormal(this.x, this.y, undefined, this.z) as number[];
    // vertical velocity implied by following the surface
    const vzSurf = -(this.vx * n2[0] + this.vy * n2[1]) / Math.max(0.2, n2[2]);
    const ballistic = this.vz - G * dt;
    if (ballistic > vzSurf + 1.5 && spd > 6) {
      // the ground drops away faster than we fall: airborne
      this.onGround = false; this.airTime = 0; this.spin = 0; this.flip = 0; this.flipRate = 0;
      this.z = Math.max(this.z, g2 + 0.02);
      this.vz = vzSurf; // start with the surface's vertical speed
    } else {
      this.z = g2;
      this.vz = vzSurf;
    }
    this.speed = Math.hypot(this.vx, this.vy);
    this.maxSpeed = Math.max(this.maxSpeed, this.speed);
    this.distance += spd * dt;
    this.landingShock = Math.max(0, this.landingShock - dt * 3);

    // collisions with trees and rocks
    if (this.collider) {
      const hit = this.collider.resolve(this.x, this.y, this.z, 0.4);
      if (hit) {
        // started inside a building: always take the pushed-out position, even when already moving out
        if (hit.inside) { this.x = hit.x; this.y = hit.y; }
        const vn = this.vx * hit.nx + this.vy * hit.ny; // negative = moving into the obstacle
        const spdNow = Math.hypot(this.vx, this.vy) || 1;
        const headOn = -vn / spdNow; // 1 = straight into it, 0 = grazing
        if (vn < 0) {
          if (hit.kind === 1) {
            // rampable rock: ride up and over it. Launch angle from how square the hit is.
            this.lastHit = 'ramp';
            const h = Math.max(0.3, hit.top - this.z);
            const launch = Math.min(0.9, 0.25 + 0.9 * headOn) * Math.min(1, h / 1.5);
            this.vz = Math.max(this.vz, spdNow * launch * 0.5 + 1.5);
            this.vx *= 1 - 0.12 * headOn; this.vy *= 1 - 0.12 * headOn;
            this.onGround = false; this.airTime = 0; this.spin = 0; this.flip = 0; this.flipRate = 0;
            this.z = Math.max(this.z, hit.top - 0.3);
            this.landingShock = 0.3;
          } else if (headOn < 0.5) {
            // glancing hit on a tree or wall: slide along it, lose a little speed
            this.lastHit = 'graze';
            this.x = hit.x; this.y = hit.y;
            this.vx -= vn * hit.nx; this.vy -= vn * hit.ny;
            this.vx *= 0.85; this.vy *= 0.85;
            this.landingShock = 0.25;
          } else {
            // square hit: bounce off; fast square hits crash
            this.lastHit = 'wall';
            this.x = hit.x; this.y = hit.y;
            if (-vn > 7) this.crashed = 1.2;
            this.vx -= 1.4 * vn * hit.nx; this.vy -= 1.4 * vn * hit.ny;
            this.vx *= 0.6; this.vy *= 0.6;
          }
        }
      }
    }
  }

  /** Unstrapping or strapping in: stand where you are while the bindings are worked. */
  private strapStep(dt: number, ground: number): void {
    const f = Math.exp(-dt * 8);
    this.vx *= f; this.vy *= f;
    this.x += this.vx * dt; this.y += this.vy * dt;
    this.z = ground; this.vz = 0; this.onGround = true;
    this.speed = Math.hypot(this.vx, this.vy);
    this.edge = 0; this.turnRadius = Infinity; this.turnRate = 0; this.carveAcc = 0; this.lateralG = 0; this.skid = 0; this.jumpCharge = 0; this.landingShock = 0;
    this.sink = bootSink(this.surface);
    this.squareBoard();
    this.strapT += dt;
    if (this.strapState === 'off' && this.strapT >= UNSTRAP_TIME) {
      this.strapState = 'none'; this.onFoot = true; this.strapT = 0;
      this.stamina = STAMINA; this.tired = false;
      this.walkVx = this.vx; this.walkVy = this.vy; this.slideVx = this.slideVy = 0;
    } else if (this.strapState === 'on' && this.strapT >= STRAP_TIME) {
      this.strapState = 'none'; this.onFoot = false; this.strapT = 0;
      this.vx = this.vy = 0; this.speed = 0;
    }
  }

  /**
   * On foot (FEAT-067). Steer turns, tuck walks forward, brake walks backward slowly, grab (Shift)
   * sprints for a few seconds of stamina, jump hops. Speed falls with the uphill grade and with how
   * far the boots sink; slopes over CLIMB_MAX cannot be climbed (you slide back), and past
   * SLIP_SLOPE you slip down whatever you do. Same colliders as riding.
   */
  private walkStep(dt: number, input: Input, n: [number, number, number], ground: number): void {
    this.sink = bootSink(this.surface);
    this.edge = 0; this.turnRadius = Infinity; this.turnRate = 0; this.carveAcc = 0; this.lateralG = 0; this.skid = 0; this.jumpCharge = 0;
    this.landingShock = Math.max(0, this.landingShock - dt * 3);
    this.squareBoard();
    // hop on the press edge
    const hop = input.jumpHeld && !this.hopHeld;
    this.hopHeld = input.jumpHeld;
    // BUG-045: a mantle in progress: up the wall first, then over the edge, then stand
    if (this.mantle > 0) {
      this.mantle = Math.min(1, this.mantle + dt / MANTLE_TIME);
      const a = this.mantleFrom, b = this.mantleTo, m = this.mantle;
      const up = Math.min(1, m / 0.6), over = Math.max(0, (m - 0.45) / 0.55);
      const ease = (t: number) => t * t * (3 - 2 * t);
      this.x = a[0] + (b[0] - a[0]) * ease(over); this.y = a[1] + (b[1] - a[1]) * ease(over);
      this.z = a[2] + (b[2] - a[2]) * ease(up);
      this.vx = this.vy = this.vz = this.walkVx = this.walkVy = this.slideVx = this.slideVy = 0; this.speed = 0;
      this.onGround = true;
      if (this.mantle >= 1) this.mantle = 0;
      return;
    }
    // BUG-045: a step up onto a low ledge, eased so the camera and board do not pop; the walk
    // velocity is kept so you carry on at the same pace once up
    if (this.stepT > 0) {
      this.stepT = Math.min(1, this.stepT + dt / STEP_TIME);
      const a = this.mantleFrom, b = this.mantleTo, m = this.stepT;
      const up = Math.min(1, m / 0.6), ease = (t: number) => t * t * (3 - 2 * t);
      this.x = a[0] + (b[0] - a[0]) * m; this.y = a[1] + (b[1] - a[1]) * m;
      this.z = a[2] + (b[2] - a[2]) * ease(up);
      this.vz = 0; this.onGround = true;
      this.speed = Math.hypot(this.walkVx, this.walkVy);
      this.distance += this.speed * dt;
      if (this.stepT >= 1) this.stepT = 0;
      return;
    }
    // BUG-045: jump into a chest-high ledge (a deck, platform or low roof) to climb onto it
    if (hop && this.onGround && this.collider) {
      const hx0 = Math.sin(this.heading), hy0 = Math.cos(this.heading);
      const px = this.x + hx0 * MANTLE_PROBE, py = this.y + hy0 * MANTLE_PROBE;
      const top = this.collider.floorAt(px, py, this.z, CLIMB_UP);
      if (top > this.z + STEP_UP * 0.5) {
        this.mantleFrom[0] = this.x; this.mantleFrom[1] = this.y; this.mantleFrom[2] = this.z;
        this.mantleTo[0] = this.x + hx0 * (MANTLE_PROBE + 0.2); this.mantleTo[1] = this.y + hy0 * (MANTLE_PROBE + 0.2); this.mantleTo[2] = top;
        if (this.collider.floorAt(this.mantleTo[0], this.mantleTo[1], this.z, CLIMB_UP) < top) { this.mantleTo[0] = px; this.mantleTo[1] = py; }
        this.mantle = 1e-3;
        return;
      }
    }
    if (!this.onGround) {
      this.vz -= G * dt;
      this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
      this.airTime += dt;
      const g2 = this.groundAt(this.x, this.y, this.z);
      if (this.z <= g2) { this.z = g2; this.vz = 0; this.onGround = true; this.airTime = 0; this.landingShock = 0.3; }
      this.collide(0.3);
      this.speed = Math.hypot(this.vx, this.vy);
      return;
    }
    this.heading += input.steer * (this.sprinting ? 2.0 : 2.6) * dt;
    const hx = Math.sin(this.heading), hy = Math.cos(this.heading);
    const fwd = input.tuck ? 1 : input.brake ? -1 : 0;
    // stamina: a few seconds of sprint, then a run until it comes back
    const wantSprint = input.grab && fwd > 0;
    if (this.stamina <= 0) this.tired = true;
    if (this.tired && this.stamina >= STAMINA_RESUME) this.tired = false;
    this.sprinting = wantSprint && !this.tired && this.speed > 0.5;
    if (this.sprinting) this.stamina = Math.max(0, this.stamina - dt);
    else this.stamina = Math.min(STAMINA, this.stamina + dt * (fwd === 0 ? 0.8 : 0.45));
    let base = fwd > 0 ? (wantSprint ? (this.tired ? JOG : SPRINT) : WALK) : fwd < 0 ? -BACK : 0;
    base *= 1 - 0.6 * this.squat; // hunkered down (FEAT-111): a slow duck walk
    // grade along the way you are walking, at body scale: rise per metre over BODY_L (+ = uphill)
    const pack = this.pack, dir = base < 0 ? -1 : 1, hl = BODY_L / 2;
    const rise = pack.groundHeight(this.x + hx * hl * dir, this.y + hy * hl * dir) - pack.groundHeight(this.x - hx * hl * dir, this.y - hy * hl * dir);
    const grade = Number.isNaN(rise) ? 0 : rise / BODY_L;
    const steep = Math.atan(Math.max(0, grade)) / D2R;
    this.walkSlopeDeg = Math.atan(grade) / D2R;
    // uphill: about 70% pace up a 20 degree pitch, half pace at 30; downhill a little careful.
    // Past CLIMB_MAX you scramble on all fours, slower as it steepens toward CRAWL_MAX.
    const slopeF = grade > 0 ? Math.max(0.4, 1 - 0.8 * grade) : Math.max(0.7, 1 + 0.6 * grade);
    this.crawling = fwd > 0 && steep >= CLIMB_MAX && steep < CRAWL_MAX;
    if (this.crawling) { base = CRAWL * Math.max(0.3, Math.min(1, (CRAWL_MAX - steep) / 8)); this.sprinting = false; }
    else base *= slopeF;
    const climbingTooSteep = fwd !== 0 && steep >= CRAWL_MAX;
    base *= Math.max(0.4, 1 - 2.2 * this.sink);
    // a slip: the feet go and you slide back down for a moment, not pushing uphill, before you can
    // try again (otherwise you just hover at the CRAWL_MAX line)
    if (climbingTooSteep && this.slipT <= 0) this.slipT = 0.7;
    if (this.slipT > 0) { this.slipT -= dt; base = 0; this.crawling = false; this.sprinting = false; }
    // walk velocity eases toward the target (quicker to stop than to start)
    const tx = hx * base, ty = hy * base;
    const k = 1 - Math.exp(-dt * (base === 0 ? 10 : 6));
    this.walkVx += (tx - this.walkVx) * k; this.walkVy += (ty - this.walkVy) * k;
    // slipping: too steep to climb (and trying to) or to stand on at all, both at body scale
    const fall = Math.hypot(n[0], n[1]);
    let fallDeg = 0;
    if (fall > 0.05) {
      const dx = (n[0] / fall) * hl, dy = (n[1] / fall) * hl; // downhill
      const drop = pack.groundHeight(this.x - dx, this.y - dy) - pack.groundHeight(this.x + dx, this.y + dy);
      fallDeg = Number.isNaN(drop) ? 0 : Math.atan(Math.max(0, drop) / BODY_L) / D2R;
    }
    if ((this.slipT > 0 || fallDeg > CRAWL_MAX) && fall > 0.05) {
      const th = Math.max(steep, fallDeg) * D2R;
      const a = Math.max(2.5, G * (Math.sin(th) - Math.cos(th) * Math.tan(30 * D2R)));
      this.slideVx += (n[0] / fall) * a * dt; this.slideVy += (n[1] / fall) * a * dt;
      const sl = Math.hypot(this.slideVx, this.slideVy);
      if (sl > 5) { this.slideVx *= 5 / sl; this.slideVy *= 5 / sl; }
    } else {
      const f = Math.exp(-dt * 5);
      this.slideVx *= f; this.slideVy *= f;
    }
    this.vx = this.walkVx + this.slideVx; this.vy = this.walkVy + this.slideVy;
    this.x += this.vx * dt; this.y += this.vy * dt;
    this.z = this.groundAt(this.x, this.y, this.z);
    void ground;
    this.vz = 0;
    if (hop) { this.vz = 2.6; this.onGround = false; this.airTime = 0; this.z += 0.02; }
    this.collide(0.3, true);
    this.speed = Math.hypot(this.vx, this.vy);
    this.distance += this.speed * dt;
    const work = this.sprinting || this.crawling ? 1 : (fwd !== 0 && grade > 0.15 ? Math.min(0.7, grade) : 0) + (this.tired ? 0.4 : 0);
    this.exertion += (Math.min(1, work) - this.exertion) * Math.min(1, dt * (work > this.exertion ? 0.8 : 0.25));
  }

  /** BUG-045: terrain or a bridge deck, or the top of a building the rider is standing on */
  private groundAt(x: number, y: number, z: number): number {
    const g = this.pack.groundHeight(x, y, z);
    if (!this.collider) return g;
    const f = this.collider.floorAt(x, y, z, 0.05);
    return f > g ? f : g;
  }

  /** On foot and sliding down the snow (a slip): the boots skid instead of stepping. */
  get slipping(): boolean { return this.onFoot && this.onGround && (this.slipT > 0 || this.slideSpeed > 0.6); }

  /** Sliding speed (m/s) when slipping down a slope too steep to climb. */
  get slideSpeed(): number { return Math.hypot(this.slideVx, this.slideVy); }

  /** On-foot collisions: push out of trunks, rocks, walls and railings and stop going into them. */
  private collide(r: number, walking = false): void {
    if (!this.collider) return;
    const hit = this.collider.resolve(this.x, this.y, this.z, r);
    if (!hit) return;
    // BUG-045: walking into a low ledge (a curb, a step, a low deck): step up onto it. Only a
    // building edge counts, so a post, trunk or railing is never stepped over.
    if (walking && hit.ledge && !hit.inside) {
      const px = hit.x - hit.nx * (r + 0.15), py = hit.y - hit.ny * (r + 0.15);
      const top = this.collider.floorAt(px, py, this.z, STEP_UP);
      if (top > this.z && Number.isFinite(top) && (this.walkVx * hit.nx + this.walkVy * hit.ny) < 0) {
        this.mantleFrom[0] = hit.x; this.mantleFrom[1] = hit.y; this.mantleFrom[2] = this.z;
        this.mantleTo[0] = px; this.mantleTo[1] = py; this.mantleTo[2] = top;
        this.x = hit.x; this.y = hit.y; this.stepT = 1e-3;
        return;
      }
    }
    this.x = hit.x; this.y = hit.y;
    const into = (vx: number, vy: number) => Math.min(0, vx * hit.nx + vy * hit.ny);
    let d = into(this.vx, this.vy); this.vx -= d * hit.nx; this.vy -= d * hit.ny;
    d = into(this.walkVx, this.walkVy); this.walkVx -= d * hit.nx; this.walkVy -= d * hit.ny;
    d = into(this.slideVx, this.slideVy); this.slideVx -= d * hit.nx; this.slideVy -= d * hit.ny;
  }

  /**
   * FEAT-127: the highest edge angle the rider can hold here (rad). Lower in powder (the board
   * planes), cut by a tuck and a press, raised a little by a squat. Rock and ice take a full edge
   * but hold little (the grip limit), so a hard carve there washes out. Slow, there is little turn
   * force to lean against, so past what the knees and hips angulate a high edge would tip the
   * rider into the hill: the cap is that plus the lean the sidecut's arc needs.
   */
  /**
   * BUG-056: where the edge will be `lead` seconds from now if the steer holds: the same ease and
   * roll-rate limit the step applies, run forward once. Visual only (the rider view's body lead).
   */
  predictEdge(lead: number): number {
    if (lead <= 0) return this.edge;
    const d = (this.edgeTarget - this.edge) * Math.min(1, lead * EDGE_EASE);
    const cap = FEEL[this.discipline].roll * lead * (this.edgeTarget * this.edge < 0 ? EDGE_SNAP : 1);
    return this.edge + Math.max(-cap, Math.min(cap, d));
  }

  /**
   * BUG-056: the inclination (rad, + toward the toe edge) that balances the edge `lead` seconds from
   * now at the current speed: the carve model's arc, R = Rsc cos(psi), opened out to what the lean
   * can hold, with no slope or skid terms. Visual only (the rider view's crossover).
   */
  predictIncline(lead: number): number {
    const e = this.predictEdge(lead), psi = Math.abs(e), F = FEEL[this.discipline];
    const spd = Math.hypot(this.vx, this.vy);
    const phi = Math.min(PHI_MAX, psi * (1 - F.angulation));
    const aLat = Math.min((spd * spd) / (F.sidecut * Math.cos(psi)), G * this.normal[2] * Math.tan(phi));
    return Math.sign(e) * Math.atan(aLat / G);
  }

  /** BUG-056: where the press lean will be `lead` seconds from now if the input holds (visual only). */
  predictLean(lead: number): number {
    return lead <= 0 ? this.lean : this.lean + (this.leanTarget - this.lean) * Math.min(1, lead / LEAN_IN);
  }

  private edgeCap(input: Input, F: Feel, powder: number, spd: number): number {
    let cap = F.psiMax - (F.psiMax - F.psiPowder) * Math.min(1, powder);
    if (input.tuck) cap *= TUCK_EDGE;
    cap = (cap + SQUAT_EDGE * this.squat) * (1 - PRESS_EDGE * Math.abs(this.lean));
    const slow = ANG_SLOW + Math.atan((spd * spd) / (G * F.sidecut * Math.cos(Math.abs(this.edge))));
    return Math.max(0, Math.min(cap, slow));
  }

  /**
   * Set boardYaw from the heading and the brake swing: eased from the heading toward the stop
   * angle off the travel direction. Returns the eased swing (0..1).
   */
  private poseBoard(): number {
    const a = this.brakeAmt;
    const e = a * a * (3 - 2 * a);
    if (e === 0 || this.brakeSide === 0) { this.boardYaw = this.heading; return 0; }
    const target = this.travelYaw + this.brakeSide * this.stopAngle();
    this.boardYaw = this.heading + wrap(target - this.heading) * e;
    return e;
  }

  /** FEAT-133: the board angle to travel this brake is swinging to: the stop angle, squared up toward
   *  GAMMA_HARD steering into the edge or opened out toward GAMMA_SOFT steering away (0 = snowplough) */
  private stopAngle(): number {
    if (this.brakeGamma <= 0) return 0;
    const m = this.brakeMod;
    return m >= 0 ? STOP_GAMMA + (GAMMA_HARD - STOP_GAMMA) * m : STOP_GAMMA + (STOP_GAMMA - GAMMA_SOFT) * m;
  }

  private land(ground: number, input: Input): void {
    const n = this.pack.groundNormal(this.x, this.y, undefined, this.z) as number[];
    this.z = ground;
    this.onGround = true;
    // impact normal to the surface
    const vn = this.vx * n[0] + this.vy * n[1] + this.vz * n[2];
    // remove normal component (inelastic), keep tangential
    this.vx -= vn * n[0]; this.vy -= vn * n[1]; this.vz -= vn * n[2];
    const impact = Math.max(0, -vn);
    // misaligned landing (board not along the velocity) or heavy impact costs speed; very heavy = crash
    const hx = Math.sin(this.heading), hy = Math.cos(this.heading);
    const spd = Math.hypot(this.vx, this.vy);
    const align = spd > 0.5 ? Math.abs((this.vx * hx + this.vy * hy) / spd) : 1;
    const spinOff = Math.abs(((this.spin % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI); // distance from facing forward/backward
    // FEAT-110: how far the flip is from a whole number of rotations (the board back under you)
    const flipOff = Math.abs(((this.flip % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    const flipped = Math.round(Math.abs(this.flip) / (Math.PI * 2));
    const sketchy = flipOff > FLIP_CLEAN && flipOff <= FLIP_CRASH;
    const clean = (align > 0.6 || spinOff < 0.6) && flipOff <= FLIP_CLEAN;
    const penalty = (clean ? 0.08 : sketchy ? 0.3 : 0.5) + impact * (clean ? 0.012 : 0.03);
    this.vx *= Math.max(0, 1 - penalty); this.vy *= Math.max(0, 1 - penalty);
    this.landingShock = Math.min(1, impact / 12);
    if (impact > 16 || (!clean && !sketchy && impact > 8 && !input.grab)) this.crashed = 1.3;
    if (flipOff > FLIP_CRASH) this.crashed = 1.3; // landed on the head or the back
    else if (sketchy) this.landingShock = Math.max(this.landingShock, 0.6); // a wobble
    if (flipped > 0 && this.crashed <= 0) this.onTrick?.(trickName(this.flip, this.spin, flipped));
    if (!clean) this.heading = Math.atan2(this.vx, this.vy); // the board snaps to the direction of travel
    this.spin = 0; this.flip = 0; this.flipRate = 0;
    this.airTime = 0;
  }
}
