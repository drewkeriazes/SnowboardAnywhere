import { PLAYLISTS, SHUFFLE_ALL } from '../audio/Audio';
import { LENSES, LENS_ORDER } from '../world/Lens';
import { DualSenseHID } from '../sim/DualSense';
import { MENU_KEYS } from './MenuKeys';
import { OUTFIT_LENS, OUTFIT_PRESETS, applyQuality, keyName, keysOf, type Outfit, type Settings } from './Settings';

/**
 * FEAT-128: every row of the settings screen as data: its category and section, label, description,
 * control and how it reads and writes the settings. `SettingsOverlay.ts` draws them; the presets and
 * the per-category reset read the same rows, so nothing about a setting lives in two places.
 */
export type CatId = 'gameplay' | 'controls' | 'camera' | 'graphics' | 'conditions' | 'world' | 'audio' | 'rider' | 'access' | 'credits';
export const CATEGORIES: { id: CatId; label: string }[] = [
  { id: 'gameplay', label: 'Gameplay' }, { id: 'controls', label: 'Controls' }, { id: 'camera', label: 'Camera' },
  { id: 'graphics', label: 'Graphics' }, { id: 'conditions', label: 'Conditions' }, { id: 'world', label: 'Map and world' },
  { id: 'audio', label: 'Audio' }, { id: 'rider', label: 'Rider' }, { id: 'access', label: 'Accessibility' }, { id: 'credits', label: 'Credits' },
];

type V = string | number | boolean;
export type Opt = [V, string];
interface Base {
  id: string;
  label: string;
  /** what it does (a function when it depends on the value) */
  desc: string | ((s: Settings) => string);
  /** what it costs, where it is known */
  cost?: string;
  /** the `what` passed to onChange (main.ts applySettings keys some work off it); default the id */
  what?: string;
  /** a note when another setting overrides this one */
  note?: (s: Settings) => string | null;
  hidden?: () => boolean;
  /** FEAT-285: a heavy graphics option, held as pending until Apply (the settings screen edits a draft of it) */
  held?: boolean;
}
interface Valued extends Base { get: (s: Settings) => V; set: (s: Settings, v: V) => void }
export type Row =
  | (Valued & { kind: 'toggle' })
  | (Valued & { kind: 'seg' | 'pick'; opts: Opt[] | ((s: Settings) => Opt[]) })
  | (Valued & { kind: 'slider'; min: number; max: number; step: number; fmt: (v: number) => string })
  | (Valued & { kind: 'color' })
  | (Base & { kind: 'action'; button: string | ((s: Settings) => string); action: string })
  | (Base & { kind: 'info' })
  /** drawn by the overlay (key slots, credits); `mount` names what it draws */
  | (Base & { kind: 'custom'; mount: string });
export interface Section { cat: CatId; title: string; rows: Row[] }

const K = <T extends keyof Settings>(k: T) => ({ get: (s: Settings) => s[k] as unknown as V, set: (s: Settings, v: V) => { (s as unknown as Record<string, V>)[k] = v; } });
const toggle = <T extends keyof Settings>(k: T, label: string, desc: Base['desc'], extra: Partial<Base> = {}): Row => ({ kind: 'toggle', id: k, label, desc, ...K(k), ...extra });
const seg = <T extends keyof Settings>(k: T, label: string, opts: Opt[], desc: Base['desc'], extra: Partial<Base> = {}): Row => ({ kind: 'seg', id: k, label, desc, opts, ...K(k), ...extra });
const pick = <T extends keyof Settings>(k: T, label: string, opts: Opt[], desc: Base['desc'], extra: Partial<Base> = {}): Row => ({ kind: 'pick', id: k, label, desc, opts, ...K(k), ...extra });
const slider = <T extends keyof Settings>(k: T, label: string, min: number, max: number, step: number, fmt: (v: number) => string, desc: Base['desc'], extra: Partial<Base> = {}): Row => ({ kind: 'slider', id: k, label, desc, min, max, step, fmt, ...K(k), ...extra });
const pct = (v: number) => `${Math.round(v * 100)}%`;
const times = (v: number) => `${v.toFixed(2)}x`;
const motion = (s: Settings) => (s.reduceMotion ? 'Off while Reduce motion is on (Accessibility).' : null);

