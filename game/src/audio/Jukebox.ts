/**
 * Procedural jukebox in Web Audio, one style per playlist so every playlist plays something
 * before real tracks are added. No samples: drums are noise bursts and pitch-dropped sines,
 * everything tonal is oscillators through filters (and a waveshaper for distortion). Each track
 * is a seed that picks tempo, key, progression and melody, so N gives a new song.
 *
 *  - ska: ska-punk / pop-punk, 158..183 BPM, off-beat upstrokes, power-chord choruses
 *  - house: melodic house, 120..124 BPM, four on the floor, wide pads, plucked 16th arpeggio
 *  - metal: 150..185 BPM, palm-muted chug riffs, double kick in the chorus, distorted lead
 *  - hiphop: boom-bap, 85..95 BPM, swung drums, jazzy electric-piano 7th chords, vinyl crackle
 */
export type JukeStyle = 'ska' | 'house' | 'metal' | 'hiphop';

const TRACK_NAMES: Record<JukeStyle, string[]> = {
  ska: ['Skank Run', 'Back Bowl Blitz', 'First Chair', 'Corduroy Kings', 'Lift Line Riot', 'Goggle Tan', 'Last Run Down', 'Powder Day Panic', 'Mongolia Bowl', 'Gondola Go'],
  house: ['Alpenglow', 'Blue Hour', 'Cloud Nine', 'Snowfall Theory', 'Treeline', 'Morning Corduroy', 'Cirrus', 'Quiet Bowl', 'Lantern Lift', 'Long Traverse'],
  metal: ['Avalanche Control', 'Cornice Drop', 'Double Black', 'Iron Chair', 'Whiteout', 'Couloir', 'Rock Band Steeps', 'Frostbite', 'No Fall Zone', 'Bulletproof'],
  hiphop: ['Lift Line Cipher', 'Fresh Tracks', 'Apres Loop', 'Chairlift Notes', 'Village Corner', 'Warm Gloves', 'Cold Coffee', 'Slow Gondola', 'Gate Six', 'Night Groom'],
};

type Section = 'intro' | 'verse' | 'chorus' | 'bridge' | 'build' | 'drop' | 'break' | 'outro' | 'end';
type Quality = 'M' | 'm' | 'm7' | 'M7' | '7' | 'm9';
type Chord = [number, Quality];
const TONES: Record<Quality, number[]> = { M: [0, 4, 7], m: [0, 3, 7], m7: [0, 3, 7, 10], M7: [0, 4, 7, 11], '7': [0, 4, 7, 10], m9: [0, 3, 7, 10, 14] };

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a += 0x6d2b79f5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

// progressions as semitone offsets from the key root
const PROGRESSIONS: Record<JukeStyle, Chord[][]> = {
  ska: [
    [[0, 'M'], [7, 'M'], [9, 'm'], [5, 'M']], // I V vi IV
    [[0, 'M'], [5, 'M'], [7, 'M'], [7, 'M']], // I IV V V
    [[9, 'm'], [5, 'M'], [0, 'M'], [7, 'M']], // vi IV I V
    [[0, 'M'], [5, 'M'], [9, 'm'], [7, 'M']], // I IV vi V
    [[2, 'm'], [7, 'M'], [0, 'M'], [0, 'M']], // ii V I I
  ],
  house: [
    [[0, 'm7'], [8, 'M7'], [3, 'M'], [10, 'M']], // i VI III VII
    [[0, 'm'], [10, 'M'], [8, 'M7'], [10, 'M']], // i VII VI VII
    [[8, 'M7'], [10, 'M'], [0, 'm7'], [0, 'm7']], // VI VII i i
    [[0, 'm9'], [5, 'm7'], [8, 'M7'], [7, 'm']], // i iv VI v
  ],
  metal: [
    [[0, 'm'], [8, 'M'], [10, 'M'], [0, 'm']], // i VI VII i
    [[0, 'm'], [1, 'M'], [0, 'm'], [10, 'M']], // i bII i VII (phrygian)
    [[0, 'm'], [5, 'm'], [8, 'M'], [7, 'M']], // i iv VI V
    [[0, 'm'], [3, 'M'], [10, 'M'], [8, 'M']], // i III VII VI
  ],
  hiphop: [
    [[2, 'm9'], [7, '7'], [0, 'M7'], [0, 'M7']], // ii V I
    [[0, 'm9'], [5, 'm7'], [10, '7'], [3, 'M7']], // i iv VII III
    [[0, 'm7'], [8, 'M7'], [5, 'm7'], [7, '7']], // i VI iv V
    [[5, 'M7'], [4, 'm7'], [2, 'm7'], [0, 'M7']], // IV iii ii I
  ],
};

