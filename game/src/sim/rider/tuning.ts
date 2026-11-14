/**
 * FEAT-165: the rider physics and feel constants, in one place so tuning touches data, not logic.
 * Moved from sim/Rider.ts as they were (names, values and notes); the rider modules import them.
 */
import type { Discipline, PressMode } from './types';

// ---- units and the fixed step
export const G = 9.81;
export const STEP = 1 / 120;
export const D2R = Math.PI / 180;

// ---- brake (FEAT-065, FEAT-133)
/** board angle to the direction of travel in a full hockey stop */
export const STOP_GAMMA = 84 * D2R;
/** FEAT-133: steering while braking opens the swing out to GAMMA_SOFT and lets the edge off to
 *  PSI_SOFT (a skidded turn, steer away from the edge), or squares it up to GAMMA_HARD and tips it
 *  PSI_DIG further than a plain brake's cut (steer into the edge); eased over BRAKE_MOD_IN s */
export const GAMMA_SOFT = 40 * D2R, GAMMA_HARD = 90 * D2R, PSI_SOFT = 25 * D2R, PSI_DIG = 12 * D2R, BRAKE_MOD_IN = 0.2;
/** FEAT-133: how fast the steering axis follows the direction of travel while the board is swung (1/s) */
export const HEAD_FOLLOW = 10;
/** FEAT-133: the dug-in edge drags along its own length with up to this share of the cut's hold,
 *  settling the slide along the board over BRAKE_TRENCH_T s */
export const BRAKE_TRENCH = 0.35, BRAKE_TRENCH_T = 0.12;
/** seconds to swing the board across, and back on release */
export const SWING_IN = 0.25, SWING_OUT = 0.3;
/** hard cap on braking deceleration from the snow cut (m/s^2): the paper's 60 degree edge case */
export const BRAKE_MAX = 14;
/** below this speed (m/s) a released brake leaves the board across the hill (a standing stop) */
export const PARK_SPEED = 1;
/** skis below this speed at brake start snowplough instead of turning across */
export const PLOUGH_SPEED = 5;

// ---- on foot (FEAT-067, FEAT-068, BUG-045)
/** FEAT-067 on foot: seconds to unstrap and to strap back in */
export const UNSTRAP_TIME = 0.8, STRAP_TIME = 1.0;
/** fastest the rider can be going to unstrap (m/s), and to strap in (standing still) */
export const UNSTRAP_SPEED = 1.5, STRAP_SPEED = 0.3;
/** BUG-045 on foot: ledges up to STEP_UP are stepped onto by walking into them (eased over STEP_TIME);
 *  up to CLIMB_UP a jump climbs (mantles) onto them over MANTLE_TIME, probing MANTLE_PROBE ahead;
 *  taller stays a wall (m, s) */
export const STEP_UP = 0.45, STEP_TIME = 0.25, CLIMB_UP = 1.4, MANTLE_TIME = 0.9, MANTLE_PROBE = 0.7;
/** on-foot speeds on groomed snow (m/s): walk, sprint, a tired sprint (a run), walking backwards */
export const WALK = 1.4, SPRINT = 3.8, JOG = 2.4, BACK = 0.6;
/** seconds of sprint, and how much has to come back before sprinting again after running out */
export const STAMINA = 4;
export const STAMINA_RESUME = 1.5;
/**
 * Slopes on foot are judged at body scale (FEAT-068): the rise over BODY_L metres, so a short steep
 * face on a small lump does not stop you. Steeper than CLIMB_MAX (degrees) you scramble on all fours
 * at CRAWL m/s; steeper than CRAWL_MAX you cannot get up and slip back, and standing on more than
 * CRAWL_MAX you slip whatever you do.
 */
export const CLIMB_MAX = 35, CRAWL_MAX = 45, CRAWL = 0.6, BODY_L = 2.5;
/**
 * BUG-112: the uphill slowdowns on foot must not stack to a standstill. The scramble slows toward
 * CRAWL_MAX down to CRAWL_FLOOR of CRAWL; sprint (Shift) scrambles CRAWL_SPRINT times faster and
 * drains stamina. Boot sink slows walking by SINK_SLOW per metre of sink, to at least SINK_FLOOR of
 * the pace, and the scramble by CRAWL_SINK of that. Pushing up a climbable slope never goes slower
 * than CLIMB_MIN_PACE m/s (times CRAWL_SPRINT when sprinting).
 */