// ---------------------------------------------------------------- presets
export type GfxPreset = 'low' | 'medium' | 'high' | 'ultra';
const fullRes = () => Math.min(2, window.devicePixelRatio || 1);
/** Graphics presets: the three quality levels, and Ultra = High plus cascaded shadows at full resolution */
export function applyGfxPreset(s: Settings, p: GfxPreset): void {
  applyQuality(s, p === 'ultra' ? 'high' : p);
  s.csmExperimental = p === 'ultra';
  if (p === 'ultra') s.pixelRatio = fullRes();
}
const GFX_FIELDS = ['quality', 'shadows', 'treeDensity', 'forestDensity', 'pixelRatio', 'csmExperimental'] as const;
/** FEAT-285: the fields the held rows write; changing one rebuilds shaders, shadow maps or the trees, so they wait for Apply */
export const HELD_FIELDS = [...GFX_FIELDS, 'snowDeform'] as const;
const held = { held: true } as const;
export function gfxPresetOf(s: Settings): GfxPreset | 'custom' {
  for (const p of ['low', 'medium', 'high', 'ultra'] as GfxPreset[]) {
    const t = { ...s }; applyGfxPreset(t, p);
    if (GFX_FIELDS.every((f) => t[f] === s[f])) return p;
  }
  return 'custom';
}
export type FeelPreset = 'arcade' | 'realistic';
/** Feel presets set the gameplay feel options together: press balance and the fall line (FEAT-134; jump mode joins as it lands).
 *  Two, by Drew's call: Arcade forgives, Realistic is the defaults (Hard press balance stays a manual pick) */
const FEEL: Record<FeelPreset, Partial<Settings>> = {
  arcade: { pressBalance: 'easy', fallLine: 'off' }, realistic: { pressBalance: 'on', fallLine: 'real' },
};
export function applyFeelPreset(s: Settings, p: FeelPreset): void { Object.assign(s, FEEL[p]); }
export function feelPresetOf(s: Settings): FeelPreset | 'custom' {
  for (const p of Object.keys(FEEL) as FeelPreset[]) if (Object.entries(FEEL[p]).every(([k, v]) => s[k as keyof Settings] === v)) return p;
  return 'custom';
}
export const GFX_OPTS: Opt[] = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']];
export const FEEL_OPTS: Opt[] = [['arcade', 'Arcade'], ['realistic', 'Realistic']];

const outfitPreset = (s: Settings) => Object.entries(OUTFIT_PRESETS).find(([, o]) => (Object.keys(o) as (keyof Outfit)[]).every((k) => o[k] === s.outfit[k]))?.[0] ?? '';
const colour = (k: keyof Outfit, label: string): Row => ({ kind: 'color', id: `outfit.${k}`, what: 'outfit', label, desc: `The ${label.toLowerCase()} colour. Pick any colour; the preset shows Custom after.`, get: (s) => s.outfit[k], set: (s, v) => { s.outfit[k] = String(v); } });
const outrun = <T extends keyof Settings['outrun']>(k: T) => ({ get: (s: Settings) => s.outrun[k] as unknown as V, set: (s: Settings, v: V) => { (s.outrun as unknown as Record<string, V>)[k] = v; }, what: 'outrun' });

