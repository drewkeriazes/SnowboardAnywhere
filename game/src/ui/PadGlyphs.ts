import { PAD, padButtonName, type PadKind } from '../sim/Pad';

/**
 * FEAT-137: controller buttons as small inline glyphs for the hints, prompts, menus and settings.
 * PlayStation face buttons are our own drawings of the four shapes (no logos); Xbox-style pads get
 * lettered circles; everything else is a text pill (R2, L1, Options, D-pad arrows).
 */
const svg = (inner: string, title: string) => `<span class="pg" title="${title}"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#1b2030" stroke="rgba(255,255,255,.55)" stroke-width="1.2"/>${inner}</svg></span>`;
const PS_FACE: Record<number, string> = {
  [PAD.A]: '<path d="M6 6 L14 14 M14 6 L6 14" stroke="#8fb3ff" stroke-width="2" stroke-linecap="round" fill="none"/>',
  [PAD.B]: '<circle cx="10" cy="10" r="4.6" stroke="#ff7b7b" stroke-width="1.9" fill="none"/>',
  [PAD.X]: '<rect x="5.8" y="5.8" width="8.4" height="8.4" stroke="#f3a3cf" stroke-width="1.9" fill="none"/>',
  [PAD.Y]: '<path d="M10 5 L15 13.8 L5 13.8 Z" stroke="#5fd6ad" stroke-width="1.9" stroke-linejoin="round" fill="none"/>',
};
const XBOX_FACE: Record<number, [string, string]> = { [PAD.A]: ['A', '#6cc24a'], [PAD.B]: ['B', '#ef5350'], [PAD.X]: ['X', '#42a5f5'], [PAD.Y]: ['Y', '#fdd835'] };
const DPAD: Record<number, string> = { [PAD.UP]: 'M8.2 3.8h3.6v4.6h-3.6z', [PAD.DOWN]: 'M8.2 11.6h3.6v4.6h-3.6z', [PAD.LEFT]: 'M3.8 8.2h4.6v3.6h-4.6z', [PAD.RIGHT]: 'M11.6 8.2h4.6v3.6h-4.6z' };
const pill = (t: string, title = t) => `<span class="pg pill" title="${title}">${t}</span>`;

/** One button. */
export function padGlyph(kind: PadKind, b: number): string {
  const name = padButtonName(kind, b);
  if (b in PS_FACE && kind === 'ps') return svg(PS_FACE[b], name);
  if (b in XBOX_FACE) { const [l, c] = XBOX_FACE[b]; return svg(`<text x="10" y="14.2" text-anchor="middle" font-size="11" font-weight="700" font-family="system-ui,sans-serif" fill="${c}">${l}</text>`, name); }
  if (b in DPAD) {
    const arms = Object.values(DPAD).map((d) => `<path d="${d}" fill="rgba(255,255,255,.38)"/>`).join('') + '<rect x="8.2" y="8.2" width="3.6" height="3.6" fill="rgba(255,255,255,.38)"/>';
    return svg(`${arms}<path d="${DPAD[b]}" fill="#ffd166"/>`, name);
  }
  const short: Record<PadKind, Record<number, string>> = {
    ps: { [PAD.SELECT]: 'Create', [PAD.START]: 'Options', [PAD.HOME]: 'PS', [PAD.TOUCH]: 'Touchpad' },
    xbox: { [PAD.SELECT]: 'Select', [PAD.START]: 'Start', [PAD.HOME]: 'Guide' },
    generic: { [PAD.SELECT]: 'Select', [PAD.START]: 'Start', [PAD.HOME]: 'Home' },
  };
  return pill(short[kind][b] ?? name, name);
}

/** Every button bound to an action ("R2", or "D-pad right / Touchpad"); '' when none. */
export function padGlyphs(kind: PadKind, buttons: readonly number[] | undefined): string {
  return (buttons ?? []).map((b) => padGlyph(kind, b)).join(' ');
}

export const stickGlyph = (side: 'L' | 'R'): string => pill(side === 'L' ? 'L stick' : 'R stick', side === 'L' ? 'Left stick' : 'Right stick');
export const pauseGlyph = (kind: PadKind): string => padGlyph(kind, PAD.START);
