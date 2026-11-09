import { PLAYLISTS, SHUFFLE_ALL } from '../audio/Audio';
import { DEFAULT_PAD, PAUSE_BUTTONS, activePad, lastPadKind, migratePadKeys, padButtonName, padUi } from '../sim/Pad';
import { DualSenseHID, dualSense } from '../sim/DualSense';
import { padGlyph } from './PadGlyphs';
/**
 * Player settings, persisted in localStorage under one versioned key. `renderPanel` builds the
 * same settings UI for the main menu and the pause menu; `onChange` fires on every edit so the
 * running game can apply changes live.
 */
export type Quality = 'high' | 'medium' | 'low';
export type Units = 'imperial' | 'metric';
export type CamMode = 'chase' | 'close' | 'far' | 'cine' | 'fp' | 'helmet';

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
  clouds: 'off' | 'cirrus' | 'few' | 'scattered' | 'broken' | 'overcast' | 'flurries' | 'storm';
  /** low morning fog lying in the valleys, burning off as the sun climbs */
  valleyFog: boolean;
  /** FEAT-105: how much new snow covers the rock at the start (a storm adds more as it falls) */
  newSnow?: 'none' | 'dusting' | '6in' | 'powder';
  /** FEAT-077: fresh morning corduroy, mid-season (skied out as the day goes on), or spring snow */
  snowDay: 'fresh' | 'mid' | 'spring';
  /** FEAT-044: the snow near the rider deforms (trenches and lips as real geometry); off on the Low preset either way */
  snowDeform: boolean;
  treeDensity: number; // 0.25 .. 1
  pixelRatio: number; // 0.5 .. 2 (capped by the device)
  fov: number; // base chase FOV, 50 .. 100
  /** FEAT-062: adaptive quality on, and the frame rate it holds (30, 60 or 0 = uncapped; main.ts makes auto quality aim for 60 when it is 0) */
  autoQuality: boolean; targetFps: number;
  /** FEAT-045 speed feel, each can be turned off: FOV widening with speed, camera rumble and landing shake, speed lines */
  speedFov: boolean; camShake: boolean; speedLines: boolean;
  invertSteer: boolean;
  camera: CamMode;
  /** first-person goggle frame and lens tint (was the plain vignette) */
  fpVignette: boolean;
  /** goggle frame strength 0..1 */
  goggleStrength: number;
  /** BUG-051: first-person and helmet cam shake, 0 (smooth) to 1 */
  fpShake: number;
  showMarkers: boolean;
  showLabels: boolean; // peak and town names
  roadsOnSnow: boolean; // BUG-042: catwalks and roads drawn on the mountain (off: plain snow)
  /** FEAT-073: lift-line mazes at the chairlift bases, and boarding only from inside them */
  liftLines: boolean;
  /** time trials: start/finish gates on real runs, timer, ghost of your best run (off by default) */
  timeTrials: boolean;
  /** FEAT-140: holding a nose or tail press is a balancing act (Easy: slower drift; Off: the press holds as long as the key) */
  pressBalance: 'on' | 'easy' | 'hard' | 'off';
  /** 'pack' = the pack's fixed sun, 'now' = real clock at the resort, or a fixed hour 6..20 */
  timeOfDay: 'pack' | 'now' | number;
  /** month 1..12 used with a fixed hour (season changes the sun's height) */
  month: number;
  units: Units;
  keys: Record<string, string[]>; // action -> up to two codes (FEAT-124)
  /** FEAT-124: the player had rebound keys before the new default layout; show the note once */
  keysNote?: boolean;
  /** FEAT-137: controller buttons per action (standard-mapping indices, two slots), rumble strength 0..1 (0 off),
   *  stick and trigger dead zones, right stick look rate and invert Y */
  padKeys: Record<string, number[]>;
  vibration: number;
  padDead: number; padTrigDead: number; lookSens: number; invertLookY: boolean;
  /** FEAT-137 DualSense extras (WebHID): adaptive triggers, the lightbar, gyro look and its rate */
  padTriggers: boolean; padLightbar: boolean; padGyro: boolean; gyroSens: number;
  outfit: Outfit;
  discipline: 'board' | 'ski';
  /** FEAT-139: the snowboarder's normal stance, left foot forward (regular) or right (goofy) */
  stance: 'regular' | 'goofy';
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