// ---------------------------------------------------------------- the rows
export const SECTIONS: Section[] = [
  { cat: 'gameplay', title: 'Feel', rows: [
    { kind: 'seg', id: 'feel', label: 'Feel', opts: FEEL_OPTS, what: 'pressBalance', get: (s) => feelPresetOf(s), set: (s, v) => applyFeelPreset(s, v as FeelPreset),
      desc: 'Sets the feel options together. Arcade forgives more, Realistic asks more of you. Changing an option below shows Custom.' },
    pick('pressBalance', 'Press balance', [['easy', 'Easy'], ['on', 'Normal'], ['hard', 'Hard'], ['off', 'Off']], 'Holding a nose or tail press is a balancing act: steer to keep the balance point centred. Easy drifts slowly, Hard fast, Off holds the press as long as the key.'),
    seg('fallLine', 'Fall line', [['real', 'Realistic'], ['assist', 'Assisted'], ['off', 'Off']], 'How hard the hill works on a flat board. Realistic: it drifts down and comes round toward the fall line unless you hold the uphill edge, a board let go across the hill side-slips, and sliding sideways onto the edge you are sliding toward catches it. Assisted: half the pull and no edge catches. Off: a flat board holds a traverse on rails.'),
  ] },
  { cat: 'gameplay', title: 'Rider', rows: [
    seg('discipline', 'Ride', [['board', 'Snowboard'], ['ski', 'Skis']], () => `Snowboard or skis. ${keyName(MENU_KEYS.discipline[0])} on the main menu switches too.`),
    seg('stance', 'Stance', [['regular', 'Regular'], ['goofy', 'Goofy']], 'Your normal stance on the board: regular rides left foot forward, goofy right foot forward.'),
    toggle('invertSteer', 'Invert steer', 'Swaps left and right steering.'),
  ] },
  { cat: 'gameplay', title: 'Modes', rows: [
    toggle('timeTrials', 'Time trials', (s) => `Start and finish gates on real runs, a timer, and a ghost of your best run. Off by default${keysOf(s, 'trial') ? `; ${keysOf(s, 'trial')} takes you to the nearest course` : ''}.`),
    { kind: 'pick', id: 'outrun.difficulty', label: 'Outrun difficulty', opts: [['chill', 'Chill'], ['normal', 'Normal'], ['skifree', 'SkiFree']], ...outrun('difficulty'),
      desc: 'A snow monster chases you down the mountain. Chill gives a 10 s head start, Normal 7 s, SkiFree 5 s and only the boost saves you.' },
    { kind: 'seg', id: 'outrun.escape', label: 'Outrun escape', opts: [['base', 'Reach the base'], ['endless', 'Endless']], ...outrun('escape'),
      desc: 'Reach the base to escape, or ride endless: a second monster joins at 3 minutes.' },
    { kind: 'toggle', id: 'outrun.gentle', label: 'Outrun gentle', ...outrun('gentle'), desc: 'When it catches you, you are swallowed whole: no rip.' },
  ] },

  { cat: 'controls', title: 'Keyboard', rows: [
    { kind: 'info', id: 'keys-help', label: 'Rebinding', desc: 'Select a slot, then press a key (or the right mouse button). Esc cancels, Delete clears the slot. A slot in red shares its key with another action.' },
    { kind: 'custom', id: 'keys', mount: 'keys', label: 'Keys', desc: 'Two keys per action. Select a slot, then press the new key.' },
    { kind: 'action', id: 'keys-reset', label: 'Reset keys', button: 'Reset keys to defaults', action: 'keys-reset', desc: 'Puts every key back to the default layout.' },
  ] },
  { cat: 'controls', title: 'Controller', rows: [
    { kind: 'custom', id: 'pad-help', mount: 'pad-help', label: 'Fixed buttons', desc: 'The sticks and the pause button are fixed; everything else can be rebound below.' },
    toggle('rumble', 'Vibration', 'Rumble on landings, carves and crashes.', { what: 'rumble' }),
    slider('vibration', 'Vibration strength', 0.05, 1, 0.05, pct, 'How strong the rumble is.'),
    { kind: 'action', id: 'rumble-test', label: 'Test vibration', button: 'Test vibration', action: 'rumble-test', desc: 'Plays a short rumble on the controller in use and says whether the browser could.' },
    slider('padDead', 'Stick dead zone', 0.05, 0.4, 0.01, pct, 'How far the stick moves before it counts. Raise it if the rider drifts with the stick at rest.'),
    slider('padTrigDead', 'Trigger dead zone', 0.05, 0.7, 0.05, pct, 'How far a trigger goes down before it counts.'),
    slider('lookSens', 'Look speed', 0.25, 3, 0.05, times, 'How fast the right stick turns the camera.'),
    toggle('invertLookY', 'Invert look Y', 'Pushing the right stick up looks down.'),
    { kind: 'custom', id: 'padkeys', mount: 'padkeys', label: 'Buttons', desc: 'Two controller buttons per action. Select a slot, then press the button (Esc or 6 s cancels, Delete clears).' },
    { kind: 'action', id: 'pad-reset', label: 'Reset buttons', button: 'Reset controller buttons', action: 'pad-reset', desc: 'Puts every controller button back to the default layout.' },
  ] },
  { cat: 'controls', title: 'DualSense extras', rows: [
    { kind: 'info', id: 'hid-none', label: 'DualSense extras', hidden: () => DualSenseHID.supported, desc: 'The DualSense extras (lightbar, adaptive triggers, gyro look) need Chrome or Edge on https or localhost (WebHID).' },
    { kind: 'action', id: 'hid', label: 'DualSense extras', button: 'Connect', action: 'hid', hidden: () => !DualSenseHID.supported, desc: 'Lightbar, adaptive triggers, gyro look and touchpad swipes, over WebHID (Chrome or Edge, USB or Bluetooth). Click with the mouse and pick the controller: the browser only opens its picker on a click.' },
    toggle('padTriggers', 'Adaptive triggers', 'The triggers push back as you tuck and brake.', { hidden: () => !DualSenseHID.supported }),
    toggle('padLightbar', 'Lightbar', 'The lightbar shows speed and Outrun danger.', { hidden: () => !DualSenseHID.supported }),
    toggle('padGyro', 'Gyro look', 'Tilt the controller to look around.', { hidden: () => !DualSenseHID.supported }),
    slider('gyroSens', 'Gyro speed', 0.25, 3, 0.05, times, 'How fast tilting turns the camera.', { hidden: () => !DualSenseHID.supported }),
  ] },

  { cat: 'camera', title: 'View', rows: [
    pick('camera', 'Default camera', [['chase', 'Chase'], ['close', 'Close'], ['far', 'Far (angled)'], ['cine', 'Cinematic'], ['fp', 'First person'], ['helmet', 'Helmet cam']], (s) => `The camera you start with.${keysOf(s, 'camera') ? ` ${keysOf(s, 'camera')} cycles them while riding.` : ''}`),
    slider('fov', 'Field of view', 50, 100, 1, (v) => `${v}°`, 'How wide the chase camera sees. Wider shows more of the slope and feels faster.'),
    toggle('speedFov', 'Widen view with speed', 'The view widens as you go faster.'),
    toggle('seeThroughTrees', 'See-through trees', 'A tree that hides you or your line ahead turns see-through, so you can see where you are going in the glades. Trees off to the side stay solid, and so does a tree you are about to hit. Not in first person or the helmet cam.'),
  ] },
  { cat: 'camera', title: 'Motion', rows: [
    toggle('camShake', 'Camera shake', 'Rumble at speed and a jolt on landings.', { note: motion }),
    toggle('speedLines', 'Speed lines', 'Streaks at the edge of the screen at high speed.', { note: motion }),
    slider('fpShake', 'First person shake', 0, 1, 0.05, pct, 'How much the first person and helmet cameras shake. 0 is smooth.', { note: motion }),
  ] },
  { cat: 'camera', title: 'Goggles', rows: [
    toggle('fpVignette', 'FP goggles', 'A goggle frame and lens tint in first person.'),
    slider('goggleStrength', 'Goggle frame', 0, 1, 0.05, pct, 'How much of the goggle frame shows.'),
    pick('goggleLens', 'Goggle lens', LENS_ORDER.map((l) => [l, l === 'auto' ? 'Auto' : LENSES[l].label] as Opt),
      (s) => s.goggleLens === 'auto' ? 'Auto picks by the weather and the sun: yellow in a storm, rose when overcast, amber in low sun, a mirror in sunshine, clear at night. First person only; the rider wears it too.'
        : s.goggleLens === 'off' ? 'No lens in first person.' : `Best for ${LENSES[s.goggleLens]?.bestFor ?? ''}. First person only; the rider wears it too.`),
    slider('lensStrength', 'Lens strength', 0, 1, 0.05, pct, 'How strongly the lens tints and sharpens the first person view.'),
  ] },

  { cat: 'graphics', title: 'Preset', rows: [
    { kind: 'seg', id: 'gfx', label: 'Preset', opts: GFX_OPTS, what: 'quality', get: (s) => gfxPresetOf(s), set: (s, v) => applyGfxPreset(s, v as GfxPreset), held: true,
      desc: 'Sets the options under Advanced together. Ultra is High plus cascaded shadows at full resolution. Changing an advanced option shows Custom.' },
  ] },
  { cat: 'graphics', title: 'Frame rate', rows: [
    seg('targetFps', 'Frame cap', [[30, '30'], [60, '60'], [0, 'Uncapped']], 'The most frames drawn each second. 30 saves battery; Uncapped draws as fast as the display refreshes. Nothing else changes with it: what you set is what is drawn. It applies at once.'),
  ] },
  { cat: 'graphics', title: 'Advanced', rows: [
    { ...seg('quality', 'Detail', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], 'The base detail level: shadow map size, snowflake count and the tree budget. Changing it moves Shadows, Trees, Forest and Resolution with it.', held), set: (s: Settings, v: V) => applyQuality(s, v as Settings['quality']) } as Row,
    toggle('shadows', 'Shadows', 'Sun shadows from the rider, trees and terrain.', held),
    toggle('csmExperimental', 'Cascaded shadows (beta)', 'Sharper shadows near you and shadows far away, in several layers. Experimental: it has turned the terrain black on some GPUs.', held),
    slider('treeDensity', 'Trees', 0.25, 1, 0.05, pct, 'How far out trees are drawn.', held),
    slider('forestDensity', 'Forest', 0, 1, 0.05, pct, 'How closed the forest near you is: the stems drawn between the trees the lidar found. The mapped trees always stay.', { cost: 'Tree instances near you scale with it.', ...held }),
    slider('pixelRatio', 'Resolution', 0.5, 2, 0.25, (v) => `${v}x`, 'Render resolution against the screen. Lower is softer and faster; the device caps the top.', { cost: 'The biggest single cost: pixels drawn scale with its square.', ...held }),
    toggle('snowDeform', 'Snow dents', 'The snow near you takes real trenches and lips.', { note: (s) => (s.quality === 'low' ? 'Off while Detail is Low.' : null), ...held }),
  ] },
  { cat: 'graphics', title: 'Apply', rows: [
    { kind: 'action', id: 'gfx-apply', label: 'Apply', button: 'Apply', action: 'gfx-apply',
      desc: 'The preset and the advanced options wait here until you apply them, so trying one costs nothing. Apply rebuilds the renderer behind a short loading screen. Leaving with changes waiting asks whether to apply or discard them.' },
  ] },

  { cat: 'conditions', title: 'Weather', rows: [
    pick('clouds', 'Weather', [['off', 'Bluebird'], ['cirrus', 'Thin high cloud'], ['few', 'Few clouds'], ['scattered', 'Scattered clouds'], ['broken', 'Broken clouds'], ['overcast', 'Overcast'], ['flurries', 'Light snow'], ['storm', 'Snowstorm']],
      'The sky. Overcast flattens the light on the snow; a snowstorm cuts the view and fills old tracks.'),
    toggle('valleyFog', 'Valley fog', 'Low morning fog in the valleys that burns off as the sun climbs.'),
  ] },
  { cat: 'conditions', title: 'Snow', rows: [
    seg('snowDay', 'Snow conditions', [['fresh', 'Fresh'], ['mid', 'Mid-season'], ['spring', 'Spring']], 'Fresh morning corduroy, mid-season snow that skis out as the day goes on, or spring snow.'),
    pick('newSnow', 'New snow', [['none', 'None'], ['dusting', 'Dusting'], ['6in', '6 in'], ['powder', 'Powder day']], 'How much new snow covers the rock at the start. A storm adds more as it falls.'),
  ] },
  { cat: 'conditions', title: 'Time', rows: [
    pick('timeOfDay', 'Time of day', [['pack', 'Resort default'], ['now', 'Now (real time)'], [7, '7 am'], [9, '9 am'], [11, '11 am'], [13, '1 pm'], [15, '3 pm'], [16.5, '4:30 pm'], [17.5, '5:30 pm']],
      'Where the sun is. Now uses the real clock at the resort.', { what: 'timeOfDay' }),
    pick('month', 'Month', [[12, 'December'], [1, 'January'], [2, 'February'], [3, 'March'], [4, 'April'], [7, 'July']], 'The season, for the height of the sun at a fixed hour.'),
  ] },

  { cat: 'world', title: 'Map', rows: [
    seg('units', 'Units', [['imperial', 'mph, ft'], ['metric', 'km/h, m']], 'Speed, height, distance and snow depth units on the HUD and the map.'),
    toggle('showMarkers', 'Lift markers', 'Markers over the lift stations.'),
    toggle('showLabels', 'Peak names', 'Peak and town names on the mountain. Hidden in a storm.'),
  ] },
  { cat: 'world', title: 'On the mountain', rows: [
    toggle('roadsOnSnow', 'Roads and trails on snow', 'Catwalks and roads drawn on the mountain. Off shows plain snow.'),
    toggle('liftLines', 'Lift-line mazes', 'Lift-line mazes at the chairlift bases; you board only from inside them.'),
  ] },

  { cat: 'audio', title: 'Volume', rows: [
    slider('sfx', 'Effects', 0, 1, 0.05, pct, 'Snow, wind, lifts and the Outrun monster.'),
    slider('music', 'Music', 0, 1, 0.05, pct, 'The music volume.'),
    toggle('mute', 'Mute', 'Silences everything.'),
  ] },
  { cat: 'audio', title: 'Music', rows: [
    pick('musicSource', 'Music source', [['files', 'Playlist'], ['builtin', 'Built-in jukebox'], ['off', 'Off']], 'Playlist plays the shipped tracks (the built-in jukebox where a playlist has none). The jukebox makes procedural music in each playlist\'s style.'),
    pick('playlist', 'Station', [...PLAYLISTS.map((p) => [p.name, p.name] as Opt), [SHUFFLE_ALL, 'Shuffle all']], (s) => `The station.${keysOf(s, 'track') ? ` ${keysOf(s, 'track')} skips to the next track while riding.` : ''}`),
  ] },

  { cat: 'rider', title: 'Outfit', rows: [
    { kind: 'pick', id: 'outfit.preset', what: 'outfit', label: 'Preset', opts: (s) => [...(outfitPreset(s) ? [] : [['', 'Custom'] as Opt]), ...Object.keys(OUTFIT_PRESETS).map((n) => [n, n] as Opt)],
      get: (s) => outfitPreset(s), set: (s, v) => { const n = String(v); if (!OUTFIT_PRESETS[n]) return; s.outfit = { ...OUTFIT_PRESETS[n] }; if (OUTFIT_LENS[n]) s.goggleLens = OUTFIT_LENS[n]; },
      desc: 'A full outfit. Each preset comes with its own goggle lens.' },
    colour('jacket', 'Jacket'), colour('pants', 'Pants'), colour('helmet', 'Helmet'), colour('gloves', 'Gloves'), colour('board', 'Board'),
  ] },

  { cat: 'access', title: 'Display', rows: [
    slider('uiScale', 'UI scale', 0.8, 1.5, 0.05, pct, 'Scales the menus, the HUD, prompts and the touch controls.'),
  ] },
  { cat: 'access', title: 'Motion', rows: [
    toggle('reduceMotion', 'Reduce motion', 'Turns camera shake, first person shake and speed lines off together, and the menus stop animating.'),
  ] },

  { cat: 'credits', title: 'Credits', rows: [
    { kind: 'custom', id: 'credits', mount: 'credits', label: 'Credits', desc: 'The music and textures in the game and their licences.' },
  ] },
];

