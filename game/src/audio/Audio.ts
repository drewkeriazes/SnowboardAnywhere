import type { Rider } from '../sim/Rider';

/**
 * Sound: everything is synthesised through Web Audio from one looping noise buffer plus
 * oscillators, so nothing needs sample files. Music is a playlist from
 * `public/music/playlist.json` (`["a.mp3", ...]`). The AudioContext is created on the first
 * user gesture (menu click).
 *
 * Continuous layers (gains driven per frame from rider state):
 *  - flow: board on snow, mixed per surface: groomed corduroy hum, powder hush with a low
 *    rumble, hardpack / rock scrape, crust crackle on steep off-piste
 *  - carve: toe-side and heel-side edge layers (different pitch and grit), plus skid chatter
 *  - wind: broadband and a whistle above 20 m/s, ducked on a lift
 *  - lift: drive hum while riding
 * One-shots, each picked from three variants with +/- 8% pitch jitter: jump pop with a board
 * creak, landings in three impact bands with a spray whoosh, crash crunch, rock ramp, tree
 * graze and branch brush, tower clunk, bull-wheel rumble at terminals, boarding and unload chimes.
 */
interface Layer { gain: GainNode; filter: BiquadFilterNode }

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private noiseBuf!: AudioBuffer;
  private flowGroom!: Layer; private flowPow!: Layer; private flowHard!: Layer; private flowCrust!: Layer;
  private carveToe!: Layer; private carveHeel!: Layer; private skidL!: Layer;
  private windLo!: Layer; private windHi!: Layer;
  private rumble!: { gain: GainNode; osc: OscillatorNode };
  private liftGain!: GainNode;
  private crackleT = 0;
  private music: HTMLAudioElement | null = null;
  private playlist: string[] = [];
  private track = 0;
  sfxVolume = 0.8;
  musicVolume = 0.5;
  private wasOnGround = true;
  private wasRiding = false;
  private brushT = 0;

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
    // 2 s of white noise, looped by every noise source
    const n = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const layer = (type: BiquadFilterType, freq: number, q: number): Layer => {
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.sfx); src.start();
      return { gain, filter };
    };
    this.flowGroom = layer('bandpass', 2200, 0.8);
    this.flowPow = layer('lowpass', 400, 0.5);
    this.flowHard = layer('highpass', 3500, 0.7);
    this.flowCrust = layer('bandpass', 1200, 2.5);
    this.carveToe = layer('bandpass', 3000, 1.6);
    this.carveHeel = layer('bandpass', 1900, 1.6);
    this.skidL = layer('bandpass', 5200, 1.2);
    this.windLo = layer('lowpass', 300, 0.5);
    this.windHi = layer('bandpass', 2400, 6);
    // powder rumble: low sine wobble
    const ro = ctx.createOscillator(); ro.type = 'triangle'; ro.frequency.value = 42;
    const rg = ctx.createGain(); rg.gain.value = 0;
    ro.connect(rg).connect(this.sfx); ro.start();
    this.rumble = { gain: rg, osc: ro };
    // lift drive hum
    const lo = ctx.createOscillator(); lo.type = 'sawtooth'; lo.frequency.value = 55;
    const lf = ctx.createBiquadFilter(); lf.type = 'lowpass'; lf.frequency.value = 180;
    this.liftGain = ctx.createGain(); this.liftGain.gain.value = 0;
    lo.connect(lf).connect(this.liftGain).connect(this.sfx); lo.start();
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
    this.music.volume = this.musicVolume * this.duck;
    void this.music.play().catch(() => undefined);
  }
  nextTrack(): void { this.playTrack(this.track + 1); }
  get trackName(): string | null { return this.playlist.length ? this.playlist[this.track].replace(/\.[a-z0-9]+$/i, '') : null; }

  private duck = 1;
  setVolumes(sfx: number, music: number): void {
    this.sfxVolume = sfx; this.musicVolume = music;
    if (this.sfx) this.sfx.gain.value = sfx * (this.duck < 1 ? 0 : 1);
    if (this.music) this.music.volume = music * this.duck;
  }
  /** Pause ducking: 1 = normal, 0.3 = paused. Effects are silenced while paused. */
  setDuck(d: number): void {
    this.duck = d;
    if (this.sfx) this.sfx.gain.value = d < 1 ? 0 : this.sfxVolume;
    if (this.music) this.music.volume = this.musicVolume * d;
  }
  stopMusic(): void { this.music?.pause(); }

  // ---------------------------------------------------------------- one-shots
  private jitter(): number { return 0.92 + Math.random() * 0.16; }
  private pick<T>(v: T[]): T { return v[Math.floor(Math.random() * v.length)]; }

  /** Filtered noise burst. `sweep` glides the filter from freq to sweep over the burst. */
  private burst(type: BiquadFilterType, freq: number, dur: number, gain: number, q = 0.7, sweep?: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq * this.jitter(), t);
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(30, sweep), t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true; src.loopStart = Math.random() * 1.5;
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t, Math.random() * 1.5); src.stop(t + dur);
  }
  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', glide?: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq * this.jitter(), t);
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.sfx); o.start(t); o.stop(t + dur);
  }

  chime(): void { this.tone(880, 0.25, 0.15); setTimeout(() => this.tone(1320, 0.35, 0.12), 120); }
  unloadChime(): void { this.tone(1320, 0.2, 0.12); setTimeout(() => this.tone(880, 0.3, 0.1), 110); }
  private jump(charge: number): void {
    // board creak then pop
    this.pick([() => this.tone(180, 0.12, 0.12, 'sawtooth', 240), () => this.tone(150, 0.14, 0.1, 'sawtooth', 260), () => this.tone(210, 0.1, 0.11, 'sawtooth', 280)])();
    this.burst('bandpass', 900 + 600 * charge, 0.14, 0.25 + 0.2 * charge, 1.2, 300);
  }
  private landing(shock: number, powder: number): void {
    const band = shock < 0.25 ? 0 : shock < 0.6 ? 1 : 2;
    const thumps = [
      [() => this.burst('lowpass', 420, 0.18, 0.35), () => this.burst('lowpass', 360, 0.2, 0.32), () => this.burst('lowpass', 480, 0.16, 0.3)],
      [() => this.burst('lowpass', 260, 0.28, 0.6), () => this.burst('lowpass', 300, 0.26, 0.6), () => this.burst('lowpass', 230, 0.3, 0.65)],
      [() => this.burst('lowpass', 160, 0.42, 0.95), () => this.burst('lowpass', 190, 0.4, 0.9), () => this.burst('lowpass', 140, 0.45, 1.0)],
    ];
    this.pick(thumps[band])();
    // spray whoosh, bigger in powder
    this.burst('bandpass', 1500, 0.25 + 0.3 * shock, (0.1 + 0.3 * shock) * (0.6 + 0.6 * powder), 0.6, 500);
  }
  private crash(): void {
    this.pick([() => this.burst('lowpass', 110, 0.55, 1.0), () => this.burst('lowpass', 130, 0.5, 0.95), () => this.burst('lowpass', 95, 0.6, 1.0)])();
    this.burst('bandpass', 2400, 0.35, 0.3, 1.5, 700); // crunch
    setTimeout(() => this.burst('lowpass', 500, 0.35, 0.3), 140); // tumble
  }
  private ramp(): void { this.pick([() => this.burst('bandpass', 650, 0.2, 0.5, 1.0, 1200), () => this.burst('bandpass', 560, 0.22, 0.5, 1.0, 1100), () => this.burst('bandpass', 720, 0.18, 0.45, 1.0, 1300)])(); }
  private graze(): void { this.pick([() => this.burst('lowpass', 420, 0.16, 0.4), () => this.burst('lowpass', 380, 0.18, 0.4), () => this.burst('lowpass', 460, 0.15, 0.38)])(); }
  private brush(): void { this.burst('highpass', 2500 + Math.random() * 1500, 0.12, 0.12, 0.5); }
  private towerClunk(): void { this.pick([() => this.tone(140, 0.18, 0.2, 'square', 90), () => this.tone(160, 0.16, 0.2, 'square', 95), () => this.tone(125, 0.2, 0.22, 'square', 85)])(); this.burst('bandpass', 1800, 0.08, 0.1, 2); }
  private bullWheel(): void { this.burst('lowpass', 120, 1.2, 0.3); this.tone(70, 1.0, 0.1, 'triangle'); }

  /** Per frame. `passedTower` is true on the frame the chair passes a tower. */
  update(r: Rider, tuck: boolean, riding: boolean, dt: number, passedTower = false): void {
    if (!this.ctx) return;
    const k = Math.min(1, dt * 12);
    const lerp = (g: GainNode, target: number) => { g.gain.value += (target - g.gain.value) * k; };
    const spd = r.speed;
    const onSnow = r.onGround && !riding && spd > 0.3;
    const s = r.surface;
    const hard = Math.min(1, s.rock + s.scree);
    const groomed = s.groomed * (1 - hard);
    const powder = Math.max(0, 1 - groomed - hard) * (s.canopy > 0.3 ? 1 : 0.7);
    const crust = Math.max(0, 1 - groomed - hard) * Math.min(1, Math.max(0, (r.slopeDeg - 25) / 15)) * (s.canopy < 0.3 ? 1 : 0.3);
    const v = Math.min(1, spd / 25);
    // flow layers
    lerp(this.flowGroom.gain, onSnow ? 0.05 + 0.3 * v * groomed : 0);
    this.flowGroom.filter.frequency.value = 1800 + 60 * spd;
    lerp(this.flowPow.gain, onSnow ? 0.05 + 0.35 * v * powder : 0);
    this.flowPow.filter.frequency.value = 250 + 20 * spd;
    lerp(this.rumble.gain, onSnow ? 0.08 * v * powder : 0);
    this.rumble.osc.frequency.value = 38 + spd * 0.6;
    lerp(this.flowHard.gain, onSnow ? 0.04 + 0.3 * v * hard : 0);
    this.flowHard.filter.frequency.value = 3000 + 120 * spd;
    // crust: crackle by gating the layer with random pops
    this.crackleT -= dt;
    if (onSnow && crust > 0.1 && this.crackleT <= 0) { this.crackleT = 0.03 + Math.random() * 0.12 / Math.max(0.2, crust * v); this.flowCrust.gain.gain.value = 0.12 * crust * v; }
    else lerp(this.flowCrust.gain, 0);
    // carve: toe vs heel by edge sign; skid chatter
    const edge = Math.abs(r.edgeAngle);
    const carveG = onSnow ? Math.min(0.5, (0.03 + 0.5 * edge * v) * (0.5 + 0.5 * groomed + 0.6 * hard)) : 0;
    lerp(this.carveToe.gain, r.edgeAngle > 0 ? carveG : 0);
    lerp(this.carveHeel.gain, r.edgeAngle < 0 ? carveG : 0);
    this.carveToe.filter.frequency.value = 2600 + 1200 * edge + 30 * spd;
    this.carveHeel.filter.frequency.value = 1700 + 900 * edge + 30 * spd;
    lerp(this.skidL.gain, onSnow ? Math.min(0.45, r.skid * 0.5 * (0.6 + 0.4 * v) * (1 + hard)) : 0);
    this.skidL.filter.frequency.value = 4500 + 2000 * r.skid;
    // wind
    const windV = riding ? 0.25 : 1;
    lerp(this.windLo.gain, Math.min(0.5, Math.max(0, spd - 6) * 0.018 * (tuck ? 1.4 : 1)) * windV);
    this.windLo.filter.frequency.value = 200 + 25 * spd;
    lerp(this.windHi.gain, Math.min(0.12, Math.max(0, spd - 20) * 0.012) * windV);
    this.windHi.filter.frequency.value = 2000 + 40 * spd;
    lerp(this.liftGain, riding ? 0.08 : 0);
    // one-shots
    if (this.wasOnGround && !r.onGround && r.airTime < 0.05 && r.lastHit !== 'ramp') this.jump(Math.min(1, r.vz / 7));
    if (!this.wasOnGround && r.onGround) this.landing(r.landingShock, powder);
    if (r.crashed > 1.15) this.crash();
    if (r.lastHit === 'ramp') this.ramp();
    else if (r.lastHit === 'graze') this.graze();
    this.brushT -= dt;
    if (onSnow && s.canopy > 0.5 && spd > 6 && this.brushT <= 0) { this.brushT = 0.4 + Math.random() * 1.6; this.brush(); }
    if (riding && !this.wasRiding) { this.chime(); this.bullWheel(); }
    if (!riding && this.wasRiding) { this.unloadChime(); this.bullWheel(); }
    if (passedTower) this.towerClunk();
    this.wasOnGround = r.onGround;
    this.wasRiding = riding;
  }
}