const PLANS: Record<JukeStyle, [Section, number][]> = {
  ska: [['intro', 4], ['verse', 8], ['chorus', 8], ['verse', 8], ['chorus', 8], ['bridge', 8], ['chorus', 8], ['chorus', 8]],
  house: [['intro', 8], ['build', 8], ['drop', 16], ['break', 8], ['drop', 16], ['outro', 8]],
  metal: [['intro', 4], ['verse', 8], ['chorus', 8], ['verse', 8], ['chorus', 8], ['bridge', 8], ['chorus', 8]],
  hiphop: [['intro', 4], ['verse', 16], ['chorus', 8], ['verse', 16], ['chorus', 8], ['outro', 4]],
};

type Drum = 'kick' | 'snare' | 'hat' | 'hatOpen' | 'crash' | 'clap';

export class Jukebox {
  private ctx: AudioContext;
  private out: GainNode;
  private shaper: WaveShaperNode;
  private noise: AudioBuffer;
  private timer: number | null = null;
  private endTimer: number | null = null;
  private nextBeat = 0; // absolute beat index
  private nextTime = 0;
  private bpm = 170;
  private root = 52;
  private prog: Chord[] = PROGRESSIONS.ska[0];
  private rnd: () => number = Math.random;
  private seed = 0;
  private lead: number[] = [];
  private leadPos = 0;
  private riff: (number | null)[] = []; // metal: 8 eighth-note chug offsets per bar, null = rest
  private arp: number[] = []; // house: chord-tone indices for the 16th pluck
  private kickPat: boolean[] = []; // hiphop: 8 eighths per bar
  style: JukeStyle = 'ska';
  playing = false;
  onTrackStart: ((name: string) => void) | null = null;
  /** fires a breath after the last bar; the owner picks what plays next */
  onEnded: (() => void) | null = null;

  constructor(ctx: AudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain(); this.out.gain.value = 0.6;
    // gentle master compression so the mix does not clip
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.15;
    this.out.connect(comp).connect(dest);
    this.shaper = ctx.createWaveShaper();
    const curve = new Float32Array(512);
    for (let i = 0; i < 512; i++) { const x = (i / 255.5) - 1; curve[i] = Math.tanh(x * 3) * 0.8; }
    this.shaper.curve = curve; this.shaper.oversample = '2x';
    this.shaper.connect(this.out);
    const n = ctx.sampleRate * 1;
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }

  get volume(): number { return this.out.gain.value; }
  set volume(v: number) { this.out.gain.value = v; }

  get trackName(): string { const n = TRACK_NAMES[this.style]; return n[this.seed % n.length]; }

  /** Start a track by seed (any integer) in a style. */
  play(seed: number, style: JukeStyle = this.style): void {
    this.stop();
    this.style = style;
    this.seed = Math.abs(Math.floor(seed));
    const r = this.rnd = mulberry(this.seed * 7919 + 13 + ['ska', 'house', 'metal', 'hiphop'].indexOf(style) * 104729);
    const progs = PROGRESSIONS[style];
    this.prog = progs[Math.floor(r() * progs.length)];
    let scale: number[];
    if (style === 'ska') { this.bpm = 158 + Math.floor(r() * 26); this.root = 48 + Math.floor(r() * 10); scale = [0, 2, 4, 7, 9, 12, 14, 16]; }
    else if (style === 'house') { this.bpm = 120 + Math.floor(r() * 5); this.root = 45 + Math.floor(r() * 8); scale = [0, 3, 5, 7, 10, 12, 15, 17]; }
    else if (style === 'metal') { this.bpm = 150 + Math.floor(r() * 36); this.root = 38 + Math.floor(r() * 4); scale = [0, 3, 5, 7, 10, 12, 15, 17]; }
    else { this.bpm = 85 + Math.floor(r() * 11); this.root = 48 + Math.floor(r() * 8); scale = [0, 3, 5, 7, 10, 12, 15, 17]; }
    // lead: 32 notes on the pentatonic, random walk
    let i = 3; this.lead = [];
    for (let k = 0; k < 32; k++) { i = Math.max(0, Math.min(scale.length - 1, i + Math.floor(r() * 5) - 2)); this.lead.push(scale[i]); }
    this.leadPos = 0;
    // metal riff: mostly root chugs, a few accents on b2, b3, b5, 5
    const accents = [1, 3, 6, 7, 12];
    this.riff = Array.from({ length: 8 }, (_, k) => k === 0 ? 0 : r() < 0.15 ? null : r() < 0.25 ? accents[Math.floor(r() * accents.length)] : 0);
    // house arpeggio over chord tones
    this.arp = Array.from({ length: 16 }, () => Math.floor(r() * 4));
    // boom-bap kick: always on 1, then a couple of syncopated hits
    this.kickPat = [true, false, false, r() < 0.6, r() < 0.3, r() < 0.5, false, r() < 0.4];
    this.nextBeat = 0;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.playing = true;
    this.onTrackStart?.(this.trackName);
    this.timer = window.setInterval(() => this.schedule(), 80);
  }