/** one row by its id (the pause menu's quick toggles and Outrun options reuse them) */
export const rowById = (id: string): Row | undefined => SECTIONS.flatMap((s) => s.rows).find((r) => r.id === id);
/** the rows of one category */
export const rowsOf = (c: CatId): Row[] => SECTIONS.filter((s) => s.cat === c).flatMap((s) => s.rows);
export const optsOf = (r: Row & { opts: Opt[] | ((s: Settings) => Opt[]) }, s: Settings): Opt[] => (typeof r.opts === 'function' ? r.opts(s) : r.opts);
export const descOf = (r: Row, s: Settings): string => (typeof r.desc === 'function' ? r.desc(s) : r.desc);

/** "Low: off · Medium: on · ..." for a Graphics advanced row, read by applying each preset to a copy */
export function presetLine(r: Row, s: Settings): string | null {
  if (!('get' in r) || r.id === 'gfx' || r.id === 'feel') return null;
  const gfx = (GFX_FIELDS as readonly string[]).includes(r.id), feel = Object.values(FEEL).some((p) => r.id in p);
  if (!gfx && !feel) return null;
  const show = (v: V) => (r.kind === 'toggle' ? (v ? 'on' : 'off') : r.kind === 'slider' ? r.fmt(Number(v)) : (('opts' in r ? optsOf(r, s) : []).find(([o]) => String(o) === String(v))?.[1] ?? String(v)).toLowerCase());
  const list = gfx ? GFX_OPTS : FEEL_OPTS;
  return list.map(([p, name]) => {
    const t: Settings = { ...s, outfit: { ...s.outfit }, outrun: { ...s.outrun } };
    if (gfx) applyGfxPreset(t, p as GfxPreset); else applyFeelPreset(t, p as FeelPreset);
    return `${name}: ${show(r.get(t))}`;
  }).join(' · ');
}
