import type { Rider } from '../sim/Rider';

/**
 * Sound: synthesised effects through Web Audio (no sample files needed) plus a music playlist
 * from `public/music/playlist.json` (`["a.mp3", "b.mp3"]`, files next to it). Volumes are
 * remembered in localStorage. The AudioContext is created on the first user gesture (menu click).
 *
 * Effects: carve/skid hiss (noise, filtered, scaled by speed and skid), wind in a tuck or at
 * speed, jump pop, landing thump, crash, rock ramp hit, lift hum while riding, boarding chime.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private noise!: AudioBufferSourceNode;
  private hissGain!: GainNode;
  private hissFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private liftOsc!: OscillatorNode;
  private liftGain!: GainNode;
  private music: HTMLAudioElement | null = null;
  private playlist: string[] = [];
  private track = 0;
  sfxVolume = 0.8;
  musicVolume = 0.5;
  private wasOnGround = true;
  private wasRiding = false;

  constructor() {}

  get started(): boolean { return this.ctx !== null; }

  /** Create the context; must run inside a user gesture. Safe to call twice. */
  start(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.sfx.gain.value = this.sfxVolume;
    // 2 s looping white noise feeds the hiss and the wind
    const n = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.noise = ctx.createBufferSource(); this.noise.buffer = buf; this.noise.loop = true;
    this.hissFilter = ctx.createBiquadFilter(); this.hissFilter.type = 'bandpass'; this.hissFilter.frequency.value = 2500; this.hissFilter.Q.value = 0.7;
    this.hissGain = ctx.createGain(); this.hissGain.gain.value = 0;
    this.noise.connect(this.hissFilter).connect(this.hissGain).connect(this.sfx);
    this.windFilter = ctx.createBiquadFilter(); this.windFilter.type = 'lowpass'; this.windFilter.frequency.value = 300;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    this.noise.connect(this.windFilter).connect(this.windGain).connect(this.sfx);
    this.noise.start();
    this.liftOsc = ctx.createOscillator(); this.liftOsc.type = 'sawtooth'; this.liftOsc.frequency.value = 55;
    const lf = ctx.createBiquadFilter(); lf.type = 'lowpass'; lf.frequency.value = 180;
    this.liftGain = ctx.createGain(); this.liftGain.gain.value = 0;
    this.liftOsc.connect(lf).connect(this.liftGain).connect(this.sfx);
    this.liftOsc.start();
    void this.loadPlaylist();
  }

  private async loadPlaylist(): Promise<void> {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}music/playlist.json`);
      if (!r.ok) return;
      this.playlist = (await r.json()) as string[];
      if (this.playlist.length) this.playTrack(0);
    } catch { /* no music shipped */ }
  }

  playTrack(i: number): void {
    if (!this.playlist.length) return;
    this.track = ((i % this.playlist.length) + this.playlist.length) % this.playlist.length;
    if (!this.music) {
      this.music = new Audio();
      this.music.addEventListener('ended', () => this.playTrack(this.track + 1));
    }
    this.music.src = `${import.meta.env.BASE_URL}music/${this.playlist[this.track]}`;
    this.music.volume = this.musicVolume;
    void this.music.play().catch(() => undefined);
  }
  nextTrack(): void { this.playTrack(this.track + 1); }
  get trackName(): string | null { return this.playlist.length ? this.playlist[this.track].replace(/\.[a-z0-9]+$/i, '') : null; }

  private duck = 1;
  setVolumes(sfx: number, music: number): void {
    this.sfxVolume = sfx; this.musicVolume = music;
    if (this.sfx) this.sfx.gain.value = sfx * this.duck;
    if (this.music) this.music.volume = music * this.duck;
  }
  /** Pause ducking: 1 = normal, 0.3 = paused. Effects are silenced while paused. */
  setDuck(d: number): void {
    this.duck = d;
    if (this.sfx) this.sfx.gain.value = d < 1 ? 0 : this.sfxVolume;
    if (this.music) this.music.volume = this.musicVolume * d;
  }
  stopMusic(): void { this.music?.pause(); }

  /** Short filtered noise burst. */
  private thump(freq: number, dur: number, gain: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    const src = ctx.createBufferSource(); src.buffer = this.noise.buffer; src.loop = true;
    src.connect(f).connect(g).connect(this.sfx);
    src.start(); src.stop(ctx.currentTime + dur);
  }
  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine'): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g).connect(this.sfx); o.start(); o.stop(ctx.currentTime + dur);
  }

  chime(): void { this.tone(880, 0.25, 0.15); setTimeout(() => this.tone(1320, 0.35, 0.12), 120); }

  /** Per frame. */
  update(r: Rider, tuck: boolean, riding: boolean, dt: number): void {
    if (!this.ctx) return;
    const k = Math.min(1, dt * 12);
    const spd = r.speed;
    // hiss: louder with speed and skid, muted in the air
    const target = r.onGround && !riding ? Math.min(0.5, (0.02 + 0.012 * spd) * (1 + 2.5 * r.skid) * (0.6 + 0.4 * r.surface.groomed)) : 0;
    this.hissGain.gain.value += (target - this.hissGain.gain.value) * k;
    this.hissFilter.frequency.value = 1500 + 2500 * r.skid + 40 * spd;
    const wind = Math.min(0.5, Math.max(0, spd - 6) * 0.018 * (tuck ? 1.4 : 1));
    this.windGain.gain.value += (wind - this.windGain.gain.value) * k;
    this.windFilter.frequency.value = 200 + 25 * spd;
    this.liftGain.gain.value += ((riding ? 0.08 : 0) - this.liftGain.gain.value) * k;
    // one-shots from state changes
    if (this.wasOnGround && !r.onGround && r.airTime < 0.05 && r.lastHit !== 'ramp') this.thump(1200, 0.12, 0.3);
    if (!this.wasOnGround && r.onGround) this.thump(250, 0.25, Math.min(1, 0.3 + r.landingShock));
    if (r.crashed > 1.15) this.thump(120, 0.5, 0.9);
    if (r.lastHit === 'ramp') this.thump(600, 0.2, 0.5);
    else if (r.lastHit === 'graze') this.thump(400, 0.15, 0.35);
    if (riding && !this.wasRiding) this.chime();
    this.wasOnGround = r.onGround;
    this.wasRiding = riding;
  }
}
