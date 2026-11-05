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
  quality: Quality;
  shadows: boolean;
  treeDensity: number; // 0.25 .. 1
  pixelRatio: number; // 0.5 .. 2 (capped by the device)
  fov: number; // base chase FOV, 50 .. 100
  invertSteer: boolean;
  camera: CamMode;
  fpVignette: boolean;
  showMarkers: boolean;
  units: Units;
  keys: Record<string, string>; // action -> KeyboardEvent.code
}

export const DEFAULT_KEYS: Record<string, string> = {
  left: 'ArrowLeft', right: 'ArrowRight', tuck: 'ArrowUp', brake: 'ArrowDown', jump: 'Space', grab: 'ShiftLeft',
  lift: 'KeyE', map: 'KeyM', camera: 'KeyC', restart: 'KeyR', piste: 'KeyP', fly: 'KeyF', track: 'KeyN',
};
const KEY_LABELS: Record<string, string> = { left: 'Steer left', right: 'Steer right', tuck: 'Tuck', brake: 'Brake', jump: 'Jump (hold)', grab: 'Grab', lift: 'Ride lift / skip', map: 'Map', camera: 'Camera', restart: 'Restart', piste: 'Piste lines', fly: 'Free fly', track: 'Next track' };

const DEFAULTS: Settings = {
  v: 1, sfx: 0.8, music: 0.5, mute: false, quality: 'high', shadows: true, treeDensity: 1, pixelRatio: Math.min(2, window.devicePixelRatio || 1),
  fov: 68, invertSteer: false, camera: 'chase', fpVignette: true, showMarkers: true, units: 'imperial', keys: { ...DEFAULT_KEYS },
};
const KEY = 'settings';

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && raw.v === DEFAULTS.v) return { ...DEFAULTS, ...raw, keys: { ...DEFAULT_KEYS, ...(raw.keys ?? {}) } };
    // migrate the older separate keys
    const s = { ...DEFAULTS, keys: { ...DEFAULT_KEYS } };
    const a = JSON.parse(localStorage.getItem('audio') ?? '{}');
    if (typeof a.sfx === 'number') s.sfx = a.sfx;
    if (typeof a.music === 'number') s.music = a.music;
    if (localStorage.getItem('gfx') === 'low') { s.quality = 'low'; s.shadows = false; s.treeDensity = 0.3; s.pixelRatio = 1; }
    return s;
  } catch { return { ...DEFAULTS, keys: { ...DEFAULT_KEYS } }; }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

export function resetSettings(): Settings {
  const s = { ...DEFAULTS, keys: { ...DEFAULT_KEYS } };
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

/**
 * Render the settings panel into `host`. Every edit mutates `s`, saves, and calls `onChange`.
 */
export function renderPanel(host: HTMLElement, s: Settings, onChange: (s: Settings, what: string) => void): void {
  host.innerHTML = `
    <div class="tabs"><button data-t="audio" class="on">Audio</button><button data-t="graphics">Graphics</button><button data-t="controls">Controls</button><button data-t="game">Game</button></div>
    <div class="tab" data-t="audio">
      <div class="row"><label>Effects</label><input type="range" data-k="sfx" min="0" max="1" step="0.05"></div>
      <div class="row"><label>Music</label><input type="range" data-k="music" min="0" max="1" step="0.05"></div>
      <div class="row"><label>Mute</label><input type="checkbox" data-k="mute"></div>
    </div>
    <div class="tab hidden" data-t="graphics">
      <div class="row"><label>Quality</label><select data-k="quality"><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></div>
      <div class="row"><label>Shadows</label><input type="checkbox" data-k="shadows"></div>
      <div class="row"><label>Trees</label><input type="range" data-k="treeDensity" min="0.25" max="1" step="0.05"></div>
      <div class="row"><label>Resolution</label><input type="range" data-k="pixelRatio" min="0.5" max="2" step="0.25"></div>
      <div class="row"><label>Field of view</label><input type="range" data-k="fov" min="50" max="100" step="1"><span class="val" data-v="fov"></span></div>
      <div class="row"><label>FP vignette</label><input type="checkbox" data-k="fpVignette"></div>
    </div>
    <div class="tab hidden" data-t="controls">
      <div class="row"><label>Invert steer</label><input type="checkbox" data-k="invertSteer"></div>
      <div class="row"><label>Default camera</label><select data-k="camera"><option value="chase">Chase</option><option value="close">Close</option><option value="far">Far</option><option value="fp">First person</option></select></div>
      <div class="keys"></div>
      <div class="hint">Click a key, then press the new one. Esc cancels.</div>
    </div>
    <div class="tab hidden" data-t="game">
      <div class="row"><label>Units</label><select data-k="units"><option value="imperial">mph, ft</option><option value="metric">km/h, m</option></select></div>
      <div class="row"><label>Lift markers</label><input type="checkbox" data-k="showMarkers"></div>
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
      else (s as unknown as Record<string, unknown>)[k] = v;
      saveSettings(s);
      onChange(s, k);
      if (k === 'quality') fill();
      const fv = host.querySelector('[data-v="fov"]'); if (fv) fv.textContent = `${s.fov}°`;
    });
  });
  host.querySelector('[data-a="reset"]')!.addEventListener('click', () => {
    const d = resetSettings();
    Object.assign(s, d, { keys: { ...d.keys } });
    fill(); onChange(s, 'reset');
  });
}
