import { PAD } from '../sim/Pad';
import { stickGlyph } from './PadGlyphs';
import type { KeyLabels } from './KeyLabels';

/** what the rider is doing, for the hints */
export interface HintState {
  onLift: boolean;
  outrunRunning: boolean;
  onFoot: boolean;
  onGround: boolean;
  liftNearby: boolean;
}

/** FEAT-124: only the keys that matter right now (the full list is in Settings > Controls); FEAT-137: in the controller's own buttons when one is in use. */
export function keyHints(keys: KeyLabels, usingPad: boolean, s: HintState): string {
  const { k, k1, pg } = keys;
  const L = stickGlyph('L');
  if (usingPad) {
    if (s.onLift) return `${k('lift')} skip &middot; ${k('tuck')} hold for 5x &middot; ${k('glance')} look behind &middot; ${stickGlyph('R')} look around`;
    if (s.outrunRunning) return `${k('boost')} boost &middot; ${k('glance')} look behind &middot; ${k('jump')} jump`;
    if (s.onFoot) return `${L} walk &middot; ${k('grab')} sprint &middot; ${k('jump')} jump / climb &middot; ${k('lift')} strap in &middot; ${k('glance')} look behind`;
    if (!s.onGround) return `${L} spin &middot; ${k('tuck')} front flip &middot; ${k('brake')} backflip &middot; ${k('grab')} grab`;
    if (s.liftNearby) return `${k('lift')} ride the lift &middot; ${k('brake')} brake`;
    return `${L} steer &middot; ${k('tuck')} tuck &middot; ${k('brake')} brake &middot; hold ${k('jump')} jump (+ ${L} up / down nollie / ollie) &middot; ${k('grab')} squat (+ steer: hard carve) &middot; ${k('pressNose')} ${k('pressTail')} press (${L} balance) &middot; ${k('skate')} skate<br>${k('lift')} interact &middot; hold ${k('glance')} look behind &middot; ${k('camera')} camera &middot; ${k('map')} map &middot; ${pg(PAD.START)} pause`;
  }
  if (s.onLift) return `${k('lift')} skip &middot; ${k('tuck')} hold for 5x &middot; ${k('glance')} look behind &middot; ${k('look')} look around`;
  if (s.outrunRunning) return `${k('boost')} boost &middot; ${k('glance')} look behind &middot; ${k('jump')} jump`;
  if (s.onFoot) return `${k1('tuck')}${k1('left')}${k1('brake')}${k1('right')} walk &middot; ${k('grab')} sprint &middot; ${k('jump')} jump / climb &middot; ${k('lift')} strap in &middot; ${k('glance')} look behind`;
  if (!s.onGround) return `${k('left')} ${k('right')} spin &middot; ${k('tuck')} front flip &middot; ${k('brake')} backflip &middot; ${k('grab')} grab`;
  if (s.liftNearby) return `${k('lift')} ride the lift &middot; ${k('brake')} brake`;
  return `${k('left')} ${k('right')} steer &middot; ${k('tuck')} tuck &middot; ${k('brake')} brake &middot; hold ${k('jump')} jump (+ ${k1('tuck')} / ${k1('brake')} nollie / ollie) &middot; ${k('grab')} squat (+ steer: hard carve) &middot; ${k('pressNose')} ${k('pressTail')} press (${k1('tuck')} / ${k1('brake')} balance) &middot; ${k('skate')} skate<br>${k('lift')} interact &middot; hold ${k('glance')} look behind &middot; ${k('camera')} camera &middot; ${k('map')} map &middot; hold ${k('restart')} restart &middot; Esc pause`;
}
