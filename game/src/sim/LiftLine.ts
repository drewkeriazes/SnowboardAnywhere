/**
 * The rules of riding a lift line that the sims share: the kinds, where along the line you board
 * and unload, and the rideable length.
 */
export type LiftKind = 'chair' | 'gondola' | 'surface' | 'carpet';
/** metres along the line from the station node to where you board / unload */
export const LOAD_OFFSET = 8;

/** Rideable length between the loading and unloading points. */
export function rideLength(l: { length: number }): number { return Math.max(1, l.length - 2 * LOAD_OFFSET); }
