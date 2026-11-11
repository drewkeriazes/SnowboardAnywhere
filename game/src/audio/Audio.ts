import type { Rider, SurfaceInfo } from '../sim/Rider';
import type { OutrunEvent } from '../sim/Outrun';
import type { Events } from '../core/Events';
import type { SnowState } from '../sim/SnowConditions';
import { Jukebox, type JukeStyle } from './Jukebox';
import { ChaseAudio } from './ChaseAudio';

/** playlist.json entry: a bare filename or a credited track */
export interface TrackInfo { file: string; title: string; artist?: string; license?: string; url?: string; playlist?: string }
export type MusicSource = 'files' | 'builtin' | 'off';
/** the built-in playlists, each with a matching jukebox style so it plays before files are added */
export const PLAYLISTS: { name: string; style: JukeStyle }[] = [
  { name: 'Ska-punk', style: 'ska' }, { name: 'Melodic house', style: 'house' }, { name: 'Metal', style: 'metal' }, { name: 'Lofi hip-hop', style: 'hiphop' },
  // no files on purpose: always the procedural ska jukebox
  { name: 'Classic ska', style: 'ska' },
];
export const SHUFFLE_ALL = 'all';
type QueueItem = { list: string } & ({ track: TrackInfo } | { style: JukeStyle; seed: number });

/**
 * Sound: everything is synthesised through Web Audio from one looping noise buffer plus
 * oscillators, so nothing needs sample files. Music comes from `public/music/playlist.json`:
 * `{ "playlists": { "Ska-punk": [...], "Metal": [...] } }` or an older flat list (one playlist).
 * The player picks a playlist (or Shuffle all); a playlist with no files plays its jukebox style.
 * The AudioContext is created on the first user gesture (menu click).
 *
 * Continuous layers (gains driven per frame from rider state):
 *  - flow: board on snow, mixed per surface: groomed corduroy hum, powder hush with a low
 *    rumble, hardpack / rock scrape, crust crackle on steep off-piste
 *  - carve: toe-side and heel-side edge layers (different pitch and grit), plus skid chatter
 *  - wind: broadband and a whistle above 20 m/s, ducked on a lift
 *  - lift: drive hum while riding
 * One-shots, each picked from three variants with +/- 8% pitch jitter: jump pop with a board
 * creak, landings in three impact bands with a spray whoosh, crash crunch, rock ramp, tree
 * graze and branch brush, snow off a bough (FEAT-217), tower clunk, bull-wheel rumble at terminals, boarding and unload chimes.
 * On foot (FEAT-067): a boot crunch per footstep by surface (groomed squeak, powder whump, ice
 * scrape), breathing that gets heavier with a sprint or a climb, binding ratchet clicks on and off.
 */
interface Layer { gain: GainNode; filter: BiquadFilterNode }

