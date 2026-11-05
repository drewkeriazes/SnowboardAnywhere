import type { GameAudio } from '../audio/Audio';
import { renderPanel, type Settings } from './Settings';

export interface MenuChoice { action: 'ride' | 'map' }

/**
 * Start screen: resort name, Free ride (continue from the last spawn), Drop in from the map,
 * and the shared settings panel. The first click also unlocks audio. Resolves once per show.
 */
export function showMainMenu(resortName: string, audio: GameAudio, settings: Settings, onChange: (s: Settings, what: string) => void): Promise<MenuChoice> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.id = 'menu';
    wrap.innerHTML = `
      <div class="panel">
        <div class="eyebrow">SnowboardAnywhere</div>
        <h1>${resortName}</h1>
        <button data-a="ride" class="primary">Free ride</button>
        <button data-a="map">Drop in from the map</button>
        <button data-a="settings">Settings</button>
        <div class="settings hidden"></div>
        <div class="keys">&larr; &rarr; steer &middot; &uarr; tuck &middot; &darr; brake &middot; Space jump &middot; E lift &middot; M map &middot; Esc pause</div>
      </div>`;
    document.body.appendChild(wrap);
    const panel = wrap.querySelector('.settings') as HTMLElement;
    renderPanel(panel, settings, (s, what) => { audio.setVolumes(s.mute ? 0 : s.sfx, s.mute ? 0 : s.music); audio.setSource(s.musicSource); onChange(s, what); });
    const credits = panel.querySelector('.credits') as HTMLElement;
    const fillCredits = () => {
      const c = audio.credits;
      credits.innerHTML = c.length
        ? `<div class="hint">Music</div>` + c.map((t) => `<div class="credit">${t.title}${t.artist ? ` by ${t.artist}` : ''}${t.license ? ` <span class="dim">(${t.license})</span>` : ''}${t.url ? ` <a href="${t.url}" target="_blank" rel="noopener">source</a>` : ''}</div>`).join('')
        : `<div class="hint">No playlist shipped: the built-in jukebox plays procedural ska-punk. Drop tracks in game/public/music/ (see README there).</div>`;
    };
    fillCredits();
    setTimeout(fillCredits, 1500);
    wrap.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => b.addEventListener('click', () => {
      audio.start();
      audio.setVolumes(settings.mute ? 0 : settings.sfx, settings.mute ? 0 : settings.music);
      if (b.dataset.a === 'settings') { panel.classList.toggle('hidden'); return; }
      wrap.remove();
      resolve({ action: b.dataset.a as 'ride' | 'map' });
    }));
  });
}