  stop(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    if (this.endTimer !== null) { clearTimeout(this.endTimer); this.endTimer = null; }
    this.playing = false;
  }

  // ---------------------------------------------------------------- scheduling
  private sectionAt(bar: number): { section: Section; barIn: number } {
    let b = bar;
    for (const [s, len] of PLANS[this.style]) {
      if (b < len) return { section: s, barIn: b };
      b -= len;
    }
    return { section: 'end', barIn: 0 };
  }

  private schedule(): void {
    const beatDur = 60 / this.bpm;
    while (this.nextTime < this.ctx.currentTime + 0.25) {
      const beat = this.nextBeat;
      const bar = Math.floor(beat / 4), inBar = beat % 4;
      const { section, barIn } = this.sectionAt(bar);
      const t = this.nextTime;
      if (section === 'end') {
        this.finale(t, beatDur);
        this.stop();
        this.endTimer = window.setTimeout(() => { this.endTimer = null; this.onEnded?.(); }, beatDur * 2500);
        return;
      }
      const chord = this.prog[barIn % this.prog.length];
      if (this.style === 'ska') this.ska(t, beatDur, section, barIn, inBar, chord);
      else if (this.style === 'house') this.house(t, beatDur, section, barIn, inBar, chord);
      else if (this.style === 'metal') this.metal(t, beatDur, section, barIn, inBar, chord);
      else this.hiphop(t, beatDur, section, barIn, inBar, chord);
      this.nextBeat++;
      this.nextTime += beatDur;
    }
  }

  private finale(t: number, beatDur: number): void {
    const c = this.prog[0];
    if (this.style === 'house') { this.pad(t, c, beatDur * 6); this.kick(t, 'house'); }
    else if (this.style === 'hiphop') { this.epiano(t, c, beatDur * 4); }
    else { this.hit(t, 'crash'); this.chord(t, c, beatDur * 2, 'power'); }
  }

  private nextLead(): number { return this.lead[this.leadPos++ % this.lead.length]; }

  // ---------------------------------------------------------------- styles (one quarter-note beat each)
  private ska(t: number, bd: number, section: Section, barIn: number, inBar: number, chord: Chord): void {
    const half = section === 'bridge';
    if (section !== 'intro' || barIn >= 1) {
      if (half) { if (inBar === 0) this.kick(t, 'rock'); if (inBar === 2) this.hit(t, 'snare'); this.hit(t, 'hat'); this.hit(t + bd / 2, 'hat'); }
      else {
        if (inBar % 2 === 0) this.kick(t, 'rock'); else this.hit(t, 'snare');
        if (section === 'chorus' && inBar === 3) this.kick(t + bd / 2, 'rock');
        this.hit(t, 'hat'); this.hit(t + bd / 2, 'hatOpen');
      }
      if (inBar === 3 && barIn % 4 === 3) this.fill(t + bd / 2, bd / 2);
    }
    // bass: root on the beat, fifth / octave / approach on the off-beat
    const rootNote = this.root + chord[0];
    const bassOff = [7, 12, 7, (inBar === 3 ? -1 : 0)][inBar];
    this.bass(t, rootNote - 12, bd * 0.45);
    if (!half || inBar % 2 === 1) this.bass(t + bd / 2, rootNote - 12 + bassOff, bd * 0.4);
    if (section === 'verse') this.chord(t + bd / 2, chord, bd * 0.22, 'skank');
    else if (section === 'chorus') { this.chord(t, chord, bd * 0.48, 'power'); this.chord(t + bd / 2, chord, bd * 0.45, 'power'); }
    else if (section === 'bridge') { if (inBar === 0) this.chord(t, chord, bd * 3.5, 'power'); }
    if (section === 'chorus') {
      this.leadNote(t, this.root + 12 + this.nextLead(), bd * 0.5);
      if (inBar % 2 === 1) this.leadNote(t + bd / 2, this.root + 12 + this.nextLead(), bd * 0.4);
    }
  }

