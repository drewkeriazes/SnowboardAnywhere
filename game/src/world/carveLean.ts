/** FEAT-126: the most the rider and board roll into a turn (rad, about 60 degrees) */
export const LEAN_MAX = 1.05;
/** FEAT-148: in a hard carve the body lays over further, toward the snow (rad, about 73 degrees) */
export const LEAN_HARD = 1.27;

/**
 * Inclination into a turn from the lateral load (in g, + toward the board's right / toe side):
 * the balance angle, tan(phi) = a_lat / g, capped at `max` (LEAN_MAX, or up to LEAN_HARD in a hard
 * carve). The rider's body leans by it; the board and the carve track follow the sim's real edge
 * angle (FEAT-127), further over than this.
 */
export function carveLean(latG: number, max = LEAN_MAX): number {
  return Math.max(-max, Math.min(max, Math.atan(latG)));
}
