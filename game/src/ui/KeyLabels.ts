import type { Controls } from '../sim/Controls';
import { keyName, keysOf, type Settings } from './Settings';
import { padGlyph, padGlyphs, stickGlyph } from './PadGlyphs';

/** FEAT-124 / FEAT-137: how an action's key reads in a prompt: the controller's glyphs while one is in use, else the bound keys. */
export class KeyLabels {
  constructor(private readonly controls: Controls, private readonly settings: Settings) {}

  /** the action's controller buttons, '' on the keyboard (an action with no button keeps its key) */
  readonly padKey = (a: string): string => (this.controls.usingPad ? padGlyphs(this.controls.padKind, this.settings.padKeys[a]) : '');
  /** every key bound to the action, as text */
  readonly keys = (a: string): string => keysOf(this.settings, a);
  /** the action's buttons or every bound key */
  readonly k = (a: string): string => this.padKey(a) || `<kbd>${keysOf(this.settings, a)}</kbd>`;
  /** first binding only (the walk cluster reads "WASD") */
  readonly k1 = (a: string): string => keyName(this.settings.keys[a]?.[0] ?? '');
  readonly lookKey = (): string => (this.controls.usingPad ? stickGlyph('R') : `<kbd>${keysOf(this.settings, 'look') || 'Alt'}</kbd>`);
  /** one controller button's glyph */
  readonly pg = (b: number): string => padGlyph(this.controls.padKind, b);
}
