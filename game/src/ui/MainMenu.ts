import type { GameAudio } from '../audio/Audio';

export interface MenuChoice { action: 'ride' | 'map'; lowgfx: boolean }

/**
 * Start screen: resort name, Free ride (continue from the last spawn), Drop in from the map,
 * audio sliders and a graphics toggle. The first click also unlocks audio. Resolves once.
 */
export function showMainMenu(resortName: string, audio: GameAudio, opts: { lowgfx: boolean }): Promise<MenuChoice> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.id = 'menu';
    wrap.innerHTML = `
      <div class="panel">
        <div class="eyebrow">SnowboardAnywhere</div>
        <h1>${resortName}</h1>
        <button data-a="ride" class="primary">Free ride</button>
        <button data-a="map">Drop in from the map</button>
        <div class="row"><label>Effects</label><input type="range" id="sfx" min="0" max="1" step="0.05" value="${audio.sfxVolume}"></div>
        <div class="row"><label>Music</label><input type="range" id="mus" min="0" max="1" step="0.05" value="${audio.musicVolume}"></div>
        <div class="row"><label>Graphics</label><select id="gfx"><option value="high" ${opts.lowgfx ? '' : 'selected'}>High</option><option value="low" ${opts.lowgfx ? 'selected' : ''}>Low (no shadows, fewer trees)</option></select></div>
        <div class="keys">&larr; &rarr; steer &middot; &uarr; tuck &middot; &darr; brake &middot; Space jump &middot; E lift &middot; M map &middot; R restart</div>
      </div>`;
    document.body.appendChild(wrap);
    const sfx = wrap.querySelector('#sfx') as HTMLInputElement, mus = wrap.querySelector('#mus') as HTMLInputElement, gfx = wrap.querySelector('#gfx') as HTMLSelectElement;
    const apply = () => audio.setVolumes(Number(sfx.value), Number(mus.value));
    sfx.addEventListener('input', apply); mus.addEventListener('input', apply);
    wrap.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      audio.start(); apply();
      const lowgfx = gfx.value === 'low';
      try { localStorage.setItem('gfx', gfx.value); } catch { /* ignore */ }
      wrap.remove();
      resolve({ action: b.dataset.a as 'ride' | 'map', lowgfx });
    }));
  });
}
