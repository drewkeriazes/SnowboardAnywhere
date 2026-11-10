/**
 * FEAT-165: the rider view's pose and feel constants (moved from world/RiderView.ts as they were).
 */
import { PRESS_RANGE } from '../../sim/Rider';

/** FEAT-112: half the skis' length (where they pivot) and the most they tip up on a full lean (rad) */
export const BOARD_HALF = 0.72, LEAN_TIP = 18 * Math.PI / 180;
/** FEAT-127: the board's roll pivots on its engaged edge, this far off centre (m); each ski on its own edge */
export const EDGE_OFF = 0.13, SKI_EDGE_OFF = 0.05, EDGE_PIVOT_ROLL = 0.15;
/** FEAT-118: board flex spring: natural frequency (rad/s, about 0.3 s a cycle) and damping ratio
 *  (0.45 overshoots about 20 %, so a full load snaps past flat to about -0.15 on the pop) */
export const FLEX_W = 21, FLEX_ZETA = 0.45;
/** FEAT-140: a held press bends the board this much (share of full flex, the free tip about 22 cm up;
 *  0.6 before), the bend follows the balance by this share at the edge (deeper toward the loaded
 *  end, flatter toward the other), and never past BEND_MAX (the mesh's bounding sphere allows ~1.18) */
export const PRESS_BEND = 0.8, BAL_BEND = 0.5, BEND_MAX = 1.15;
/** FEAT-140: deep in a press the whole board also tips up on its loaded tip, like a real tail press
 *  at the extreme (35 deg or more with the bend): the tip at the edge of the balance toward the
 *  loaded end (rad; half of it centred, none toward the other end), its response (s), and how far the
 *  hips move on toward the loaded end at the full tip (m) */
export const PRESS_TIP = 32 * Math.PI / 180, TIP_RESPONSE = 0.12, TIP_SHIFT = 0.1;
/** BUG-047: the hip joint stays this far above the deck under it (the glutes hang 0.1 to 0.15 m below
 *  the joint). FEAT-125: on a full press the hips move this far toward the loaded end (m), reached
 *  at this much bend (a full lean without a charge bends the board 0.6) */
export const HIP_CLEAR = 0.2, HIP_SHIFT = 0.3, PRESS_FLEX = 0.6;
/** FEAT-125: on a full press the leg over the unloaded end reaches this share of its length (knee
 *  about 20 deg), and the head takes this share of the pelvis roll back out so it stays up */
export const PRESS_REACH = 0.975, HEAD_LEVEL = 0.8;
/** FEAT-125 balance arms: wobble amplitude on a press (rad) at first and after holding it FLAIL_RAMP s,
 *  and the correction swing when the lean changes: spring frequency (rad/s), damping, kick per unit lean */
export const FLAIL_BASE = 0.04, FLAIL_HOLD = 0.13, FLAIL_RAMP = 2.5, CORR_W = 11, CORR_ZETA = 0.35, CORR_KICK = 5;
/** FEAT-125 wobble growth: share added per m/s of speed (up to FLAIL_VMAX m/s), share added at full
 *  bumps, and the vertical acceleration counted as full bumps (m/s^2, about 1.5 g) */
export const FLAIL_SPEED = 0.04, FLAIL_VMAX = 15, FLAIL_BUMP = 1.5, BUMP_ACC = 15;
/** FEAT-140: the wobble added as the press balance runs out to either end (share at the end), the
 *  extra pelvis roll toward the end it runs to (rad per unit of balance, about 23 deg; the head takes
 *  most of it back out), and how far the hips slide along the board toward that end (m per unit).
 *  The balance runs to PRESS_RANGE units, so at the edge the body leans PRESS_RANGE times as far. */
export const FLAIL_BAL = 1.6, BAL_ROLL = 0.4 * PRESS_RANGE, BAL_SHIFT = 0.14 * PRESS_RANGE;
/** FEAT-125 wobble shape: the fore-aft swing as a share of the up-down wave, and the elbow's bend
 *  (deg) per rad of wave (each elbow follows the other arm's wave, so the two never move in step) */
