import { PLAYLISTS, SHUFFLE_ALL } from '../audio/Audio';
import { DEFAULT_PAD, migratePadKeys } from '../sim/Pad';
import type { LensSetting } from '../world/Lens';
/**
 * Player settings, persisted in localStorage under one versioned key. The settings screen
 * (`SettingsOverlay.ts`, rows in `SettingsRows.ts`) edits them and reports every change so the
 * running game can apply it live.
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
  /** FEAT-130: the goggle lens (first person view and the rider's goggles), or Auto by the weather and the sun */
  goggleLens: LensSetting;
  /** FEAT-130: how strongly the lens tints and sharpens the first-person view, 0..1 */
  lensStrength: number;
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
  /** rumble on or off (the strength is kept for when it comes back on), and its strength */
  rumble: boolean;
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
  /** FEAT-128 Accessibility: one switch that turns camera shake, first person shake and speed lines off together (BUG-051) */
  reduceMotion: boolean;
  /** FEAT-128 Accessibility: scales the menus, HUD, prompts and touch controls (the --ui-scale token), 0.8 .. 1.5 */
  uiScale: number;
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

/** FEAT-130: the goggle lens that comes with each outfit preset */
export const OUTFIT_LENS: Record<string, LensSetting> = {
  'Classic red': 'rose', 'All black': 'purple', 'Neon 90s': 'yellow', 'Powder blue': 'blue', 'Forest': 'green', 'Safety orange': 'orange',
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
/** the Controls rows, grouped by when each action applies */
export const KEY_GROUPS: [string, [string, string][]][] = [
  ['Board', [['left', 'Steer left'], ['right', 'Steer right'], ['tuck', 'Tuck (front flip in the air)'], ['brake', 'Brake (backflip in the air)'], ['jump', 'Jump (hold, release)'], ['grab', 'Squat on the snow / grab in the air / sprint on foot'], ['squat', 'Squat only (optional)'], ['pressNose', 'Nose press (hold)'], ['pressTail', 'Tail press (hold)'], ['skate', 'Skate on the flat (hold)']]],
  ['Everywhere', [['lift', 'Interact: ride lift, skip, strap in or out'], ['board', 'Strap in or out only (optional)'], ['glance', 'Look behind (hold)'], ['look', 'Free look (hold, move mouse)']]],
  ['Camera and UI', [['camera', 'Camera'], ['map', 'Map'], ['piste', 'Piste lines'], ['track', 'Next track'], ['trial', 'Go to nearest time trial'], ['restart', 'Restart (hold)'], ['replay', 'Replay viewer'], ['rewind', 'Rewind (hold)'], ['fly', 'Free fly']]],
  ['Outrun', [['boost', 'Boost']]],
];

/** FEAT-137: the actions a controller button can be bound to (the sticks steer, lean and look; Options / PS pause) */
export const PAD_GROUPS: [string, [string, string][]][] = KEY_GROUPS.map(([g, list]) => [g, list.filter(([a]) => a in DEFAULT_PAD)] as [string, [string, string][]]).filter(([, l]) => l.length > 0);

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
  fov: 68, autoQuality: true, targetFps: 60, speedFov: true, camShake: true, speedLines: true, invertSteer: false, camera: 'chase', fpVignette: true, goggleStrength: 0.6, goggleLens: 'rose', lensStrength: 1, fpShake: 0.3, showMarkers: true, showLabels: true, roadsOnSnow: false, liftLines: true, timeTrials: false, pressBalance: 'on', outfit: { ...OUTFIT_PRESETS['Classic red'] }, discipline: 'board', stance: 'regular', timeOfDay: 'pack', month: 2, units: 'imperial', keys: migrateKeys(undefined).keys,
  outrun: { difficulty: 'normal', escape: 'base', gentle: false },
  padKeys: migratePadKeys(undefined), rumble: true, vibration: 0.8, padDead: 0.18, padTrigDead: 0.3, lookSens: 1, invertLookY: false,
  padTriggers: false, padLightbar: true, padGyro: false, gyroSens: 1,
  reduceMotion: false, uiScale: 1,
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

/** A fresh copy of the defaults (nothing shared with DEFAULTS). */
export function defaultSettings(): Settings {
  return { ...DEFAULTS, keys: migrateKeys(undefined).keys, padKeys: migratePadKeys(undefined), outfit: { ...DEFAULTS.outfit }, outrun: { ...DEFAULTS.outrun } };
}

/** FEAT-128: the UI scale token every menu and HUD size multiplies (DOM only, so it costs nothing per frame). */
export function applyUiScale(s: Settings): void {
  document.documentElement.style.setProperty('--ui-scale', String(Math.max(0.8, Math.min(1.5, s.uiScale || 1))));
  document.documentElement.classList.toggle('reduce-motion', !!s.reduceMotion);
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
