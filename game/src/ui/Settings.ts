import { PLAYLISTS, SHUFFLE_ALL } from '../audio/Audio';
/**
 * Player settings, persisted in localStorage under one versioned key. `renderPanel` builds the
 * same settings UI for the main menu and the pause menu; `onChange` fires on every edit so the
 * running game can apply changes live.
 */
export type Quality = 'high' | 'medium' | 'low';
export type Units = 'imperial' | 'metric';
export type CamMode = 'chase' | 'close' | 'far' | 'fp';

export interface Settings {
  v: number;
  sfx: number;
  music: number;
  mute: boolean;
  musicSource: 'files' | 'builtin' | 'off';
  /** a playlist name (see PLAYLISTS in audio/Audio.ts) or 'all' for Shuffle all */
  playlist: string;
  /** 2 once the Lofi hip-hop default has been applied to a save made while Ska-punk was the default */
  playlistDefault?: number;
  quality: Quality;
  shadows: boolean;
  /** cascaded shadow maps (experimental, off by default: turned the terrain black on Drew's GPU); off = single shadow camera around the rider */
  csmExperimental: boolean;
  /** volumetric cloud cover */
  clouds: 'off' | 'few' | 'scattered' | 'broken' | 'overcast' | 'flurries' | 'storm';
  /** low morning fog lying in the valleys, burning off as the sun climbs */
  valleyFog: boolean;
  treeDensity: number; // 0.25 .. 1
  pixelRatio: number; // 0.5 .. 2 (capped by the device)
  fov: number; // base chase FOV, 50 .. 100
  invertSteer: boolean;
  camera: CamMode;
  /** first-person goggle frame and lens tint (was the plain vignette) */
  fpVignette: boolean;
  /** goggle frame strength 0..1 */
  goggleStrength: number;
  showMarkers: boolean;
  showLabels: boolean; // peak and town names
  roadsOnSnow: boolean; // BUG-042: catwalks and roads drawn on the mountain (off: plain snow)
  /** time trials: start/finish gates on real runs, timer, ghost of your best run (off by default) */
  timeTrials: boolean;
  /** 'pack' = the pack's fixed sun, 'now' = real clock at the resort, or a fixed hour 6..20 */
  timeOfDay: 'pack' | 'now' | number;
  /** month 1..12 used with a fixed hour (season changes the sun's height) */
  month: number;
  units: Units;
  keys: Record<string, string>; // action -> KeyboardEvent.code
  outfit: Outfit;
  discipline: 'board' | 'ski';
  /** Outrun mode (FEAT-097): the last picked difficulty, escape rule and the Gentle eat */
  outrun: { difficulty: 'chill' | 'normal' | 'skifree'; escape: 'endless' | 'base'; gentle: boolean };
}
export interface Outfit { jacket: string; pants: string; helmet: string; board: string; gloves: string }
export const OUTFIT_PRESETS: Record<string, Outfit> = {
  'Classic red': { jacket: '#ef4444', pants: '#1f2937', helmet: '#111111', board: '#1d4ed8', gloves: '#111111' },
  'All black': { jacket: '#15171c', pants: '#0f1114', helmet: '#0a0a0a', board: '#2a2a2a', gloves: '#111111' },
  'Neon 90s': { jacket: '#d6ff00', pants: '#ff2d95', helmet: '#00e5ff', board: '#ff6a00', gloves: '#d6ff00' },
  'Powder blue': { jacket: '#7dd3fc', pants: '#1e3a8a', helmet: '#f8fafc', board: '#0ea5e9', gloves: '#1e3a8a' },
  'Forest': { jacket: '#2f6b3a', pants: '#3b2f2f', helmet: '#d9b08c', board: '#8b5a2b', gloves: '#3b2f2f' },
  'Safety orange': { jacket: '#ff7a00', pants: '#111827', helmet: '#ffffff', board: '#111827', gloves: '#ff7a00' },
};

