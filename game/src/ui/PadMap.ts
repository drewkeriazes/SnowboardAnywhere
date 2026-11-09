/**
 * FEAT-128: the one gamepad table. `sim/Controls.ts` reads its button indices from here, and every
 * pad hint (the riding help line, Settings > Controls, the menus' hint bars) is built from the same
 * rows, so a hint can't disagree with what the button does.
 */

/** Gamepad (standard mapping) buttons */
export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
export type PadButton = keyof typeof PAD;

/** the button behind each riding action that has one (the sticks are in PAD_RIDE only) */
export const PAD_BUTTON_FOR: Record<string, PadButton> = {
  jump: 'A', grab: 'X', skate: 'B', tuck: 'RT', brake: 'LT', pressNose: 'RB', pressTail: 'LB', lift: 'Y', glance: 'R3',
  camera: 'UP', map: 'RIGHT', piste: 'LEFT', track: 'DOWN', replay: 'SELECT', pause: 'START',
};

const LABEL: Record<PadButton, string> = {
  A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', LT: 'LT', RT: 'RT', SELECT: 'Select', START: 'Start', L3: 'L3', R3: 'R3',
  UP: 'D-pad up', DOWN: 'D-pad down', LEFT: 'D-pad left', RIGHT: 'D-pad right',
};
/** What a button is called in hints. */
export function padLabel(b: PadButton): string { return LABEL[b]; }

const p = (a: string) => padLabel(PAD_BUTTON_FOR[a]);
/** The riding layout, in the order Settings > Controls lists it. */
export const PAD_RIDE: { pad: string; what: string }[] = [
  { pad: 'Left stick', what: 'Steer and lean' },
  { pad: p('jump'), what: 'Jump (hold, release)' },
  { pad: p('grab'), what: 'Squat / grab (+ steer: hard carve)' },
  { pad: `${p('tuck')} / ${p('brake')}`, what: 'Tuck / brake' },
  { pad: `${p('pressNose')} / ${p('pressTail')}`, what: 'Nose / tail press' },
  { pad: p('skate'), what: 'Skate' },
  { pad: p('lift'), what: 'Interact' },
  { pad: 'Right stick', what: 'Look around' },
  { pad: p('glance'), what: 'Look behind' },
  { pad: p('camera'), what: 'Camera' },
  { pad: p('map'), what: 'Map' },
  { pad: p('piste'), what: 'Piste lines' },
  { pad: p('track'), what: 'Next track' },
  { pad: p('replay'), what: 'Replay' },
  { pad: p('pause'), what: 'Pause' },
];

/** The riding help line while a pad is in use: the first nine rows (the D-pad and Select / Start are in Settings > Controls). */
export function padRideHint(): string {
  return PAD_RIDE.slice(0, 9).map((r) => `${r.pad} ${r.what.toLowerCase()}`).join(' &middot; ');
}