export const FLAIL_SWING = 0.6, FLAIL_ELBOW = 40;
/** FEAT-125: the arms' upswing on the pop: length (s) and extra lift at its peak (rad) */
export const POP_T = 0.4, POP_LIFT = 0.45;
/** BUG-034: share of a skier's counter-rotation taken by the pelvis (the rest is the chest) */
export const SKI_HIP_TWIST = 0.35;
/** FEAT-126: lean (rad) where the deep carve pose starts blending in; it is all in at LEAN_MAX */
export const DEEP_FROM = 0.3;
/** FEAT-126: least height above the snow on a lean (m): the knee joints (the knee pad is about 5 cm
 *  round), the hip joint (the glutes hang 0.1 to 0.15 m below it) and the wrists */
export const CLEAR_KNEE = 0.06, CLEAR_HIP = 0.17, CLEAR_HAND = 0.05;
/** FEAT-148: in a hard carve the inside hand reaches down and drags on the snow once the lean passes
 *  HAND_DRAG_FROM (rad), all the way by HAND_DRAG_FULL, this high (m), a little out toward the inside */
export const HAND_DRAG_FROM = 0.95, HAND_DRAG_FULL = 1.15, HAND_DRAG_Y = 0.02, HAND_DRAG_OUT = 0.08;
/** BUG-066: the leg bones' least distance above the deck (m) where they pass over the board (the knee is
 *  about 6.5 cm round the bone, so about 5 cm of skin clear), the board's half width plus a limb's
 *  reach over it, and where along the shin (from the ankle) and the thigh (from the knee) it is tested */
export const DECK_CLEAR = 0.115, DECK_HALF_W = 0.13 + 0.05, DECK_HALF_L = 0.8;
export const SHIN_TS = [0.35, 0.55, 0.75, 1], THIGH_TS = [0.25, 0.5, 0.75];
/** FEAT-152: the set-down eases with this time constant (s, settled in about 3x) */
export const BURY_TAU = 0.1;
/** FEAT-152: the snow cover is all in once the tail is this far down (m), and the sag is held ahead of the board from this tail depth */
export const COVER_FULL = 0.03, HOLD_FULL = 0.05;
/** FEAT-152: a full press moves the sag held ahead of the board this far (m) toward the end that is down */
export const HOLD_SHIFT = 0.35;

/** BUG-056 lead / lag chain (s), visual only. The head and shoulders pose for where the rider will
 *  be LEAD_UPPER ahead (the steer's target edge and the heading the turn rate is taking them to),
 *  the hips and the body's inclination LEAD_HIPS ahead (the crossover), the knees and ankles ride the
 *  board, and the board as drawn follows the physics yaw and edge BOARD_LAG behind (a critically
 *  damped follow), so every turn reads look, shoulders, hips cross, knees roll, then the board tips.
 *  Physics, collision and the tracks keep the true board state. Live-tunable on the view
 *  (`leadUpper`, `leadHips`, `boardLag`; the ?debug HUD has sliders). */
export const LEAD_UPPER = 0.2, LEAD_HIPS = 0.12, BOARD_LAG = 0.08;
/** BUG-056: how far the edge must be moving (rad ahead of the physics edge over the hips' lead) for
 *  the inclination to lean fully for the predicted edge instead of the measured lateral g, the most
 *  the shoulders turn ahead of the drawn board (rad), and the pelvis's share of that turn on a snowboard */
export const LEAD_BLEND = 0.2, YAW_LEAD_CAP = 0.5, HIP_YAW_SHARE = 0.5;
/** BUG-056: the body's own response time (s): every lead signal (the edges the poses are built for,
 *  the inclination, the shoulders' turn, the hips over a press) is a critically damped follow of its
 *  prediction with this lag, so a new steer moves the body at a human speed, ahead of the board but
 *  never snapping to it (the prediction itself jumps the moment the input changes) */
export const BODY_RESPONSE = 0.09;
