import { dualSense, triggerFeedback, triggerOff, triggerWeapon } from './DualSense';
import type { PadState } from './Pad';
import type { Rider } from './Rider';

/**
 * FEAT-137: what the controller does back. Rumble through the standard Gamepad API
 * (`vibrationActuator.playEffect('dual-rumble')`, no permission needed) or, with the DualSense extras
 * connected, through its own motors over WebHID; plus the extras' lightbar and adaptive triggers.
 *
 * Effects: a thump on landings (by `landingShock`), a buzz on a crash, a texture while the board scrapes
 * rock or scree (FEAT-103), bumps at speed (moguls, rollers, chop: the board's vertical jolt), a press
 * being balanced (a hum that beats faster and harder as the needle nears either end, the heavy motor
 * toward the slam, the light one toward dropping flat), a tick at each time-trial checkpoint, the Outrun
 * monster's footfalls (stronger as it closes in). Lightbar: the goggle lens colour, pulsing red as the monster
 * closes, flashing green on a time-trial best. Triggers: L2 (brake) resists harder the more the edge
 * digs (FEAT-133), R2 (tuck) clicks near the top of its travel.
 */
interface Pulse { t: number; dur: number; strong: number; weak: number }

/** How often a continuing rumble is renewed through the Gamepad API (each effect lasts a little longer). */
const RENEW_S = 0.08;
const EFFECT_MS = 140;
/** bumps: the board's vertical jolt (m/s^2, smoothed) where the rumble starts, and how much more is full */
export const BUMP_A0 = 4, BUMP_A1 = 30;
/** press: the share of the balance range where the warning starts */
const PRESS_WARN = 0.35;
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export interface PadFxFrame {
  rider: Rider;
  /** the rider is on the board on the snow (not on a lift, unstrapped, frozen or in a menu) */
  riding: boolean;
  /** metres to the nearest Outrun monster while a chase runs, else Infinity */
  monsterDist: number;
  /** goggle lens colour, 0xRRGGBB */
  lens: number;
}

export class PadFeedback {
  /** 0 (off) .. 1 */
  strength = 0.8;
  triggers = false;
  lightbar = true;
  private readonly pulses: Pulse[] = [];
  private texStrong = 0; texWeak = 0;
  private renew = 0;
  private lastStrong = -1; private lastWeak = -1;
  private prevShock = 0; private prevCrash = 0;
  /** bumps: last frame's vertical speed on the snow (NaN off it), the smoothed jolt, its envelope */
  private vzPrev = NaN; jolt = 0; private bumpEnv = 0;
  private prevChop = 0;
  private pressPhase = 0; private prevPressing = false;
  private flashT = 0; private t = 0;
  private pad: PadState | null = null;

  /** One-shot effect, magnitudes 0..1. */
  pulse(durS: number, strong: number, weak: number): void {
    if (this.pulses.length > 8) this.pulses.shift();
    this.pulses.push({ t: 0, dur: durS, strong, weak });
  }
  /** a time-trial checkpoint or the finish (a best flashes the lightbar green) */
  trialEvent(kind: 'split' | 'finish' | 'start', isBest = false): void {
    if (kind === 'split' || kind === 'start') this.pulse(0.05, 0, 0.55);
    else { this.pulse(0.09, 0.2, 0.7); if (isBest) this.flashT = 2.5; }
  }
  /** Outrun: a monster's foot came down `dist` m away */
  footfall(dist: number): void {
    const k = Math.max(0, 1 - dist / 120);
    if (k > 0) this.pulse(0.1 + 0.08 * k, 0.15 + 0.85 * k * k, 0.1 * k);
  }

