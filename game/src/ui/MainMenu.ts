import type { GameAudio } from '../audio/Audio';
import { playlistSelect, saveSettings, type Settings } from './Settings';
import { closeSettings, openSettings } from './SettingsOverlay';
import { closeScreen, lastInputKind, openScreen, Screen } from './MenuNav';
import { renderHints, type Hint } from './HintBar';

/**
 * FEAT-138: on a build from `npm run host`, the address another computer on the home network opens, so it is
 * easy to read off and share. Over plain http (not localhost) some browsers (Firefox) hide controllers, so it says how to get them.
 */
function hostedLine(): string {
  const pc = import.meta.env.VITE_HOST_NAME as string | undefined;
  if (!pc) return '';
  const pads = window.isSecureContext ? '' : `<br>Controller not seen? Run <code>npm run host -- --https</code> on ${pc}`;
  return `<div class="keys hosted">Hosted from ${pc} &middot; ${location.host}${pads}</div>`;
}

export interface MenuChoice { action: 'ride' | 'map' }
/** What the menu says about where Free ride starts (BUG-037). */
export interface MenuStart { resortLabel: string; custom: boolean; onReset: () => void }

/**
 * Start screen: resort name, Free ride (continue from the last spawn), Drop in from the map,
 * and the shared settings panel. The first click also unlocks audio. Resolves once per show.
 */
export function showMainMenu(resortName: string, audio: GameAudio, settings: Settings, onChange: (s: Settings, what: string) => void, resorts: { slug: string; name: string }[] = [], current = '', start?: MenuStart): Promise<MenuChoice> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.id = 'menu';
    wrap.innerHTML = `
      <div class="panel">
        <div class="eyebrow">SnowboardAnywhere</div>
        <h1>${resortName}</h1>
        ${resorts.length > 1 ? `<div class="row resort"><label>Resort</label><select data-r="1">${resorts.map((r) => `<option value="${r.slug}" ${r.slug === current ? 'selected' : ''}>${r.name}</option>`).join('')}</select></div>` : ''}
        <div class="row seg"><button data-d="board" class="${settings.discipline === 'board' ? 'on' : ''}">Snowboard</button><button data-d="ski" class="${settings.discipline === 'ski' ? 'on' : ''}">Skis</button></div>
        <div class="row resort music">${'<label>Music</label>' + playlistSelect()}</div>
        <button data-a="ride" class="primary">Free ride</button>
        ${start ? `<div class="start"><span class="where"></span><button class="ghost" data-reset="1">Reset to resort start</button></div>` : ''}
        <button data-a="map">Drop in from the map</button>
        <div class="ds-connect" style="display:none"><button data-ds-connect>Turn on DualSense rumble and lightbar</button><div class="hint ds-status">Click it with the mouse and pick the controller (once: it reconnects by itself after that).</div></div>
        <button data-a="settings">Settings</button>
        <button data-a="controls" class="ghost">Controls</button>
        <div class="hintbar"></div>
        ${hostedLine()}
      </div>`;
    document.body.appendChild(wrap);
    // switching resort reloads with ?pack= (the pack loads before the menu)
    wrap.querySelector<HTMLSelectElement>('select[data-r]')?.addEventListener('change', (e) => {
      const u = new URL(location.href);
      u.searchParams.set('pack', (e.target as HTMLSelectElement).value);
      for (const k of ['x', 'y', 'h']) u.searchParams.delete(k);
      location.href = u.toString();
    });
    if (start) {
      const where = wrap.querySelector('.start .where') as HTMLElement;
      const reset = wrap.querySelector<HTMLButtonElement>('button[data-reset]')!;
      const show = (custom: boolean) => { where.textContent = custom ? 'Starts at your map drop-in' : start.resortLabel; reset.style.display = custom ? '' : 'none'; };
      show(start.custom);
      reset.addEventListener('click', () => { start.onReset(); show(false); });
    }
    // playlist picker on the menu itself (Settings > Audio > Station is the same setting)
    const pick = wrap.querySelector('.music select') as HTMLSelectElement;
    pick.value = settings.playlist;
    pick.addEventListener('input', () => { settings.playlist = pick.value; saveSettings(settings); audio.setPlaylist(settings.playlist); onChange(settings, 'playlist'); });
    // FEAT-128: the settings screen over the menu; the menu applies the audio itself (no session yet)
    const openSet = (cat?: 'controls') => openSettings(settings, {
      overGame: false, cat, credits: () => audio.credits,
      onChange: (s, what) => { audio.setVolumes(s.mute ? 0 : s.sfx, s.mute ? 0 : s.music); audio.setSource(s.musicSource); audio.setPlaylist(s.playlist); pick.value = s.playlist; syncDiscipline(); onChange(s, what); },
    });
    const syncDiscipline = () => wrap.querySelectorAll<HTMLButtonElement>('button[data-d]').forEach((x) => x.classList.toggle('on', x.dataset.d === settings.discipline));
    // keyboard and gamepad navigation, hints from the key tables
    const hintEl = wrap.querySelector('.hintbar') as HTMLElement;
    const showHints = () => renderHints(hintEl, [['select', 'Select'], ['move', 'Move'], ['discipline', 'Snowboard / Skis']] as Hint[], lastInputKind());
    const screen = new Screen(wrap, {
      primary: () => wrap.querySelector<HTMLButtonElement>('button[data-a="ride"]'),
      onIntent: (i, down) => {
        if (down && i === 'discipline') { wrap.querySelector<HTMLButtonElement>(`button[data-d="${settings.discipline === 'board' ? 'ski' : 'board'}"]`)?.click(); return true; }
        return false;
      },
      onInputKind: showHints,
    });
    openScreen(screen);
    showHints();
    wrap.querySelectorAll<HTMLButtonElement>('button[data-d]').forEach((b) => b.addEventListener('click', () => {
      settings.discipline = b.dataset.d as 'board' | 'ski';
      syncDiscipline();
      onChange(settings, 'discipline');
      saveSettings(settings);
    }));
    wrap.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => b.addEventListener('click', () => {
      audio.start();
      audio.setVolumes(settings.mute ? 0 : settings.sfx, settings.mute ? 0 : settings.music);
      if (b.dataset.a === 'controls') { openSet('controls'); return; } // the bindings, read from the keymap
      if (b.dataset.a === 'settings') { openSet(); return; }
      closeSettings();
      closeScreen(screen);
      wrap.remove();
      resolve({ action: b.dataset.a as 'ride' | 'map' });
    }));
  });
}
