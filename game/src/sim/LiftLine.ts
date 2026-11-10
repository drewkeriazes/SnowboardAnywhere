/**
 * The rules of riding a lift line that the sims share (LiftRide, Outrun): the kinds, where along the
 * line you board and unload, and the rideable length. All in pack coordinates (x east, y north, z up).
 * world/Lifts builds the lines, the cables and the chairs and answers LiftNetwork, so the sims never
 * see a three.js object (FEAT-166).
 */
export type LiftKind = 'chair' | 'gondola' | 'surface' | 'carpet';
/** metres along the line from the station node to where you board / unload */
export const LOAD_OFFSET = 8;

/** A point in pack coordinates. */
export interface Vec3 { x: number; y: number; z: number }

/** What the sims read of a lift. */
export interface LiftLine {
  kind: LiftKind;
  speed: number;
  /** how far below the cable the rider sits (chair, gondola floor); surface and carpet put the rider on the snow */
  riderDrop: number;
  /** cable length from station a to station b */
  length: number;
  /** across the line, unit (pack x, y) */
  lateral: [number, number];
  /** true when station a (curve start) is the lower terminal, so riding up means d: 0 -> length */
  upFromA: boolean;
  bottom: [number, number, number]; // pack coords of the loading point
  top: [number, number, number]; // pack coords of the unloading point
  /** distance from the bottom station node of each tower along the line (sorted ascending) */
  towerUp: number[];
}

/** The lifts as the sims ask about them. */
export interface LiftNetwork<L extends LiftLine = LiftLine> {
  /** Nearest lift whose loading point is within `maxDist` m of a point, or null. */
  nearestBoardable(x: number, y: number, maxDist?: number): L | null;
  rideLength(l: L): number;
  /** Rider position (pack coords) at distance `up` metres from the loading point along the line. */
  seatAt(l: L, up: number, out: Vec3): Vec3;
}

/** Rideable length between the loading and unloading points. */
export function rideLength(l: { length: number }): number { return Math.max(1, l.length - 2 * LOAD_OFFSET); }
