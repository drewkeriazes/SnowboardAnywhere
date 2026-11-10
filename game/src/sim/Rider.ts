import type { Pack } from '../pack/Pack';
import type { Collider } from './Collider';
import { Rng } from './Rng';
import { rockCover } from '../terrain/rockCover';
import { DEFAULT_SNOW_WORLD, newSnowState, snowAt, type SnowState, type SnowWorld } from './SnowConditions';

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
  /** FEAT-140: weight forward (+1, W or the stick up) or back (-1) to balance a press; Controls sends W / S here instead of tuck / brake while a press key is held on the snow */
  balance?: number;
}

export interface SurfaceInfo {
  rock: number;
  scree: number;
  groomed: number;
  canopy: number;
  /** FEAT-059: mogul amplitude under the rider, metres (0 off the bump fields) */
  moguls: number;
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
 * How far a boot sinks (m): 70% of the snow depth under the rider (FEAT-053), at least 4 mm. It
 * follows the day's conditions: deeper after a storm, a few cm in chop and slush, almost nothing
 * on ice or rock. Drives the walking speed, the boot height and the print depth.
 */
export function bootSink(snow: SnowState): number {
  return Math.max(0.004, snow.depth * 0.7);
}
/** FEAT-053 powder: speed (m/s) by which the board planes and the speed-scaled drag stops growing,
 *  the drag per m/s before that (per unit powder), and the nose-sink drag (g) at a standstill that
 *  is gone by SINK_SPEED m/s */
export const PLANE_SPEED = 12; const POWDER_DRAG = 0.012, SINK_DRAG = 0.08, SINK_SPEED = 6;
/** FEAT-152 presses in deep powder (scaled by powder x depth): weight forward digs the nose in (up to
 *  SINK_NOSE times the nose dig, and on to SINK_NOSE_SPEED times the speed), weight back lifts it out
 *  (SINK_TAIL of the dig gone, the speed it lasts to cut by the same share); the press's own drag is
 *  PD_NOSE_DRAG times more on a nose press and PD_TAIL_EASE (all) of it gone on a tail press (the way powder is ridden) */
const SINK_NOSE = 0.6, SINK_NOSE_SPEED = 0.6, SINK_TAIL = 0.75, PD_NOSE_DRAG = 1.5, PD_TAIL_EASE = 1;
/** FEAT-053 chop: a jolt every CHOP_GAP s (random, about), kicking the heading up to CHOP_YAW rad and
 *  the board sideways up to CHOP_KICK m/s at full chop and speed, smaller at low speed (gone by CHOP_SPEED) */
const CHOP_GAP = 0.2, CHOP_YAW = 0.035, CHOP_KICK = 0.3, CHOP_SPEED = 12;

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
/** FEAT-134 the fall line, all scaled by `fallLine` (1 realistic, 0.5 assisted, 0 off = rails as before).
 *  A flat base holds only GRIP_FLAT_REAL g sideways (a waxed base on snow), so across a slope it
 *  side-slips unless an edge is in. A flat board follows its slide down the hill (FALL_FOLLOW) and the
 *  weight on the leading foot drops that end at up to FALL_YAW x sin(slope) rad/s, gone by FALL_EDGE
 *  of edge and halved by FALL_YAW_SPEED m/s. Standing on a slope needs STAND_EDGE x fallLine of uphill edge or the brake.
 *  The edge catch (realistic only): see CATCH_* below. */
const GRIP_FLAT_REAL = 0.12, FALL_YAW = 2, FALL_YAW_SPEED = 15, FALL_EDGE = 12 * D2R, STAND_EDGE = 10 * D2R;
/** the weathervane swings the leading end: full nose (or tail) once moving FALL_LEAD_V m/s along the board,
 *  nothing sliding straight sideways; climbing, it fades out from across the hill and is gone at
 *  cos(angle from the fall line) = -FALL_CLIMB (about 135 deg), so a climb falls back into switch */
const FALL_LEAD_V = 1.5, FALL_CLIMB = 0.7;
/** a flat board follows its slide at up to FALL_FOLLOW rad/s times the sine of its slip angle (the
 *  main swing: gravity bends the slide down the hill and the board follows it); FALL_YAW is only the
 *  leading foot's weight dropping that end */
const FALL_FOLLOW = 2;
/** FEAT-134 the edge catch (realistic only): the board sliding sideways toward an edge that meets the snow.
 *  The leading edge (on the side the board slides toward: the downhill edge in a side-slip, the outside
 *  edge in a skid) dug in past CATCH_EDGE catches at up to CATCH_DIG per second; a flat base, at up to
 *  CATCH_FLAT per second times the roughness (CATCH_ROUGH on a groomer, plus chop jolts and moguls); a
 *  trailing edge of CATCH_GUARD or more keeps it off the snow. Both times the drift (none under
 *  CATCH_DRIFT m/s sideways, full CATCH_DRIFT_SPAN past it) and the slip (none under CATCH_SLIP off the
 *  board, full CATCH_SLIP_SPAN past it), so a carve, even a skidded carve transition, never qualifies.
 *  Seeded, so runs replay. */
const CATCH_EDGE = 15 * D2R, CATCH_GUARD = 6 * D2R, CATCH_DIG = 25, CATCH_FLAT = 1.5, CATCH_ROUGH = 0.15;
const CATCH_DRIFT = 1, CATCH_DRIFT_SPAN = 2, CATCH_SLIP = 20 * D2R, CATCH_SLIP_SPAN = 20 * D2R;
/** the board's slip past its line (rad) before the carve lets go: from SLIP_HOLD on, the arc stops
 *  driving the heading, gone by SLIP_HOLD + SLIP_WASH (a skid that settles, not a spin) */
const SLIP_HOLD = 4 * D2R, SLIP_WASH = 30 * D2R;
/**
 * FEAT-148 hard carve (the squat key held while steering on the snow): eased in over HARD_IN s. The
 * edge cap goes up to HARD_PSI and the edge rolls HARD_ROLL times as fast, slowing with the square
 * of the speed past HARD_ROLL_V m/s (driving a deep edge in against the load takes longer at speed),
 * never below HARD_ROLL_MIN of that. The body may lean to HARD_PHI and the snow holds up to HARD_G g
 * on groomed corduroy, scaled by the snow's grip: the edge bites and whips the rider round.
 */
const HARD_IN = 0.12, HARD_PSI = 80 * D2R, HARD_ROLL = 1.5, HARD_ROLL_V = 10, HARD_ROLL_MIN = 0.45, HARD_PHI = 69 * D2R, HARD_G = 2.6;
/**
 * FEAT-148: the press drives the turn in over HARD_DRIVE_T s from when the edge is on the steer's side
 * (it asks for the turn of the target edge, not the edge the board has got to). The edge holds
 * g tan(lean) of its real angle, so an edge that lags (pressed at speed from flat, on ice) cannot hold
 * the turn asked of it: the tail slides out. Short of it by more than WASH_SHARE of the turn asked (a
 * share, so softer snow that asks less washes out alike) fills a washout meter at WASH_RATE per s per
 * share past it, times the speed past WASH_V0 over WASH_SPAN m/s (1 at 20 m/s, more beyond); full, the
 * edge lets go and the rider goes down on the inside of the turn. It drains at WASH_DRAIN per s.
 */
const HARD_DRIVE_T = 0.15, WASH_SHARE = 0.35, WASH_V0 = 8, WASH_SPAN = 12, WASH_RATE = 38, WASH_DRAIN = 3;
/** extra sideways grip on groomed corduroy (gripBase is GROOMED_GRIP there): HARD_G is in g on corduroy */
const GROOMED_BONUS = 0.4, GROOMED_GRIP = 1 + GROOMED_BONUS;
/** FEAT-148: a committed edge holds this much over the turn it balances, so it bites clean instead of riding the grip limit */
const HARD_SLACK = 1.2;
/** FEAT-148: a hard carve's deep edge plows snow: a drag of HARD_DRAG times the lateral acceleration */
const HARD_DRAG = 0.06;
/** FEAT-148: forced past its hold the edge scrapes and chatters: a full skid (spray, sound, scrub) at HARD_SKID g short */
const HARD_SKID = 1.2;
/** FEAT-148: powder this deep (m) planes the board fully in a hard carve: the edge cap drops toward the
 *  powder cap and the washout stops, a deep surfy turn. Shallower powder, chop and slush do not (BUG-066 follow-up) */
const HARD_DEEP = 0.3;
/** FEAT-148: steer under this does not start a hard carve, and below HARD_MIN_SPEED m/s it is just a squat pivot */
const HARD_STEER = 0.3, HARD_MIN_SPEED = 3;

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
/**
 * FEAT-139: a spin with no flip ("Frontside 180", "Backside 360"), or '' under a half turn. `toe` is
 * the side the toe edge is on (+1 the heading's right): frontside turns the chest toward the
 * direction of travel first, which is counterclockwise (spin < 0) for a rider facing right.
 */
export function spinName(spin: number, toe: number): string {
  const turns = Math.round(Math.abs(spin) / Math.PI) * 180;
  return turns < 180 ? '' : `${spin * toe < 0 ? 'Frontside' : 'Backside'} ${turns}`;
}
/** FEAT-139: "Switch backside 180", "Switch backflip": a trick taken off riding switch */
export function switchName(name: string, sw: boolean): string {
  return sw && name ? `Switch ${name[0].toLowerCase()}${name.slice(1)}` : name;
}

/** FEAT-139: riding backwards faster than this (m/s) the steering axis turns round and the stance
 *  toggles to switch (or back); was 4 m/s when it spun the drawn rider round, which is now invisible */
const FAKIE_SPEED = 2.5;
/** FEAT-139: share of the sideways grip lost riding switch (most riders are weaker switch); 0 turns it off */
const SWITCH_GRIP = 0.04;

/** FEAT-085 skating: mean push (m/s^2) from a standstill, top skating speed (m/s), steepest slope it works on (deg), stroke period (s) */
const SKATE_ACC = 4.2, SKATE_MAX = 5.5, SKATE_SLOPE = 10, SKATE_PERIOD = 0.6;

/** FEAT-112 lean: ease time (s), grip lost and drag added (per m/s) on a full press, pop multiplier for an
 * ollie / nollie (|lean| > 0.5 at release), and the pitch rate it leaves (rad/s per unit lean) */
const LEAN_IN = 0.2, PRESS_GRIP = 0.35, PRESS_DRAG = 0.05, OLLIE_POP = 1.3, OLLIE_PITCH = 1.2;

/** FEAT-140: how a held press ends: let go (or left the snow), dropped flat (under-pressed), slammed or stalled (over-pressed) */
export type PressEnd = 'clean' | 'flat' | 'slam' | 'stall';
/** FEAT-140: Settings > Game > Press balance */
export type PressMode = 'on' | 'easy' | 'hard' | 'off';
/**
 * FEAT-140 press balance, in needle units per second (the needle runs -1 .. 1, + toward the
 * heading's front end): the base drift, the most it and the runaway grow with the time held (share;
 * they level off with PB_HOLD_T s, starting at PB_HOLD_MAX / PB_HOLD_T per second), the share it grows per m/s of
 * speed, the runaway rate off centre (an inverted pendulum, so a needle off centre keeps going), the
 * jitter at full bumps (moguls, crud), a random push of PB_PUSH every PB_GAP s (min, max), full
 * W / S (raised to PB_CORRECT_OVER times the steady drift when that is more, so no press is ever
 * past saving: the skill is in reacting and not overcorrecting), and the slowest the loaded end slams
 * instead of stalling (m/s). On a groomer at 10 m/s a sloppy keyboard press lasts about 8 s and a
 * careful one much longer (tools/presscheck.mjs).
 */
const PB_DRIFT = 0.2, PB_HOLD_MAX = 1.6, PB_HOLD_T = 4.6, PB_SPEED = 0.04, PB_UNSTABLE = 1.0, PB_BUMP = 2.4, PB_PUSH = 0.35, PB_CORRECT = 1.5, PB_STALL = 3;
const PB_GAP = [0.8, 2.2] as const, PB_PUSH_T = 0.15;
/** FEAT-140: full W / S is at least this many times the drift, the bump jitter and the runaway together (fast, bumpy, long presses), so it can always win */
const PB_CORRECT_OVER = 1.4;
/** FEAT-140: the weight shift W / S make builds and lets go over this long (s) */
const PB_SHIFT_T = 0.15;
/**
 * FEAT-140: how far the balance can run before it is lost, in the units the rates above are in
 * (was 1). pressBalance stays a share of it (-1 .. 1) for the meter; the body leans in proportion,
 * so at the edge it leans this many times as far as at 1. The runaway grows with the share, not the
 * distance, so a press stays saveable out to the edge.
 */
export const PRESS_RANGE = 1.6;
/** FEAT-140 difficulty (Settings > Game > Press balance): drift, jitter and push scaled by the first, the runaway by the second */
const PB_LEVEL: Record<Exclude<PressMode, 'off'>, [number, number]> = { easy: [0.5, 0.6], on: [1, 1], hard: [1.5, 1.3] };
/** FEAT-140: vertical acceleration through the board counted as full bumps (m/s^2), the bumps counted
 *  in ungroomed snow, the drift added at full bumps (share), and the longest hop (s) a press rides
 *  through (a roller or a mogul; longer is a jump and ends it) */
const PB_BUMP_ACC = 15, PB_CRUD = 0.35, PB_BUMP_DRIFT = 2, PB_AIR = 0.3;
/** FEAT-140: a press that starts within this long of landing a trick (s) is landed into from it ("Backflip to tail press") */
const PB_LAND_WINDOW = 0.5;
/** FEAT-152 presses in deep powder (scaled by powder x depth): a nose press is pulled on toward its
 *  buried nose at PB_POWDER needle units/s when slow (PB_POWDER_FAST of it from PLANE_SPEED), and a
 *  tail press, the nose up out of the snow, has PB_POWDER_STEADY less drift and jitter and PB_POWDER_CALM less runaway */
const PB_POWDER = 0.55, PB_POWDER_FAST = 0.4, PB_POWDER_STEADY = 0.4, PB_POWDER_CALM = 0.25;
/** FEAT-140: a press held shorter than this (s) ends without a report */
export const PRESS_MIN_REPORT = 0.5;

export class Rider {
  x = 0; y = 0; z = 0; // position, local metres (z up)
  vx = 0; vy = 0; vz = 0;
  heading = 0; // radians, 0 = north (+y), increasing clockwise (toward +x)
  /** FEAT-139: riding switch (the other foot forward, the tail leading). `heading` stays the steering
   *  axis along the direction of travel and every physics value stays in its frame; the view draws
   *  the board and the body turned round (see toeSign). Snowboard only. */
  switch = false;
  /** FEAT-139: the rider's normal stance has the right foot forward (Settings > Rider > Stance) */
  goofy = false;
  onGround = true;
  airTime = 0;
  jumpCharge = 0;
  /** 0..1 how far into the deep squat (FEAT-111), eased over about 0.25 s */
  squat = 0;
  /** s since the squat was let go from deep; a jump right then pops higher */
  private squatUp = 9;
  speed = 0;
  /** FEAT-127: the board's edge angle to the snow (rad), + = the heading's right-hand edge (the toe edge riding regular; see toeSign), rolled toward the steer at a limited rate */
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
  // ---- FEAT-148 hard carve
  /** 0..1 how far into a hard carve (the squat key held while steering on the snow), eased */
  hardCarve = 0;
  /** 0..1 how far the press has driven the turn in on the current edge */
  private hardDrive = 0;
  /** how far short (g) the edge's hold falls of the turn the press asks for (0 = committed, it bites) */
  carveShort = 0;
  /** 0..1 the washout meter: a big shortfall at speed fills it, full the edge lets go */
  washout = 0;
  /** called when a hard carve washes out: -1 heelside (down on the butt), +1 toeside (onto the hip) */
  onWashout: ((side: number) => void) | null = null;
  /** FEAT-148: which way a crash throws the body sideways, + the heading's right-hand side (a washout falls to the inside of the turn), 0 none */
  crashSide = 0;
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
  // ---- FEAT-140 press balance
  /** Settings > Game > Press balance (main sets it) */
  pressMode: PressMode = 'on';
  /** a press is being held and balanced (|lean| > 0.5 on the snow) */
  pressing = false;
  /** the balance needle, -1 .. 1 (a share of PRESS_RANGE), 0 = the sweet spot, + toward the heading's front end (W) */
  pressBalance = 0;
  /** the loaded end of the press being held: +1 the front (nose press), -1 the back (tail press) */
  pressDir = 0;
  /** seconds and metres the press has been held */
  pressT = 0; pressDist = 0;
  /** called when a press ends (how, which end, s, m, riding switch); one held under PRESS_MIN_REPORT is not reported */
  onPress: ((end: PressEnd, dir: number, t: number, dist: number, switchStance: boolean, from: string) => void) | null = null;
  /** the trick this press was landed into from ('' if none) */
  pressFrom = '';
  /** the last trick landed and the step it landed on */
  private landTrick = ''; private landStep = -1e9;
  /** lost it: the lean stays flat until the press key (this sign) is let go */
  private pressLock = 0;
  private pbDrift = 1; private pbPushT = 0; private pbPushLeft = 0; private pbPushV = 0;
  private pbNoise = 0; private pbNoiseTo = 0; private pbNoiseT = 0; private pbBump = 0; private pbVz = 0; private pbCorr = 0;
  skating = false;
  skatePhase = 0;
  onSkateStroke: (() => void) | null = null;
  /** FEAT-110: called on landing a flip ("Backflip", "Double front flip", "Rodeo 540"), clean or sketchy */
  onTrick: ((name: string) => void) | null = null;
  crashed = 0; // seconds remaining in a crash
  /** FEAT-140: which way the crash throws the body, +1 forward along the heading, -1 back, 0 either (a press slam falls over its loaded end) */
  crashFall = 0;
  surface: SurfaceInfo = { rock: 0, scree: 0, groomed: 0, canopy: 0, moguls: 0 };
  /** FEAT-053: the snow here (groomed / powder / chop / ice / slush weights and the physics they set) */
  readonly snow: SnowState = newSnowState();
  /** FEAT-053: the day's conditions (main.ts sets the hour, weather, new snow and the setting) */
  readonly snowWorld: SnowWorld = { ...DEFAULT_SNOW_WORLD };
  /** FEAT-053: 0..1 how hard the chop is rattling the board right now (smoothed, for the camera and the view) */
  chop = 0;
  /** FEAT-053: 0..1 the nose sinking into slow powder (for the drag; the view may tip the board) */
  noseSink = 0;
  private chopT = 0;
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
  /** FEAT-134: how hard the fall line works on the board: 1 realistic, 0.5 assisted, 0 off (Settings > Rider) */
  fallLine = 1;
  /** the edge catch's chance per second this step (FEAT-134; ?debug shows it) */
  catchRisk = 0;
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

