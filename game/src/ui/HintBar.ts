import { MENU_KEYS, MENU_PAD, type NavIntent } from './MenuKeys';
import type { InputKind } from './MenuNav';
import { padLabel } from './PadMap';
import { keyName } from './Settings';

/** a hint: a menu intent, or 'move' (the arrows / D-pad) and 'cat' (Q E / LB RB), with its label */
export type Hint = [NavIntent | 'move' | 'cat', string];

function chip(i: Hint[0], pad: boolean): string {
  if (i === 'move') return pad ? 'D-pad' : '↑↓';
  if (i === 'cat') return pad ? `${padLabel('LB')} ${padLabel('RB')}` : `${keyName(MENU_KEYS.prevCat[0])} ${keyName(MENU_KEYS.nextCat[0])}`;
  if (pad) { const b = MENU_PAD[i]; return b ? padLabel(b) : ''; }
  return MENU_KEYS[i].map((c) => (c === 'Escape' ? 'Esc' : keyName(c))).join(' / ');
}

/**
 * FEAT-128: a row of button hints read from the menu key table (keyboard) or the pad map (gamepad),
 * whichever was used last. Nothing in it is typed by hand.
 */
export function renderHints(el: HTMLElement, items: Hint[], kind: InputKind): void {
  const pad = kind === 'pad';
  el.innerHTML = items.map(([i, label]) => { const c = chip(i, pad); return c ? `<span><kbd>${c}</kbd>${label}</span>` : ''; }).join('');
}
