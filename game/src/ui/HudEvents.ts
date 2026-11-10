import type { Events } from '../core/Events';
import type { PressEnd } from '../sim/Rider';
import { switchName } from '../sim/Rider';
import type { Settings } from './Settings';
import type { TrialHud } from './TrialHud';
import type { RunCard } from './RunCard';
import { fmtDistance } from './Units';

export interface HudEventDeps {
  toast: (text: string, ms?: number) => void;
  trialHud: TrialHud;
  runCard: RunCard;
  settings: Settings;
  slug: string;
  headless: boolean;
}

const PRESS_HOW: Record<PressEnd, string> = { clean: '', flat: ' · dropped flat', slam: ' · slammed', stall: ' · stalled' };

/** FEAT-163: the HUD's side of the news: toasts, the time trial panel, the after-run card. */
export function listenHud(events: Events, d: HudEventDeps): void {
  const { toast, trialHud, runCard, settings, headless } = d;
  events.on('trick', (e) => toast(e.name, 1800)); // FEAT-110: flips; FEAT-139: spins and switch tricks
  events.on('washout', (e) => toast(e.side > 0 ? 'Washed out onto the hip' : 'Washed out onto the butt', 1800)); // FEAT-148: a hard carve the edge could not hold
  // FEAT-140: a toast with the time and distance when a press ends (best per resort)
  const pressBestKey = `pressBest:${d.slug}`;
  events.on('pressEnd', (e) => {
    const { how, dir, time: t, dist, switchStance: sw, from } = e;
    let best = 0; try { best = Number(localStorage.getItem(pressBestKey)) || 0; } catch { /* private mode */ }
    const isBest = t > best;
    if (isBest) try { localStorage.setItem(pressBestKey, t.toFixed(2)); } catch { /* private mode */ }
    const press = switchName(dir > 0 ? 'Nose press' : 'Tail press', sw);
    const name = from ? `${from} to ${press[0].toLowerCase()}${press.slice(1)}` : press; // landed into it from a trick
    const tail = isBest ? (best > 0 ? ' · new best!' : '') : ` · best ${best.toFixed(1)} s`;
    toast(`${name} ${t.toFixed(1)} s, ${fmtDistance(dist, settings.units === 'metric')}${PRESS_HOW[how]}${tail}`, 2600);
  });
  events.on('landmark', (e) => toast(e.name, 3000));
  events.on('song', (e) => toast(`♫ ${e.name}`)); // now playing
  events.on('outrun', (e) => { if (e.event.kind === 'second') toast('Another one.', 2500); });
  events.on('trial', (e) => trialHud.onEvent(e.event, e.candidates));
  events.on('runEnd', (e) => { if (!headless) runCard.show(e.summary, settings.units === 'metric'); }); // FEAT-055
}
