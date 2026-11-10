import type { Pack } from '../pack/Pack';
import type { Settings } from '../ui/Settings';

/**
 * FEAT-128: the main menu's backdrop shots, one or more per resort, hand-picked so the place is
 * recognisable. The menu runs inside the session: the eye camera sits on the shot and drifts slowly while
 * ghosts ride a line through it. Each shot ships with a still rendered from the same pose
 * (`game/public/attract/<slug>/<id>.jpg`, `tools/shoot_attract.mjs`), shown while the session loads.
 */
export interface AttractShot {
  id: string;
  /** pack metres, heading in degrees clockwise from north, pitch in degrees (+ up), vertical fov, eye height above the snow (m) */
  x: number; y: number; h: number; pitch: number; fov: number; eye: number;
  /** the big title (the place in the shot) and the line above it */
  place: string; region: string;
  /** the place's elevation (m) and where it is measured, from a source named in the table (resort numbers are counted from the pack) */
  elev?: { m: number; where: string };
  /** the drift: metres of dolly along the view and degrees of pan, over one cycle of `period` seconds */
  dolly: number; pan: number; period: number;
  /** FEAT-177: the conditions the menu draws the shot in (and the still is rendered in), whatever the player's settings */
  conditions: ShotConditions;
}

/**
 * FEAT-177: what the shot looks like, as the Settings fields that change the picture: the weather, the sun
 * (a fixed hour on the 15th of `month`, or the pack's own sun), the new snow and the snow day, the valley fog,
 * and where the clouds start (seconds of wind, Clouds.ts). The menu draws these while it is up (until the
 * player picks a condition in its Settings) and `tools/shoot_attract.mjs` renders the still with the same.
 */
export type ShotConditions = Pick<Settings, 'clouds' | 'month' | 'snowDay' | 'valleyFog'> & {
  timeOfDay: 'pack' | number; newSnow: NonNullable<Settings['newSnow']>; cloudTime: number;
};
/** the shot conditions for a resort without a hand-picked shot */
export const DEFAULT_CONDITIONS: ShotConditions = { clouds: 'few', timeOfDay: 'pack', month: 2, newSnow: 'none', snowDay: 'mid', valleyFog: false, cloudTime: 0 };
/** the Settings fields a shot's conditions override (a pick of any of them in the menu's Settings ends the override) */
export const CONDITION_FIELDS = ['clouds', 'timeOfDay', 'month', 'newSnow', 'snowDay', 'valleyFog'] as const;

export const ATTRACT_SHOTS: Record<string, AttractShot[]> = {
  vail: [
    {
      // on the ridge just behind the Legendary Back Bowls gateway (world/Landmarks.ts), angled down: the
      // sign on the right, the bowls opening on the left (the pose from the FEAT-128 mockups)
      id: 'back-bowls', x: -727, y: 524, h: 150, pitch: -12, fov: 50, eye: 9,
      place: 'Back Bowls', region: 'Vail · Colorado',
      elev: { m: 11250 * 0.3048, where: 'at the gateway' }, // the sign's own "ELEV. 11,250" ft (Landmarks.ts)
      dolly: 4, pan: 1.5, period: 26,
      // the look of Drew's photo of the sign (FEAT-132): a bluebird day (no clouds), late morning in February
      conditions: { clouds: 'off', timeOfDay: 11, month: 2, newSnow: 'none', snowDay: 'mid', valleyFog: false, cloudTime: 0 },
    },
  ],
};

/**
 * `game/public/attract/index.json`: per resort, the shot ids with a rendered still, the ghost take files, and
 * (FEAT-177) each still's look key from `tools/shoot_attract.mjs`: `code`, a hash of the source files that
 * change the picture (`tools/attract_look.mjs`, checked in CI), and `pack`, the pack's `meta.build` it was
 * rendered from (checked here: a still from another build of the pack is never shown).
 */
export interface StillLook { code: string; pack: string }
export type AttractManifest = Record<string, { stills?: string[]; ghosts?: string[]; looks?: Record<string, StillLook> }>;

/** The shipped still for a shot, or '' when there is none or it was rendered from another build of the pack. */
export function shippedStill(base: string, man: AttractManifest, pack: Pack, shotId: string): string {
  const mine = man[pack.meta.slug];
  if (!mine?.stills?.includes(shotId)) return '';
  const look = mine.looks?.[shotId];
  if (!look || look.pack !== (pack.meta.build ?? '')) return '';
  return `${base}attract/${pack.meta.slug}/${shotId}.jpg`;
}
/** The manifest ({} when missing, so nothing else is requested and nothing 404s). */
export async function loadAttractManifest(base: string): Promise<AttractManifest> {
  try { const r = await fetch(`${base}attract/index.json`, { cache: 'no-cache' }); return r.ok ? await r.json() as AttractManifest : {}; } catch { return {}; }
}

/** The shot for a resort: its first hand-picked one, else the start looking downhill from 15 m up. */
export function attractShot(pack: Pack, start: { x: number; y: number; heading: number }): AttractShot {
  const s = ATTRACT_SHOTS[pack.meta.slug]?.[0];
  if (s) return s;
  return {
    id: 'start', x: start.x, y: start.y, h: start.heading * 180 / Math.PI, pitch: -10, fov: 55, eye: 15,
    place: pack.meta.name, region: '', dolly: 4, pan: 1.5, period: 26, conditions: DEFAULT_CONDITIONS,
  };
}

/** The pose at time t: a slow dolly along the view and a pan, eased in and out (back and forth over `period`). */
export function shotPose(s: AttractShot, t: number): { x: number; y: number; h: number; pitch: number; fov: number; eye: number } {
  const k = 0.5 - 0.5 * Math.cos((t / s.period) * Math.PI * 2); // 0 .. 1 .. 0
  const hr = s.h * Math.PI / 180;
  return { x: s.x + Math.sin(hr) * s.dolly * k, y: s.y + Math.cos(hr) * s.dolly * k, h: s.h + s.pan * (k - 0.5), pitch: s.pitch, fov: s.fov, eye: s.eye };
}

/** Resort numbers counted from the pack (never typed): named runs, lifts, and the lift-served top and vertical. */
export function resortNumbers(pack: Pack): { runs: number; lifts: number; top: number | null; vertical: number | null } {
  const f = pack.features;
  const runs = new Set(f.runs.filter((r) => r.name && !r.area).map((r) => r.name)).size;
  const zs = f.lifts.flatMap((l) => l.stations.map((s) => s[2])).filter((z) => Number.isFinite(z));
  const top = zs.length ? Math.max(...zs) : null, bottom = zs.length ? Math.min(...zs) : null;
  return { runs, lifts: f.lifts.length, top, vertical: top !== null && bottom !== null ? top - bottom : null };
}