/**
 * FEAT-124 default layout: up to two bindings per action (KeyboardEvent.code, or Mouse2 for the right
 * mouse button). Everything you do while riding sits under the left hand on WASD; the arrows are the
 * second bindings for steering, tuck and brake. No action needs Ctrl.
 */
export const DEFAULT_KEYS: Record<string, string[]> = {
  left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], tuck: ['KeyW', 'ArrowUp'], brake: ['KeyS', 'ArrowDown'], jump: ['Space'],
  grab: ['ShiftLeft', 'ShiftRight'], squat: [], pressNose: ['KeyQ'], pressTail: ['KeyZ'], skate: ['KeyX'],
  lift: ['KeyE'], board: [], glance: ['KeyG'], look: ['AltLeft', 'Mouse2'],
  camera: ['KeyC'], map: ['KeyM'], piste: ['KeyP'], track: ['KeyN'], trial: ['KeyT'], restart: ['KeyR'], replay: ['KeyK'], rewind: ['Backspace'],
  boost: ['KeyF'], fly: ['Backquote'],
};
/** the layout before FEAT-124: a saved keymap equal to this never changed a key, so it gets the new defaults */
const OLD_DEFAULT_KEYS: Record<string, string> = {
  left: 'ArrowLeft', right: 'ArrowRight', tuck: 'ArrowUp', brake: 'ArrowDown', jump: 'Space', grab: 'ShiftLeft', squat: 'ControlLeft', skate: 'KeyX', pressNose: 'KeyV', pressTail: 'KeyZ',
  lift: 'KeyE', board: 'KeyB', trial: 'KeyT', map: 'KeyM', camera: 'KeyC', restart: 'KeyR', piste: 'KeyP', fly: 'KeyF', track: 'KeyN', look: 'AltLeft', boost: 'KeyQ', glance: 'KeyG', replay: 'KeyK', rewind: 'Backspace',
};
/** the Controls tab, grouped by when each action applies */
const KEY_GROUPS: [string, [string, string][]][] = [
  ['Board', [['left', 'Steer left'], ['right', 'Steer right'], ['tuck', 'Tuck (front flip in the air)'], ['brake', 'Brake (backflip in the air)'], ['jump', 'Jump (hold, release)'], ['grab', 'Squat on the snow / grab in the air / sprint on foot'], ['squat', 'Squat only (optional)'], ['pressNose', 'Nose press (hold)'], ['pressTail', 'Tail press (hold)'], ['skate', 'Skate on the flat (hold)']]],
  ['Everywhere', [['lift', 'Interact: ride lift, skip, strap in or out'], ['board', 'Strap in or out only (optional)'], ['glance', 'Look behind (hold)'], ['look', 'Free look (hold, move mouse)']]],
  ['Camera and UI', [['camera', 'Camera'], ['map', 'Map'], ['piste', 'Piste lines'], ['track', 'Next track'], ['trial', 'Go to nearest time trial'], ['restart', 'Restart (hold)'], ['replay', 'Replay viewer'], ['rewind', 'Rewind (hold)'], ['fly', 'Free fly']]],
  ['Outrun', [['boost', 'Boost']]],
];

/** FEAT-137: the actions a controller button can be bound to (the sticks steer, lean and look; Options / PS pause) */
const PAD_GROUPS: [string, [string, string][]][] = KEY_GROUPS.map(([g, list]) => [g, list.filter(([a]) => a in DEFAULT_PAD)] as [string, [string, string][]]).filter(([, l]) => l.length > 0);

/** A saved keymap from any version, as two-binding arrays. `custom` is true when the player had rebound a key. */
export function migrateKeys(raw: Record<string, unknown> | undefined): { keys: Record<string, string[]>; custom: boolean } {
  const keys: Record<string, string[]> = {};
  for (const a in DEFAULT_KEYS) keys[a] = [...DEFAULT_KEYS[a]];
  if (!raw) return { keys, custom: false };
  const vals = Object.values(raw);
  if (vals.length && vals.every((v) => Array.isArray(v))) { for (const a in raw) keys[a] = [...(raw[a] as string[])].slice(0, 2); return { keys, custom: false }; }
  // the old one-code-per-action format
  const changed = Object.entries(raw).some(([a, v]) => typeof v === 'string' && OLD_DEFAULT_KEYS[a] !== undefined && OLD_DEFAULT_KEYS[a] !== v);
  if (!changed) return { keys, custom: false };
  for (const [a, v] of Object.entries(raw)) if (typeof v === 'string') keys[a] = [v];
  // the old hidden aliases become real second bindings
  const alias: Record<string, string> = { left: 'KeyA', right: 'KeyD', tuck: 'KeyW', brake: 'KeyS' };
  for (const a in alias) if (keys[a].length < 2 && !keys[a].includes(alias[a])) keys[a].push(alias[a]);
  return { keys, custom: true };
}