export const CRAWL_FLOOR = 0.6, CRAWL_SPRINT = 1.5, SINK_SLOW = 2.2, SINK_FLOOR = 0.4, CRAWL_SINK = 0.5, CLIMB_MIN_PACE = 0.4;

// ---- snow conditions: powder, presses in powder, chop (FEAT-053, FEAT-152)
/** FEAT-053 powder: speed (m/s) by which the board planes and the speed-scaled drag stops growing,
 *  the drag per m/s before that (per unit powder), and the nose-sink drag (g) at a standstill that
 *  is gone by SINK_SPEED m/s */
export const PLANE_SPEED = 12; export const POWDER_DRAG = 0.012, SINK_DRAG = 0.08, SINK_SPEED = 6;
/** FEAT-159: riding through brush (surface.shrub 1): this drag (m/s^2) plus SHRUB_DRAG_V per m/s; 2.5 m/s^2 at 15 m/s, so a willow clump costs a few tenths of a m/s */
export const SHRUB_DRAG = 1.0, SHRUB_DRAG_V = 0.1;
/** FEAT-152 presses in deep powder (scaled by powder x depth): weight forward digs the nose in (up to
 *  SINK_NOSE times the nose dig, and on to SINK_NOSE_SPEED times the speed), weight back lifts it out
 *  (SINK_TAIL of the dig gone, the speed it lasts to cut by the same share); the press's own drag is
 *  PD_NOSE_DRAG times more on a nose press and PD_TAIL_EASE (all) of it gone on a tail press (the way powder is ridden) */
export const SINK_NOSE = 0.6, SINK_NOSE_SPEED = 0.6, SINK_TAIL = 0.75, PD_NOSE_DRAG = 1.5, PD_TAIL_EASE = 1;
/** FEAT-053 chop: a jolt every CHOP_GAP s (random, about), kicking the heading up to CHOP_YAW rad and
 *  the board sideways up to CHOP_KICK m/s at full chop and speed, smaller at low speed (gone by CHOP_SPEED) */
export const CHOP_GAP = 0.2, CHOP_YAW = 0.035, CHOP_KICK = 0.3, CHOP_SPEED = 12;

// ---- edge and carve (FEAT-127, BUG-053), the fall line and edge catch (FEAT-134), the hard carve (FEAT-148)
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
export interface Feel {
  pivot: number; pivotTuck: number; pivotFade: number;
  sidecut: number; psiMax: number; psiPowder: number; roll: number; angulation: number;
  gripFlat: number; gripEdge: number;
  brake: number; fakie: boolean; aero: number; aeroTuck: number;
}
export const FEEL: Record<Discipline, Feel> = {
  board: { pivot: 1.9, pivotTuck: 0.9, pivotFade: 9, sidecut: 7.8, psiMax: 72 * D2R, psiPowder: 45 * D2R, roll: 400 * D2R, angulation: 0.12, gripFlat: 0.55, gripEdge: 0.9, brake: 0.45, fakie: true, aero: 0.0055, aeroTuck: 0.0025 },
  ski: { pivot: 2.4, pivotTuck: 1.1, pivotFade: 8, sidecut: 13, psiMax: 68 * D2R, psiPowder: 42 * D2R, roll: 460 * D2R, angulation: 0.08, gripFlat: 0.65, gripEdge: 0.75, brake: 0.6, fakie: false, aero: 0.005, aeroTuck: 0.0021 },
};
/** FEAT-127: `edgeAngle` is the edge as a share of this (1 = 60 degrees) for sound, poses and the ghost format */
export const EDGE_FULL = 60 * D2R;
/** edge angle (rad) at which the edge's grip is fully in; the flat base holds little sideways */
export const GRIP_EDGE = 40 * D2R;
/** most the body inclines (rad): past it the rider can't lean further whatever the edge */
export const PHI_MAX = 68 * D2R;
/** at a crawl the body can't lean against a turn, so only this much edge (rad) comes from angulation alone */
export const ANG_SLOW = 25 * D2R;
/** a tuck keeps this share of the top edge; a full squat adds SQUAT_EDGE (rad); a full press loses PRESS_EDGE of it */
export const TUCK_EDGE = 0.85, SQUAT_EDGE = 5 * D2R, PRESS_EDGE = 0.4;
/** the edge eases into its target over the last part of the roll (1/s) */
export const EDGE_EASE = 30;
/** BUG-053: the roll is this much quicker while the edge crosses to the other side (unweighting
 *  between turns), so a full edge change at speed takes about 0.3 s */