  private house(t: number, bd: number, section: Section, barIn: number, inBar: number, chord: Chord): void {
    const full = section === 'drop';
    const kick = section !== 'break';
    if (kick) this.kick(t, 'house');
    if (section !== 'intro' || barIn >= 4) this.hit(t + bd / 2, 'hatOpen');
    if (full || section === 'build') { this.hit(t, 'hat'); this.hit(t + bd / 4, 'hat'); this.hit(t + bd * 3 / 4, 'hat'); }
    if (full && inBar % 2 === 1) this.hit(t, 'clap');
    // rolling off-beat sub bass
    if (section !== 'intro' && section !== 'break') this.sub(t + bd / 2, this.root - 12 + chord[0], bd * 0.45);
    // pads: one long chord per bar
    if (inBar === 0 && section !== 'intro') this.pad(t, chord, bd * 4);
    // plucked 16th arpeggio over the chord tones
    if (full || section === 'break') {
      const tones = TONES[chord[1]];
      for (let s = 0; s < 4; s++) {
        const idx = this.arp[(inBar * 4 + s) % 16];
        this.pluck(t + s * bd / 4, this.root + 12 + chord[0] + tones[idx % tones.length] + (idx >= tones.length ? 12 : 0), bd * 0.22);
      }
    }
    // riser noise sweep into the drop
    if (section === 'build' && barIn === 7 && inBar === 0) this.riser(t, bd * 4);
    if (section === 'break' && barIn === 7 && inBar === 0) this.riser(t, bd * 4);
    if (section === 'drop' && barIn === 0 && inBar === 0) this.hit(t, 'crash');
  }

  private metal(t: number, bd: number, section: Section, barIn: number, inBar: number, chord: Chord): void {
    const rootNote = this.root + chord[0];
    if (section === 'intro') {
      if (inBar === 0) { this.chord(t, chord, bd * 3.8, 'power', -12); this.hit(t, 'crash'); this.kick(t, 'metal'); }
      if (barIn === 3) { this.hit(t, 'snare'); this.hit(t + bd / 2, 'snare'); }
      return;
    }
    if (section === 'verse') {
      // palm-muted chug riff in eighths, kick doubles the riff, snare on 2 and 4
      for (let e = 0; e < 2; e++) {
        const off = this.riff[inBar * 2 + e];
        if (off === null) continue;
        this.chug(t + e * bd / 2, rootNote + off, bd * 0.32);
        this.kick(t + e * bd / 2, 'metal');
      }
      if (inBar % 2 === 1) this.hit(t, 'snare');
      this.hit(t, 'hat'); this.hit(t + bd / 2, 'hat');
    } else if (section === 'chorus') {
      // open power chords and a double-kick 16th roll
      if (inBar % 2 === 0) this.chord(t, chord, bd * 1.9, 'power', -12);
      for (let s = 0; s < 4; s++) this.kick(t + s * bd / 4, 'metal');
      if (inBar % 2 === 1) this.hit(t, 'snare');
      if (inBar === 0 && barIn % 4 === 0) this.hit(t, 'crash');
      this.leadNote(t, rootNote + 24 + this.nextLead(), bd * 0.9, true);
    } else {
      // bridge: half-time, sustained chord, the lead takes eighth-note runs
      if (inBar === 0) { this.chord(t, chord, bd * 3.8, 'power', -12); this.kick(t, 'metal'); }
      if (inBar === 2) this.hit(t, 'snare');
      this.hit(t, 'hatOpen');
      this.leadNote(t, rootNote + 24 + this.nextLead(), bd * 0.45, true);
      this.leadNote(t + bd / 2, rootNote + 24 + this.nextLead(), bd * 0.45, true);
    }
    this.bass(t, rootNote - 12, bd * 0.45);
    this.bass(t + bd / 2, rootNote - 12, bd * 0.4);
    if (inBar === 3 && barIn % 4 === 3) this.fill(t + bd / 2, bd / 2);
  }

