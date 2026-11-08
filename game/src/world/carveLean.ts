/** FEAT-126: the most the rider and board roll into a turn (rad, about 60 degrees) */
export const LEAN_MAX = 1.05;

/**
 * Inclination into a turn from the lateral load (in g, + toward the board's right / toe side):
 * the balance angle, tan(phi) = a_lat / g, capped at LEAN_MAX. The rider model leans by it and the
 * carve track cuts its edge from it, so the line in the snow matches the body.
 */
export function carveLean(latG: number): number {
  return Math.max(-LEAN_MAX, Math.min(LEAN_MAX, Math.atan(latG)));
}