export const EDGE_SNAP = 1.5;
/** BUG-053: yaw rate (rad/s) a full steer adds at speed whatever the edge is doing, faded in as the
 *  pivot fades out, so the board starts coming round through the flat crossover instead of hanging
 *  until the new edge bites. A game feel term, not physics. */
export const STEER_YAW = 0.25;
/** BUG-053: share of the fall line's pull kept when it fights the turn (climbing out across the
 *  hill); in full when it helps (turning down into it) */
export const GIN_FIGHT = 0.5;
/** FEAT-134 the fall line, all scaled by `fallLine` (1 realistic, 0.5 assisted, 0 off = rails as before).
 *  A flat base holds only GRIP_FLAT_REAL g sideways (a waxed base on snow), so across a slope it
 *  side-slips unless an edge is in. A flat board follows its slide down the hill (FALL_FOLLOW) and the
 *  weight on the leading foot drops that end at up to FALL_YAW x sin(slope) rad/s, gone by FALL_EDGE
 *  of edge and halved by FALL_YAW_SPEED m/s. Standing on a slope needs STAND_EDGE x fallLine of uphill edge or the brake.
 *  The edge catch (realistic only): see CATCH_* below. */
export const GRIP_FLAT_REAL = 0.12, FALL_YAW = 2, FALL_YAW_SPEED = 15, FALL_EDGE = 12 * D2R, STAND_EDGE = 10 * D2R;
/** the weathervane swings the leading end: full nose (or tail) once moving FALL_LEAD_V m/s along the board,
 *  nothing sliding straight sideways; climbing, it fades out from across the hill and is gone at
 *  cos(angle from the fall line) = -FALL_CLIMB (about 135 deg), so a climb falls back into switch */
export const FALL_LEAD_V = 1.5, FALL_CLIMB = 0.7;
/** a flat board follows its slide at up to FALL_FOLLOW rad/s times the sine of its slip angle (the
 *  main swing: gravity bends the slide down the hill and the board follows it); FALL_YAW is only the
 *  leading foot's weight dropping that end */
export const FALL_FOLLOW = 2;
/** FEAT-134 the edge catch (realistic only): the board sliding sideways toward an edge that meets the snow.
 *  The leading edge (on the side the board slides toward: the downhill edge in a side-slip, the outside
 *  edge in a skid) dug in past CATCH_EDGE catches at up to CATCH_DIG per second; a flat base, at up to
 *  CATCH_FLAT per second times the roughness (CATCH_ROUGH on a groomer, plus chop jolts and moguls); a
 *  trailing edge of CATCH_GUARD or more keeps it off the snow. Both times the drift (none under
 *  CATCH_DRIFT m/s sideways, full CATCH_DRIFT_SPAN past it) and the slip (none under CATCH_SLIP off the
 *  board, full CATCH_SLIP_SPAN past it), so a carve, even a skidded carve transition, never qualifies.
 *  Seeded, so runs replay. */
export const CATCH_EDGE = 15 * D2R, CATCH_GUARD = 6 * D2R, CATCH_DIG = 25, CATCH_FLAT = 1.5, CATCH_ROUGH = 0.15;
export const CATCH_DRIFT = 1, CATCH_DRIFT_SPAN = 2, CATCH_SLIP = 20 * D2R, CATCH_SLIP_SPAN = 20 * D2R;
/** the board's slip past its line (rad) before the carve lets go: from SLIP_HOLD on, the arc stops
 *  driving the heading, gone by SLIP_HOLD + SLIP_WASH (a skid that settles, not a spin) */
export const SLIP_HOLD = 4 * D2R, SLIP_WASH = 30 * D2R;
/**
 * FEAT-148 hard carve (the squat key held while steering on the snow): eased in over HARD_IN s. The
 * edge cap goes up to HARD_PSI and the edge rolls HARD_ROLL times as fast, slowing with the square
 * of the speed past HARD_ROLL_V m/s (driving a deep edge in against the load takes longer at speed),
 * never below HARD_ROLL_MIN of that. The body may lean to HARD_PHI and the snow holds up to HARD_G g
 * on groomed corduroy, scaled by the snow's grip: the edge bites and whips the rider round.
 */