  /** FEAT-139: which side of the heading the toe edge is on: +1 the right (regular, or goofy riding
   *  switch), -1 the left (goofy, or regular riding switch; the board and body are drawn turned round) */
  get toeSign(): number { return this.discipline === 'board' && this.switch !== this.goofy ? -1 : 1; }

  /**
   * FEAT-139: turn the steering axis round to the direction of travel and toggle the stance, so the
   * rider as drawn (the board at heading + PI while switch) does not move. The edge, the lean and the
   * lateral g keep their side of the board, which is the other side of the new heading.
   */
  private turnRound(): void {
    this.heading += Math.PI; this.boardYaw += Math.PI; // the board was already posed this step
    this.edge = -this.edge; this.edgeTarget = -this.edgeTarget;
    this.lateralG = -this.lateralG; this.lean = -this.lean; this.crashSide = -this.crashSide;
    this.pressBalance = -this.pressBalance; this.pressDir = -this.pressDir; this.pbDrift = -this.pbDrift; this.pressLock = -this.pressLock; // FEAT-140
    if (this.discipline === 'board') this.switch = !this.switch;
  }

  reset(x: number, y: number, heading: number, seed = 1): void {
    this.x = x; this.y = y; this.z = this.pack.groundHeight(x, y) + 0.5;
    this.vx = this.vy = this.vz = 0;
    this.heading = heading; this.switch = false; this.onGround = true; this.airTime = 0; this.jumpCharge = 0;
    this.crashed = 0; this.crashFall = 0; this.spin = 0; this.skid = 0; this.distance = 0; this.maxSpeed = 0;
    this.edge = 0; this.edgeTarget = 0; this.leanTarget = 0; this.lean = 0; this.pressing = false; this.pressBalance = 0; this.pressDir = 0; this.pressLock = 0; this.turnRadius = Infinity; this.turnRate = 0; this.carveAcc = 0; this.lateralG = 0; this.landingShock = 0;
    this.hardCarve = 0; this.hardDrive = 0; this.carveShort = 0; this.washout = 0; this.crashSide = 0; this.catchRisk = 0;
    this.accum = 0; this.alpha = 1; this.steps = 0; this.coarseSteps = 0;
    this.onFoot = false; this.strapState = 'none'; this.strapT = 0; this.stamina = STAMINA; this.tired = false; this.mantle = 0; this.stepT = 0;
    this.sprinting = false; this.crawling = false; this.slipT = 0; this.exertion = 0; this.slideVx = this.slideVy = this.walkVx = this.walkVy = 0;
    this.chop = 0; this.noseSink = 0; this.chopT = 0;
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
      // FEAT-139: on foot the body is drawn along the heading, so a rider drawn turned round (switch,
      // or goofy) takes the heading the way they face; nearly stopped, so nothing else moves
      if (this.toeSign < 0) this.heading += Math.PI;
      this.switch = false;
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
      // FEAT-140: a lost press keeps the board flat until the press key is let go. In the air a press
      // key held (not the lean a jump charge's W / S sets) sets the board up to land into the press.
      const want = input.lean ?? 0;
      if (this.pressLock && Math.sign(want) !== this.pressLock) this.pressLock = 0;
      this.leanTarget = (this.onGround || !input.jumpHeld) && !this.pressLock ? want : 0;
      this.lean += (this.leanTarget - this.lean) * Math.min(1, STEP / LEAN_IN); // snaps back level in the air
      this.pressStep(STEP, input);
      this.step(STEP, input);
      this.steps++;
      if (this.pack.coarseFallbacks !== fb) this.onCoarse();
      this.accum -= STEP;
      input.jumpReleased = false; // consume the release edge
    }
    this.end[0] = this.x; this.end[1] = this.y; this.end[2] = this.z; this.end[3] = this.heading;
    this.alpha = this.accum / STEP;
  }

