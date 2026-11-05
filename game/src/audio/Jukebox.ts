/**
 * Procedural ska-punk / pop-punk jukebox in Web Audio. No samples: drums are noise bursts and
 * pitch-dropped sines, bass is a filtered saw, guitar upstrokes are detuned saws through a
 * fast-decay lowpass, chorus power chords go through a waveshaper. Each "track" is a seed that
 * picks tempo, key, chord progressions and the lead melody, so N gives a new song.
 *
 * Structure per track: intro (4 bars, drums + bass) -> verse (8, upstrokes) -> chorus (8,
 * power chords + lead) -> verse -> chorus -> bridge (8, half-time) -> chorus x2 -> end.
 */
const TRACK_NAMES = ['Skank Run', 'Back Bowl Blitz', 'First Chair', 'Corduroy Kings', 'Lift Line Riot', 'Goggle Tan', 'Last Run Down', 'Powder Day Panic', 'Mongolia Bowl', 'Gondola Go'];

type Section = 'intro' | 'verse' | 'chorus' | 'bridge' | 'end';

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a += 0x6d2b79f5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
// chord degrees as semitone offsets from the key root (major scale), with quality
type Chord = [number, 'M' | 'm'];
const PROGRESSIONS: Chord[][] = [
  [[0, 'M'], [7, 'M'], [9, 'm'], [5, 'M']], // I V vi IV
  [[0, 'M'], [5, 'M'], [7, 'M'], [7, 'M']], // I IV V V
  [[9, 'm'], [5, 'M'], [0, 'M'], [7, 'M']], // vi IV I V
  [[0, 'M'], [5, 'M'], [9, 'm'], [7, 'M']], // I IV vi V
  [[2, 'm'], [7, 'M'], [0, 'M'], [0, 'M']], // ii V I I
];

export class Jukebox {
  private ctx: AudioContext;
  private out: GainNode;
  private shaper: WaveShaperNode;
  private noise: AudioBuffer;
  private timer: number | null = null;
  private nextBeat = 0; // absolute beat index
  private nextTime = 0;
  private bpm = 170;
  private root = 52; // E3
  private prog = PROGRESSIONS[0];
  private rnd: () => number = Math.random;
  private seed = 0;
  private plan: Section[] = [];
  private lead: number[] = [];
  private leadPos = 0;
  playing = false;
  onTrackStart: ((name: string) => void) | null = null;

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

  get trackName(): string { return TRACK_NAMES[this.seed % TRACK_NAMES.length]; }

