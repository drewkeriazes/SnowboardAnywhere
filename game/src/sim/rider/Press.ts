/** FEAT-140 press balance (split from sim/Rider.ts, FEAT-165) */
import type { Rider } from '../Rider';
import type { Input, PressEnd } from './types';
import { PB_AIR, PB_BUMP, PB_BUMP_ACC, PB_BUMP_DRIFT, PB_CORRECT, PB_CORRECT_OVER, PB_CRUD, PB_DRIFT, PB_GAP, PB_HOLD_MAX, PB_HOLD_T, PB_LAND_WINDOW, PB_LEVEL, PB_POWDER, PB_POWDER_CALM, PB_POWDER_FAST, PB_POWDER_STEADY, PB_PUSH, PB_PUSH_T, PB_SHIFT_T, PB_SPEED, PB_STALL, PB_UNSTABLE, PLANE_SPEED, PRESS_MIN_REPORT, PRESS_RANGE, STEP } from './tuning';

  /**
   * FEAT-140: balance a held nose or tail press. The needle drifts toward one end, faster the longer
   * the press is held, the faster the rider goes and the bumpier the snow, with a random push now and
   * then; off centre it runs away on its own. W / S (input.balance) push it back. Off the loaded end
   * the board catches (a crash, or a stall below PB_STALL); off the other end it drops flat.
   */
export function pressStep(r: Rider, dt: number, input: Input): void {
  const live = r.pressMode !== 'off' && r.discipline === 'board' && r.onGround && !r.unstrapped && r.crashed <= 0;
  const L = r.lean;
  if (!r.pressing) {
    // a press starts once the lean passes half way (not the lean a jump charge's W / S sets)
    if (!live || Math.abs(L) <= 0.5 || Math.sign(r.leanTarget) !== Math.sign(L) || input.jumpHeld) return;
    r.pressing = true; r.pressDir = Math.sign(L); r.pressBalance = 0; r.pressT = 0; r.pressDist = 0;
    r.pressFrom = r.steps - r.landStep < PB_LAND_WINDOW / STEP ? r.landTrick : '';
    // the step count too, so the first press after every restart does not drift the same way
    r.pbDrift = (r.rng.next() + r.steps * 0.618034) % 1 < 0.5 ? -1 : 1;
    r.pbPushT = pbGap(r); r.pbPushLeft = 0;
    r.pbNoise = r.pbNoiseTo = 0; r.pbNoiseT = 0; r.pbBump = 0; r.pbVz = r.vz; r.pbCorr = 0;
    return;
  }
  if (r.crashed > 0) { endPress(r, null); return; } // crashed into something else
  if (!r.onGround && r.airTime < PB_AIR && r.crashed <= 0) return; // a short hop: the press rides through it
  if (!live || Math.abs(L) < 0.5 || Math.sign(L) !== r.pressDir) { endPress(r, 'clean'); return; } // let go, or left the snow
  const [e, u] = PB_LEVEL[r.pressMode === 'off' ? 'on' : r.pressMode], spd = r.speed;
  r.pressT += dt; r.pressDist += spd * dt;
  // bumps: vertical acceleration through the board, plus crud off the groomers at speed
  const az = Math.abs(r.vz - r.pbVz) / dt; r.pbVz = r.vz;
  const crud = PB_CRUD * (1 - r.surface.groomed) * Math.min(1, spd / 12);
  r.pbBump += (Math.min(1, az / PB_BUMP_ACC + crud) - r.pbBump) * Math.min(1, dt * 4);
  r.pbNoiseT -= dt;
  if (r.pbNoiseT <= 0) { r.pbNoiseT = 0.15; r.pbNoiseTo = r.rng.next() * 2 - 1; }
  r.pbNoise += (r.pbNoiseTo - r.pbNoise) * Math.min(1, dt * 8);
  // a random push now and then, and the drift may turn to the other end with it
  r.pbPushT -= dt;
  if (r.pbPushT <= 0) {
    r.pbPushT = pbGap(r); r.pbPushLeft = PB_PUSH_T;
    r.pbPushV = (r.rng.next() < 0.5 ? -1 : 1) * PB_PUSH * e / PB_PUSH_T;
    if (r.rng.next() < 0.4) r.pbDrift = -r.pbDrift;
  }
  const push = r.pbPushLeft > 0 ? r.pbPushV : 0;
  r.pbPushLeft -= dt;
  const hold = 1 + PB_HOLD_MAX * (1 - Math.exp(-r.pressT / PB_HOLD_T));
  // FEAT-152: deep powder pulls a nose press on into the snow and steadies a tail press
  const pd = r.snow.powder * Math.min(1, r.snow.depth / 0.3);
  const steady = r.pressDir < 0 ? 1 - PB_POWDER_STEADY * pd : 1;
  const pull = r.pressDir > 0 ? PB_POWDER * e * pd * (1 - (1 - PB_POWDER_FAST) * Math.min(1, spd / PLANE_SPEED)) : 0;
  const drift = PB_DRIFT * e * hold * (1 + PB_SPEED * spd) * (1 + PB_BUMP_DRIFT * r.pbBump) * r.pbDrift * steady + pull;
  const jitter = PB_BUMP * e * r.pbBump * r.pbNoise * steady;
  const b = r.pressBalance;
  // the runaway grows with the time held too: a long press needs quicker, finer corrections, never more than W / S has
  const runaway = PB_UNSTABLE * u * hold * b * (r.pressDir < 0 ? 1 - PB_POWDER_CALM * pd : 1);
  // W / S shift the weight, which takes PB_SHIFT_T to build or let go: react late or overcorrect and it costs you
  r.pbCorr += (Math.max(-1, Math.min(1, input.balance ?? 0)) - r.pbCorr) * Math.min(1, dt / PB_SHIFT_T);
  const corr = r.pbCorr * Math.max(PB_CORRECT, PB_CORRECT_OVER * (Math.abs(drift) + Math.abs(jitter) + Math.abs(runaway)));
  r.pressBalance = b + (drift + runaway + jitter + push + corr) / PRESS_RANGE * dt;
  const over = r.pressBalance * r.pressDir;
  if (over >= 1) {
    // over-pressed: the loaded end catches; slow, the board just stops
    if (spd < PB_STALL) { r.vx *= 0.2; r.vy *= 0.2; r.speed *= 0.2; endPress(r, 'stall'); }
    else { r.crashed = 1.3; r.crashFall = r.pressDir; endPress(r, 'slam'); }
  } else if (over <= -1) endPress(r, 'flat'); // under-pressed: the board drops flat
}

function pbGap(r: Rider): number { return PB_GAP[0] + r.rng.next() * (PB_GAP[1] - PB_GAP[0]); }

/** FEAT-140: end the press (null: silently), keep the lean flat if it was lost, report it */
export function endPress(r: Rider, how: PressEnd | null): void {
  const dir = r.pressDir, t = r.pressT, d = r.pressDist;
  r.pressing = false; r.pressBalance = 0;
  if (how && how !== 'clean') { r.pressLock = dir; r.leanTarget = 0; }
  if (how && t >= PRESS_MIN_REPORT) r.onPress?.(how, dir, t, d, r.switch, r.pressFrom);
}