export const DEFAULT_KEYS: Record<string, string> = {
  left: 'ArrowLeft', right: 'ArrowRight', tuck: 'ArrowUp', brake: 'ArrowDown', jump: 'Space', grab: 'ShiftLeft', squat: 'ControlLeft', skate: 'KeyX', pressNose: 'KeyV', pressTail: 'KeyZ',
  lift: 'KeyE', board: 'KeyB', trial: 'KeyT', map: 'KeyM', camera: 'KeyC', restart: 'KeyR', piste: 'KeyP', fly: 'KeyF', track: 'KeyN', look: 'AltLeft', boost: 'KeyQ', glance: 'KeyG', replay: 'KeyK', rewind: 'Backspace',
};
const KEY_LABELS: Record<string, string> = { left: 'Steer left', right: 'Steer right', tuck: 'Tuck', brake: 'Brake', jump: 'Jump (hold)', grab: 'Grab (sprint on foot)', squat: 'Squat (hold)', skate: 'Skate on the flat (hold)', pressNose: 'Nose press (hold)', pressTail: 'Tail press (hold)', lift: 'Ride lift / skip', board: 'Board on / off', trial: 'Go to nearest time trial', map: 'Map', camera: 'Camera', restart: 'Restart', piste: 'Piste lines', fly: 'Free fly', track: 'Next track', look: 'Free look (hold, move mouse)', boost: 'Outrun boost', glance: 'Outrun look back (hold)', replay: 'Replay viewer', rewind: 'Rewind (hold)' };

const DEFAULTS: Settings = {
  v: 1, sfx: 0.8, music: 0.5, mute: false, musicSource: 'files', playlist: 'Lofi hip-hop', playlistDefault: 2, quality: 'high', shadows: true, csmExperimental: false, clouds: 'scattered', valleyFog: false, treeDensity: 1, pixelRatio: Math.min(2, window.devicePixelRatio || 1),
  fov: 68, invertSteer: false, camera: 'chase', fpVignette: true, goggleStrength: 0.6, showMarkers: true, showLabels: true, roadsOnSnow: false, timeTrials: false, outfit: { ...OUTFIT_PRESETS['Classic red'] }, discipline: 'board', timeOfDay: 'pack', month: 2, units: 'imperial', keys: { ...DEFAULT_KEYS },
  outrun: { difficulty: 'normal', escape: 'base', gentle: false },
};
const KEY = 'settings';

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && raw.v === DEFAULTS.v) {
      // the Hip-hop playlist was renamed Lofi hip-hop
      if (raw.playlist === 'Hip-hop') raw.playlist = 'Lofi hip-hop';
      // saves from before the Lofi hip-hop default carry the old Ska-punk default: switch them once
      if (raw.playlistDefault !== 2) { if (raw.playlist === 'Ska-punk') raw.playlist = 'Lofi hip-hop'; raw.playlistDefault = 2; }
      return { ...DEFAULTS, ...raw, keys: { ...DEFAULT_KEYS, ...(raw.keys ?? {}) }, outfit: { ...DEFAULTS.outfit, ...(raw.outfit ?? {}) }, outrun: { ...DEFAULTS.outrun, ...(raw.outrun ?? {}) } };
    }
    // migrate the older separate keys
    const s = { ...DEFAULTS, keys: { ...DEFAULT_KEYS }, outfit: { ...DEFAULTS.outfit }, outrun: { ...DEFAULTS.outrun } };
    const a = JSON.parse(localStorage.getItem('audio') ?? '{}');
    if (typeof a.sfx === 'number') s.sfx = a.sfx;
    if (typeof a.music === 'number') s.music = a.music;
    if (localStorage.getItem('gfx') === 'low') { s.quality = 'low'; s.shadows = false; s.treeDensity = 0.3; s.pixelRatio = 1; }
    return s;
  } catch { return { ...DEFAULTS, keys: { ...DEFAULT_KEYS }, outfit: { ...DEFAULTS.outfit }, outrun: { ...DEFAULTS.outrun } }; }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

export function resetSettings(): Settings {
  const s = { ...DEFAULTS, keys: { ...DEFAULT_KEYS }, outfit: { ...DEFAULTS.outfit }, outrun: { ...DEFAULTS.outrun } };
  saveSettings(s);
  return s;
}

/** Apply a quality preset to the dependent fields. */
export function applyQuality(s: Settings, q: Quality): void {
  s.quality = q;
  if (q === 'high') { s.shadows = true; s.treeDensity = 1; s.pixelRatio = Math.min(2, window.devicePixelRatio || 1); }
  else if (q === 'medium') { s.shadows = true; s.treeDensity = 0.6; s.pixelRatio = 1; }
  else { s.shadows = false; s.treeDensity = 0.3; s.pixelRatio = 1; }
}

export function keyName(code: string): string {
  return code.replace(/^Key/, '').replace(/^Arrow/, '').replace('ShiftLeft', 'Shift').replace('ShiftRight', 'R Shift').replace('Space', 'Space');
}

