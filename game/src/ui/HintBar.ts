import { MENU_KEYS, MENU_PAD, type NavIntent } from './MenuKeys';
import type { InputKind } from './MenuNav';
import { PAD, activePad, lastPadKind } from '../sim/Pad';
import { padGlyph } from './PadGlyphs';
import { keyName } from './Settings';

/** a hint: a menu intent, or 'move' (the arrows / D-pad) and 'cat' (Q E / LB RB), with its label */
export type Hint = [NavIntent | 'move' | 'cat', string];

function keyChip(i: Hint[0]): string {
  if (i === 'move') return '↑↓';
  if (i === 'cat') return `${keyName(MENU_KEYS.prevCat[0])} ${keyName(MENU_KEYS.nextCat[0])}`;
  return MENU_KEYS[i].map((c) => (c === 'Escape' ? 'Esc' : keyName(c))).join(' / ');
}
/** the controller's own glyphs (FEAT-137: PlayStation shapes or Xbox letters) */
function padChip(i: Hint[0]): string {
  const k = activePad()?.kind ?? lastPadKind ?? 'ps'; // as Settings > Controls
  if (i === 'move') return padGlyph(k, PAD.UP) + padGlyph(k, PAD.DOWN);
  if (i === 'cat') return `${padGlyph(k, PAD.LB)} ${padGlyph(k, PAD.RB)}`;
  const b = MENU_PAD[i];
  return b === undefined ? '' : padGlyph(k, b);
}

/**
 * FEAT-128: a row of button hints read from the menu key table (keyboard) or the controller's glyphs
 * (gamepad), whichever was used last. Nothing in it is typed by hand.
 */
export function renderHints(el: HTMLElement, items: Hint[], kind: InputKind): void {
  const pad = kind === 'pad';
  el.innerHTML = items.map(([i, label]) => {
    const c = pad ? padChip(i) : keyChip(i);
    return c ? `<span>${pad ? `<kbd class="pad">${c}</kbd>` : `<kbd>${c}</kbd>`}${label}</span>` : '';
  }).join('');
}