export const HARD_IN = 0.12, HARD_PSI = 80 * D2R, HARD_ROLL = 1.5, HARD_ROLL_V = 10, HARD_ROLL_MIN = 0.45, HARD_PHI = 69 * D2R, HARD_G = 2.6;
/**
 * FEAT-148: the press drives the turn in over HARD_DRIVE_T s from when the edge is on the steer's side
 * (it asks for the turn of the target edge, not the edge the board has got to). The edge holds
 * g tan(lean) of its real angle, so an edge that lags (pressed at speed from flat, on ice) cannot hold
 * the turn asked of it: the tail slides out. Short of it by more than WASH_SHARE of the turn asked (a
 * share, so softer snow that asks less washes out alike) fills a washout meter at WASH_RATE per s per
 * share past it, times the speed past WASH_V0 over WASH_SPAN m/s (1 at 20 m/s, more beyond); full, the
 * edge lets go and the rider goes down on the inside of the turn. It drains at WASH_DRAIN per s.
 */
export const HARD_DRIVE_T = 0.15, WASH_SHARE = 0.35, WASH_V0 = 8, WASH_SPAN = 12, WASH_RATE = 38, WASH_DRAIN = 3;
/** extra sideways grip on groomed corduroy (gripBase is GROOMED_GRIP there): HARD_G is in g on corduroy */
export const GROOMED_BONUS = 0.4, GROOMED_GRIP = 1 + GROOMED_BONUS;
/** FEAT-148: a committed edge holds this much over the turn it balances, so it bites clean instead of riding the grip limit */
export const HARD_SLACK = 1.2;
/** FEAT-148: a hard carve's deep edge plows snow: a drag of HARD_DRAG times the lateral acceleration */
export const HARD_DRAG = 0.06;
/** FEAT-148: forced past its hold the edge scrapes and chatters: a full skid (spray, sound, scrub) at HARD_SKID g short */
export const HARD_SKID = 1.2;
/** FEAT-148: powder this deep (m) planes the board fully in a hard carve: the edge cap drops toward the
 *  powder cap and the washout stops, a deep surfy turn. Shallower powder, chop and slush do not (BUG-066 follow-up) */
export const HARD_DEEP = 0.3;
/** FEAT-148: steer under this does not start a hard carve, and below HARD_MIN_SPEED m/s it is just a squat pivot */
export const HARD_STEER = 0.3, HARD_MIN_SPEED = 3;

// ---- squat (FEAT-111) and flips (FEAT-110)
/** FEAT-111 deep squat: ease time (s), extra grip, share of the tuck's drag cut, jump bonus and its window after letting go (s) */
export const SQUAT_IN = 0.25;
export const SQUAT_GRIP = 0.08;
export const SQUAT_AERO = 0.3;
export const SQUAT_POP = 1.15;
/** Pop speed (m/s) off flat snow: base + charge x jump charge (0 .. 1), before the squat and ollie
 *  multipliers. Arcade (BUG-055) is the old pop: a 0.1 s tap 0.57 m, a full charge 2.5 m. FEAT-311 Real:
 *  a full charge peaks at the old tap's 0.57 m, a tap at about 0.2 m (tools/jumpcheck.mjs). Lips, rollers and
 *  kickers still send you from speed, not this. */
export const JUMP_POP = { arcade: { base: 2.5, charge: 4.5 }, real: { base: 1.6, charge: 1.62 } } as const;
export type JumpMode = keyof typeof JUMP_POP;
export const SQUAT_SPRING_WINDOW = 0.25;
/** FEAT-110 flips: full-input pitch rate (1.1 rotations a second), how fast it builds and decays (1/s),
 * and the landing windows (rad): within FLIP_CLEAN of upright is clean, up to FLIP_CRASH a wobble, past it a crash */
export const FLIP_RATE = 1.1 * Math.PI * 2;
export const FLIP_EASE = 6, FLIP_DECAY = 4;
export const FLIP_CLEAN = 35 * Math.PI / 180, FLIP_CRASH = 60 * Math.PI / 180;

// ---- switch (FEAT-139), skating (FEAT-085), the press lean (FEAT-112)
/** FEAT-139: riding backwards faster than this (m/s) the steering axis turns round and the stance
 *  toggles to switch (or back); was 4 m/s when it spun the drawn rider round, which is now invisible */
export const FAKIE_SPEED = 2.5;
/** FEAT-139: share of the sideways grip lost riding switch (most riders are weaker switch); 0 turns it off */
export const SWITCH_GRIP = 0.04;

/** FEAT-085 skating: mean push (m/s^2) from a standstill, top skating speed (m/s), steepest slope it works on (deg), stroke period (s) */
export const SKATE_ACC = 4.2, SKATE_MAX = 5.5, SKATE_SLOPE = 10, SKATE_PERIOD = 0.6;

/** FEAT-112 lean: ease time (s), grip lost and drag added (per m/s) on a full press, pop multiplier for an
 * ollie / nollie (|lean| > 0.5 at release), and the pitch rate it leaves (rad/s per unit lean) */