const DEFAULTS: Settings = {
  v: 1, sfx: 0.8, music: 0.5, mute: false, musicSource: 'files', playlist: 'Lofi hip-hop', playlistDefault: 2, quality: 'high', shadows: true, csmExperimental: false, clouds: 'scattered', valleyFog: false, newSnow: 'none', snowDay: 'mid', snowDeform: true, treeDensity: 1, pixelRatio: Math.min(2, window.devicePixelRatio || 1),
  fov: 68, autoQuality: true, targetFps: 60, speedFov: true, camShake: true, speedLines: true, invertSteer: false, camera: 'chase', fpVignette: true, goggleStrength: 0.6, fpShake: 0.3, showMarkers: true, showLabels: true, roadsOnSnow: false, liftLines: true, timeTrials: false, pressBalance: 'on', outfit: { ...OUTFIT_PRESETS['Classic red'] }, discipline: 'board', stance: 'regular', timeOfDay: 'pack', month: 2, units: 'imperial', keys: migrateKeys(undefined).keys,
  outrun: { difficulty: 'normal', escape: 'base', gentle: false },
  padKeys: migratePadKeys(undefined), vibration: 0.8, padDead: 0.18, padTrigDead: 0.3, lookSens: 1, invertLookY: false,
  padTriggers: false, padLightbar: true, padGyro: false, gyroSens: 1,
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
      const mk = migrateKeys(raw.keys);
      return { ...DEFAULTS, ...raw, keys: mk.keys, keysNote: raw.keysNote ?? (mk.custom ? true : undefined), padKeys: migratePadKeys(raw.padKeys), outfit: { ...DEFAULTS.outfit, ...(raw.outfit ?? {}) }, outrun: { ...DEFAULTS.outrun, ...(raw.outrun ?? {}) } };
    }
    // migrate the older separate keys
    const s = { ...DEFAULTS, keys: migrateKeys(undefined).keys, padKeys: migratePadKeys(undefined), outfit: { ...DEFAULTS.outfit }, outrun: { ...DEFAULTS.outrun } };
    const a = JSON.parse(localStorage.getItem('audio') ?? '{}');
    if (typeof a.sfx === 'number') s.sfx = a.sfx;
    if (typeof a.music === 'number') s.music = a.music;
    if (localStorage.getItem('gfx') === 'low') { s.quality = 'low'; s.shadows = false; s.treeDensity = 0.3; s.pixelRatio = 1; }
    return s;
  } catch { return { ...DEFAULTS, keys: migrateKeys(undefined).keys, padKeys: migratePadKeys(undefined), outfit: { ...DEFAULTS.outfit }, outrun: { ...DEFAULTS.outrun } }; }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

export function resetSettings(): Settings {
  const s = { ...DEFAULTS, keys: migrateKeys(undefined).keys, padKeys: migratePadKeys(undefined), outfit: { ...DEFAULTS.outfit }, outrun: { ...DEFAULTS.outrun } };
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
  if (!code) return '-';
  const named: Record<string, string> = { ShiftLeft: 'Shift', ShiftRight: 'R Shift', AltLeft: 'Alt', AltRight: 'R Alt', ControlLeft: 'Ctrl', ControlRight: 'R Ctrl', Mouse2: 'Right mouse', Backquote: '`', Backspace: 'Backspace', ArrowLeft: '\u2190', ArrowRight: '\u2192', ArrowUp: '\u2191', ArrowDown: '\u2193' };
  return named[code] ?? code.replace(/^Key/, '').replace(/^Digit/, '');
}