  /** Start a track by seed (any integer). */
  play(seed: number): void {
    this.stop();
    this.seed = Math.abs(Math.floor(seed));
    this.rnd = mulberry(this.seed * 7919 + 13);
    this.bpm = 158 + Math.floor(this.rnd() * 26); // 158..183
    this.root = 48 + Math.floor(this.rnd() * 10); // C3..A3
    this.prog = PROGRESSIONS[Math.floor(this.rnd() * PROGRESSIONS.length)];
    this.plan = ['intro', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus', 'chorus', 'end'];
    // lead: 32 notes on the major pentatonic, random walk
    const penta = [0, 2, 4, 7, 9, 12, 14, 16];
    let i = 3; this.lead = [];
    for (let k = 0; k < 32; k++) { i = Math.max(0, Math.min(penta.length - 1, i + Math.floor(this.rnd() * 5) - 2)); this.lead.push(penta[i]); }
    this.leadPos = 0;
    this.nextBeat = 0;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.playing = true;
    this.onTrackStart?.(this.trackName);
    this.timer = window.setInterval(() => this.schedule(), 80);
  }

  next(): void { this.play(this.seed + 1); }

  stop(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.playing = false;
  }

  // ---------------------------------------------------------------- scheduling
  private sectionAt(bar: number): { section: Section; barIn: number } {
    let b = bar;
    for (const s of this.plan) {
      const len = s === 'intro' ? 4 : s === 'end' ? 1 : 8;
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
      if (section === 'end' && barIn === 0 && inBar === 0) {
        // final hit then the next track after a breath
        this.hit(this.nextTime, 'crash');
        this.chord(this.nextTime, this.prog[0], beatDur * 2, 'power');
        this.stop();
        window.setTimeout(() => this.next(), beatDur * 2500);
        return;
      }
      const chord = this.prog[Math.floor(barIn % this.prog.length)];
      const t = this.nextTime;
      const half = section === 'bridge';
      // drums
      if (section !== 'intro' || barIn >= 1) {
        if (half) { if (inBar === 0) this.hit(t, 'kick'); if (inBar === 2) this.hit(t, 'snare'); this.hit(t, 'hat'); this.hit(t + beatDur / 2, 'hat'); }
        else {
          this.hit(t, inBar % 2 === 0 ? 'kick' : 'snare');
          if (section === 'chorus' && inBar === 3) this.hit(t + beatDur / 2, 'kick');
          this.hit(t, 'hat'); this.hit(t + beatDur / 2, 'hatOpen');
        }
        if (inBar === 3 && barIn % 4 === 3) this.fill(t + beatDur / 2, beatDur / 2);
      }
      // bass: root on the beat, fifth / octave / approach on the off-beat
      const rootNote = this.root + chord[0];
      const bassOff = [7, 12, 7, (inBar === 3 ? -1 : 0)][inBar];
      this.bass(t, rootNote - 12, beatDur * 0.45);
      if (!half || inBar % 2 === 1) this.bass(t + beatDur / 2, rootNote - 12 + bassOff, beatDur * 0.4);
      // guitar
      if (section === 'verse' || section === 'intro') { if (section === 'verse') this.chord(t + beatDur / 2, chord, beatDur * 0.22, 'skank'); }
      else if (section === 'chorus') { this.chord(t, chord, beatDur * 0.48, 'power'); this.chord(t + beatDur / 2, chord, beatDur * 0.45, 'power'); }
      else if (section === 'bridge') { if (inBar === 0) this.chord(t, chord, beatDur * 3.5, 'power'); }
      // lead on the chorus
      if (section === 'chorus') {
        const n = this.lead[this.leadPos++ % this.lead.length];
        this.leadNote(t, this.root + 12 + n, beatDur * 0.5);
        if (inBar % 2 === 1) { const n2 = this.lead[this.leadPos++ % this.lead.length]; this.leadNote(t + beatDur / 2, this.root + 12 + n2, beatDur * 0.4); }
      }
      this.nextBeat++;
      this.nextTime += beatDur;
    }
  }

  // ---------------------------------------------------------------- instruments
  private hit(t: number, kind: 'kick' | 'snare' | 'hat' | 'hatOpen' | 'crash'): void {
    const ctx = this.ctx;
    if (kind === 'kick') {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.1);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      o.connect(g).connect(this.out); o.start(t); o.stop(t + 0.2);
      return;
    }
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true; src.loopStart = Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    let dur = 0.1, gain = 0.3;
    if (kind === 'snare') { f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.8; dur = 0.16; gain = 0.55; const o = ctx.createOscillator(); o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.05); const og = ctx.createGain(); og.gain.setValueAtTime(0.4, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.09); o.connect(og).connect(this.out); o.start(t); o.stop(t + 0.1); }
    else if (kind === 'hat') { f.type = 'highpass'; f.frequency.value = 7500; dur = 0.04; gain = 0.18; }
    else if (kind === 'hatOpen') { f.type = 'highpass'; f.frequency.value = 6500; dur = 0.12; gain = 0.16; }
    else { f.type = 'highpass'; f.frequency.value = 4500; dur = 0.9; gain = 0.35; }
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.out); src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
  }
  private fill(t: number, step: number): void {
    for (let i = 0; i < 2; i++) this.hit(t + i * step / 2, 'snare');
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
  private chord(t: number, chord: Chord, dur: number, style: 'skank' | 'power'): void {
    const ctx = this.ctx;
    const root = this.root + chord[0];
    const third = chord[1] === 'm' ? 3 : 4;
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
  private leadNote(t: number, note: number, dur: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = midi(note);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2200;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f).connect(g).connect(this.out); o.start(t); o.stop(t + dur + 0.02);
  }
}