export const LEAN_IN = 0.2, PRESS_GRIP = 0.35, PRESS_DRAG = 0.05, OLLIE_POP = 1.3, OLLIE_PITCH = 1.2;

// ---- leaving the snow off lips and side hits (FEAT-277)
/** the margin (m/s per step) by which the ground has to drop away faster than you fall before you leave
 *  it: TAKEOFF_LIFT on open snow, so 1 m elevation-model noise doesn't launch you; LIP_LIFT (about 1 g
 *  the legs soak up) where the snow bends over sharply along the line of travel */
export const TAKEOFF_LIFT = 1.5, LIP_LIFT = 0.1;
/** the bend is the slope behind minus the slope ahead (rise over run, each a fit to LIP_SAMPLES heights out
 *  to LIP_SPAN m): from LIP_BEND0 it starts to count as a lip, from LIP_BEND1 fully (0.2 is about an 11
 *  degree kink; a 15 degree side hit onto the flat is about 0.25). 10 cm of 1 m elevation noise reads
 *  as about 0.05 */
export const LIP_SPAN = 3, LIP_SAMPLES = 3, LIP_BEND0 = 0.1, LIP_BEND1 = 0.2;
/** a lip only counts when you leave it climbing: vertical speed at least this share of the speed (about 6 degrees up) */
export const LIP_RISE = 0.1;
/** leaving the snow with the board pre-loaded springs you up this much more (m/s): a full jump charge
 *  held through the lip, or LIP_FLEX of it on a full press (|lean| from 0.5 to 1). Bending the board in
 *  the early part of an ollie; small next to the ramp, and no pop without it */
export const LIP_PRELOAD = 0.8, LIP_FLEX = 0.6;

// ---- press balance (FEAT-140, FEAT-152)
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
export const PB_DRIFT = 0.2, PB_HOLD_MAX = 1.6, PB_HOLD_T = 4.6, PB_SPEED = 0.04, PB_UNSTABLE = 1.0, PB_BUMP = 2.4, PB_PUSH = 0.35, PB_CORRECT = 1.5, PB_STALL = 3;
export const PB_GAP = [0.8, 2.2] as const, PB_PUSH_T = 0.15;
/** FEAT-140: full W / S is at least this many times the drift, the bump jitter and the runaway together (fast, bumpy, long presses), so it can always win */
export const PB_CORRECT_OVER = 1.4;
/** FEAT-140: the weight shift W / S make builds and lets go over this long (s) */
export const PB_SHIFT_T = 0.15;
/**
 * FEAT-140: how far the balance can run before it is lost, in the units the rates above are in
 * (was 1). pressBalance stays a share of it (-1 .. 1) for the meter; the body leans in proportion,
 * so at the edge it leans this many times as far as at 1. The runaway grows with the share, not the
 * distance, so a press stays saveable out to the edge.
 */
export const PRESS_RANGE = 1.6;
/** FEAT-140 difficulty (Settings > Game > Press balance): drift, jitter and push scaled by the first, the runaway by the second */
export const PB_LEVEL: Record<Exclude<PressMode, 'off'>, [number, number]> = { easy: [0.5, 0.6], on: [1, 1], hard: [1.5, 1.3] };
/** FEAT-140: vertical acceleration through the board counted as full bumps (m/s^2), the bumps counted
 *  in ungroomed snow, the drift added at full bumps (share), and the longest hop (s) a press rides
 *  through (a roller or a mogul; longer is a jump and ends it) */
export const PB_BUMP_ACC = 15, PB_CRUD = 0.35, PB_BUMP_DRIFT = 2, PB_AIR = 0.3;
/** FEAT-140: a press that starts within this long of landing a trick (s) is landed into from it ("Backflip to tail press") */
export const PB_LAND_WINDOW = 0.5;
/** FEAT-152 presses in deep powder (scaled by powder x depth): a nose press is pulled on toward its
 *  buried nose at PB_POWDER needle units/s when slow (PB_POWDER_FAST of it from PLANE_SPEED), and a
 *  tail press, the nose up out of the snow, has PB_POWDER_STEADY less drift and jitter and PB_POWDER_CALM less runaway */
export const PB_POWDER = 0.55, PB_POWDER_FAST = 0.4, PB_POWDER_STEADY = 0.4, PB_POWDER_CALM = 0.25;
/** FEAT-140: a press held shorter than this (s) ends without a report */
export const PRESS_MIN_REPORT = 0.5;
