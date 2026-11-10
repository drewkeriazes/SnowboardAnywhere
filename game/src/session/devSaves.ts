import type { Settings } from '../ui/Settings';
import { OUTFIT_PRESETS } from '../ui/Settings';
import { takeFrom, type AttractGhosts } from '../world/AttractGhosts';
import type { ReplaySample } from '../sim/Replay';

/**
 * Saves that go through the dev server when it is there (vite.config.ts endpoints) and fall back to a
 * browser download on a hosted build or when the endpoint fails.
 */

/** an eye camera pose, rounded as it is written into the URL and the compare file */
export interface EyePose { x: number; y: number; h: number; pitch: number; fov: number; eye: number }

/** FEAT-128 (?debug, replay viewer): the span marked with I and O saved as a take for the main menu's ghosts. */
export function saveTake(o: {
  takeIn: number | null; takeOut: number | null; samples: ReplaySample[]; slug: string; settings: Settings;
  ghosts: AttractGhosts; hosted: boolean; toast: (text: string) => void;
}): void {
  const { takeIn, takeOut, settings, slug, toast } = o;
  if (takeIn === null || takeOut === null || takeOut - takeIn < 1) { toast('Mark a span first: I at the start, O at the end'); return; }
  const outfit = Object.entries(OUTFIT_PRESETS).find(([, p]) => Object.keys(p).every((k) => p[k as keyof typeof p] === settings.outfit[k as keyof typeof p]))?.[0] ?? 'Classic red';
  const take = takeFrom(o.samples, Math.min(takeIn, takeOut), Math.max(takeIn, takeOut), { pack: slug, discipline: settings.discipline, stance: settings.stance, outfit });
  o.ghosts.add(take); // ride it behind the menu now
  const json = JSON.stringify(take);
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = `${slug}-take.json`; a.click();
    toast('Saved the take to Downloads: put it in game/public/attract/<resort>/ and list it in index.json');
  };
  if (o.hosted) { download(); return; }
  fetch('/__attract/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pack: slug, take: json }) })
    .then(async (r) => { if (!r.ok) throw new Error(await r.text()); const { file } = await r.json() as { file: string }; toast(`Saved ${file}`); })
    .catch((e) => { console.warn('take save failed, downloading instead', e); download(); });
}

/** DATA-008: save the canvas into docs/compare through the dev server when ?spot= is set, else a browser download. */
export function saveShot(o: {
  dataUrl: string; jpgUrl: string; eye: EyePose; spot: string; slug: string; weather: string;
  hosted: boolean; toast: (text: string) => void;
}): void {
  const { dataUrl, jpgUrl, eye: p, spot, slug, toast } = o;
  const pose = { x: +p.x.toFixed(1), y: +p.y.toFixed(1), h: +p.h.toFixed(1), pitch: +p.pitch.toFixed(1), fov: +p.fov.toFixed(1), eye: +p.eye.toFixed(2) };
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(pose)) u.searchParams.set(k, String(v));
  history.replaceState(null, '', u.toString());
  console.log('eye shot', JSON.stringify({ spot, ...pose, link: u.toString() }));
  const download = () => {
    const a = document.createElement('a');
    a.href = dataUrl; a.download = `${slug}_${pose.x}_${pose.y}_${pose.h.toFixed(0)}.png`; a.click();
    toast('Saved the shot to Downloads');
  };
  if (!spot || o.hosted) { download(); return; } // the compare-shot endpoint is dev server only
  fetch('/__compare/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pack: slug, spot, pose, weather: o.weather, link: u.toString(), png: dataUrl, jpg: jpgUrl }) })
    .then(async (r) => {
      if (!r.ok) throw new Error(await r.text());
      const { file, warning } = await r.json() as { file: string; warning?: string };
      if (warning) console.warn(warning);
      toast(warning ? `Saved ${file}. ${warning}` : `Saved ${file}`);
    })
    .catch((e) => { console.warn('compare save failed, downloading instead', e); download(); });
}

/**
 * FEAT-181 (?debug, eye camera, Shift+P): the view as the resort's main menu shot. The heading is set half the pan
 * right of the view, so the drift starts (shotPose at 0) on exactly what was framed. The dev server writes
 * game/public/attract/<pack>/shots.json (replacing the shot there and the riders made for it); a hosted build
 * downloads the file instead.
 */
export function saveMenuShot(o: {
  slug: string; eye: EyePose; labels: { id: string; place: string; region: string };
  conditions: Record<string, unknown>; hosted: boolean; toast: (text: string, ms?: number) => void;
}): void {
  const pan = 1.5;
  const shot = { ...o.labels, x: o.eye.x, y: o.eye.y, h: o.eye.h + pan / 2, pitch: o.eye.pitch, fov: o.eye.fov, eye: o.eye.eye, dolly: 4, pan, period: 26, conditions: o.conditions };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify([shot], null, 2)], { type: 'application/json' })); a.download = 'shots.json'; a.click();
    o.toast(`Saved shots.json to Downloads: put it in game/public/attract/${o.slug}/`);
  };
  if (o.hosted) { download(); return; }
  fetch('/__attract/shot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pack: o.slug, shot }) })
    .then(async (r) => {
      if (!r.ok) throw new Error(await r.text());
      const { file, removed } = await r.json() as { file: string; removed: string[] };
      o.toast(`Menu shot saved: ${file}${removed.length ? ` (removed the old shot's ${removed.length} files)` : ''}`, 6000);
    })
    .catch((e) => { console.warn('menu shot save failed, downloading instead', e); download(); });
}