  /**
   * FEAT-140: balance a held nose or tail press. The needle drifts toward one end, faster the longer
   * the press is held, the faster the rider goes and the bumpier the snow, with a random push now and
   * then; off centre it runs away on its own. W / S (input.balance) push it back. Off the loaded end
   * the board catches (a crash, or a stall below PB_STALL); off the other end it drops flat.
   */
  private pressStep(dt: number, input: Input): void {
    const live = this.pressMode !== 'off' && this.discipline === 'board' && this.onGround && !this.unstrapped && this.crashed <= 0;
    const L = this.lean;
    if (!this.pressing) {
      // a press starts once the lean passes half way (not the lean a jump charge's W / S sets)
      if (!live || Math.abs(L) <= 0.5 || Math.sign(this.leanTarget) !== Math.sign(L) || input.jumpHeld) return;
      this.pressing = true; this.pressDir = Math.sign(L); this.pressBalance = 0; this.pressT = 0; this.pressDist = 0;
      this.pressFrom = this.steps - this.landStep < PB_LAND_WINDOW / STEP ? this.landTrick : '';
      // the step count too, so the first press after every restart does not drift the same way
      this.pbDrift = (this.rng.next() + this.steps * 0.618034) % 1 < 0.5 ? -1 : 1;
      this.pbPushT = this.pbGap(); this.pbPushLeft = 0;
      this.pbNoise = this.pbNoiseTo = 0; this.pbNoiseT = 0; this.pbBump = 0; this.pbVz = this.vz; this.pbCorr = 0;
      return;
    }
    if (this.crashed > 0) { this.endPress(null); return; } // crashed into something else
    if (!this.onGround && this.airTime < PB_AIR && this.crashed <= 0) return; // a short hop: the press rides through it
    if (!live || Math.abs(L) < 0.5 || Math.sign(L) !== this.pressDir) { this.endPress('clean'); return; } // let go, or left the snow
    const [e, u] = PB_LEVEL[this.pressMode === 'off' ? 'on' : this.pressMode], spd = this.speed;
    this.pressT += dt; this.pressDist += spd * dt;
    // bumps: vertical acceleration through the board, plus crud off the groomers at speed
    const az = Math.abs(this.vz - this.pbVz) / dt; this.pbVz = this.vz;
    const crud = PB_CRUD * (1 - this.surface.groomed) * Math.min(1, spd / 12);
    this.pbBump += (Math.min(1, az / PB_BUMP_ACC + crud) - this.pbBump) * Math.min(1, dt * 4);
    this.pbNoiseT -= dt;
    if (this.pbNoiseT <= 0) { this.pbNoiseT = 0.15; this.pbNoiseTo = this.rng.next() * 2 - 1; }
    this.pbNoise += (this.pbNoiseTo - this.pbNoise) * Math.min(1, dt * 8);
    // a random push now and then, and the drift may turn to the other end with it
    this.pbPushT -= dt;
    if (this.pbPushT <= 0) {
      this.pbPushT = this.pbGap(); this.pbPushLeft = PB_PUSH_T;
      this.pbPushV = (this.rng.next() < 0.5 ? -1 : 1) * PB_PUSH * e / PB_PUSH_T;
      if (this.rng.next() < 0.4) this.pbDrift = -this.pbDrift;
    }
    const push = this.pbPushLeft > 0 ? this.pbPushV : 0;
    this.pbPushLeft -= dt;
    const hold = 1 + PB_HOLD_MAX * (1 - Math.exp(-this.pressT / PB_HOLD_T));
    // FEAT-152: deep powder pulls a nose press on into the snow and steadies a tail press
    const pd = this.snow.powder * Math.min(1, this.snow.depth / 0.3);
    const steady = this.pressDir < 0 ? 1 - PB_POWDER_STEADY * pd : 1;
    const pull = this.pressDir > 0 ? PB_POWDER * e * pd * (1 - (1 - PB_POWDER_FAST) * Math.min(1, spd / PLANE_SPEED)) : 0;
    const drift = PB_DRIFT * e * hold * (1 + PB_SPEED * spd) * (1 + PB_BUMP_DRIFT * this.pbBump) * this.pbDrift * steady + pull;
    const jitter = PB_BUMP * e * this.pbBump * this.pbNoise * steady;
    const b = this.pressBalance;
    // the runaway grows with the time held too: a long press needs quicker, finer corrections, never more than W / S has
    const runaway = PB_UNSTABLE * u * hold * b * (this.pressDir < 0 ? 1 - PB_POWDER_CALM * pd : 1);
    // W / S shift the weight, which takes PB_SHIFT_T to build or let go: react late or overcorrect and it costs you
    this.pbCorr += (Math.max(-1, Math.min(1, input.balance ?? 0)) - this.pbCorr) * Math.min(1, dt / PB_SHIFT_T);
    const corr = this.pbCorr * Math.max(PB_CORRECT, PB_CORRECT_OVER * (Math.abs(drift) + Math.abs(jitter) + Math.abs(runaway)));
    this.pressBalance = b + (drift + runaway + jitter + push + corr) / PRESS_RANGE * dt;
    const over = this.pressBalance * this.pressDir;
    if (over >= 1) {
      // over-pressed: the loaded end catches; slow, the board just stops
      if (spd < PB_STALL) { this.vx *= 0.2; this.vy *= 0.2; this.speed *= 0.2; this.endPress('stall'); }
      else { this.crashed = 1.3; this.crashFall = this.pressDir; this.endPress('slam'); }
    } else if (over <= -1) this.endPress('flat'); // under-pressed: the board drops flat
  }