/** Playlist picker (shared by the settings panel and the main menu). */
export function playlistSelect(): string {
  return `<select data-k="playlist">${PLAYLISTS.map((p) => `<option value="${p.name}">${p.name}</option>`).join('')}<option value="${SHUFFLE_ALL}">Shuffle all</option></select>`;
}

/**
 * Render the settings panel into `host`. Every edit mutates `s`, saves, and calls `onChange`.
 */
export function renderPanel(host: HTMLElement, s: Settings, onChange: (s: Settings, what: string) => void): void {
  host.innerHTML = `
    <div class="tabs"><button data-t="audio" class="on">Audio</button><button data-t="graphics">Graphics</button><button data-t="controls">Controls</button><button data-t="rider">Rider</button><button data-t="game">Game</button></div>
    <div class="tab" data-t="audio">
      <div class="row"><label>Effects</label><input type="range" data-k="sfx" min="0" max="1" step="0.05"></div>
      <div class="row"><label>Music</label><input type="range" data-k="music" min="0" max="1" step="0.05"></div>
      <div class="row"><label>Mute</label><input type="checkbox" data-k="mute"></div>
      <div class="row"><label>Music</label><select data-k="musicSource"><option value="files">Playlist (built-in if none)</option><option value="builtin">Built-in jukebox</option><option value="off">Off</option></select></div>
      <div class="row"><label>Playlist</label>${playlistSelect()}</div>
      <div class="credits"></div>
    </div>
    <div class="tab hidden" data-t="graphics">
      <div class="row"><label>Quality</label><select data-k="quality"><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></div>
      <div class="row"><label>Shadows</label><input type="checkbox" data-k="shadows"></div>
      <div class="row"><label>Cascaded (beta)</label><input type="checkbox" data-k="csmExperimental"></div>
      <div class="row"><label>Weather</label><select data-k="clouds"><option value="off">Bluebird (clear)</option><option value="few">Few clouds</option><option value="scattered">Scattered clouds</option><option value="broken">Broken clouds</option><option value="overcast">Overcast (flat light)</option><option value="flurries">Overcast, light snow</option><option value="storm">Snowstorm</option></select></div>
      <div class="row"><label>Valley fog</label><input type="checkbox" data-k="valleyFog"></div>
      <div class="row"><label>Trees</label><input type="range" data-k="treeDensity" min="0.25" max="1" step="0.05"></div>
      <div class="row"><label>Resolution</label><input type="range" data-k="pixelRatio" min="0.5" max="2" step="0.25"></div>
      <div class="row"><label>Field of view</label><input type="range" data-k="fov" min="50" max="100" step="1"><span class="val" data-v="fov"></span></div>
      <div class="row"><label>FP goggles</label><input type="checkbox" data-k="fpVignette"></div>
      <div class="row"><label>Goggle frame</label><input type="range" data-k="goggleStrength" min="0" max="1" step="0.05"></div>
    </div>
    <div class="tab hidden" data-t="controls">
      <div class="row"><label>Invert steer</label><input type="checkbox" data-k="invertSteer"></div>
      <div class="row"><label>Default camera</label><select data-k="camera"><option value="chase">Chase</option><option value="close">Close</option><option value="far">Far</option><option value="fp">First person</option></select></div>
      <div class="keys"></div>
      <div class="hint">Click a key, then press the new one. Esc cancels.</div>
    </div>
    <div class="tab hidden" data-t="rider">
      <div class="row"><label>Ride</label><select data-k="discipline"><option value="board">Snowboard</option><option value="ski">Skis</option></select></div>
      <div class="row"><label>Preset</label><select data-o="preset"><option value="">Custom</option>${Object.keys(OUTFIT_PRESETS).map((n) => `<option value="${n}">${n}</option>`).join('')}</select></div>
      ${(['jacket', 'pants', 'helmet', 'gloves', 'board'] as (keyof Outfit)[]).map((k) => `<div class="row"><label>${k[0].toUpperCase() + k.slice(1)}</label><input type="color" data-o="${k}"><span class="val" data-ov="${k}"></span></div>`).join('')}
    </div>
    <div class="tab hidden" data-t="game">
      <div class="row"><label>Units</label><select data-k="units"><option value="imperial">mph, ft</option><option value="metric">km/h, m</option></select></div>
      <div class="row"><label>Lift markers</label><input type="checkbox" data-k="showMarkers"></div>
      <div class="row"><label>Peak names</label><input type="checkbox" data-k="showLabels"></div>
      <div class="row"><label>Roads and trails on snow</label><input type="checkbox" data-k="roadsOnSnow"></div>
      <div class="row"><label>Time trials</label><input type="checkbox" data-k="timeTrials"></div>
      <div class="row"><label>Time of day</label><select data-k="timeOfDay"><option value="pack">Resort default</option><option value="now">Now (real time)</option><option value="7">7 am</option><option value="9">9 am</option><option value="11">11 am</option><option value="13">1 pm</option><option value="15">3 pm</option><option value="16.5">4:30 pm</option><option value="17.5">5:30 pm</option></select></div>
      <div class="row"><label>Month</label><select data-k="month"><option value="12">December</option><option value="1">January</option><option value="2">February</option><option value="3">March</option><option value="4">April</option><option value="7">July</option></select></div>
      <button data-a="reset" class="ghost">Reset to defaults</button>
    </div>`;
  const tabs = host.querySelectorAll<HTMLButtonElement>('.tabs button');
  tabs.forEach((b) => b.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('on', x === b));
    host.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.classList.toggle('hidden', t.dataset.t !== b.dataset.t));
  }));
  const fill = () => {
    host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((el) => {
      const k = el.dataset.k as keyof Settings;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!s[k];
      else el.value = String(s[k]);
    });
    const fv = host.querySelector('[data-v="fov"]'); if (fv) fv.textContent = `${s.fov}°`;
    const keys = host.querySelector('.keys')!;
    keys.innerHTML = Object.keys(DEFAULT_KEYS).map((a) => `<div class="row"><label>${KEY_LABELS[a]}</label><button class="key" data-action="${a}">${keyName(s.keys[a])}</button></div>`).join('');
    keys.querySelectorAll<HTMLButtonElement>('button.key').forEach((b) => b.addEventListener('click', () => {
      b.textContent = '...'; b.classList.add('listening');
      const onKey = (e: KeyboardEvent) => {
        e.preventDefault(); e.stopPropagation();
        window.removeEventListener('keydown', onKey, true);
        if (e.code !== 'Escape') { s.keys[b.dataset.action!] = e.code; saveSettings(s); onChange(s, 'keys'); }
        fill();
      };
      window.addEventListener('keydown', onKey, true);
    }));
  };
  fill();
  host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((el) => {
    el.addEventListener('input', () => {
      const k = el.dataset.k as keyof Settings;
      let v: unknown;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') v = el.checked;
      else if (el instanceof HTMLInputElement && el.type === 'range') v = Number(el.value);
      else v = el.value;
      if (k === 'quality') applyQuality(s, v as Quality);
      else if (k === 'timeOfDay') s.timeOfDay = v === 'pack' || v === 'now' ? v : Number(v);
      else if (k === 'month') s.month = Number(v);
      else (s as unknown as Record<string, unknown>)[k] = v;
      saveSettings(s);
      onChange(s, k);
      if (k === 'quality') fill();
      const fv = host.querySelector('[data-v="fov"]'); if (fv) fv.textContent = `${s.fov}°`;
    });
  });
  // outfit
  const fillOutfit = () => {
    host.querySelectorAll<HTMLInputElement>('input[data-o]').forEach((el) => { const k = el.dataset.o as keyof Outfit; el.value = s.outfit[k]; const v = host.querySelector(`[data-ov="${k}"]`); if (v) v.textContent = s.outfit[k]; });
    const preset = Object.entries(OUTFIT_PRESETS).find(([, o]) => (Object.keys(o) as (keyof Outfit)[]).every((k) => o[k] === s.outfit[k]))?.[0] ?? '';
    (host.querySelector('select[data-o="preset"]') as HTMLSelectElement).value = preset;
  };
  fillOutfit();
  host.querySelectorAll<HTMLInputElement>('input[data-o]').forEach((el) => el.addEventListener('input', () => {
    s.outfit[el.dataset.o as keyof Outfit] = el.value; saveSettings(s); fillOutfit(); onChange(s, 'outfit');
  }));
  (host.querySelector('select[data-o="preset"]') as HTMLSelectElement).addEventListener('change', (e) => {
    const n = (e.target as HTMLSelectElement).value;
    if (OUTFIT_PRESETS[n]) { s.outfit = { ...OUTFIT_PRESETS[n] }; saveSettings(s); fillOutfit(); onChange(s, 'outfit'); }
  });
  host.querySelector('[data-a="reset"]')!.addEventListener('click', () => {
    const d = resetSettings();
    Object.assign(s, d, { keys: { ...d.keys }, outfit: { ...d.outfit } });
    fill(); fillOutfit(); onChange(s, 'reset');
  });
}
