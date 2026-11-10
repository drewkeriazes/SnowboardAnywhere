import { PAD } from '../sim/Pad';

/**
 * FEAT-128: the fixed menu keys. They are not part of the rebindable riding keymap (`DEFAULT_KEYS`),
 * so a rebind can never lock you out of the menus. MenuNav reads them for input and HintBar for hints.
 */
export type NavIntent = 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'next' | 'prev' | 'prevCat' | 'nextCat' | 'peek' | 'reset' | 'discipline';

export const MENU_KEYS: Record<NavIntent, string[]> = {
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
  select: ['Enter', 'Space'], back: ['Escape'], next: ['Tab'], prev: ['Tab'],
  prevCat: ['KeyQ'], nextCat: ['KeyE'], peek: ['KeyV'], reset: ['KeyR'], discipline: ['KeyB'],
};

/** the controller button behind each menu intent (standard-mapping indices, sim/Pad.ts); PadNav reads them */
export const MENU_PAD: Partial<Record<NavIntent, number>> = {
  up: PAD.UP, down: PAD.DOWN, left: PAD.LEFT, right: PAD.RIGHT,
  select: PAD.A, back: PAD.B, prevCat: PAD.LB, nextCat: PAD.RB, peek: PAD.Y, reset: PAD.X, discipline: PAD.X,
};

/** letter keys: menu shortcuts that must not fire while typing in a field or a select */
export const LETTER_INTENTS: ReadonlySet<NavIntent> = new Set(['prevCat', 'nextCat', 'peek', 'reset', 'discipline']);

/** The menu intent of a key press (Shift+Tab is prev), or null. */
export function intentForKey(code: string, shift: boolean): NavIntent | null {
  if (code === 'Tab') return shift ? 'prev' : 'next';
  for (const k in MENU_KEYS) {
    const i = k as NavIntent;
    if (i === 'next' || i === 'prev') continue;
    if (MENU_KEYS[i].includes(code)) return i;
  }
  return null;
}