/** Every binding of an action as text ("A / \u2190"). */
export function keysOf(s: Settings, action: string): string { return (s.keys[action] ?? []).map(keyName).join(' / '); }

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
      <div class="row"><label>Weather</label><select data-k="clouds"><option value="off">Bluebird (clear)</option><option value="cirrus">Thin high cloud</option><option value="few">Few clouds</option><option value="scattered">Scattered clouds</option><option value="broken">Broken clouds</option><option value="overcast">Overcast (flat light)</option><option value="flurries">Overcast, light snow</option><option value="storm">Snowstorm</option></select></div>
      <div class="row"><label>Snow conditions</label><select data-k="snowDay"><option value="fresh">Fresh corduroy</option><option value="mid">Mid-season</option><option value="spring">Spring</option></select></div>
      <div class="row"><label>New snow</label><select data-k="newSnow"><option value="none">None</option><option value="dusting">Dusting</option><option value="6in">6 in</option><option value="powder">Powder day</option></select></div>
      <div class="row"><label>Snow dents</label><input type="checkbox" data-k="snowDeform"></div>
      <div class="row"><label>Valley fog</label><input type="checkbox" data-k="valleyFog"></div>
      <div class="row"><label>Trees</label><input type="range" data-k="treeDensity" min="0.25" max="1" step="0.05"></div>
      <div class="row"><label>Resolution</label><input type="range" data-k="pixelRatio" min="0.5" max="2" step="0.25"></div>
      <div class="row"><label>Auto quality</label><input type="checkbox" data-k="autoQuality"></div>
      <div class="row"><label>Target FPS</label><select data-k="targetFps"><option value="30">30</option><option value="60">60</option><option value="0">Uncapped</option></select></div>
      <div class="row"><label>Field of view</label><input type="range" data-k="fov" min="50" max="100" step="1"><span class="val" data-v="fov"></span></div>
      <div class="row"><label>Widen view with speed</label><input type="checkbox" data-k="speedFov"></div>
      <div class="row"><label>Camera shake</label><input type="checkbox" data-k="camShake"></div>
      <div class="row"><label>Speed lines</label><input type="checkbox" data-k="speedLines"></div>
      <div class="row"><label>FP goggles</label><input type="checkbox" data-k="fpVignette"></div>
      <div class="row"><label>First person shake</label><input type="range" data-k="fpShake" min="0" max="1" step="0.05"></div>
      <div class="row"><label>Goggle frame</label><input type="range" data-k="goggleStrength" min="0" max="1" step="0.05"></div>
    </div>
    <div class="tab hidden" data-t="controls">
      <div class="row"><label>Invert steer</label><input type="checkbox" data-k="invertSteer"></div>
      <div class="row"><label>Default camera</label><select data-k="camera"><option value="chase">Chase</option><option value="close">Close</option><option value="far">Far (angled)</option><option value="cine">Cinematic</option><option value="fp">First person</option><option value="helmet">Helmet cam</option></select></div>
      <div class="keys"></div>
      <div class="row"><button data-a="keys-reset">Reset keys to defaults</button></div>
      <div class="hint">Click a slot, then press a key (or the right mouse button). Esc cancels, Delete clears the slot.</div>
      <div class="hint" style="margin-top:14px;font-weight:600;opacity:.9">Controller</div>
      <div class="hint">The left stick steers and leans (up / down tuck and brake), the right stick looks, Options / Start or the PS button pauses. In menus: D-pad or stick to move, Cross / A to pick, Circle / B to go back, L1 / R1 for the tabs.</div>
      <div class="row"><label>Vibration</label><input type="range" data-k="vibration" min="0" max="1" step="0.05"><span class="val" data-v="vibration"></span></div>
      <div class="row"><label>Stick dead zone</label><input type="range" data-k="padDead" min="0.05" max="0.4" step="0.01"><span class="val" data-v="padDead"></span></div>
      <div class="row"><label>Trigger dead zone</label><input type="range" data-k="padTrigDead" min="0.05" max="0.7" step="0.05"><span class="val" data-v="padTrigDead"></span></div>
      <div class="row"><label>Look speed</label><input type="range" data-k="lookSens" min="0.25" max="3" step="0.05"><span class="val" data-v="lookSens"></span></div>
      <div class="row"><label>Invert look Y</label><input type="checkbox" data-k="invertLookY"></div>
      <div class="padkeys"></div>
      <div class="row"><button data-a="pad-reset">Reset controller buttons</button></div>
      <div class="hint">Click a slot (or press Cross / A on it), then press a controller button. Esc or 6 s cancels, Delete clears the slot.</div>
      <div class="hint" style="margin-top:14px;font-weight:600;opacity:.9">DualSense extras</div>
      <div class="hid">
        <div class="hint">Lightbar, adaptive triggers, gyro look and touchpad swipes, over WebHID (Chrome or Edge, USB or Bluetooth). Click the button with the mouse and pick the controller.</div>
        <div class="row"><button data-a="hid">Connect DualSense extras</button></div>
        <div class="hint" data-hid-status></div>
        <div class="row"><label>Adaptive triggers</label><input type="checkbox" data-k="padTriggers"></div>
        <div class="row"><label>Lightbar</label><input type="checkbox" data-k="padLightbar"></div>
        <div class="row"><label>Gyro look</label><input type="checkbox" data-k="padGyro"></div>
        <div class="row"><label>Gyro speed</label><input type="range" data-k="gyroSens" min="0.25" max="3" step="0.05"><span class="val" data-v="gyroSens"></span></div>
      </div>
      <div class="hint" data-hid-none>DualSense extras need Chrome or Edge on https or localhost (WebHID).</div>
    </div>
    <div class="tab hidden" data-t="rider">
      <div class="row"><label>Ride</label><select data-k="discipline"><option value="board">Snowboard</option><option value="ski">Skis</option></select></div>
      <div class="row"><label>Stance</label><select data-k="stance"><option value="regular">Regular (left foot forward)</option><option value="goofy">Goofy (right foot forward)</option></select></div>
      <div class="row"><label>Preset</label><select data-o="preset"><option value="">Custom</option>${Object.keys(OUTFIT_PRESETS).map((n) => `<option value="${n}">${n}</option>`).join('')}</select></div>
      ${(['jacket', 'pants', 'helmet', 'gloves', 'board'] as (keyof Outfit)[]).map((k) => `<div class="row"><label>${k[0].toUpperCase() + k.slice(1)}</label><input type="color" data-o="${k}"><span class="val" data-ov="${k}"></span></div>`).join('')}
    </div>
    <div class="tab hidden" data-t="game">
      <div class="row"><label>Units</label><select data-k="units"><option value="imperial">mph, ft</option><option value="metric">km/h, m</option></select></div>
      <div class="row"><label>Lift markers</label><input type="checkbox" data-k="showMarkers"></div>
      <div class="row"><label>Peak names</label><input type="checkbox" data-k="showLabels"></div>
      <div class="row"><label>Roads and trails on snow</label><input type="checkbox" data-k="roadsOnSnow"></div>
      <div class="row"><label>Lift-line mazes</label><input type="checkbox" data-k="liftLines"></div>
      <div class="row"><label>Time trials</label><input type="checkbox" data-k="timeTrials"></div>
      <div class="row"><label>Press balance</label><select data-k="pressBalance"><option value="easy">Easy (slow drift)</option><option value="on">Normal</option><option value="hard">Hard (fast drift)</option><option value="off">Off (hold as long as you like)</option></select></div>
      <div class="row"><label>Time of day</label><select data-k="timeOfDay"><option value="pack">Resort default</option><option value="now">Now (real time)</option><option value="7">7 am</option><option value="9">9 am</option><option value="11">11 am</option><option value="13">1 pm</option><option value="15">3 pm</option><option value="16.5">4:30 pm</option><option value="17.5">5:30 pm</option></select></div>
      <div class="row"><label>Month</label><select data-k="month"><option value="12">December</option><option value="1">January</option><option value="2">February</option><option value="3">March</option><option value="4">April</option><option value="7">July</option></select></div>
      <button data-a="reset" class="ghost">Reset to defaults</button>
    </div>`;
  const tabs = host.querySelectorAll<HTMLButtonElement>('.tabs button');
  tabs.forEach((b) => b.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('on', x === b));
    host.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.classList.toggle('hidden', t.dataset.t !== b.dataset.t));
  }));
  let cancelListen: (() => void) | null = null; // the one key slot waiting for a press, if any
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const showVals = () => {
    const vals: Record<string, string> = { fov: `${s.fov}°`, vibration: s.vibration > 0 ? pct(s.vibration) : 'off', padDead: pct(s.padDead), padTrigDead: pct(s.padTrigDead), lookSens: `${s.lookSens.toFixed(2)}x`, gyroSens: `${s.gyroSens.toFixed(2)}x` };
    for (const k in vals) { const el = host.querySelector(`[data-v="${k}"]`); if (el) el.textContent = vals[k]; }
  };
  const fill = () => {
    cancelListen?.();
    host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((el) => {
      const k = el.dataset.k as keyof Settings;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!s[k];
      else el.value = String(s[k]);
    });
    showVals();
    const keys = host.querySelector('.keys')!;
    // FEAT-124: grouped by context, two slots per action, conflicts marked
    const owner = new Map<string, string[]>();
    for (const act in s.keys) for (const c of s.keys[act] ?? []) owner.set(c, [...(owner.get(c) ?? []), act]);
    const slot = (act: string, i: number) => {
      const c = s.keys[act]?.[i] ?? '';
      const clash = c && (owner.get(c)?.length ?? 0) > 1;
      return `<button class="key${clash ? ' clash' : ''}" data-action="${act}" data-slot="${i}" title="${clash ? 'Also bound to: ' + owner.get(c)!.filter((x) => x !== act).join(', ') : ''}">${keyName(c)}</button>`;
    };
    keys.innerHTML = KEY_GROUPS.map(([g, list]) => `<div class="hint" style="margin-top:10px;font-weight:600;opacity:.9">${g}</div>` +
      list.map(([act, label]) => `<div class="row"><label>${label}</label>${slot(act, 0)}${slot(act, 1)}</div>`).join('')).join('');
    keys.querySelectorAll<HTMLButtonElement>('button.key').forEach((b) => b.addEventListener('click', () => {
      cancelListen?.(); // a slot that was still listening stops (else both would take the next key)
      b.textContent = '...'; b.classList.add('listening');
      const act = b.dataset.action!, i = Number(b.dataset.slot);
      const set = (code: string | null) => {
        const arr = [...(s.keys[act] ?? [])];
        if (code === null) arr.splice(i, 1); else { arr[i] = code; }
        s.keys[act] = arr.filter((x) => !!x).slice(0, 2);
        saveSettings(s); onChange(s, 'keys');
      };
      const done = () => { stop(); fill(); };
      const onKey = (e: KeyboardEvent) => {
        e.preventDefault(); e.stopPropagation();
        if (e.code === 'Delete') set(null); else if (e.code !== 'Escape') set(e.code);
        done();
      };
      const onMouse = (e: MouseEvent) => { if (e.button !== 2) return; e.preventDefault(); e.stopPropagation(); set('Mouse2'); done(); };
      const mouseTimer = setTimeout(() => window.addEventListener('mousedown', onMouse, true), 0);
      const stop = () => { clearTimeout(mouseTimer); window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onMouse, true); cancelListen = null; };
      cancelListen = stop;
      window.addEventListener('keydown', onKey, true);
    }));
    fillPad();
  };
  // FEAT-137: controller buttons, two slots per action like the keys
  const fillPad = () => {
    const kind = activePad()?.kind ?? lastPadKind ?? 'ps';
    const padHost = host.querySelector('.padkeys')!;
    const owner = new Map<number, string[]>();
    for (const act in s.padKeys) for (const b of s.padKeys[act] ?? []) owner.set(b, [...(owner.get(b) ?? []), act]);
    const slot = (act: string, i: number) => {
      const b = s.padKeys[act]?.[i];
      const clash = b !== undefined && (owner.get(b)?.length ?? 0) > 1;
      const title = b === undefined ? 'unbound' : padButtonName(kind, b) + (clash ? ' (also: ' + owner.get(b)!.filter((x) => x !== act).join(', ') + ')' : '');
      return `<button class="key pad${clash ? ' clash' : ''}" data-paction="${act}" data-slot="${i}" title="${title}">${b === undefined ? '-' : padGlyph(kind, b)}</button>`;
    };
    padHost.innerHTML = PAD_GROUPS.map(([g, list]) => `<div class="hint" style="margin-top:10px;font-weight:600;opacity:.9">${g}</div>` +
      list.map(([act, label]) => `<div class="row"><label>${label}</label>${slot(act, 0)}${slot(act, 1)}</div>`).join('')).join('');
    padHost.querySelectorAll<HTMLButtonElement>('button.key').forEach((btn) => btn.addEventListener('click', () => {
      cancelListen?.();
      btn.textContent = '...'; btn.classList.add('listening');
      const act = btn.dataset.paction!, i = Number(btn.dataset.slot);
      const set = (b: number | null) => {
        const arr = [...(s.padKeys[act] ?? [])];
        if (b === null) arr.splice(i, 1); else arr[i] = b;
        s.padKeys[act] = arr.filter((x) => x !== undefined && x !== null).slice(0, 2);
        saveSettings(s); onChange(s, 'padKeys');
      };
      // wait for every button to be let go (the Cross that opened the slot), then take the next press
      let armed = false, raf = 0;
      const t0 = performance.now();
      const poll = () => {
        const p = activePad();
        const down = p ? p.buttons.findIndex((x, j) => j !== 6 && j !== 7 ? x.pressed : x.value > 0.5) : -1;
        if (!armed) { if (down < 0) armed = true; }
        else if (down >= 0) {
          if (!PAUSE_BUTTONS.includes(down)) set(down);
          done(); return;
        }
        if (performance.now() - t0 > 6000) { done(); return; }
        raf = requestAnimationFrame(poll);
      };
      const onKey = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); if (e.code === 'Delete' || e.code === 'Backspace') set(null); done(); };
      const stop = () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey, true); padUi.listening = false; cancelListen = null; };
      const done = () => { stop(); fill(); };
      cancelListen = stop;
      padUi.listening = true;
      window.addEventListener('keydown', onKey, true);
      raf = requestAnimationFrame(poll);
    }));
  };
  fill();
  // FEAT-137: the DualSense extras (only where WebHID is)
  const hidBox = host.querySelector<HTMLElement>('.hid')!, hidNone = host.querySelector<HTMLElement>('[data-hid-none]')!;
  hidBox.style.display = DualSenseHID.supported ? '' : 'none';
  hidNone.style.display = DualSenseHID.supported ? 'none' : '';
  const hidStatus = host.querySelector<HTMLElement>('[data-hid-status]')!;
  const hidBtn = host.querySelector<HTMLButtonElement>('[data-a="hid"]')!;
  const showHid = () => {
    hidStatus.textContent = dualSense.status || (dualSense.connected ? 'Connected' : 'Not connected');
    hidBtn.textContent = dualSense.connected ? 'Disconnect DualSense extras' : 'Connect DualSense extras';
  };
  showHid();
  const prevStatus = dualSense.onStatus;
  dualSense.onStatus = (st) => { prevStatus?.(st); if (host.isConnected) showHid(); };
  hidBtn.addEventListener('click', () => { void (dualSense.connected ? dualSense.disconnect() : dualSense.connect()).then(showHid); });
  host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((el) => {
    el.addEventListener('input', () => {
      const k = el.dataset.k as keyof Settings;
      let v: unknown;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') v = el.checked;
      else if (el instanceof HTMLInputElement && el.type === 'range') v = Number(el.value);
      else v = k === 'targetFps' ? Number(el.value) : el.value;
      if (k === 'quality') applyQuality(s, v as Quality);
      else if (k === 'timeOfDay') s.timeOfDay = v === 'pack' || v === 'now' ? v : Number(v);
      else if (k === 'month') s.month = Number(v);
      else (s as unknown as Record<string, unknown>)[k] = v;
      saveSettings(s);
      onChange(s, k);
      if (k === 'quality') fill();
      showVals();
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
  host.querySelector('[data-a="keys-reset"]')!.addEventListener('click', () => {
    s.keys = migrateKeys(undefined).keys; s.keysNote = false; saveSettings(s); fill(); onChange(s, 'keys');
  });
  host.querySelector('[data-a="pad-reset"]')!.addEventListener('click', () => {
    s.padKeys = migratePadKeys(undefined); saveSettings(s); fill(); onChange(s, 'padKeys');
  });
  host.querySelector('[data-a="reset"]')!.addEventListener('click', () => {
    const d = resetSettings();
    Object.assign(s, d, { keys: { ...d.keys }, padKeys: migratePadKeys(undefined), outfit: { ...d.outfit } });
    fill(); fillOutfit(); onChange(s, 'reset');
  });
}
