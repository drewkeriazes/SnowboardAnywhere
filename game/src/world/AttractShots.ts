import type { Pack } from '../pack/Pack';

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
  /** a line of facts about the place itself, from a source named here (resort numbers are counted from the pack) */
  facts: string;
  /** the drift: metres of dolly along the view and degrees of pan, over one cycle of `period` seconds */
  dolly: number; pan: number; period: number;
}

export const ATTRACT_SHOTS: Record<string, AttractShot[]> = {
  vail: [
    {
      // on the ridge just behind the Legendary Back Bowls gateway (world/Landmarks.ts), angled down: the
      // sign on the right, the bowls opening on the left (the pose from the FEAT-128 mockups)
      id: 'back-bowls', x: -727, y: 524, h: 150, pitch: -12, fov: 50, eye: 9,
      place: 'Back Bowls', region: 'Vail · Colorado',
      facts: 'Elev. 11,250 ft at the gateway', // the sign's own "ELEV. 11,250" (Landmarks.ts)
      dolly: 4, pan: 1.5, period: 26,
    },
  ],
};

/** `game/public/attract/index.json`: per resort, the shot ids with a rendered still and the ghost take files. */
export type AttractManifest = Record<string, { stills?: string[]; ghosts?: string[] }>;
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
    place: pack.meta.name, region: '', facts: '', dolly: 4, pan: 1.5, period: 26,
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
