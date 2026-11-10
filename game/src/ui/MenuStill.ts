import type { Pack } from '../pack/Pack';
import type { AttractShot } from '../world/AttractShots';
import type { Settings } from './Settings';

/**
 * FEAT-177: the main menu's still, kept from the real view. The first time the menu crossfades to live, the
 * session saves that frame here (Cache Storage); on later loads the menu shows it instead of the shipped JPEG,
 * so the still is this player's own quality, window and build. The key is the build, the pack build, the shot,
 * its conditions and the quality preset, so any of them changing falls back to the shipped still (or none).
 * Not in the dev server (its build id only changes on a restart, so an edit would show an old frame). Every
 * call is guarded: a private window or a plain-http LAN address has no Cache Storage, and the menu does without.
 */
const CACHE = 'menu-still-v1';
/** the build id from vite.config.ts (a new one each build) */
const BUILD: string = import.meta.env.VITE_BUILD_ID ?? '';

function stillUrl(pack: Pack, shot: AttractShot, s: Pick<Settings, 'quality'>): string | null {
  if (import.meta.env.DEV || !BUILD || typeof caches === 'undefined') return null;
  const c = shot.conditions;
  const cond = [c.clouds, c.timeOfDay, c.month, c.newSnow, c.snowDay, c.valleyFog ? 'fog' : 'nofog', c.cloudTime].join('_');
  const parts = [BUILD, pack.meta.slug, pack.meta.build ?? 'nobuild', shot.id, cond, s.quality].map(encodeURIComponent);
  return new URL(`${import.meta.env.BASE_URL}__menu-still/${parts.join('/')}.jpg`, location.href).toString();
}

/** The kept still for this shot as an object URL, or '' when there is none (or no Cache Storage). */
export async function cachedMenuStill(pack: Pack, shot: AttractShot, s: Pick<Settings, 'quality'>): Promise<string> {
  const url = stillUrl(pack, shot, s);
  if (!url) return '';
  try {
    const hit = await (await caches.open(CACHE)).match(url);
    return hit ? URL.createObjectURL(await hit.blob()) : '';
  } catch { return ''; }
}

/**
 * Keep the frame just drawn on `canvas` as this shot's still. Call it right after the render, in the same task
 * (toBlob reads the drawing buffer when called). Older keys are dropped: one still per shot is all the menu needs.
 */
export function saveMenuStill(canvas: HTMLCanvasElement, pack: Pack, shot: AttractShot, s: Pick<Settings, 'quality'>): void {
  const url = stillUrl(pack, shot, s);
  if (!url) return;
  try {
    canvas.toBlob((blob) => {
      if (!blob) return;
      void (async () => {
        try {
          const cache = await caches.open(CACHE);
          const mine = `/${encodeURIComponent(pack.meta.slug)}/`, id = `/${encodeURIComponent(shot.id)}/`;
          for (const k of await cache.keys()) if (k.url.includes(mine) && k.url.includes(id) && k.url !== url) await cache.delete(k);
          await cache.put(url, new Response(blob, { headers: { 'content-type': 'image/jpeg' } }));
        } catch { /* no Cache Storage here */ }
      })();
    }, 'image/jpeg', 0.85);
  } catch { /* a tainted or lost canvas */ }
}
