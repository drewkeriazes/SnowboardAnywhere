import type { GameAudio } from '../audio/Audio';
import { playlistSelect, renderPanel, saveSettings, type Settings } from './Settings';

export interface MenuChoice { action: 'ride' | 'map' }

/**
 * Start screen: resort name, Free ride (continue from the last spawn), Drop in from the map,
 * and the shared settings panel. The first click also unlocks audio. Resolves once per show.
 */
export function showMainMenu(resortName: string, audio: GameAudio, settings: Settings, onChange: (s: Settings, what: string) => void, resorts: { slug: string; name: string }[] = [], current = ''): Promise<MenuChoice> {
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
        <button data-a="map">Drop in from the map</button>
        <button data-a="settings">Settings</button>
        <div class="settings hidden"></div>
        <div class="keys">&larr; &rarr; steer &middot; &uarr; tuck &middot; &darr; brake &middot; Space jump &middot; E lift &middot; M map &middot; Esc pause</div>
      </div>`;
    document.body.appendChild(wrap);
    // switching resort reloads with ?pack= (the pack loads before the menu)
    wrap.querySelector<HTMLSelectElement>('select[data-r]')?.addEventListener('change', (e) => {
      const u = new URL(location.href);
      u.searchParams.set('pack', (e.target as HTMLSelectElement).value);
      for (const k of ['x', 'y', 'h']) u.searchParams.delete(k);
      location.href = u.toString();
    });
    const panel = wrap.querySelector('.settings') as HTMLElement;
    // playlist picker on the menu itself, kept in step with the one under Settings > Audio
    const pick = wrap.querySelector('.music select') as HTMLSelectElement;
    const syncPick = () => { pick.value = settings.playlist; const other = panel.querySelector<HTMLSelectElement>('select[data-k="playlist"]'); if (other) other.value = settings.playlist; };
    pick.value = settings.playlist;
    pick.addEventListener('input', () => { settings.playlist = pick.value; saveSettings(settings); audio.setPlaylist(settings.playlist); syncPick(); onChange(settings, 'playlist'); });
    renderPanel(panel, settings, (s, what) => { audio.setVolumes(s.mute ? 0 : s.sfx, s.mute ? 0 : s.music); audio.setSource(s.musicSource); audio.setPlaylist(s.playlist); syncPick(); onChange(s, what); });
    const credits = panel.querySelector('.credits') as HTMLElement;
    const fillCredits = () => {
      const c = audio.credits;
      credits.innerHTML = c.length
        ? `<div class="hint">Music</div>` + c.map((t) => `<div class="credit">${t.title}${t.artist ? ` by ${t.artist}` : ''}${t.license ? ` <span class="dim">(${t.license})</span>` : ''}${t.url ? ` <a href="${t.url}" target="_blank" rel="noopener">source</a>` : ''}${t.playlist ? ` <span class="dim">${t.playlist}</span>` : ''}</div>`).join('')
          + `<div class="hint">Playlists without tracks play the built-in jukebox (procedural, no samples).</div>`
        : `<div class="hint">No playlist shipped: the built-in jukebox plays procedural music in each playlist's style. Drop tracks in game/public/music/ (see README there).</div>`;
    };
    fillCredits();
    void audio.loaded.then(fillCredits);
    wrap.querySelectorAll<HTMLButtonElement>('button[data-d]').forEach((b) => b.addEventListener('click', () => {
      settings.discipline = b.dataset.d as 'board' | 'ski';
      wrap.querySelectorAll<HTMLButtonElement>('button[data-d]').forEach((x) => x.classList.toggle('on', x === b));
      onChange(settings, 'discipline');
      try { localStorage.setItem('settings', JSON.stringify(settings)); } catch { /* ignore */ }
    }));
    wrap.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => b.addEventListener('click', () => {
      audio.start();
      audio.setVolumes(settings.mute ? 0 : settings.sfx, settings.mute ? 0 : settings.music);
      if (b.dataset.a === 'settings') { panel.classList.toggle('hidden'); return; }
      wrap.remove();
      resolve({ action: b.dataset.a as 'ride' | 'map' });
    }));
  });
}
