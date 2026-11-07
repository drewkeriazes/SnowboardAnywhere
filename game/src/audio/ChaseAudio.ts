import type * as THREE from 'three';
import { Jukebox } from './Jukebox';

/**
 * Outrun chase sound (FEAT-098). Everything synthesised from the shared noise buffer and
 * oscillators, like the rest of GameAudio. The design goal is that you can play by ear alone:
 *
 *  - the monster bus goes through a PannerNode (HRTF) placed at the nearest monster, with the
 *    listener on the camera, so you hear which way it is coming from
 *  - gallop thuds per footfall, opening up (less low-passed, louder) as it closes in
 *  - roars at spawn, on regaining line of sight, on a close call (angry) and when it gives up
 *  - breathing under 40 m, panting snorts under 15 m
 *  - a heartbeat on the plain effects bus whose rate climbs from 60 bpm at 300 m to 150 at 20 m
 *  - a low tension drone from 300 m in
 *  - war drums (the jukebox's `chase` style) on their own Jukebox instance from 150 m in
 *  - music stages through `setMusicStage` (gain and low-pass on the music bus), with a
 *    record-scratch stop and a silly sting when caught
 *  - boost: a wind roar for the few seconds it lasts
 */
export type Roar = 'spawn' | 'sight' | 'angry' | 'giveup' | 'wake';

export class ChaseAudio {
  private readonly bus: GainNode;
  private readonly panner: PannerNode;
  private readonly breath: { gain: GainNode; filter: BiquadFilterNode };
  private readonly drone: { gain: GainNode; osc: OscillatorNode };
  private readonly wind: { gain: GainNode; filter: BiquadFilterNode };
  private readonly drums: Jukebox;
  private breathT = 0;
  private snortT = 0;
  private heartT = 0;
  private drumsOn = false;
  private stage = 0;
  /** smoothed distance (m) the stages run on */
  private d = Infinity;

  constructor(private readonly ctx: AudioContext, private readonly sfx: GainNode, master: GainNode, private readonly noise: AudioBuffer, private readonly setMusicStage: (gain: number, lowpass: number) => void) {
    void master;
    this.bus = ctx.createGain(); this.bus.gain.value = 1;
    const p = this.panner = ctx.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 20; p.rolloffFactor = 1.5; p.maxDistance = 2000;
    this.bus.connect(p).connect(sfx);
    const layer = (dest: AudioNode, type: BiquadFilterType, freq: number, q: number) => {
      const src = ctx.createBufferSource(); src.buffer = noise; src.loop = true;
      const filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(dest); src.start();
      return { gain, filter };
    };
    this.breath = layer(this.bus, 'bandpass', 500, 0.9);
    this.wind = layer(sfx, 'lowpass', 500, 0.6);
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 36;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 120;
    const g = ctx.createGain(); g.gain.value = 0;
    o.connect(f).connect(g).connect(sfx); o.start();
    this.drone = { gain: g, osc: o };
    this.drums = new Jukebox(ctx, sfx);
    this.drums.volume = 0.5;
  }

  /** Listener on the camera (three.js frame). */
  setListener(cam: THREE.Camera): void {
    const L = this.ctx.listener, t = this.ctx.currentTime;
    const p = cam.position;
    const fwd = { x: 0, y: 0, z: -1 }, up = { x: 0, y: 1, z: 0 };
    const q = cam.quaternion;
    const rot = (v: { x: number; y: number; z: number }) => {
      // v' = q v q*
      const ix = q.w * v.x + q.y * v.z - q.z * v.y, iy = q.w * v.y + q.z * v.x - q.x * v.z, iz = q.w * v.z + q.x * v.y - q.y * v.x, iw = -q.x * v.x - q.y * v.y - q.z * v.z;
      return { x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y, y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z, z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x };
    };
    const F = rot(fwd), U = rot(up);
    if (L.positionX) {
      L.positionX.setTargetAtTime(p.x, t, 0.02); L.positionY.setTargetAtTime(p.y, t, 0.02); L.positionZ.setTargetAtTime(p.z, t, 0.02);
      L.forwardX.setTargetAtTime(F.x, t, 0.02); L.forwardY.setTargetAtTime(F.y, t, 0.02); L.forwardZ.setTargetAtTime(F.z, t, 0.02);
      L.upX.setTargetAtTime(U.x, t, 0.02); L.upY.setTargetAtTime(U.y, t, 0.02); L.upZ.setTargetAtTime(U.z, t, 0.02);
    } else { L.setPosition(p.x, p.y, p.z); L.setOrientation(F.x, F.y, F.z, U.x, U.y, U.z); }
  }