  private hiphop(t: number, bd: number, section: Section, barIn: number, inBar: number, chord: Chord): void {
    const swing = bd * 0.6; // swung eighth
    // vinyl crackle all the way through
    for (let k = 0; k < 3; k++) if (this.rnd() < 0.6) this.crackle(t + this.rnd() * bd);
    // electric piano: chord on 1, a pushed re-hit on the and of 2
    if (inBar === 0) this.epiano(t, chord, bd * 1.8);
    if (inBar === 1 && section !== 'outro') this.epiano(t + swing, chord, bd * 1.2);
    if (section === 'intro' || section === 'outro') return;
    // boom-bap: kick pattern on swung eighths, snare on 2 and 4, hats on every eighth
    for (let e = 0; e < 2; e++) {
      const at = t + (e ? swing : 0);
      if (this.kickPat[inBar * 2 + e]) this.kick(at, 'boom');
      this.hit(at, 'hat');
    }
    if (inBar % 2 === 1) this.hit(t, 'snare');
    // upright-ish bass following the kick on the root
    if (inBar === 0) this.sub(t, this.root - 12 + chord[0], bd * 0.9);
    if (inBar === 2) this.sub(t + swing, this.root - 12 + chord[0] + 7, bd * 0.5);
    // the hook gets a muted horn line
    if (section === 'chorus' && (inBar === 0 || inBar === 2)) this.horn(t + (inBar === 2 ? swing : 0), this.root + 12 + this.nextLead(), bd * 0.8);
  }