/** FEAT-103: reference rider weight (kg, about 180 lb) for the rock scrape level; a rider-weight setting can scale it later */
const RIDER_KG = 82;

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
  private breath!: Layer;
  private breathT = 0;
  private wasStrap: 'none' | 'off' | 'on' = 'none';
  private crackleT = 0;
  /** FEAT-103 rock: edge grind (gritty band through a waveshaper), base drag (low, rough), and the
   *  sample-and-hold skip that makes the grind stutter, plus the tick timer */
  private rockGrind!: Layer; private rockDrag!: Layer;
  private skipT = 0; private skipV = 1; private tickT = 0;
  private music: HTMLAudioElement | null = null;
  /** file tracks per playlist name, from playlist.json */
  private lists = new Map<string, TrackInfo[]>();
  private queue: QueueItem[] = [];
  private qi = 0;
  private seed = Math.floor(Math.random() * 1000);
  private jukebox: Jukebox | null = null;
  private musicGain!: GainNode;
  /** low-pass on the whole music bus (Outrun muffles the music as the monster closes in) */
  private musicFilter!: BiquadFilterNode;
  /** Outrun music stage gain 0..1, on top of the volume and the pause duck */
  private tension = 1;
  private chaseAudio: ChaseAudio | null = null;
  /** 'files' plays playlist.json (falls back to builtin when there is none), 'builtin' is the procedural jukebox */
  source: MusicSource = 'files';
  /** a playlist name or SHUFFLE_ALL */
  playlist = 'Lofi hip-hop';
  private playlistLoaded = false;
  private loadedResolve!: () => void;
  /** resolves once playlist.json has been read (after the first start()) */
  readonly loaded = new Promise<void>((r) => { this.loadedResolve = r; });
  onTrack: ((name: string) => void) | null = null;
  sfxVolume = 0.8;
  musicVolume = 0.5;
  private wasOnGround = true;
  private wasRiding = false;
  private brushT = 0;
  /** FEAT-159: last frame's brush under the board (a swish on the way in) */
  private wasShrub = 0;
  /** FEAT-140: time to the next board creak near the limits of a press */
  private creakT = 0;

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
    this.musicGain = ctx.createGain(); this.musicGain.gain.value = this.musicVolume * this.duck;
    this.musicFilter = ctx.createBiquadFilter(); this.musicFilter.type = 'lowpass'; this.musicFilter.frequency.value = 20000; this.musicFilter.Q.value = 0.5;
    this.musicGain.connect(this.musicFilter).connect(this.master);
    this.jukebox = new Jukebox(ctx, this.musicGain);
    this.jukebox.onEnded = () => this.advance();
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
    {
      // FEAT-103: the edge grind gets a soft-clip waveshaper for grit
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const filter = ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 3000; filter.Q.value = 1.4;
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(4 * x) * 0.8; }
      shaper.curve = curve;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(filter).connect(shaper).connect(gain).connect(this.sfx); src.start();
      this.rockGrind = { gain, filter };
    }
    this.rockDrag = layer('lowpass', 900, 0.9);
    this.carveToe = layer('bandpass', 3000, 1.6);
    this.carveHeel = layer('bandpass', 1900, 1.6);
    this.skidL = layer('bandpass', 5200, 1.2);
    this.windLo = layer('lowpass', 300, 0.5);
    this.windHi = layer('bandpass', 2400, 6);
    this.breath = layer('bandpass', 750, 0.8);
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
      if (r.ok) this.lists = parsePlaylists(await r.json());
    } catch { /* no music shipped */ }
    this.playlistLoaded = true;
    this.loadedResolve();
    this.startMusic();
  }

  /** Playlist names for the picker: the built-in four plus any extra ones playlist.json defines. */
  get playlistNames(): string[] {
    return [...PLAYLISTS.map((p) => p.name), ...[...this.lists.keys()].filter((n) => !PLAYLISTS.some((p) => p.name === n))];
  }
  private styleOf(list: string): JukeStyle { return PLAYLISTS.find((p) => p.name === list)?.style ?? 'ska'; }

  /** Build the play queue for the current source and playlist. */
  private buildQueue(): void {
    const files = this.source === 'files';
    const names = this.playlist === SHUFFLE_ALL ? this.playlistNames : [this.playlistNames.includes(this.playlist) ? this.playlist : PLAYLISTS[0].name];
    const q: QueueItem[] = [];
    for (const list of names) {
      const tracks = files ? this.lists.get(list) ?? [] : [];
      if (tracks.length) q.push(...tracks.map((track) => ({ list, track })));
      else if (PLAYLISTS.some((p) => p.name === list)) for (let k = 0; k < (names.length > 1 ? 3 : 6); k++) q.push({ list, style: this.styleOf(list), seed: this.seed++ });
    }
    if (this.playlist === SHUFFLE_ALL) {
      for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
    }
    this.queue = q;
    this.qi = 0;
  }

  /** (Re)start music for the current source and playlist. */
  startMusic(): void {
    if (!this.ctx || !this.playlistLoaded) return;
    this.music?.pause();
    this.jukebox?.stop();
    if (this.source === 'off') return;
    this.buildQueue();
    this.playItem();
  }
  setSource(src: MusicSource): void { if (src !== this.source) { this.source = src; this.startMusic(); } }
  setPlaylist(name: string): void { if (name !== this.playlist) { this.playlist = name; this.startMusic(); } }
  get hasFiles(): boolean { return this.lists.size > 0; }
  /** every shipped file track, tagged with its playlist, for the credits */
  get credits(): TrackInfo[] { return [...this.lists].flatMap(([list, ts]) => ts.map((t) => ({ ...t, playlist: list }))); }

  private playItem(): void {
    const it = this.queue[this.qi];
    if (!it) return;
    if ('track' in it) {
      this.jukebox?.stop();
      if (!this.music) {
        this.music = new Audio();
        this.music.addEventListener('ended', () => this.advance());
      }
      const t = it.track;
      this.music.src = `${import.meta.env.BASE_URL}music/${t.file}`;
      this.music.volume = this.musicVolume * this.duck;
      void this.music.play().catch(() => undefined);
      this.announce(`${t.artist ? `${t.title} by ${t.artist}` : t.title} · ${it.list}`);
    } else {
      this.music?.pause();
      this.jukebox?.play(it.seed, it.style);
      this.announce(`${this.jukebox?.trackName ?? ''} (built-in) · ${it.list}`);
    }
  }
  private nowPlayingText: string | null = null;
  private announce(text: string): void { this.nowPlayingText = text; this.onTrack?.(text); }
  /** toast text for the track playing right now ("title by artist · station"), null when music is off or silent */
  get nowPlaying(): string | null { return this.trackName === null ? null : this.nowPlayingText; }
  /** next queue item; a finished queue is rebuilt (reshuffled, fresh jukebox seeds) */
  private advance(): void {
    if (this.source === 'off') return;
    if (++this.qi >= this.queue.length) this.buildQueue();
    this.playItem();
  }
  nextTrack(): void { this.music?.pause(); this.jukebox?.stop(); this.advance(); }
  get trackName(): string | null {
    const it = this.queue[this.qi];
    if (!it || this.source === 'off') return null;
    return 'track' in it ? it.track.title : this.jukebox?.playing ? this.jukebox.trackName : null;
  }

  private duck = 1;
  setVolumes(sfx: number, music: number): void {
    this.sfxVolume = sfx; this.musicVolume = music;
    if (this.sfx) this.sfx.gain.value = sfx * (this.duck < 1 ? 0 : 1);
    this.applyMusicGain();
  }
  /** Pause ducking: 1 = normal, 0.3 = paused. Effects are silenced while paused. */
  setDuck(d: number): void {
    this.duck = d;
    if (this.sfx) this.sfx.gain.value = d < 1 ? 0 : this.sfxVolume;
    this.applyMusicGain();
  }
  private applyMusicGain(): void {
    const g = this.musicVolume * this.duck * this.tension;
    if (this.music) this.music.volume = Math.max(0, Math.min(1, g));
    if (this.musicGain) this.musicGain.gain.value = g;
  }
  /** Outrun (FEAT-098): music stage, a gain 0..1 and a low-pass cutoff (Hz) on the music bus. */
  setMusicStage(gain: number, lowpass: number): void {
    this.tension = gain;
    if (this.musicFilter && this.ctx) this.musicFilter.frequency.setTargetAtTime(lowpass, this.ctx.currentTime, 0.15);
    this.applyMusicGain();
  }
  /** Caught: a record-scratch stop (the file track winds down, the jukebox stops dead). */
  scratchStop(): void {
    const m = this.music;
    if (m && !m.paused) {
      const t0 = performance.now();
      const step = () => { const u = Math.min(1, (performance.now() - t0) / 400); m.playbackRate = Math.max(0.1, 1 - u); if (u < 1) requestAnimationFrame(step); else { m.pause(); m.playbackRate = 1; } };
      step();
    }
    this.jukebox?.stop();
  }
  /** After an Outrun run: the music back to normal and playing. */
  resumeMusic(): void {
    this.setMusicStage(1, 20000);
    if (this.music) this.music.playbackRate = 1;
    const it = this.queue[this.qi];
    if (this.source === 'off' || !this.ctx) return;
    if (it && 'track' in it && this.music) { if (this.music.paused) void this.music.play().catch(() => undefined); }
    else if (!this.jukebox?.playing) this.startMusic();
  }
  /** The Outrun chase sounds (FEAT-098), built on the first call once the context exists. */
  chase(): ChaseAudio | null {
    if (!this.ctx) return null;
    if (!this.chaseAudio) this.chaseAudio = new ChaseAudio(this.ctx, this.sfx, this.master, this.noiseBuf, (g, lp) => this.setMusicStage(g, lp));
    return this.chaseAudio;
  }
  stopMusic(): void { this.music?.pause(); this.jukebox?.stop(); }

  /** FEAT-163: the one-shots other systems announce: footsteps, the trial chimes, the Outrun and eat sounds. */
  listen(events: Events): void {
    events.on('footstep', (e) => this.footstep(e.surface, e.speed, e.sink, e.snow));
    events.on('trial', ({ event: e }) => { if (e.kind === 'start' || e.kind === 'finish') this.chime(); });
    events.on('outrun', ({ event: e }) => this.outrunEvent(e));
    events.on('eatSound', ({ sound: k }) => {
      const chase = this.chaseAudio;
      if (!chase) return;
      if (k === 'roar') chase.roar('angry'); else if (k === 'pop') chase.pop(); else if (k === 'gulp') chase.gulp();
      else if (k === 'burp') chase.burp(); else if (k === 'spit') chase.spit(); else if (k === 'sting') chase.sting();
    });
    events.on('treeCrack', () => this.chaseAudio?.crack());
  }
  /** an Outrun sim event to the chase sounds (the chase audio exists once an Outrun started with the context up) */
  private outrunEvent(e: OutrunEvent): void {
    const chase = this.chaseAudio;
    if (e.kind === 'wake') chase?.roar('wake');
    else if (e.kind === 'spawn') { if (e.m && e.m.id > 1) chase?.roar('spawn'); }
    else if (e.kind === 'roar') chase?.roar('spawn');
    else if (e.kind === 'sight') chase?.roar('sight');
    else if (e.kind === 'closecall') { chase?.roar('angry'); chase?.closeCall(); }
    else if (e.kind === 'footfall' && e.m) chase?.footfall(e.m.dist);
    else if (e.kind === 'escaped') { chase?.roar('giveup'); chase?.stop(); this.resumeMusic(); chase?.fanfare(); }
    else if (e.kind === 'caught' && e.m) { this.scratchStop(); chase?.stop(); }
  }

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
  /** FEAT-140: a short flex creak of the board, rougher and louder the nearer the press is to losing it (k 0..1) */
  private creak(k: number): void {
    this.pick([() => this.tone(120, 0.16, 0.05 + 0.05 * k, 'sawtooth', 165), () => this.tone(105, 0.18, 0.05 + 0.05 * k, 'sawtooth', 150), () => this.tone(140, 0.14, 0.05 + 0.05 * k, 'sawtooth', 185)])();
    this.burst('bandpass', 700 + 500 * k, 0.12, 0.04 + 0.05 * k, 3);
  }
  private crash(): void {
    this.pick([() => this.burst('lowpass', 110, 0.55, 1.0), () => this.burst('lowpass', 130, 0.5, 0.95), () => this.burst('lowpass', 95, 0.6, 1.0)])();
    this.burst('bandpass', 2400, 0.35, 0.3, 1.5, 700); // crunch
    setTimeout(() => this.burst('lowpass', 500, 0.35, 0.3), 140); // tumble
  }
  private ramp(): void { this.pick([() => this.burst('bandpass', 650, 0.2, 0.5, 1.0, 1200), () => this.burst('bandpass', 560, 0.22, 0.5, 1.0, 1100), () => this.burst('bandpass', 720, 0.18, 0.45, 1.0, 1300)])(); }
  private graze(): void { this.pick([() => this.burst('lowpass', 420, 0.16, 0.4), () => this.burst('lowpass', 380, 0.18, 0.4), () => this.burst('lowpass', 460, 0.15, 0.38)])(); }
  private brush(): void { this.burst('highpass', 2500 + Math.random() * 1500, 0.12, 0.12, 0.5); }
  /** FEAT-159: the board through willow stems or a juniper mat: a twiggy scratch and a soft swish, louder the more brush and speed (k 0..1) */
  private shrubBrush(k: number, v: number): void {
    const g = (0.4 + 0.6 * k) * (0.4 + 0.6 * v);
    this.burst('highpass', 2200 + Math.random() * 2200, 0.08 + 0.06 * Math.random(), 0.16 * g, 0.6);
    this.burst('bandpass', 700 + Math.random() * 500, 0.16, 0.12 * g, 0.7, 2400);
  }
  /** FEAT-217: snow off a bough onto the rider: a soft low thump and the hiss of it sifting down through the needles (k 0..1) */
  treePuff(k: number): void {
    if (!this.ctx) return;
    const g = 0.3 + 0.7 * Math.min(1, k);
    this.pick([() => this.burst('lowpass', 220, 0.22, 0.3 * g), () => this.burst('lowpass', 190, 0.25, 0.32 * g), () => this.burst('lowpass', 250, 0.2, 0.28 * g)])();
    this.burst('bandpass', 1600 + Math.random() * 900, 0.45 + 0.3 * k, 0.05 * g, 0.8, 700);
  }
  private towerClunk(): void { this.pick([() => this.tone(140, 0.18, 0.2, 'square', 90), () => this.tone(160, 0.16, 0.2, 'square', 95), () => this.tone(125, 0.2, 0.22, 'square', 85)])(); this.burst('bandpass', 1800, 0.08, 0.1, 2); }
  private bullWheel(): void { this.burst('lowpass', 120, 1.2, 0.3); this.tone(70, 1.0, 0.1, 'triangle'); }

  /**
   * One footstep, on the frame the boot comes down. Groomed snow squeaks (a short high band and a
   * tiny pitch chirp), powder whumps (low and soft, deeper the more the boot sinks), ice and rock
   * scrape (high and dry). A sprint lands harder.
   */
  footstep(s: SurfaceInfo, speed: number, sink: number, snow: SnowState): void {
    if (!this.ctx) return;
    // FEAT-053: ice scrapes like rock, slush squelches, chop is a soft crunch
    const hard = Math.min(1, s.rock + s.scree + 0.8 * snow.ice);
    const groomed = snow.groomed + 0.5 * snow.chop;
    const powder = snow.powder + 0.5 * snow.chop;
    const g = 0.5 + 0.5 * Math.min(1, speed / 3.8);
    if (snow.slush > 0.3) this.burst('lowpass', 420, 0.12, 0.3 * snow.slush * g, 0.5, 200);
    if (groomed > 0.3) {
      this.burst('bandpass', 2600, 0.09, 0.22 * groomed * g, 2.2, 1800);
      this.tone(1400 + Math.random() * 500, 0.05, 0.025 * groomed * g, 'triangle', 1900);
    }
    if (powder > 0.3) this.burst('lowpass', 260 + 200 * (1 - Math.min(1, sink / 0.2)), 0.2, 0.4 * powder * g, 0.6, 120);
    if (hard > 0.3) this.burst('highpass', 3200, 0.07, 0.25 * hard * g, 0.8);
    this.burst('lowpass', 500, 0.07, 0.12 * g); // the boot heel itself
  }

  /**
   * FEAT-103: board on exposed rock or scree. Edge grind (metallic, 1.8 to 5 kHz with speed, louder on
   * edge), base drag (300 Hz to 1.5 kHz, louder flat), both stuttered by a random skip at 8 to 30 Hz;
   * ticks and pebble clacks at 5 to 40 a second. Scree is looser: more ticks, less ring. Load (edge
   * pressure and landings) for an 82 kg rider deepens and raises it. Fades in over 30 ms, out over 120 ms.
   */
  private rockScrape(r: Rider, onSnow: boolean, dt: number): void {
    const s = r.surface, spd = r.speed;
    const rock = onSnow ? s.rock : 0, scree = onSnow ? s.scree : 0;
    const v = Math.min(1, spd / 20), edge = Math.min(1, Math.abs(r.edgeAngle));
    const load = (RIDER_KG / 82) * (1 + 0.5 * Math.min(1.5, Math.abs(r.lateralG)) + r.landingShock);
    this.skipT -= dt;
    if (this.skipT <= 0) { this.skipT = 1 / (8 + 22 * v) * (0.6 + 0.8 * Math.random()); this.skipV = 0.35 + 0.65 * Math.random(); }
    const ease = (g: GainNode, target: number) => { const k = Math.min(1, dt / (target > g.gain.value ? 0.03 : 0.12)); g.gain.value += (target - g.gain.value) * k; };
    const metal = rock + 0.25 * scree; // scree rings far less
    ease(this.rockGrind.gain, Math.min(0.45, metal * v * (0.25 + 0.75 * edge) * load * 0.5 * this.skipV));
    this.rockGrind.filter.frequency.value = 1800 + 3200 * v * (0.7 + 0.3 * edge);
    ease(this.rockDrag.gain, Math.min(0.4, (rock + 0.7 * scree) * v * (1 - 0.7 * edge) * load * 0.45 * (0.6 + 0.4 * this.skipV)));
    this.rockDrag.filter.frequency.value = 300 + 1200 * v;
    // ticks and pebbles
    const hit = rock + 1.6 * scree;
    if (hit > 0.15 && spd > 1) {
      this.tickT -= dt;
      if (this.tickT <= 0) {
        this.tickT = (1 / (5 + 35 * v)) * (0.4 + 1.2 * Math.random()) / Math.min(1.5, hit);
        const looseness = scree / Math.max(1e-3, rock + scree);
        this.burst('highpass', 2500 + 3500 * Math.random() * (1 - 0.4 * looseness), 0.01 + 0.02 * Math.random(), 0.12 * Math.min(1, hit) * (0.5 + 0.5 * v));
        if (Math.random() < 0.35 * (1 - looseness)) this.tone(2200 + 2400 * Math.random(), 0.012, 0.03 * v, 'square'); // a steel click
      }
    } else this.tickT = 0;
  }

  /** Binding ratchets: a quick run of clicks (strapping in) or a couple of releases (unstrapping). */
  private bindings(on: boolean): void {
    const clicks = on ? [0.45, 0.52, 0.59, 0.66, 0.8, 0.87, 0.94] : [0.12, 0.3];
    for (const t of clicks) setTimeout(() => { this.burst('highpass', on ? 4200 : 3000, 0.025, 0.25, 1.5); this.tone(2400, 0.02, 0.04, 'square'); }, t * 1000);
  }

  /** Per frame. `passedTower` is true on the frame the chair passes a tower. */
  update(r: Rider, tuck: boolean, riding: boolean, dt: number, passedTower = false): void {
    if (!this.ctx) return;
    const k = Math.min(1, dt * 12);
    const lerp = (g: GainNode, target: number) => { g.gain.value += (target - g.gain.value) * k; };
    const spd = r.speed;
    const onSnow = r.onGround && !riding && spd > 0.3 && !r.unstrapped; // board on snow
    const s = r.surface, sn = r.snow;
    // FEAT-053: the sound follows the snow state. Ice rides on the hardpack scrape layer (dry and
    // high), slush on the powder hush pitched up (wet), chop on the crust crackle.
    const hard = Math.min(1, s.rock + s.scree + 0.8 * sn.ice);
    // FEAT-103: on rock there is no snow under the board, so the snow layers duck
    const snowLeft = 1 - Math.min(1, s.rock + 0.6 * s.scree);
    const groomed = sn.groomed;
    const powder = Math.min(1, sn.powder + 0.8 * sn.slush);
    const crust = Math.min(1, sn.chop + Math.max(0, 1 - groomed - hard) * Math.min(1, Math.max(0, (r.slopeDeg - 25) / 15)) * (s.canopy < 0.3 ? 1 : 0.3));
    const v = Math.min(1, spd / 25);
    // flow layers
    lerp(this.flowGroom.gain, onSnow ? (0.05 + 0.3 * v * groomed) * snowLeft : 0);
    this.flowGroom.filter.frequency.value = 1800 + 60 * spd;
    lerp(this.flowPow.gain, onSnow ? (0.05 + 0.35 * v * powder) * snowLeft : 0);
    this.flowPow.filter.frequency.value = 250 + 20 * spd + 350 * sn.slush;
    lerp(this.rumble.gain, onSnow ? 0.08 * v * powder * snowLeft : 0);
    this.rumble.osc.frequency.value = 38 + spd * 0.6;
    lerp(this.flowHard.gain, onSnow ? (0.04 + 0.3 * v * hard) * (0.4 + 0.6 * snowLeft) : 0);
    this.flowHard.filter.frequency.value = 3000 + 120 * spd;
    // crust: crackle by gating the layer with random pops
    this.crackleT -= dt;
    if (onSnow && crust > 0.1 && this.crackleT <= 0) { this.crackleT = 0.03 + Math.random() * 0.12 / Math.max(0.2, crust * v); this.flowCrust.gain.gain.value = 0.12 * crust * v; }
    else lerp(this.flowCrust.gain, 0);
    // carve: toe vs heel by edge sign; skid chatter
    const edge = Math.abs(r.edgeAngle);
    // FEAT-148: a hard carve's edge hisses louder and higher with the g it pulls (2.5 g full)
    const hiss = onSnow ? r.hardCarve * Math.min(1, Math.abs(r.lateralG) / 2.5) : 0;
    const carveG = onSnow ? Math.min(0.5 + 0.2 * hiss, (0.03 + 0.5 * edge * v) * (0.5 + 0.5 * groomed + 0.6 * hard) * (1 + 0.6 * hiss)) : 0;
    const toe = r.edgeAngle * r.toeSign; // FEAT-139: the toe edge is the heading's left riding switch or goofy
    lerp(this.carveToe.gain, toe > 0 ? carveG : 0);
    lerp(this.carveHeel.gain, toe < 0 ? carveG : 0);
    this.carveToe.filter.frequency.value = 2600 + 1200 * edge + 30 * spd + 1500 * hiss;
    this.carveHeel.filter.frequency.value = 1700 + 900 * edge + 30 * spd + 1200 * hiss;
    // skid chatter, and the edge scraping through a brake (louder and higher on hard snow)
    const scrub = Math.max(r.skid, r.scrape);
    lerp(this.skidL.gain, onSnow ? Math.min(0.5, scrub * 0.5 * (0.6 + 0.4 * v) * (1 + hard)) : 0);
    this.skidL.filter.frequency.value = 4500 + 2000 * scrub;
    this.rockScrape(r, onSnow, dt);
    // wind
    const windV = riding ? 0.25 : 1;
    lerp(this.windLo.gain, Math.min(0.5, Math.max(0, spd - 6) * 0.018 * (tuck ? 1.4 : 1)) * windV);
    this.windLo.filter.frequency.value = 200 + 25 * spd;
    lerp(this.windHi.gain, Math.min(0.12, Math.max(0, spd - 20) * 0.012) * windV);
    this.windHi.filter.frequency.value = 2000 + 40 * spd;
    lerp(this.liftGain, riding ? 0.08 : 0);
    // breathing on foot: in and out at a rate and strength that rise with the effort
    const ex = r.onFoot ? r.exertion : 0;
    this.breathT += dt * (0.3 + 0.6 * ex);
    const env = Math.max(0, Math.sin(this.breathT * Math.PI * 2));
    lerp(this.breath.gain, r.onFoot ? (0.006 + 0.07 * ex) * env * env : 0);
    this.breath.filter.frequency.value = 650 + 350 * env;
    if (r.strapState !== this.wasStrap && r.strapState !== 'none') this.bindings(r.strapState === 'on');
    this.wasStrap = r.strapState;
    // one-shots
    if (this.wasOnGround && !r.onGround && r.airTime < 0.05 && r.lastHit !== 'ramp') {
      if (r.onFoot) this.burst('lowpass', 600, 0.1, 0.15); else this.jump(Math.min(1, r.vz / 7));
    }
    if (!this.wasOnGround && r.onGround && !r.onFoot) this.landing(r.landingShock, powder);
    if (r.crashed > 1.15) this.crash();
    if (r.lastHit === 'ramp') this.ramp();
    else if (r.lastHit === 'graze') this.graze();
    this.brushT -= dt;
    // FEAT-140: the board creaks as a press nears either end of the balance meter, quicker the closer it gets
    this.creakT -= dt;
    const pb = r.pressing && onSnow ? Math.abs(r.pressBalance) : 0;
    if (pb > 0.65 && this.creakT <= 0) { const k = Math.min(1, (pb - 0.65) / 0.35); this.creakT = 0.45 - 0.25 * k + Math.random() * 0.12; this.creak(k); }
    // FEAT-159: brush under the board: a swish on the way in, then every 0.1 to 0.25 s while it lasts
    const shrub = onSnow && spd > 1.5 ? s.shrub : 0;
    if (shrub > 0.05 && (this.brushT <= 0 || this.wasShrub <= 0.05)) { this.brushT = 0.1 + Math.random() * 0.15; this.shrubBrush(shrub, Math.min(1, spd / 15)); }
    else if (onSnow && s.canopy > 0.5 && spd > 6 && this.brushT <= 0) { this.brushT = 0.4 + Math.random() * 1.6; this.brush(); }
    this.wasShrub = shrub;
    if (riding && !this.wasRiding) { this.chime(); this.bullWheel(); }
    if (!riding && this.wasRiding) { this.unloadChime(); this.bullWheel(); }
    if (passedTower) this.towerClunk();
    this.wasOnGround = r.onGround;
    this.wasRiding = riding;
  }
}

/** playlist.json: `{ "playlists": { name: [entry, ...] } }`, or a flat `[entry, ...]` read as Ska-punk. */
export function parsePlaylists(raw: unknown): Map<string, TrackInfo[]> {
  const entry = (e: unknown): TrackInfo | null => {
    if (typeof e === 'string') return { file: e, title: e.replace(/\.[a-z0-9]+$/i, '') };
    if (e && typeof e === 'object' && typeof (e as TrackInfo).file === 'string') { const t = e as TrackInfo; return { ...t, title: t.title || t.file }; }
    return null;
  };
  const list = (v: unknown) => (Array.isArray(v) ? v.map(entry).filter((t): t is TrackInfo => !!t) : []);
  const out = new Map<string, TrackInfo[]>();
  if (Array.isArray(raw)) { const l = list(raw); if (l.length) out.set(PLAYLISTS[0].name, l); }
  else if (raw && typeof raw === 'object' && (raw as { playlists?: unknown }).playlists) {
    for (const [name, v] of Object.entries((raw as { playlists: Record<string, unknown> }).playlists)) { const l = list(v); if (l.length) out.set(name, l); }
  }
  return out;
}