  /** Per frame while the game runs. `pad` is the controller read this frame. */
  update(dt: number, pad: PadState | null, f: PadFxFrame): void {
    this.pad = pad;
    this.t += dt;
    const r = f.rider;
    // events from the rider's state
    if (r.landingShock > this.prevShock + 0.05) { const s = Math.min(1, r.landingShock); this.pulse(0.08 + 0.16 * s, 0.25 + 0.75 * s, 0.2 + 0.4 * s); }
    this.prevShock = r.landingShock;
    if (r.crashed > 0 && this.prevCrash <= 0) this.pulse(0.35, 1, 0.8);
    this.prevCrash = r.crashed;
    // textures: rock and scree under the board (a gritty high buzz)
    let ts = 0, tw = 0;
    const onSnow = f.riding && r.onGround && !r.onFoot;
    if (onSnow && r.speed > 1) {
      const v = Math.min(1, r.speed / 18);
      const rock = Math.min(1, r.surface.rock + 0.6 * r.surface.scree);
      if (rock > 0.05) { tw += rock * v * (0.35 + 0.35 * Math.random()); ts += 0.25 * rock * v; }
    }
    // bumps at speed: on the snow vz is the surface's vertical speed at every physics step, so its rate of
    // change is how hard the board is being thrown up and dropped (moguls, rollers, lips); smoothed over
    // about 70 ms so frames that do not line up with the 120 Hz steps don't flicker it
    if (onSnow && dt > 0) {
      if (!Number.isNaN(this.vzPrev)) this.jolt += (Math.abs(r.vz - this.vzPrev) / dt - this.jolt) * Math.min(1, dt * 15);
      this.vzPrev = r.vz;
    } else { this.vzPrev = NaN; this.jolt *= Math.exp(-dt * 15); }
    // a quick rise (a roller at 20 m/s is a light thrum, a mogul line close to full), less at a crawl
    // (groomed snow half: smoother under the board, and it keeps the elevation model's noise out of a fast groomer)
    const bump = onSnow ? Math.pow(Math.max(0, Math.min(1, (this.jolt - BUMP_A0) / BUMP_A1)), 0.7) * Math.min(1, r.speed / 8) * (1 - 0.5 * r.surface.groomed) : 0;
    this.bumpEnv = Math.max(this.bumpEnv * Math.exp(-dt * 10), bump);
    ts += 0.8 * this.bumpEnv; tw += 0.25 * this.bumpEnv;
    // chop: each rattle of the board in tracked-out snow
    if (onSnow && r.chop > this.prevChop + 0.05) { const c = Math.min(1, (r.chop - this.prevChop) * 2); this.pulse(0.06, 0.25 * c, 0.45 * c); }
    this.prevChop = r.chop;
    // a press being balanced: a light hum, then a beat that quickens and hardens toward either end; the heavy
    // motor toward the loaded end catching (a slam), the light one toward the board dropping flat
    if (onSnow && r.pressing) {
      if (!this.prevPressing) this.pulse(0.06, 0.15, 0.3);
      const over = r.pressBalance * r.pressDir, warn = smooth(PRESS_WARN, 1, Math.abs(over));
      this.pressPhase += dt * (1.5 + 8.5 * warn);
      const beat = Math.pow(0.5 + 0.5 * Math.sin(this.pressPhase * Math.PI * 2), 2);
      tw += 0.07;
      if (over > 0) ts += warn * (0.25 + 0.6 * beat); else tw += warn * (0.25 + 0.6 * beat);
    } else if (this.prevPressing && r.crashed <= 0) this.pulse(0.08, 0.1, 0.35); // the board settles back flat
    this.prevPressing = onSnow && r.pressing;
    this.texStrong = ts; this.texWeak = tw;
    // combine
    let s = ts, w = tw;
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.t += dt;
      if (p.t >= p.dur) { this.pulses.splice(i, 1); continue; }
      s = Math.max(s, p.strong); w = Math.max(w, p.weak);
    }
    this.output(dt, Math.min(1, s * this.strength), Math.min(1, w * this.strength));
    this.extras(dt, f);
  }

  /** Paused or in a menu: no rumble, triggers off. */
  idle(pad: PadState | null): void {
    this.pad = pad;
    this.pulses.length = 0; this.texStrong = this.texWeak = 0;
    this.output(1, 0, 0);
    if (dualSense.connected) { dualSense.setTriggers(triggerOff(), triggerOff()); dualSense.flush(); }
  }
  /** Session over. */
  stop(): void { this.idle(this.pad); this.prevShock = 0; this.prevCrash = 0; this.vzPrev = NaN; this.jolt = this.bumpEnv = 0; this.prevPressing = false; this.prevChop = 0; }

  private output(dt: number, strong: number, weak: number): void {
    if (dualSense.live) { dualSense.setRumble(strong, weak); return; }
    const act = (this.pad?.gp as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown>; reset?: () => Promise<unknown> } }) | null)?.vibrationActuator;
    if (!act?.playEffect) return;
    this.renew -= dt;
    const off = strong < 0.02 && weak < 0.02;
    if (off) {
      if (this.lastStrong > 0 || this.lastWeak > 0) { void act.reset?.()?.catch(() => undefined); this.lastStrong = this.lastWeak = 0; }
      return;
    }
    const changed = Math.abs(strong - this.lastStrong) > 0.08 || Math.abs(weak - this.lastWeak) > 0.08;
    if (!changed && this.renew > 0) return;
    this.renew = RENEW_S; this.lastStrong = strong; this.lastWeak = weak;
    void act.playEffect('dual-rumble', { startDelay: 0, duration: EFFECT_MS, strongMagnitude: strong, weakMagnitude: weak }).catch(() => undefined);
  }

  private extras(dt: number, f: PadFxFrame): void {
    if (!dualSense.connected) return;
    const r = f.rider;
    // lightbar
    if (!this.lightbar) dualSense.setLight([0, 0, 0]);
    else {
      let cr = (f.lens >> 16) & 0xff, cg = (f.lens >> 8) & 0xff, cb = f.lens & 0xff;
      const dim = 0.55; cr *= dim; cg *= dim; cb *= dim;
      if (f.monsterDist < 90) {
        const c = 1 - f.monsterDist / 90, rate = 1 + 5 * c;
        const k = c * (0.55 + 0.45 * Math.sin(this.t * rate * Math.PI * 2));
        cr += (255 - cr) * k; cg *= 1 - k; cb *= 1 - k;
      }
      if (this.flashT > 0) {
        this.flashT -= dt;
        const on = Math.floor(this.flashT * 8) % 2 === 0;
        if (on) { cr = 20; cg = 255; cb = 60; }
      }
      dualSense.setLight([Math.round(cr), Math.round(cg), Math.round(cb)]);
    }
    // adaptive triggers: quantised so a report goes out only when the feel changes
    if (!this.triggers || !f.riding || r.onFoot) dualSense.setTriggers(triggerOff(), triggerOff());
    else {
      const dig = r.onGround ? Math.min(1, Math.max(r.scrape * 1.4, r.brakeAmt * 0.35)) : 0;
      const left = triggerFeedback(1, 1 + Math.round(7 * dig));
      const right = triggerWeapon(2, 4, 3);
      dualSense.setTriggers(left, right);
    }
    dualSense.flush();
  }
}

export const padFx = new PadFeedback();