  // ---------------------------------------------------------------- instruments
  private kick(t: number, kind: 'rock' | 'house' | 'metal' | 'boom'): void {
    const ctx = this.ctx;
    const [f0, f1, dec, gain] = kind === 'house' ? [140, 42, 0.32, 1.0] : kind === 'metal' ? [190, 55, 0.09, 0.75] : kind === 'boom' ? [120, 40, 0.38, 1.0] : [160, 45, 0.18, 0.9];
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dec * 0.5);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dec);
    o.connect(g).connect(this.out); o.start(t); o.stop(t + dec + 0.02);
    if (kind === 'metal') this.hit(t, 'hat'); // beater click
  }

  private hit(t: number, kind: Drum): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true; src.loopStart = Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    let dur = 0.1, gain = 0.3;
    if (kind === 'snare') { f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.8; dur = 0.16; gain = 0.55; const o = ctx.createOscillator(); o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.05); const og = ctx.createGain(); og.gain.setValueAtTime(0.4, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.09); o.connect(og).connect(this.out); o.start(t); o.stop(t + 0.1); }
    else if (kind === 'clap') {
      // three quick bursts, then the tail
      f.type = 'bandpass'; f.frequency.value = 1300; f.Q.value = 1.2; dur = 0.18; gain = 0.45;
      g.gain.setValueAtTime(0.0001, t);
      for (const d of [0, 0.011, 0.022]) { g.gain.setValueAtTime(gain, t + d); g.gain.exponentialRampToValueAtTime(0.05, t + d + 0.009); }
      g.gain.setValueAtTime(gain * 0.7, t + 0.033); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f).connect(g).connect(this.out); src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
      return;
    }
    else if (kind === 'hat') { f.type = 'highpass'; f.frequency.value = 7500; dur = 0.04; gain = 0.18; }
    else if (kind === 'hatOpen') { f.type = 'highpass'; f.frequency.value = 6500; dur = 0.12; gain = 0.16; }
    else { f.type = 'highpass'; f.frequency.value = 4500; dur = 0.9; gain = 0.35; }
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.out); src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
  }
  private fill(t: number, step: number): void {
    for (let i = 0; i < 2; i++) this.hit(t + i * step / 2, 'snare');
  }
  private crackle(t: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 3000;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.04 + Math.random() * 0.05, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.006);
    src.connect(f).connect(g).connect(this.out); src.start(t, Math.random() * 0.9); src.stop(t + 0.01);
  }
  private riser(t: number, dur: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(7000, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + dur * 0.95); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.out); src.start(t); src.stop(t + dur + 0.02);
  }
  private bass(t: number, note: number, dur: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(note);
    const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = midi(note) * 0.5;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(250, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.008); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    o.connect(f); o2.connect(g2).connect(f); f.connect(g).connect(this.out);
    o.start(t); o2.start(t); o.stop(t + dur + 0.02); o2.stop(t + dur + 0.02);
  }
  /** round sine sub with a soft attack (house and hip-hop) */
  private sub(t: number, note: number, dur: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = midi(note);
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = midi(note) * 2;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.55, t + 0.015); g.gain.setValueAtTime(0.5, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const g2 = ctx.createGain(); g2.gain.value = 0.12;
    o.connect(g); o2.connect(g2).connect(g); g.connect(this.out);
    o.start(t); o2.start(t); o.stop(t + dur + 0.02); o2.stop(t + dur + 0.02);
  }
  private chord(t: number, chord: Chord, dur: number, style: 'skank' | 'power', shift = 0): void {
    const ctx = this.ctx;
    const root = this.root + chord[0] + shift;
    const third = chord[1].startsWith('m') ? 3 : 4;
    const notes = style === 'power' ? [root, root + 7, root + 12] : [root + 12, root + 12 + third, root + 19];
    const f = ctx.createBiquadFilter(); f.type = 'lowpass';
    const g = ctx.createGain();
    if (style === 'skank') {
      f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(600, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.005); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      f.connect(g).connect(this.out);
    } else {
      f.frequency.value = 2600;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.006); g.gain.setValueAtTime(0.16, t + dur * 0.8); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      f.connect(g).connect(this.shaper);
    }
    for (const n of notes) {
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(n); o.detune.value = det;
        o.connect(f); o.start(t); o.stop(t + dur + 0.03);
      }
    }
  }
  /** palm-muted power chord: short, dark, distorted */
  private chug(t: number, note: number, dur: number): void {
    const ctx = this.ctx;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(1600, t); f.frequency.exponentialRampToValueAtTime(350, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.004); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    f.connect(g).connect(this.shaper);
    for (const n of [note, note + 7]) for (const det of [-8, 8]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(n); o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + dur + 0.02);
    }
  }
  /** wide detuned-saw pad with a slow swell */
  private pad(t: number, chord: Chord, dur: number): void {
    const ctx = this.ctx;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.7;
    f.frequency.setValueAtTime(500, t); f.frequency.linearRampToValueAtTime(1400, t + dur * 0.5); f.frequency.linearRampToValueAtTime(700, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.045, t + dur * 0.3); g.gain.setValueAtTime(0.045, t + dur * 0.8); g.gain.linearRampToValueAtTime(0.0001, t + dur);
    f.connect(g).connect(this.out);
    for (const n of TONES[chord[1]].slice(0, 4)) for (const det of [-12, 0, 12]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(this.root + chord[0] + n); o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + dur + 0.05);
    }
  }
  private pluck(t: number, note: number, dur: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(note);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 4; f.frequency.setValueAtTime(4200, t); f.frequency.exponentialRampToValueAtTime(500, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + 0.004); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f).connect(g).connect(this.out); o.start(t); o.stop(t + dur + 0.02);
  }
  /** Rhodes-ish electric piano: sine pairs with a bell partial that fades fast */
  private epiano(t: number, chord: Chord, dur: number): void {
    const ctx = this.ctx;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.01); g.gain.exponentialRampToValueAtTime(0.02, t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const trem = ctx.createGain(); trem.gain.value = 1;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 5; const lg = ctx.createGain(); lg.gain.value = 0.15;
    lfo.connect(lg).connect(trem.gain); lfo.start(t); lfo.stop(t + dur + 0.05);
    g.connect(trem).connect(this.out);
    TONES[chord[1]].forEach((n, k) => {
      const hz = midi(this.root + chord[0] + n + (k === 0 ? 0 : 12));
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = hz;
      const b = ctx.createOscillator(); b.type = 'sine'; b.frequency.value = hz * 4;
      const bg = ctx.createGain(); bg.gain.setValueAtTime(0.25, t); bg.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      o.connect(g); b.connect(bg).connect(g);
      o.start(t + k * 0.008); b.start(t + k * 0.008); o.stop(t + dur + 0.05); b.stop(t + 0.2);
    });
  }
  /** muted-trumpet stand-in: soft saw through a narrow bandpass with a little vibrato */
  private horn(t: number, note: number, dur: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(note);
    const vib = ctx.createOscillator(); vib.frequency.value = 5.5; const vg = ctx.createGain(); vg.gain.value = 6;
    vib.connect(vg).connect(o.detune);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1100; f.Q.value = 1.5;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.05); g.gain.setValueAtTime(0.07, t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f).connect(g).connect(this.out); o.start(t); vib.start(t); o.stop(t + dur + 0.02); vib.stop(t + dur + 0.02);
  }
  private leadNote(t: number, note: number, dur: number, dirty = false): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = dirty ? 'sawtooth' : 'square'; o.frequency.value = midi(note);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = dirty ? 3000 : 2200;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(dirty ? 0.06 : 0.09, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f).connect(g).connect(dirty ? this.shaper : this.out); o.start(t); o.stop(t + dur + 0.02);
  }
}