  /** The nearest monster's position (three.js frame). */
  setMonster(x: number, y: number, z: number): void {
    const p = this.panner, t = this.ctx.currentTime;
    if (p.positionX) { p.positionX.setTargetAtTime(x, t, 0.05); p.positionY.setTargetAtTime(y, t, 0.05); p.positionZ.setTargetAtTime(z, t, 0.05); }
    else p.setPosition(x, y, z);
  }

  /**
   * Per frame. `dist` is the nearest monster's distance (Infinity before it spawns),
   * `chasing` true while the run is on, `boosting` during the boost.
   */
  update(dt: number, dist: number, chasing: boolean, boosting: boolean): void {
    const k = Math.min(1, dt * 6);
    const lerp = (g: GainNode, target: number) => { g.gain.value += (target - g.gain.value) * k; };
    this.d = Number.isFinite(dist) ? (Number.isFinite(this.d) ? this.d + (dist - this.d) * Math.min(1, dt * 3) : dist) : Infinity;
    const d = chasing ? this.d : Infinity;
    // breathing: in and out under 40 m, panting snorts under 15 m
    const near = Math.max(0, Math.min(1, (40 - d) / 25));
    this.breathT += dt * (0.5 + 1.5 * near);
    const env = Math.max(0, Math.sin(this.breathT * Math.PI * 2));
    lerp(this.breath.gain, near * (0.25 + 0.5 * env * env));
    this.breath.filter.frequency.value = 350 + 400 * env;
    this.snortT -= dt;
    if (d < 15 && this.snortT <= 0) { this.snortT = 0.5 + Math.random() * 0.4; this.burst(this.bus, 'bandpass', 800, 0.12, 0.7, 1.5, 300); }
    // heartbeat: 60 bpm at 300 m up to 150 at 20 m
    if (d < 300) {
      const bpm = 60 + 90 * Math.max(0, Math.min(1, (300 - d) / 280));
      this.heartT += dt * bpm / 60;
      if (this.heartT >= 1) { this.heartT -= 1; const g = 0.25 + 0.5 * (1 - Math.min(1, d / 300)); this.thump(55, 0.1, g); setTimeout(() => this.thump(50, 0.09, g * 0.7), 140); }
    } else this.heartT = 0;
    // drone from 300 m in
    lerp(this.drone.gain, d < 300 ? 0.05 + 0.05 * Math.max(0, 1 - d / 300) : 0);
    this.drone.osc.frequency.value = 34 + 6 * Math.max(0, 1 - d / 300);
    // boost wind
    lerp(this.wind.gain, boosting ? 0.45 : 0);
    this.wind.filter.frequency.value = boosting ? 700 : 400;
    // music stages
    const stage = d > 300 ? 0 : d > 150 ? 1 : d > 60 ? 2 : 3;
    if (stage !== this.stage) {
      this.stage = stage;
      if (stage === 0) this.setMusicStage(1, 20000);
      else if (stage === 1) this.setMusicStage(0.7, 20000);
      else if (stage === 2) this.setMusicStage(0.6, 800);
      else this.setMusicStage(0, 500);
      if (stage >= 2 && !this.drumsOn) { this.drumsOn = true; this.drums.play(Math.floor(Math.random() * 1000), 'chase'); }
      if (stage < 2 && this.drumsOn) { this.drumsOn = false; this.drums.stop(); }
    }
  }

  /** Nothing chasing any more (stopped, eaten, escaped): layers off, music restored by the owner. */
  stop(): void {
    this.breath.gain.gain.value = 0; this.drone.gain.gain.value = 0; this.wind.gain.gain.value = 0;
    if (this.drumsOn) { this.drumsOn = false; this.drums.stop(); }
    this.stage = 0; this.d = Infinity; this.heartT = 0;
  }

