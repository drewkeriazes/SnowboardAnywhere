import type { Rider } from '../sim/Rider';
import type { LiftRide } from '../sim/LiftRide';
import type { Lifts, LiftRuntime } from '../world/Lifts';
import type { KeyLabels } from './KeyLabels';

export interface PromptState {
  onLift: boolean;
  liftRide: LiftRide<LiftRuntime>;
  lifts: Lifts;
  mapOpen: boolean;
  /** free fly or the eye camera */
  detached: boolean;
  rider: Rider;
  /** a strap message still showing ('' for none) */
  boardMsg: string;
  usingPad: boolean;
  metric: boolean;
}

/** The prompt in the middle of the screen: the lift you are on or near, or strapping in and out (FEAT-124: E straps in and out, or the optional board-only key). */
export function contextPrompt(keys: KeyLabels, s: PromptState): string {
  const { k, padKey, lookKey } = keys;
  const { liftRide, rider } = s;
  if (s.onLift) {
    const pct = ((liftRide.up / (liftRide.lift ? s.lifts.rideLength(liftRide.lift) : 1)) * 100).toFixed(0);
    return `<div class="name">${liftRide.lift?.feature.name ?? 'Lift'}</div><div class="row">${k('lift')} skip to the ${liftRide.lift?.kind === 'carpet' ? 'end' : 'top'} <span class="dim">${pct}%</span></div><div class="row">${k('tuck')} hold for ${liftRide.fast ? '<b>5x speed</b>' : '5x speed'} &nbsp; ${lookKey()} look around</div>`;
  }
  if (liftRide.nearby && !s.mapOpen && !s.detached) {
    const name = liftRide.nearby.feature.name ?? 'Lift';
    const dist = s.metric ? `${liftRide.nearbyDist.toFixed(0)} m` : `${(liftRide.nearbyDist * 3.28084).toFixed(0)} ft`;
    if (liftRide.canBoard) return `<div class="name">${name}</div><div class="row">${k('lift')} ${rider.unstrapped ? 'strap in and ' : ''}${liftRide.nearby.kind === 'gondola' ? 'board the gondola' : liftRide.nearby.kind === 'surface' ? 'grab the lift' : liftRide.nearby.kind === 'carpet' ? 'step on' : 'ride up'}</div>`;
    if (liftRide.blocker === 'fast') return `<div class="name">${name}</div><div class="row">slow down to board ${s.usingPad ? k('brake') : '<kbd>&darr;</kbd>'} brake</div>`;
    return `<div class="name">${name}</div><div class="row">ride to the lift <span class="dim">${dist}</span> then ${k('lift')}</div>`;
  }
  if (!s.mapOpen && !s.detached) {
    // board on / off
    const bk = padKey('board') || padKey('lift') || `<kbd>${keys.keys('board') || keys.keys('lift')}</kbd>`;
    if (s.boardMsg) return `<div class="row">${s.boardMsg}</div>`;
    if (rider.strapState !== 'none') return '';
    if (rider.onFoot) return `<div class="row">${bk} strap in${rider.speed > 0.3 ? ' <span class="dim">(stand still)</span>' : ''} &nbsp; ${k('grab')} sprint</div>`;
    if (rider.canUnstrap) return `<div class="row">${bk} unstrap</div>`;
  }
  return '';
}