  private pbGap(): number { return PB_GAP[0] + this.rng.next() * (PB_GAP[1] - PB_GAP[0]); }

  /** FEAT-140: end the press (null: silently), keep the lean flat if it was lost, report it */
  private endPress(how: PressEnd | null): void {
    const dir = this.pressDir, t = this.pressT, d = this.pressDist;
    this.pressing = false; this.pressBalance = 0;
    if (how && how !== 'clean') { this.pressLock = dir; this.leanTarget = 0; }
    if (how && t >= PRESS_MIN_REPORT) this.onPress?.(how, dir, t, d, this.switch, this.pressFrom);
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
    this.surface.moguls = pack.mogulAmp?.(this.x, this.y) ?? 0; // FEAT-059 (test planes may lack the method)
    snowAt(this.surface, n, this.z, this.snowWorld, this.snow); // FEAT-053
    this.chop *= Math.exp(-dt * 6);
    if (this.strapState !== 'none') { this.strapStep(dt, ground); return; }
    if (this.onFoot) { this.walkStep(dt, input, n, ground); return; }
    if (this.crashed > 0) {
      this.crashed -= dt;
      if (this.crashed <= 0) { this.crashFall = 0; this.crashSide = 0; }
      this.hardCarve = this.hardDrive = this.carveShort = this.washout = 0;
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
      this.hardCarve = Math.max(0, this.hardCarve - dt / HARD_IN); this.hardDrive = 0; this.carveShort = 0; // FEAT-148
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

    // surface properties (FEAT-053: the snow state blends the day's conditions into the grip,
    // the drag, the turn shape and the jolts)
    const groomed = this.surface.groomed;
    const rock = this.surface.rock;
    const snow = this.snow;
    const powder = Math.min(1, snow.powder + 0.5 * snow.chop + 0.5 * snow.slush); // soft snow the board planes in, so the edge cap is lower
    const deepPow = snow.powder * Math.min(1, snow.depth / HARD_DEEP); // FEAT-148: only deep powder planes a hard carve
    const gripBase = (1.0 + GROOMED_BONUS * groomed - 0.5 * rock) * snow.grip * (1 + SQUAT_GRIP * this.squat) * (1 - PRESS_GRIP * Math.abs(this.lean)) // low centre of mass bites a little more; on a press you can't carve
      * (this.switch ? 1 - SWITCH_GRIP : 1); // FEAT-139: a touch weaker switch

    // ---- FEAT-148 hard carve: the squat key held while steering drives the edge in (eased over HARD_IN)
    const hardWant = !!input.squat && Math.abs(input.steer) > HARD_STEER && !input.brake && this.brakeAmt === 0 && !this.pressing && spd > HARD_MIN_SPEED;
    this.hardCarve = hardWant ? Math.min(1, this.hardCarve + dt / HARD_IN) : Math.max(0, this.hardCarve - dt / HARD_IN);
    const H = this.hardCarve;

    // ---- FEAT-127 edge and carve. Steer sets a target edge angle up to what can be held here; the
    // edge rolls toward it at F.roll, quicker through the flat while it changes sides (BUG-053), so
    // edge to edge takes about 0.3 s. A brake takes the edge over.
    const want = input.steer * this.edgeCap(input, F, powder, spd, deepPow) * (1 - this.brakeAmt);
    this.edgeTarget = want;
    const roll = this.rollRate(F, spd) * dt * (want * this.edge < 0 ? EDGE_SNAP : 1);
    this.edge += Math.max(-roll, Math.min(roll, (want - this.edge) * Math.min(1, dt * EDGE_EASE)));
    const psi = Math.abs(this.edge);
    // the board bent on edge carves an arc of R = Rsc cos(psi), and the rider balances it with
    // tan(phi) = v^2 / (g R), phi being the body's inclination (the edge less the angulation). Slow,
    // the sidecut's arc sets the turn; fast, the arc opens out to the radius the lean can hold.
    // Either way more edge is a tighter turn. The lean balances the edge's load, so on a slope the
    // pull of the fall line helps the turn into it (gIn > 0) and fights it climbing across (gIn < 0,
    // kept at GIN_FIGHT so the end of a turn across the hill is not its weakest part).
    // FEAT-148: a hard carve lets the body lean further (HARD_PHI)
    const phiMax = PHI_MAX + (HARD_PHI - PHI_MAX) * H;
    const gInRaw = (ax * lx + ay * ly) * Math.sign(this.edge);
    const gIn = gInRaw < 0 ? gInRaw * GIN_FIGHT : gInRaw;
    // FEAT-053: soft snow does not hold the sidecut's arc, so the turns come round wider and slower (snow.turn < 1)
    let aLat = this.balance(psi, spd, snow.turn, F, phiMax, n[2], gIn);
    // FEAT-148: the press asks for the turn of the target edge, driven in over HARD_DRIVE_T once the edge
    // is on the steer's side; the edge only holds the turn its real angle balances (aLat above), and the
    // snow no more than HARD_G g times its grip (gripBase is GROOMED_GRIP on groomed corduroy, plus the squat's bite).
    // Asking more than it holds slides the tail out (a skid); far more at speed, for long, washes out.
    let hardHold = 0;
    this.carveShort = 0;
    if (H > 0) {
      this.hardDrive = this.edge * want > 0 ? Math.min(1, this.hardDrive + dt / HARD_DRIVE_T) : 0;
      const psiAsk = psi + Math.max(0, Math.abs(want) - psi) * this.hardDrive;
      const aAsk = Math.min(HARD_G * G, this.balance(psiAsk, spd, snow.turn, F, phiMax, n[2], gIn));
      // the snow's grip scales what the edge holds as well as the ceiling: chop and ice let go sooner (1 on corduroy)
      hardHold = Math.min(aLat * Math.min(1, snow.grip), HARD_G * G * gripBase / (GROOMED_GRIP * (1 + SQUAT_GRIP * this.squat)));
      this.carveShort = H * Math.max(0, aAsk - hardHold) / G;
      aLat += (aAsk - aLat) * H;
      // the washout meter: deep powder lets the board plane instead (a deep surfy turn); tracked-out chop and ice do not
      const fast = Math.max(0, (spd - WASH_V0) / WASH_SPAN) * (1 - deepPow);
      const over = (aAsk > 0.5 ? H * Math.max(0, aAsk - hardHold) / aAsk : 0) - WASH_SHARE;
      this.washout = over > 0 && fast > 0 ? this.washout + over * fast * WASH_RATE * dt : Math.max(0, this.washout - WASH_DRAIN * dt);
      if (this.washout >= 1) {
        // the edge lets go: down on the inside of the turn, on the butt heelside or the hip toeside
        const side = Math.sign(this.edge) || 1;
        this.crashed = 1.3; this.crashSide = side; this.crashFall = 0;
        this.onWashout?.(side * this.toeSign);
        this.hardCarve = this.hardDrive = this.carveShort = this.washout = 0;
        this.edge *= 0.3; this.edgeTarget = 0;
        // the tumble starts sliding at once (as the crash branch does from the next step)
        this.x += this.vx * dt; this.y += this.vy * dt;
        this.z = this.groundAt(this.x, this.y, this.z); this.vz = 0;
        this.speed = Math.hypot(this.vx, this.vy);
        return;
      }
    } else { this.hardDrive = 0; this.washout = Math.max(0, this.washout - WASH_DRAIN * dt); }
    this.carveAcc = aLat;
    // more than the snow holds and the tail slides out: once the board slips past its line the
    // arc lets go of the heading, so the skid settles at a slip angle instead of spinning out
    let hold = 1;
    if (spd > 0.5 && psi > 0) {
      const ahead = wrap(this.heading - Math.atan2(this.vx, this.vy)) * Math.sign(this.edge);
      if (ahead > SLIP_HOLD && ahead < Math.PI / 2) hold = Math.max(0, 1 - (ahead - SLIP_HOLD) / SLIP_WASH);
    }
    const carveRate = spd > 0.1 ? Math.sign(this.edge) * (aLat / spd) * hold : 0;
    // how far the edge's grip is in (the flat base holds little sideways)
    const bite = Math.min(1, psi / GRIP_EDGE);
    // the fall line (FEAT-134): the slope's pull across the heading (+ = downhill is to the right)
    // and the yaw a flat or lightly edged board takes toward it, quicker on steep pitches and when
    // slow, not while the brake has the board swung
    const fall = Math.hypot(n[0], n[1]);
    const gLat = ax * lx + ay * ly;
    let fallRate = 0;
    if (this.fallLine > 0 && spd > 0.3 && psi < FALL_EDGE) {
      const toFall = wrap(Math.atan2(n[0], n[1]) - this.heading);
      const flat = (1 - psi / FALL_EDGE) ** 2 * (1 - this.brakeAmt) * this.fallLine;
      const vA = this.vx * hx + this.vy * hy;
      // the leading end: the nose riding forward, the tail sliding back before the switch turn-round
      const lead = Math.max(-1, Math.min(1, vA / FALL_LEAD_V));
      // pointed up the hill the leading end does not come round: the board slows, stops and slides
      // back tail first into switch; full across the hill, gone by about 135 deg from the fall line
      const down = Math.cos(toFall) * (Math.sign(vA) || 1);
      const climb = down >= 0 ? 1 : Math.max(0, 1 + down / FALL_CLIMB);
      // a flat board follows its slide: the leading end turns toward where the board is going, as
      // gravity bends the slide down the hill. Sliding straight sideways (a flat board let go across
      // the hill from a stand) it does not turn at all: it side-slips, and the downhill edge may catch
      fallRate = FALL_FOLLOW * ((this.vx * lx + this.vy * ly) / spd) * lead * climb * flat;
      // and the weight over the leading foot drops that end a little, less at speed
      if (fall > 0.03) fallRate += FALL_YAW * fall * Math.sin(toFall) * lead * climb * flat / (1 + spd / FALL_YAW_SPEED);
    }
    // slow or flat: a pivot (a skidded turn) straight from the steer, gone by F.pivotFade; from about
    // there on a small steer yaw (STEER_YAW) keeps the board coming round through an edge change.
    // Neither while the board is swung across for a brake: the steer works the brake then (FEAT-133).
    const steerFade = Math.max(0, Math.min(1, spd / F.pivotFade - 0.5));
    // FEAT-148: a hard carve turns on its edge alone (the steer yaw would pull it past the snow's hold)
    let pivotRate = input.steer * ((input.tuck ? F.pivotTuck : F.pivot) * Math.max(0, 1 - spd / F.pivotFade) + STEER_YAW * steerFade * (1 - H)) * (1 - this.brakeAmt);
    // standing on the uphill edge the hill is in the way, so at a crawl the pivot into it is cut: the
    // steer holds the edge instead of spinning the board (FEAT-134); pivoting downhill still runs.
    // Whole for Assisted too, which also needs the edge held to stand
    if (this.fallLine > 0 && spd < 1 && fall > 0.03 && input.steer * gLat < 0) pivotRate *= spd;
    const turnRate = carveRate + pivotRate + fallRate;
    // FEAT-053 chop: tracked-out snow rattles the board, a small random jolt to the heading and a
    // sideways kick every CHOP_GAP s or so, bigger with speed; from the seeded rng so replays match
    if (snow.jolt > 0.05 && spd > 2 && this.brakeAmt === 0) {
      this.chopT -= dt;
      if (this.chopT <= 0) {
        this.chopT = CHOP_GAP * (0.5 + this.rng.next());
        const amp = snow.jolt * Math.min(1, spd / CHOP_SPEED);
        const r1 = this.rng.next() * 2 - 1, r2 = this.rng.next() * 2 - 1;
        this.heading += CHOP_YAW * amp * r1;
        this.vx += lx * CHOP_KICK * amp * r2; this.vy += ly * CHOP_KICK * amp * r2;
        this.chop = Math.min(1, this.chop + amp * (0.4 + 0.6 * Math.abs(r1)));
      }
    } else this.chopT = 0;
    this.turnRate = turnRate;
    this.turnRadius = Math.abs(turnRate) > 1e-3 ? spd / Math.abs(turnRate) : Infinity;
    const dHeading = turnRate * dt;
    this.heading += dHeading;

    // brake: swing the board across the direction of travel (a hockey stop). Steer picks the
    // side (right = the heading's right-hand edge: toeside riding regular, heelside switch or goofy);
    // otherwise the edge already engaged, else heelside (FEAT-139: whichever side the heel is on).
    // brakeSide +1 rotates the board clockwise from the travel direction, which leaves the left-hand
    // edge leading and the right-hand edge trailing (the uphill edge, cutting the snow); -1 the reverse.
    if (spd > 0.5) this.travelYaw = Math.atan2(this.vx, this.vy);
    else this.travelYaw += dHeading; // stopped: steering turns the board where it stands
    if (input.brake) {
      if (this.brakeSide === 0) {
        this.brakeSide = input.steer > 0.1 ? 1 : input.steer < -0.1 ? -1 : this.edgeAngle * this.toeSign > 0.3 ? this.toeSign : -this.toeSign;
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
    // over from it (FEAT-133). With the fall line on (FEAT-134) the flat base holds only a waxed
    // base's friction, so across a slope the board side-slips until an edge is in; a full edge
    // holds the same as before, the edge making up what the base lost.
    const gripFlat = F.gripFlat - (F.gripFlat - GRIP_FLAT_REAL) * this.fallLine;
    let maxLat = G * gripBase * (gripFlat + (F.gripFlat + F.gripEdge - gripFlat) * bite);
    // FEAT-148: a hard carve holds what its edge balances (up to HARD_G), never less than the flat base
    if (H > 0) maxLat += (Math.max(G * gripBase * gripFlat, hardHold * HARD_SLACK) - maxLat) * H;
    // wanted: kill lateral velocity (carve) within a short time
    let latAcc = -vLat / Math.max(0.04, 0.12 - 0.08 * bite);
    const skidding = Math.abs(latAcc) > maxLat;
    if (skidding) latAcc = Math.sign(latAcc) * maxLat;
    latAcc *= 1 - swing;
    this.skid += (Math.max(skidding ? Math.min(1, Math.abs(vLat) / 6) : 0, Math.min(1, this.carveShort / HARD_SKID)) - this.skid) * Math.min(1, dt * 10);
    // the edge catch (FEAT-134, realistic only): the board sliding sideways toward an edge that meets
    // the snow. The snow stops that edge and the rider goes over it, the way the board was sliding
    // (crashSide, so the ragdoll falls that way). A carve never slides sideways enough to qualify
    this.catchRisk = 0;
    if (this.fallLine >= 1 && this.crashed <= 0 && this.brakeAmt === 0 && spd > 0.5) {
      const slipA = Math.asin(Math.min(1, Math.abs(vLat) / spd));
      const exposed = Math.min(1, Math.max(0, (Math.abs(vLat) - CATCH_DRIFT) / CATCH_DRIFT_SPAN)) * Math.min(1, Math.max(0, (slipA - CATCH_SLIP) / CATCH_SLIP_SPAN));
      if (exposed > 0) {
        const lead = this.edge * Math.sign(vLat); // + the leading edge is in, - the trailing edge
        const dig = Math.min(1, Math.max(0, lead / CATCH_EDGE));
        const bare = (1 - dig) * (1 - Math.min(1, Math.max(0, -lead / CATCH_GUARD)));
        const rough = CATCH_ROUGH + snow.jolt + Math.min(1, this.surface.moguls / 0.4);
        this.catchRisk = (CATCH_DIG * dig + CATCH_FLAT * bare * rough) * exposed;
        if (this.rng.next() < this.catchRisk * dt) { this.crashed = 1.3; this.crashSide = Math.sign(vLat); this.crashFall = 0; this.lastHit = 'catch'; }
      }
    }
    ax += latAcc * lx; ay += latAcc * ly;
    this.lateralG += ((latAcc / G) - this.lateralG) * Math.min(1, dt * 12);

    // drag: aerodynamic + snow. Tuck lowers aero, skidding scrubs speed (less on ice). FEAT-053: the
    // snow state sets the constant and speed-scaled drag by condition; powder adds speed-scaled drag
    // until the board planes at PLANE_SPEED (float), and slow in powder the nose sinks and digs in
    const aeroK = input.tuck ? F.aeroTuck : F.aero + (F.aeroTuck - F.aero) * SQUAT_AERO * this.squat; // a squat is part way to a tuck
    const deep = Math.min(1, snow.depth / 0.3);
    // FEAT-152: in deep powder a lean forward digs the nose in and a lean back lifts it out
    const pd = snow.powder * deep, fwd = Math.max(0, this.lean), back = Math.max(0, -this.lean);
    const pressDrag = PRESS_DRAG * Math.abs(this.lean) * spd * (1 + PD_NOSE_DRAG * pd * fwd - PD_TAIL_EASE * pd * back);
    const aero = aeroK * spd * spd * (this.boost ? 0.55 : 1) + pressDrag; // FEAT-112: the loaded end digs in
    const sinkSpeed = SINK_SPEED * (1 + SINK_NOSE_SPEED * fwd - SINK_TAIL * back);
    const sinkNow = Math.min(1, pd * Math.max(0, 1 - spd / sinkSpeed) * (1 + SINK_NOSE * fwd - SINK_TAIL * back));
    this.noseSink += (sinkNow - this.noseSink) * Math.min(1, dt * 6);
    const snowDrag = snow.drag0 + snow.drag1 * spd
      + snow.powder * POWDER_DRAG * Math.min(spd, PLANE_SPEED) * (0.6 + 0.6 * deep) + sinkNow * SINK_DRAG * G
      + 0.35 * this.skid * G * snow.skidScrub * (1 + H) // FEAT-148: a hard carve's deep edge scrubs twice as hard
      + HARD_DRAG * H * Math.abs(latAcc); // FEAT-148: the deep edge plows snow
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
    // Turning the board toward the fall line or tucking lets it run again. With the fall line
    // realistic (FEAT-134) the edge has to be held, by steering into the hill or by the brake; let
    // go and the board starts to slide. The edge needed scales with the setting: Assisted needs half
    // of STAND_EDGE, and Off stands with no input as before.
    if (spd < 0.3 && !input.tuck && fall > 0.03 && this.slopeDeg < 55) {
      const across = Math.abs(Math.sin(this.boardYaw - Math.atan2(n[0], n[1])));
      const held = this.fallLine <= 0 || -Math.sign(gLat) * this.edge > STAND_EDGE * this.fallLine || this.brakeAmt > 0.5;
      if (across > 0.75 && held) { this.vx = this.vy = 0; ax = ay = 0; }
    }
    // FEAT-139: going backwards along the heading, the steering axis turns round to the direction of
    // travel and the rider is riding switch (or back to the normal stance): drawn the same, tail leading
    if (F.fakie && vAlong < -FAKIE_SPEED && this.brakeAmt === 0) this.turnRound();
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
      if (this.pressing) this.endPress('clean'); // FEAT-140: popped out of a press (W / S flip again at once)
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
    // FEAT-059: the 1.5 m/s margin absorbs 1 m DEM noise on open snow, but it also swallows every mogul
    // (a 0.7 m bump at 20 m/s drops away at about 10 g). On a bump field the legs absorb only about 2 g.
    const lift = 1.5 - 1.3 * Math.min(1, this.surface.moguls / 0.4);
    if (ballistic > vzSurf + lift && spd > 6) {
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
    this.sink = bootSink(this.snow);
    this.squareBoard();
    this.strapT += dt;
    if (this.strapState === 'off' && this.strapT >= UNSTRAP_TIME) {
      this.strapState = 'none'; this.onFoot = true; this.strapT = 0;
      this.stamina = STAMINA; this.tired = false;
      this.walkVx = this.vx; this.walkVy = this.vy; this.slideVx = this.slideVy = 0;
    } else if (this.strapState === 'on' && this.strapT >= STRAP_TIME) {
      this.strapState = 'none'; this.onFoot = false; this.strapT = 0;
      this.vx = this.vy = 0; this.speed = 0;
      // FEAT-139: strapped in the normal stance; goofy is drawn turned round, so the heading turns
      // round under it and the rider on screen stays put
      this.switch = false;
      if (this.toeSign < 0) { this.heading += Math.PI; this.squareBoard(); }
    }
  }

  /**
   * On foot (FEAT-067). Steer turns, tuck walks forward, brake walks backward slowly, grab (Shift)
   * sprints for a few seconds of stamina, jump hops. Speed falls with the uphill grade and with how
   * far the boots sink; slopes over CLIMB_MAX cannot be climbed (you slide back), and past
   * SLIP_SLOPE you slip down whatever you do. Same colliders as riding.
   */
  private walkStep(dt: number, input: Input, n: [number, number, number], ground: number): void {
    this.sink = bootSink(this.snow);
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
   * BUG-056: where the edge will be `lead` seconds from now if the steer holds: the step's own ease
   * and roll-rate rule integrated forward in 20 ms substeps, so the prediction moves at the physics
   * roll rate and is continuous through the edge change (a closed form with the quicker through-flat
   * limit jumped when the edge crossed zero). Visual only (the rider view's body lead).
   */
  predictEdge(lead: number): number {
    if (lead <= 0) return this.edge;
    const F = FEEL[this.discipline], want = this.edgeTarget, n = Math.ceil(lead / 0.02), h = lead / n;
    let e = this.edge;
    const rate = this.rollRate(F, Math.hypot(this.vx, this.vy));
    for (let i = 0; i < n; i++) {
      const roll = rate * h * (want * e < 0 ? EDGE_SNAP : 1);
      e += Math.max(-roll, Math.min(roll, (want - e) * Math.min(1, h * EDGE_EASE)));
    }
    return e;
  }

  /**
   * BUG-056: the inclination (rad, + toward the toe edge) that balances the edge `lead` seconds from
   * now at the current speed: the carve model's arc, R = Rsc cos(psi), opened out to what the lean
   * can hold, with no slope or skid terms. Visual only (the rider view's crossover).
   */
  predictIncline(lead: number): number {
    const e = this.predictEdge(lead), psi = Math.abs(e), F = FEEL[this.discipline];
    const spd = Math.hypot(this.vx, this.vy);
    const phi = Math.min(PHI_MAX + (HARD_PHI - PHI_MAX) * this.hardCarve, psi * (1 - F.angulation));
    const aLat = Math.min((spd * spd) / (F.sidecut * Math.cos(psi)), G * this.normal[2] * Math.tan(phi));
    return Math.sign(e) * Math.atan(aLat / G);
  }

  /**
   * FEAT-127: the lateral acceleration (m/s^2) a board on edge angle p carves: the sidecut's arc,
   * R = Rsc cos(p), opened out to what the lean (capped at phiMax) balances, scaled by the snow's turn
   * factor, plus the fall line's pull into the turn (gIn); nz is the ground normal's up component.
   */
  private balance(p: number, spd: number, turn: number, F: Feel, phiMax: number, nz: number, gIn: number): number {
    return Math.min((spd * spd * turn) / (F.sidecut * Math.cos(p)), Math.max(0, G * nz * Math.tan(Math.min(phiMax, p * (1 - F.angulation))) * turn + gIn));
  }

  /** FEAT-148: how fast the edge rolls (rad/s): HARD_ROLL times quicker in a hard carve, slowing past HARD_ROLL_V m/s */
  private rollRate(F: Feel, spd: number): number {
    const H = this.hardCarve;
    if (H <= 0) return F.roll;
    const slow = Math.min(1, HARD_ROLL_V / Math.max(1, spd));
    return F.roll * (1 + (HARD_ROLL * Math.max(HARD_ROLL_MIN, slow * slow) - 1) * H);
  }

  /** BUG-056: where the press lean will be `lead` seconds from now if the input holds (visual only). */
  predictLean(lead: number): number {
    return lead <= 0 ? this.lean : this.lean + (this.leanTarget - this.lean) * Math.min(1, lead / LEAN_IN);
  }

  /**
   * FEAT-127: the highest edge angle the rider can hold here (rad). Lower in powder (the board
   * planes), cut by a tuck and a press, raised a little by a squat. Rock and ice take a full edge
   * but hold little (the grip limit), so a hard carve there washes out. Slow, there is little turn
   * force to lean against, so past what the knees and hips angulate a high edge would tip the
   * rider into the hill: the cap is that plus the lean the sidecut's arc needs.
   */
  private edgeCap(input: Input, F: Feel, powder: number, spd: number, deepPow = powder): number {
    let cap = F.psiMax - (F.psiMax - F.psiPowder) * Math.min(1, powder);
    if (input.tuck) cap *= TUCK_EDGE;
    cap = (cap + SQUAT_EDGE * this.squat) * (1 - PRESS_EDGE * Math.abs(this.lean));
    // FEAT-148: a hard carve drives the edge to HARD_PSI (less in deep powder, where the board planes)
    const hardCap = HARD_PSI - (F.psiMax - F.psiPowder) * Math.min(1, deepPow);
    cap += Math.max(0, hardCap - cap) * this.hardCarve;
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
    // FEAT-139: a spin on its own is a trick too, and either is "Switch ..." taken off riding switch
    // (the stance cannot change in the air, so it is still the takeoff's here)
    if (this.crashed <= 0) {
      const name = flipped > 0 ? trickName(this.flip, this.spin, flipped) : clean && this.discipline === 'board' ? spinName(this.spin, this.toeSign) : '';
      if (name) this.onTrick?.(switchName(name, this.switch));
      this.landTrick = name ? switchName(name, this.switch) : ''; this.landStep = this.steps; // FEAT-140: landed into a press
    }
    // FEAT-139: landed with the board backwards (a 180, a 540): ride away switch, tail leading
    if (this.discipline === 'board' && spd > 0.5 && this.vx * hx + this.vy * hy < 0) this.turnRound();
    if (!clean) this.heading = Math.atan2(this.vx, this.vy); // the board snaps to the direction of travel (the nearer end leading)
    this.spin = 0; this.flip = 0; this.flipRate = 0;
    this.airTime = 0;
  }
}