  // ---------------------------------------------------------------- one-shots
  private burst(dest: AudioNode, type: BiquadFilterType, freq: number, dur: number, gain: number, q = 0.7, sweep?: number, at = 0): void {
    const ctx = this.ctx, t = ctx.currentTime + at;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq * (0.92 + Math.random() * 0.16), t);
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(30, sweep), t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true; src.loopStart = Math.random() * 1.5;
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5); src.stop(t + dur);
  }
  private tone(dest: AudioNode, freq: number, dur: number, gain: number, type: OscillatorType = 'sine', glide?: number, at = 0): void {
    const ctx = this.ctx, t = ctx.currentTime + at;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(dest); o.start(t); o.stop(t + dur);
  }
  private thump(freq: number, dur: number, gain: number): void { this.tone(this.sfx, freq, dur, gain, 'sine', freq * 0.6); }

  /** A gallop footfall at distance d: a low thud that opens up as it closes in. */
  footfall(d: number): void {
    const close = Math.max(0, Math.min(1, (400 - d) / 370));
    this.burst(this.bus, 'lowpass', 90 + 310 * close, 0.14, 0.8 + 0.6 * close, 0.8);
    this.tone(this.bus, 48, 0.12, 0.5 + 0.4 * close, 'sine', 30);
  }
  /** Roars: a sawtooth growl sweep through a bandpass with a noise rasp on top. */
  roar(kind: Roar): void {
    const ctx = this.ctx, t = ctx.currentTime;
    const dur = kind === 'angry' ? 0.9 : kind === 'wake' ? 1.6 : 1.3;
    const f0 = kind === 'angry' ? 150 : kind === 'giveup' ? 110 : 95, f1 = kind === 'angry' ? 90 : 55;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0 * 0.7, t); o.frequency.exponentialRampToValueAtTime(f0, t + 0.12); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const vib = ctx.createOscillator(); vib.frequency.value = 11; const vg = ctx.createGain(); vg.gain.value = 18; vib.connect(vg).connect(o.detune);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.6; f.frequency.setValueAtTime(260, t); f.frequency.exponentialRampToValueAtTime(600, t + dur * 0.4); f.frequency.exponentialRampToValueAtTime(180, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.08); g.gain.setValueAtTime(0.9, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f).connect(g).connect(this.bus); o.start(t); vib.start(t); o.stop(t + dur + 0.05); vib.stop(t + dur + 0.05);
    this.burst(this.bus, 'bandpass', 900, dur, 0.5, 0.8, 300);
    this.burst(this.bus, 'lowpass', 120, dur * 0.8, 0.9);
  }
  /** A small tree snapping as it bounds through. */
  crack(): void { this.burst(this.bus, 'highpass', 2200, 0.09, 0.6, 0.8); this.tone(this.bus, 140, 0.07, 0.3, 'square', 70); this.burst(this.bus, 'lowpass', 400, 0.25, 0.4, 0.7, 150, 0.05); }
  /** The boost: a whoosh up front and the wind layer does the rest. */
  boostWhoosh(): void { this.burst(this.sfx, 'bandpass', 500, 0.6, 0.6, 0.8, 3000); }
  /** 3-2-1 beeps and the go. */
  countBeep(go: boolean): void { this.tone(this.sfx, go ? 1320 : 880, go ? 0.5 : 0.15, 0.2, 'square'); }
  /** Close call: a short rising sting. */
  closeCall(): void { this.tone(this.sfx, 600, 0.25, 0.15, 'triangle', 1200); this.tone(this.sfx, 900, 0.3, 0.12, 'triangle', 1800, 0.12); }
  // the eat sequence (FEAT-100)
  pop(): void { this.burst(this.sfx, 'bandpass', 1400, 0.09, 0.9, 1.2, 500); this.tone(this.sfx, 700, 0.12, 0.3, 'square', 250); }
  gulp(): void { this.tone(this.sfx, 330, 0.22, 0.35, 'sine', 110); this.burst(this.sfx, 'lowpass', 700, 0.18, 0.4, 0.7, 200); }
  burp(): void {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(75, t); o.frequency.linearRampToValueAtTime(48, t + 0.7);
    const vib = ctx.createOscillator(); vib.frequency.value = 22; const vg = ctx.createGain(); vg.gain.value = 60; vib.connect(vg).connect(o.detune);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(380, t); f.frequency.linearRampToValueAtTime(180, t + 0.7);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.7, t + 0.05); g.gain.setValueAtTime(0.7, t + 0.45); g.gain.exponentialRampToValueAtTime(0.001, t + 0.75);
    o.connect(f).connect(g).connect(this.sfx); o.start(t); vib.start(t); o.stop(t + 0.8); vib.stop(t + 0.8);
    this.burst(this.sfx, 'lowpass', 300, 0.7, 0.4, 0.7, 120);
  }
  spit(): void { this.burst(this.sfx, 'bandpass', 1100, 0.2, 0.5, 1.0, 2500); this.tone(this.sfx, 500, 0.15, 0.2, 'triangle', 900); }
  /** Caught: a slide whistle down and a boing. */
  sting(): void {
    this.tone(this.sfx, 1100, 0.7, 0.2, 'sine', 180);
    this.tone(this.sfx, 220, 0.35, 0.2, 'square', 330, 0.75);
    this.tone(this.sfx, 165, 0.5, 0.18, 'square', 110, 1.0);
  }
  /** Escaped: a little fanfare. */
  fanfare(): void { for (const [i, f] of [660, 880, 1100, 1320].entries()) this.tone(this.sfx, f, i === 3 ? 0.6 : 0.18, 0.18, 'square', undefined, i * 0.16); }
}
