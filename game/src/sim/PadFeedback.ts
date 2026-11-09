import { dualSense, triggerFeedback, triggerOff, triggerWeapon } from './DualSense';
import type { PadState } from './Pad';
import type { Rider } from './Rider';

/**
 * FEAT-137: what the controller does back. Rumble through the standard Gamepad API
 * (`vibrationActuator.playEffect('dual-rumble')`, no permission needed) or, with the DualSense extras
 * connected, through its own motors over WebHID; plus the extras' lightbar and adaptive triggers.
 *
 * Effects: a thump on landings (by `landingShock`), a buzz on a crash, a texture while the board scrapes
 * rock or scree (FEAT-103) or rides moguls, a tick at each time-trial checkpoint, the Outrun monster's
 * footfalls (stronger as it closes in). Lightbar: the goggle lens colour, pulsing red as the monster
 * closes, flashing green on a time-trial best. Triggers: L2 (brake) resists harder the more the edge
 * digs (FEAT-133), R2 (tuck) clicks near the top of its travel.
 */
interface Pulse { t: number; dur: number; strong: number; weak: number }

/** How often a continuing rumble is renewed through the Gamepad API (each effect lasts a little longer). */
const RENEW_S = 0.08;
const EFFECT_MS = 140;
/** Trigger effects built once (no per-frame allocation): R2 click, and L2 resistance for each of the 8 quantised dig levels (index 0 is off). */
const RIGHT_CLICK = triggerWeapon(2, 4, 3);
const LEFT_FX = Array.from({ length: 8 }, (_, i) => triggerFeedback(1, 1 + i));

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
  private mogulPhase = 0;
  private flashT = 0; private t = 0;
  private pad: PadState | null = null;
  private readonly rgb: [number, number, number] = [0, 0, 0];

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
    // textures: rock and scree under the board (a gritty high buzz), moguls (a low thud each bump)
    let ts = 0, tw = 0;
    if (f.riding && r.onGround && !r.onFoot && r.speed > 1) {
      const v = Math.min(1, r.speed / 18);
      const rock = Math.min(1, r.surface.rock + 0.6 * r.surface.scree);
      if (rock > 0.05) { tw += rock * v * (0.35 + 0.35 * Math.random()); ts += 0.25 * rock * v; }
      const m = Math.min(1, r.surface.moguls / 0.4);
      if (m > 0.05) {
        this.mogulPhase += r.speed * dt / 4.5; // a bump every 4.5 m or so
        const bump = Math.pow(0.5 + 0.5 * Math.sin(this.mogulPhase * Math.PI * 2), 6);
        ts += 0.5 * m * Math.min(1, r.speed / 10) * bump;
      }
    }
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
  stop(): void { this.idle(this.pad); this.prevShock = 0; this.prevCrash = 0; }

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
      const rgb = this.rgb;
      rgb[0] = Math.round(cr); rgb[1] = Math.round(cg); rgb[2] = Math.round(cb);
      dualSense.setLight(rgb); // setLight copies the values
    }
    // adaptive triggers: quantised so a report goes out only when the feel changes
    if (!this.triggers || !f.riding || r.onFoot) dualSense.setTriggers(triggerOff(), triggerOff());
    else {
      const dig = r.onGround ? Math.min(1, Math.max(r.scrape * 1.4, r.brakeAmt * 0.35)) : 0;
      dualSense.setTriggers(LEFT_FX[Math.round(7 * dig)], RIGHT_CLICK);
    }
    dualSense.flush();
  }
}

export const padFx = new PadFeedback();
